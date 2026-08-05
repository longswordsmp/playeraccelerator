'use strict';

/**
 * AutoMod engine.
 *
 * Every module is a small rule with a shared shape:
 *
 *   { key, enabled(config), detect(context) -> finding|null }
 *
 * A finding is `{ reason, evidence?, severity? }`. The engine runs the enabled
 * rules in order, stops at the first hit, and applies the punishment that
 * module is configured with. Rules are pure and synchronous wherever possible —
 * the message path must stay fast even on a busy server.
 */

const filters = require('./filters');
const linkProtection = require('./linkProtection');
const moderationService = require('../services/moderationService');
const logService = require('../services/logService');
const { SlidingWindow, registry } = require('../utils/rateLimiter');
const { attempt } = require('../utils/discord');
const { EMOJIS } = require('../config/branding');
const { truncate } = require('../utils/formatters');
const { GuildStats } = require('../database/models');
const { logger } = require('../utils/logger');

const log = logger.child('automod');

// ── Shared counters ──────────────────────────────────────────────────────────
// Keyed by `guildId:userId` (or `:channelId` where the rule is channel-scoped).
// Windows are sized generously; each rule reads its own configured window.

const windows = {
  messages: registry.register(new SlidingWindow(10_000)),
  duplicates: registry.register(new SlidingWindow(60_000)),
  emoji: registry.register(new SlidingWindow(15_000)),
  stickers: registry.register(new SlidingWindow(15_000)),
  gifs: registry.register(new SlidingWindow(20_000)),
  attachments: registry.register(new SlidingWindow(20_000)),
  mentions: registry.register(new SlidingWindow(15_000)),
  channels: registry.register(new SlidingWindow(15_000)),
  links: registry.register(new SlidingWindow(60_000)),
};

/** Last message content per user, for repeat detection. */
const lastMessages = new Map();
registry.register({
  prune() {
    const cutoff = Date.now() - 120_000;
    for (const [key, entry] of lastMessages) if (entry.at < cutoff) lastMessages.delete(key);
  },
});

/** Recently deleted mentions, for ghost-ping detection. */
const pendingGhostPings = new Map();
registry.register({
  prune() {
    const cutoff = Date.now() - 60_000;
    for (const [key, entry] of pendingGhostPings) if (entry.at < cutoff) pendingGhostPings.delete(key);
  },
});

// ── Rules ────────────────────────────────────────────────────────────────────

/**
 * @typedef {object} AutoModContext
 * @property {import('discord.js').Message} message
 * @property {string} content
 * @property {object} config
 * @property {object} settings the module's configuration block
 * @property {string} key `guildId:userId`
 */

/** @type {Array<{ key: string, label: string, detect: (ctx: AutoModContext) => object|null }>} */
const RULES = [
  {
    key: 'spam',
    label: 'Anti-Spam',
    detect: ({ message, settings, key }) => {
      const window = (settings.window ?? 5) * 1000;
      windows.messages.windowMs = Math.max(windows.messages.windowMs, window);
      const count = windows.messages.hit(`spam:${key}`);
      return count >= (settings.threshold ?? 5)
        ? { reason: `Sent ${count} messages in ${settings.window ?? 5}s`, clear: `spam:${key}` }
        : null;
    },
  },
  {
    key: 'flood',
    label: 'Anti-Flood',
    detect: ({ settings, key, message }) => {
      const count = windows.channels.hit(`flood:${key}:${message.channelId}`);
      return count >= (settings.threshold ?? 8)
        ? { reason: `Flooded ${message.channel.name} with ${count} messages`, clear: `flood:${key}:${message.channelId}` }
        : null;
    },
  },
  {
    key: 'repeatedMessages',
    label: 'Anti-Repeat',
    detect: ({ content, settings, key }) => {
      if (content.length < 4) return null;
      const fingerprint = filters.collapsed(content).slice(0, 120);
      const entry = lastMessages.get(key);
      if (entry?.fingerprint === fingerprint) {
        entry.count += 1;
        entry.at = Date.now();
        if (entry.count >= (settings.threshold ?? 3)) {
          lastMessages.delete(key);
          return { reason: `Repeated the same message ${entry.count} times` };
        }
      } else {
        lastMessages.set(key, { fingerprint, count: 1, at: Date.now() });
      }
      return null;
    },
  },
  {
    key: 'emojiSpam',
    label: 'Anti-Emoji-Spam',
    detect: ({ content, settings }) => {
      const count = filters.countEmoji(content);
      return count >= (settings.threshold ?? 12) ? { reason: `Message contained ${count} emoji` } : null;
    },
  },
  {
    key: 'stickerSpam',
    label: 'Anti-Sticker-Spam',
    detect: ({ message, settings, key }) => {
      if (!message.stickers?.size) return null;
      const count = windows.stickers.hit(`sticker:${key}`, message.stickers.size);
      return count >= (settings.threshold ?? 3) ? { reason: `Sent ${count} stickers in quick succession` } : null;
    },
  },
  {
    key: 'gifSpam',
    label: 'Anti-GIF-Spam',
    detect: ({ message, content, settings, key }) => {
      const gifs = (content.match(/https?:\/\/\S*(?:\.gif|tenor\.com|giphy\.com)\S*/gi) ?? []).length
        + [...(message.attachments?.values() ?? [])].filter((a) => /\.gif$/i.test(a.name ?? '')).length;
      if (!gifs) return null;
      const count = windows.gifs.hit(`gif:${key}`, gifs);
      return count >= (settings.threshold ?? 4) ? { reason: `Sent ${count} GIFs in quick succession` } : null;
    },
  },
  {
    key: 'attachmentSpam',
    label: 'Anti-Attachment-Spam',
    detect: ({ message, settings, key }) => {
      if (!message.attachments?.size) return null;
      const count = windows.attachments.hit(`att:${key}`, message.attachments.size);
      return count >= (settings.threshold ?? 5) ? { reason: `Uploaded ${count} attachments in quick succession` } : null;
    },
  },
  {
    key: 'mentionSpam',
    label: 'Anti-Mention-Spam',
    detect: ({ message, settings, key }) => {
      const mentions = message.mentions.users.size + message.mentions.roles.size;
      if (!mentions) return null;
      if (mentions >= (settings.threshold ?? 6)) {
        return { reason: `Mentioned ${mentions} users/roles in a single message` };
      }
      const total = windows.mentions.hit(`mention:${key}`, mentions);
      return total >= (settings.threshold ?? 6) * 2
        ? { reason: `Sent ${total} mentions in a short period` }
        : null;
    },
  },
  {
    key: 'everyonePing',
    label: 'Anti-Everyone-Ping',
    detect: ({ message, content }) => (
      content.includes('@everyone') && !message.mentions.everyone
        ? { reason: 'Attempted to ping @everyone without permission' }
        : null
    ),
  },
  {
    key: 'herePing',
    label: 'Anti-Here-Ping',
    detect: ({ message, content }) => (
      content.includes('@here') && !message.mentions.everyone
        ? { reason: 'Attempted to ping @here without permission' }
        : null
    ),
  },
  {
    key: 'inviteLinks',
    label: 'Anti-Invite',
    detect: ({ content, message }) => {
      const invites = filters.findInvites(content);
      if (!invites.length) return null;
      // Invites to this same server are legitimate.
      const external = invites.filter((code) => !message.guild.vanityURLCode || code !== message.guild.vanityURLCode);
      return external.length
        ? { reason: `Posted ${external.length} Discord invite link(s)`, evidence: external.map((code) => `discord.gg/${code}`) }
        : null;
    },
  },
  {
    key: 'fakeNitro',
    label: 'Anti-Fake-Nitro',
    detect: ({ content }) => (filters.isFakeNitro(content) ? { reason: 'Fake Nitro / gift scam message', severity: 'critical' } : null),
  },
  {
    key: 'capsAbuse',
    label: 'Anti-Caps',
    detect: ({ content, settings }) => {
      if (content.length < (settings.minLength ?? 12)) return null;
      const ratio = filters.capsRatio(content);
      return ratio >= (settings.threshold ?? 70) ? { reason: `Message was ${ratio}% capital letters` } : null;
    },
  },
  {
    key: 'symbolAbuse',
    label: 'Anti-Symbol-Abuse',
    detect: ({ content, settings }) => {
      if (content.length < (settings.minLength ?? 12)) return null;
      const ratio = filters.symbolRatio(content);
      return ratio >= (settings.threshold ?? 60) ? { reason: `Message was ${ratio}% symbols` } : null;
    },
  },
  {
    key: 'newlineAbuse',
    label: 'Anti-Newline-Spam',
    detect: ({ content, settings }) => {
      const run = filters.maxNewlineRun(content);
      return run >= (settings.threshold ?? 15) ? { reason: `Message contained ${run} consecutive line breaks` } : null;
    },
  },
  {
    key: 'zalgo',
    label: 'Anti-Zalgo',
    detect: ({ content }) => (filters.isZalgo(content) ? { reason: 'Message contained zalgo text' } : null),
  },
  {
    key: 'unicodeAbuse',
    label: 'Anti-Unicode-Abuse',
    detect: ({ content, settings }) => {
      if (content.length < (settings.minLength ?? 10)) return null;
      const ratio = filters.unicodeAbuseRatio(content);
      return ratio >= (settings.threshold ?? 40) ? { reason: `Message was ${ratio}% lookalike/decorative characters` } : null;
    },
  },
  {
    key: 'slurs',
    label: 'Anti-Slur',
    detect: ({ content }) => {
      const hits = filters.findSlurs(content);
      return hits.length ? { reason: 'Message contained a slur', severity: 'critical' } : null;
    },
  },
  {
    key: 'profanity',
    label: 'Profanity Filter',
    detect: ({ content, config }) => {
      const automod = config.automod ?? {};
      const { matched } = filters.findBannedWords(content, {
        words: [...filters.PROFANITY, ...(automod.customWords ?? [])],
        patterns: automod.customPatterns ?? [],
        allowed: automod.allowedWords ?? [],
      });
      return matched.length ? { reason: `Message contained blocked language (${matched.length} match)` } : null;
    },
  },
  {
    key: 'offensiveLanguage',
    label: 'Offensive Language',
    detect: ({ content, config }) => {
      const automod = config.automod ?? {};
      if (!(automod.customWords ?? []).length && !(automod.customPatterns ?? []).length) return null;
      const { matched } = filters.findBannedWords(content, {
        words: automod.customWords ?? [],
        patterns: automod.customPatterns ?? [],
        allowed: automod.allowedWords ?? [],
      });
      return matched.length ? { reason: 'Message matched a custom blocked term' } : null;
    },
  },
  {
    key: 'advertising',
    label: 'Advertising Detection',
    detect: ({ content }) => {
      const advert = filters.findAdvertising(content);
      if (!advert.length) return null;
      const hasLink = /https?:\/\//i.test(content) || filters.findInvites(content).length > 0;
      return hasLink ? { reason: 'Unsolicited advertising' } : null;
    },
  },
  {
    key: 'selfPromotion',
    label: 'Self-Promotion Detection',
    detect: ({ content, settings, key }) => {
      const urls = content.match(/https?:\/\/\S+/gi) ?? [];
      if (!urls.length) return null;
      const count = windows.links.hit(`links:${key}`, urls.length);
      return count >= (settings.threshold ?? 6) ? { reason: `Posted ${count} links in a short period` } : null;
    },
  },
  {
    key: 'massDm',
    label: 'Anti-Mass-DM',
    detect: ({ message, content, settings, key }) => {
      // Discord gives bots no visibility into DMs between users. What IS
      // detectable is the public shape of a mass-DM campaign: the same message
      // repeated across many different channels in a short window.
      const fingerprint = filters.collapsed(content).slice(0, 80);
      if (fingerprint.length < 10) return null;
      const count = windows.duplicates.hit(`crosspost:${key}:${fingerprint}`);
      const channels = windows.channels.hit(`spread:${key}:${fingerprint}:${message.channelId}`) === 1 ? 1 : 0;
      if (channels && count >= (settings.threshold ?? 5)) {
        return { reason: `Posted the same message across ${count} channels — likely mass-DM/advertising campaign` };
      }
      return null;
    },
  },
];

/** Rules that only make sense when message content is visible. */
const CONTENT_RULES = new Set([
  'repeatedMessages', 'emojiSpam', 'everyonePing', 'herePing', 'inviteLinks',
  'fakeNitro', 'capsAbuse', 'symbolAbuse', 'newlineAbuse', 'zalgo',
  'unicodeAbuse', 'slurs', 'profanity', 'offensiveLanguage', 'advertising',
  'selfPromotion', 'massDm',
]);

// ── Engine ───────────────────────────────────────────────────────────────────

/**
 * Inspect a message and act on the first rule that fires.
 *
 * @param {import('discord.js').Message} message
 * @param {object} config
 * @returns {Promise<{ action: string, module: string, reason: string }|null>}
 */
/**
 * The only modules that still run inside a ticket.
 *
 * Every one of these protects the customer from a third party rather than
 * policing how they write. A phishing link in a private channel is still
 * phishing; a Discord invite in one is a customer showing you their server.
 */
const TICKET_SAFE_MODULES = new Set([
  'scamLinks', 'phishingLinks', 'malwareLinks', 'tokenGrabbers', 'fakeNitro',
]);

/**
 * Is this channel a customer's private ticket?
 *
 * Tickets are a conversation with one paying customer, not a public room, and
 * the things a filter is protecting a public room *from* are usually exactly
 * what a customer needs to send: the invite to the server they want a plugin
 * for, a wall of caps because something is broken, a config file pasted in
 * full. Moderating that is both pointless — nobody else can see it — and
 * actively harmful, because the message that gets deleted is the brief.
 *
 * Parent-based rather than a database lookup so it stays synchronous on the
 * message hot path.
 */
function isTicketChannel(channel, config) {
  const parents = [config.categories?.tickets, config.categories?.archive].filter(Boolean);
  return Boolean(channel?.parentId && parents.includes(channel.parentId));
}

async function inspect(message, config) {
  if (!config.automod?.enabled || !config.moderation?.enabled) return null;
  if (!message.guild || message.author.bot || !message.member) return null;
  if (moderationService.isChannelExempt(message.channelId, config)) return null;
  if (moderationService.isExempt(message.member, config)) return null;

  // Inside a ticket, only the rules that protect the *customer* still apply:
  // scam, phishing, malware and token grabbers. Everything else stands down.
  const inTicket = config.moderation?.relaxInTickets !== false && isTicketChannel(message.channel, config);

  const content = message.content ?? '';
  const key = `${message.guild.id}:${message.author.id}`;
  const modules = config.automod.modules ?? {};

  // Link protection runs first: a malicious link is the highest-severity thing
  // an ordinary message can contain.
  const linkFinding = await linkProtection.inspect(message, config);
  if (linkFinding && !(inTicket && !TICKET_SAFE_MODULES.has(linkFinding.module))) {
    return enforce(message, config, linkFinding.module, modules[linkFinding.module] ?? {}, linkFinding);
  }

  for (const rule of RULES) {
    const settings = modules[rule.key];
    if (!settings?.enabled) continue;
    if (inTicket && !TICKET_SAFE_MODULES.has(rule.key)) continue;
    // Content-dependent rules need the MessageContent intent to be useful.
    if (CONTENT_RULES.has(rule.key) && !content) continue;

    let finding;
    try {
      finding = rule.detect({ message, content, config, settings, key });
    } catch (err) {
      log.debug(`AutoMod rule ${rule.key} threw`, { message: err.message });
      continue;
    }
    if (!finding) continue;

    if (finding.clear) windows.messages.reset(finding.clear);
    return enforce(message, config, rule.key, settings, finding);
  }

  return null;
}

/**
 * Apply a module's configured response.
 *
 * @param {import('discord.js').Message} message
 * @param {object} config
 * @param {string} moduleKey
 * @param {object} settings
 * @param {{ reason: string, evidence?: string[], severity?: string }} finding
 */
async function enforce(message, config, moduleKey, settings, finding) {
  const action = settings.action ?? 'delete';
  const label = RULES.find((rule) => rule.key === moduleKey)?.label ?? moduleKey;

  // 1. Remove the offending message.
  if (settings.deleteMessage !== false || action === 'delete') {
    await attempt(() => message.delete(), { label: 'automod delete' });
    await GuildStats.bump(message.guild.id, { 'moderation.messagesDeleted': 1 });
  }

  // 2. Tell the member what happened, briefly and without lecturing.
  //    A self-deleting notice keeps the channel clean.
  if (message.channel?.isTextBased?.()) {
    const notice = await attempt(
      () => message.channel.send({
        content: `<@${message.author.id}>`,
        embeds: [require('../utils/embeds').notice(`${finding.reason}. Your message was removed.`, 'warning', config)],
      }),
      { label: 'automod notice' },
    );
    if (notice) setTimeout(() => attempt(() => notice.delete(), { label: 'cleanup notice' }), 8000).unref?.();
  }

  // 3. Punish, when the module asks for more than deletion.
  if (!['none', 'delete'].includes(action)) {
    await moderationService.punish({
      guild: message.guild,
      type: action,
      target: message.author,
      moderator: { id: message.client.user.id, tag: `${config.brand?.name ?? 'AutoMod'} (auto)` },
      reason: `${label}: ${finding.reason}`,
      duration: action === 'timeout' ? (settings.duration ?? 10) * 60_000 : null,
      config,
      automated: true,
      source: moduleKey,
      context: {
        channelId: message.channelId,
        messageId: message.id,
        content: truncate(message.content ?? '', 500),
      },
      evidence: finding.evidence ?? [],
    }).catch((err) => {
      log.warn(`AutoMod punishment failed for ${moduleKey}`, { message: err.message });
    });
  } else {
    // Deletion-only hits still deserve a security log line.
    await logService.security(message.guild, {
      event: `automod.${moduleKey}`,
      title: `${EMOJIS.moderation} AutoMod · ${label}`,
      summary: finding.reason,
      actorId: message.author.id,
      actorName: message.author.tag,
      channelId: message.channelId,
      severity: finding.severity ?? 'warn',
      fields: { Content: truncate(message.content ?? '(no text)', 500) },
    }, config);
    await GuildStats.bump(message.guild.id, { 'moderation.automodHits': 1 });
  }

  return { action, module: moduleKey, reason: finding.reason };
}

/**
 * Ghost-ping detection: remember mentions so a delete can be attributed.
 * @param {import('discord.js').Message} message
 */
function rememberMentions(message) {
  if (!message.guild || message.author?.bot) return;
  const mentioned = message.mentions.users.size + message.mentions.roles.size;
  if (!mentioned) return;
  pendingGhostPings.set(message.id, {
    at: Date.now(),
    authorId: message.author.id,
    authorTag: message.author.tag,
    channelId: message.channelId,
    content: truncate(message.content ?? '', 300),
    mentioned: [...message.mentions.users.keys()],
  });
}

/**
 * Handle a deleted message that contained mentions.
 * @param {import('discord.js').Message} message
 * @param {object} config
 */
async function checkGhostPing(message, config) {
  const record = pendingGhostPings.get(message.id);
  pendingGhostPings.delete(message.id);
  if (!record) return null;

  const settings = config.automod?.modules?.ghostPing;
  if (!config.automod?.enabled || !settings?.enabled) return null;

  // A message deleted within 15 seconds of a mention is the classic pattern.
  if (Date.now() - record.at > 15_000) return null;

  const member = await message.guild.members.fetch(record.authorId).catch(() => null);
  if (moderationService.isExempt(member, config)) return null;

  await logService.security(message.guild, {
    event: 'automod.ghostPing',
    title: `${EMOJIS.moderation} AutoMod · Ghost Ping`,
    summary: `<@${record.authorId}> deleted a message that mentioned ${record.mentioned.length} member(s)`,
    actorId: record.authorId,
    actorName: record.authorTag,
    channelId: record.channelId,
    severity: 'warn',
    fields: { Content: record.content },
  }, config);

  if (settings.action && !['none', 'delete'].includes(settings.action)) {
    await moderationService.punish({
      guild: message.guild,
      type: settings.action,
      target: { id: record.authorId, tag: record.authorTag },
      moderator: { id: message.client.user.id, tag: 'AutoMod' },
      reason: 'Ghost ping: deleted a message containing mentions',
      duration: settings.action === 'timeout' ? (settings.duration ?? 10) * 60_000 : null,
      config,
      automated: true,
      source: 'ghostPing',
    }).catch(() => null);
  }

  return record;
}

/** The list of modules, for `/security` rendering. */
const MODULE_LIST = RULES.map((rule) => ({ key: rule.key, label: rule.label }))
  .concat([
    { key: 'ghostPing', label: 'Anti-Ghost-Ping' },
    { key: 'scamLinks', label: 'Anti-Scam-Links' },
    { key: 'phishingLinks', label: 'Anti-Phishing' },
    { key: 'malwareLinks', label: 'Anti-Malware-Links' },
    { key: 'tokenGrabbers', label: 'Anti-Token-Grabber' },
    { key: 'suspiciousUrls', label: 'Suspicious URL Filter' },
    { key: 'nsfwImages', label: 'Image Moderation' },
  ]);

module.exports = { inspect, enforce, rememberMentions, checkGhostPing, isTicketChannel, RULES, MODULE_LIST, TICKET_SAFE_MODULES, windows };
