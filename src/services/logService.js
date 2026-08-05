'use strict';

/**
 * Unified event logging.
 *
 * A single entry point that fans out to three destinations:
 *   1. the process logger (stdout + files),
 *   2. the appropriate Discord log channel as a branded embed,
 *   3. the `Log` collection when persistence is enabled.
 *
 * Discord sends are queued per channel so a burst of events (a raid, a mass
 * delete) never floods the API — entries are batched into a single message
 * every couple of seconds.
 */

const { Log, GuildStats } = require('../database/models');
const configService = require('./configService');
const embeds = require('../utils/embeds');
const { safeSend } = require('../utils/discord');
const { logger } = require('../utils/logger');
const { COLORS, EMOJIS } = require('../config/branding');
const { truncate, timestamp } = require('../utils/formatters');

const log = logger.child('events');

/** How long to accumulate embeds before flushing a channel's queue. */
const FLUSH_INTERVAL_MS = 2000;
/** Discord allows ten embeds per message. */
const MAX_EMBEDS_PER_MESSAGE = 10;

/** @type {Map<string, { channel: import('discord.js').TextChannel, embeds: any[], timer: NodeJS.Timeout|null }>} */
const queues = new Map();

/** Severity → colour. */
const SEVERITY_COLORS = {
  debug: COLORS.muted,
  info: COLORS.primary,
  warn: COLORS.warning,
  error: COLORS.danger,
  critical: COLORS.danger,
};

/** Category → which configured log channel receives it. */
const CATEGORY_ROUTING = {
  message: 'audit',
  member: 'audit',
  channel: 'audit',
  role: 'audit',
  guild: 'audit',
  voice: 'audit',
  invite: 'audit',
  webhook: 'audit',
  moderation: 'moderation',
  security: 'security',
  ticket: 'ticket',
  order: 'ticket',
  review: 'ticket',
  report: 'report',
  business: 'business',
  command: 'bot',
  error: 'bot',
  system: 'bot',
};

/** Flush a channel's pending embeds. */
async function flush(channelId) {
  const queue = queues.get(channelId);
  if (!queue) return;
  queue.timer = null;
  const batch = queue.embeds.splice(0, MAX_EMBEDS_PER_MESSAGE);
  if (!batch.length) {
    queues.delete(channelId);
    return;
  }
  await safeSend(queue.channel, { embeds: batch });
  if (queue.embeds.length) schedule(channelId);
  else queues.delete(channelId);
}

/** Ensure a flush is scheduled for a channel. */
function schedule(channelId) {
  const queue = queues.get(channelId);
  if (!queue || queue.timer) return;
  queue.timer = setTimeout(() => flush(channelId).catch(() => null), FLUSH_INTERVAL_MS);
  queue.timer.unref?.();
}

/**
 * Enqueue an embed for a log channel.
 * @param {import('discord.js').TextChannel} channel
 * @param {import('discord.js').EmbedBuilder} embed
 */
function enqueue(channel, embed) {
  let queue = queues.get(channel.id);
  if (!queue) {
    queue = { channel, embeds: [], timer: null };
    queues.set(channel.id, queue);
  }
  // Hard cap so a runaway event source cannot exhaust memory.
  if (queue.embeds.length >= 200) return;
  queue.embeds.push(embed);
  schedule(channel.id);
}

/**
 * Build the standard log embed.
 * @param {object} entry
 * @param {object} config
 */
function buildEmbed(entry, config) {
  const fields = [];
  if (entry.actorId) {
    fields.push({ name: 'Actor', value: `<@${entry.actorId}>\n\`${entry.actorId}\``, inline: true });
  }
  if (entry.targetId && entry.targetId !== entry.actorId) {
    fields.push({ name: 'Target', value: entry.targetName ? `${entry.targetName}\n\`${entry.targetId}\`` : `<@${entry.targetId}>\n\`${entry.targetId}\``, inline: true });
  }
  if (entry.channelId) {
    fields.push({ name: 'Channel', value: `<#${entry.channelId}>`, inline: true });
  }
  for (const [name, value] of Object.entries(entry.fields ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    fields.push({ name, value: truncate(String(value), 1024), inline: String(value).length < 40 });
  }

  return embeds.base({
    config,
    color: SEVERITY_COLORS[entry.severity] ?? COLORS.primary,
    author: { name: entry.title ?? entry.event },
    description: entry.summary ? truncate(entry.summary, 2000) : undefined,
    fields,
    footer: `${entry.event}${entry.caseId ? ` · Case #${entry.caseId}` : ''}`,
    thumbnail: entry.thumbnail ?? null,
  });
}

/**
 * Record an event.
 *
 * @param {import('discord.js').Guild|null} guild
 * @param {object} entry
 * @param {string} entry.category routing category (see CATEGORY_ROUTING)
 * @param {string} entry.event specific event name
 * @param {string} [entry.title] embed heading
 * @param {string} [entry.summary]
 * @param {string} [entry.actorId]
 * @param {string} [entry.actorName]
 * @param {string} [entry.targetId]
 * @param {string} [entry.targetName]
 * @param {string} [entry.channelId]
 * @param {string} [entry.messageId]
 * @param {Record<string, any>} [entry.fields] rendered as embed fields
 * @param {object} [entry.details] persisted, not rendered
 * @param {'debug'|'info'|'warn'|'error'|'critical'} [entry.severity]
 * @param {object} [config] pre-fetched guild configuration
 */
async function record(guild, entry, config = null) {
  const severity = entry.severity ?? 'info';

  try {
    if (!guild) {
      log.log(severity === 'critical' ? 'error' : severity, `${entry.event}: ${entry.summary ?? ''}`, entry.details);
      return;
    }

    const cfg = config ?? (await configService.get(guild));
    if (!cfg.logging?.enabled) return;

    // Per-event opt-out.
    const eventKey = entry.event.split('.')[0];
    if (cfg.logging.events && eventKey in cfg.logging.events && cfg.logging.events[eventKey] === false) return;

    // Channel-level opt-out (e.g. noisy bot channels).
    if (entry.channelId && (cfg.logging.ignoredChannels ?? []).includes(entry.channelId)) return;

    const routeKey = CATEGORY_ROUTING[entry.category] ?? 'bot';
    const channel = configService.logChannel(guild, cfg, routeKey);
    if (channel) enqueue(channel, buildEmbed(entry, cfg));

    if (cfg.logging.persist !== false) {
      await Log.record({
        guildId: guild.id,
        category: entry.category,
        event: entry.event,
        actorId: entry.actorId ?? '',
        actorName: entry.actorName ?? '',
        targetId: entry.targetId ?? '',
        targetName: entry.targetName ?? '',
        channelId: entry.channelId ?? '',
        messageId: entry.messageId ?? '',
        summary: truncate(entry.summary ?? entry.title ?? entry.event, 500),
        details: entry.details ?? entry.fields ?? {},
        severity,
      });
    }
  } catch (err) {
    // Logging failures are logged locally and otherwise ignored.
    log.warn('Failed to record event', { event: entry?.event, message: err.message });
  }
}

/**
 * Convenience wrapper for security events — always high severity, always
 * counted in the daily metrics.
 */
async function security(guild, entry, config = null) {
  await record(guild, { ...entry, category: 'security', severity: entry.severity ?? 'warn' }, config);
  const counterKey = {
    raid: 'security.raidAlerts',
    nuke: 'security.nukeAlerts',
    link: 'security.blockedLinks',
    account: 'security.flaggedAccounts',
  }[entry.metric];
  if (guild && counterKey) await GuildStats.bump(guild.id, { [counterKey]: 1 });
}

/**
 * Report an internal error to the bot-log channel and the process logger.
 * @param {import('discord.js').Guild|null} guild
 * @param {Error} err
 * @param {{ context?: string, reference?: string|null, userId?: string }} [meta]
 */
async function error(guild, err, meta = {}) {
  log.error(`${meta.context ?? 'Unhandled error'}: ${err?.message}`, { stack: err?.stack, reference: meta.reference });

  if (guild) await GuildStats.bump(guild.id, { 'activity.errors': 1 });

  await record(guild, {
    category: 'error',
    event: 'runtime.error',
    title: `${EMOJIS.error} Runtime Error`,
    summary: truncate(err?.message ?? 'Unknown error', 1000),
    actorId: meta.userId,
    severity: 'error',
    fields: {
      Context: meta.context ?? 'Unknown',
      Reference: meta.reference ?? '—',
      When: timestamp(new Date(), 'relative'),
    },
    details: { stack: truncate(err?.stack ?? '', 3000) },
  });
}

/** Flush every pending queue — called during graceful shutdown. */
async function drain() {
  const ids = [...queues.keys()];
  for (const id of ids) {
    const queue = queues.get(id);
    if (queue?.timer) clearTimeout(queue.timer);
    // eslint-disable-next-line no-await-in-loop -- ordered drain during shutdown
    await flush(id).catch(() => null);
  }
}

module.exports = { record, security, error, drain, CATEGORY_ROUTING };
