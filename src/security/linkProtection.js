'use strict';

/**
 * Link and attachment protection.
 *
 * Runs before the general AutoMod rules because a credential-stealing link is
 * the highest-impact thing an ordinary message can carry. Classification is
 * local by default; an optional external reputation API and an optional image
 * classifier can be wired in through the environment.
 */

const filters = require('./filters');
const moderationService = require('../services/moderationService');
const logService = require('../services/logService');
const { env } = require('../config/env');
const { extractUrls } = require('../utils/validators');
const { registry, SlidingWindow } = require('../utils/rateLimiter');
const { GuildStats } = require('../database/models');
const { logger } = require('../utils/logger');

const log = logger.child('links');

/** Cache verdicts so the same link is not re-checked on every repost. */
const verdictCache = new Map();
registry.register({
  prune() {
    const cutoff = Date.now() - 3_600_000;
    for (const [key, entry] of verdictCache) if (entry.at < cutoff) verdictCache.delete(key);
  },
});

/** Repeat-offender tracking, used to escalate. */
const offences = registry.register(new SlidingWindow(3_600_000));

/** Which automod module a verdict maps onto. */
const VERDICT_MODULE = {
  malicious: 'malwareLinks',
  blocked: 'suspiciousUrls',
  suspicious: 'suspiciousUrls',
};

/**
 * Query the optional external reputation service.
 * Failures are non-fatal: the local classifier already made a decision.
 * @param {string} url
 * @returns {Promise<{ malicious: boolean, category?: string }|null>}
 */
async function checkReputation(url) {
  if (!env.urlReputation.enabled) return null;

  const cached = verdictCache.get(url);
  if (cached && cached.at > Date.now() - 3_600_000) return cached.value;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const response = await fetch(env.urlReputation.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.urlReputation.key ? { authorization: `Bearer ${env.urlReputation.key}` } : {}),
      },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    const value = await response.json();
    verdictCache.set(url, { value, at: Date.now() });
    return value;
  } catch (err) {
    log.debug('URL reputation lookup failed', { message: err.message });
    return null;
  }
}

/**
 * Query the optional image classifier for an attachment.
 * @param {string} url
 * @returns {Promise<{ nsfw: boolean, score: number }|null>}
 */
async function classifyImage(url) {
  if (!env.imageModeration.enabled) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const response = await fetch(env.imageModeration.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(env.imageModeration.key ? { authorization: `Bearer ${env.imageModeration.key}` } : {}),
      },
      body: JSON.stringify({ url }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    if (!response.ok) return null;
    return await response.json();
  } catch (err) {
    log.debug('Image classification failed', { message: err.message });
    return null;
  }
}

/**
 * Inspect a message's links and attachments.
 *
 * @param {import('discord.js').Message} message
 * @param {object} config
 * @returns {Promise<{ module: string, reason: string, evidence: string[], severity: string }|null>}
 */
async function inspect(message, config) {
  if (config.links?.enabled === false) return null;
  if ((config.links?.allowedChannels ?? []).includes(message.channelId)) return null;

  const content = message.content ?? '';
  const urls = extractUrls(content);

  // ── Scam language, even without a link ────────────────────────────────────
  const scamModule = config.automod?.modules?.scamLinks;
  if (scamModule?.enabled) {
    const scamHits = filters.findScamLanguage(content);
    if (scamHits.length && urls.length) {
      await record(message, config, 'scam', urls);
      return {
        module: 'scamLinks',
        reason: 'Message matched a known scam pattern and contained a link',
        evidence: urls.slice(0, 5),
        severity: 'critical',
      };
    }
  }

  // ── Attachments ───────────────────────────────────────────────────────────
  for (const attachment of message.attachments?.values() ?? []) {
    const name = attachment.name ?? '';
    if (/\.(?:exe|scr|bat|cmd|com|pif|vbs|jar|msi|apk|dll|ps1|sh)$/i.test(name)) {
      await record(message, config, 'malware', [name]);
      return {
        module: 'malwareLinks',
        reason: `Uploaded an executable file (\`${name}\`)`,
        evidence: [name],
        severity: 'critical',
      };
    }

    const nsfwModule = config.automod?.modules?.nsfwImages;
    if (nsfwModule?.enabled && /\.(?:png|jpe?g|webp|gif)$/i.test(name) && !message.channel.nsfw) {
      // eslint-disable-next-line no-await-in-loop -- at most a handful of attachments
      const verdict = await classifyImage(attachment.url);
      // Only act on high confidence; borderline results go to staff for review.
      if (verdict?.nsfw && verdict.score >= 0.9) {
        await record(message, config, 'nsfw', [name]);
        return { module: 'nsfwImages', reason: 'Attachment was classified as explicit content', evidence: [name], severity: 'warn' };
      }
      if (verdict?.nsfw && verdict.score >= 0.6) {
        await logService.security(message.guild, {
          event: 'links.nsfwReview',
          title: '🔍 Attachment Flagged for Review',
          summary: `An attachment scored ${Math.round(verdict.score * 100)}% on the explicit-content classifier. No action was taken automatically.`,
          actorId: message.author.id,
          actorName: message.author.tag,
          channelId: message.channelId,
          severity: 'info',
          fields: { File: name, Message: message.url },
        }, config);
      }
    }
  }

  if (!urls.length) return null;

  // ── URLs ──────────────────────────────────────────────────────────────────
  const staffExempt = config.links?.allowStaff !== false
    && require('../utils/permissions').isStaff(message.member, config);

  for (const url of urls) {
    const verdict = filters.classifyUrl(url, {
      whitelist: config.links?.whitelist ?? [],
      blacklist: config.links?.blacklist ?? [],
      blockShorteners: config.links?.blockShorteners === true,
    });

    if (verdict.verdict === 'allowed') continue;
    // Staff can post anything except confirmed malware.
    if (staffExempt && verdict.verdict !== 'malicious') continue;

    const moduleKey = VERDICT_MODULE[verdict.verdict] ?? 'suspiciousUrls';
    const moduleConfig = config.automod?.modules?.[moduleKey];
    if (!moduleConfig?.enabled) continue;

    // eslint-disable-next-line no-await-in-loop -- short list
    const reputation = await checkReputation(url);
    const confirmed = reputation?.malicious === true || verdict.verdict === 'malicious';

    await record(message, config, confirmed ? 'malware' : 'suspicious', [url]);

    return {
      module: confirmed ? 'malwareLinks' : moduleKey,
      reason: `${verdict.reason}${reputation?.category ? ` (${reputation.category})` : ''}: \`${verdict.host}\``,
      evidence: [url],
      severity: confirmed ? 'critical' : 'warn',
    };
  }

  // ── Token-grabber heuristics on otherwise-allowed links ───────────────────
  const grabberModule = config.automod?.modules?.tokenGrabbers;
  if (grabberModule?.enabled) {
    const suspicious = urls.filter((url) => /(?:token|passwo?rd|login|auth|session|cookie)[=/]/i.test(url));
    if (suspicious.length && /(?:discord|nitro|verify|login)/i.test(content)) {
      await record(message, config, 'malware', suspicious);
      return {
        module: 'tokenGrabbers',
        reason: 'Link resembles a credential or token harvesting page',
        evidence: suspicious.slice(0, 3),
        severity: 'critical',
      };
    }
  }

  return null;
}

/** Count an offence and write the security log entry. */
async function record(message, config, kind, evidence) {
  offences.hit(`${message.guild.id}:${message.author.id}`);
  await GuildStats.bump(message.guild.id, { 'security.blockedLinks': 1 });
  await logService.security(message.guild, {
    event: `links.${kind}`,
    metric: 'link',
    title: '🔗 Link Blocked',
    summary: `${kind} content from ${message.author.tag}`,
    actorId: message.author.id,
    actorName: message.author.tag,
    channelId: message.channelId,
    severity: kind === 'malware' || kind === 'scam' ? 'critical' : 'warn',
    fields: { Evidence: evidence.slice(0, 3).map((item) => `\`${item}\``).join('\n') },
  }, config);
}

/** How many link offences a member has committed in the last hour. */
const offenceCount = (guildId, userId) => offences.count(`${guildId}:${userId}`);

module.exports = { inspect, checkReputation, classifyImage, offenceCount };
