'use strict';

/**
 * Defensive Discord helpers.
 *
 * Discord's API fails in ordinary, expected ways — a channel is deleted mid
 * operation, a member leaves, an interaction token expires. These wrappers make
 * those outcomes explicit instead of letting them become unhandled rejections.
 */

const { MessageFlags, ChannelType, PermissionFlagsBits } = require('discord.js');
const { logger } = require('./logger');

const log = logger.child('discord');

/** Discord's per-request rate limit is generous; this keeps bursts civil. */
const BULK_DELAY_MS = 350;

/** Await `ms` milliseconds. */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run an async Discord call, swallowing expected failures.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {{ label?: string, fallback?: any, rethrow?: number[] }} [options]
 * @returns {Promise<T|any>} the result, or `fallback` when the call failed
 */
async function attempt(fn, { label = 'discord call', fallback = null, rethrow = [] } = {}) {
  try {
    return await fn();
  } catch (err) {
    if (rethrow.includes(err?.code)) throw err;
    log.debug(`${label} failed`, { code: err?.code, message: err?.message });
    return fallback;
  }
}

/**
 * Reply to an interaction safely regardless of its current state.
 * Handles: not yet acknowledged, deferred, already replied, expired token.
 *
 * @param {import('discord.js').RepliableInteraction} interaction
 * @param {import('discord.js').InteractionReplyOptions} payload
 * @param {{ ephemeral?: boolean, followUp?: boolean }} [options]
 */
async function safeReply(interaction, payload, { ephemeral = false, followUp = false } = {}) {
  const body = { ...payload };
  if (ephemeral) body.flags = (body.flags ?? 0) | MessageFlags.Ephemeral;

  try {
    if (interaction.deferred && !interaction.replied && !followUp) {
      // editReply cannot change ephemerality — the flag was set at defer time.
      const { flags, ...rest } = body;
      return await interaction.editReply(rest);
    }
    if (interaction.replied || interaction.deferred) {
      return await interaction.followUp(body);
    }
    return await interaction.reply(body);
  } catch (err) {
    // 10062 = Unknown interaction (token expired), 40060 = already acknowledged.
    if (err?.code === 40060) {
      return attempt(() => interaction.followUp(body), { label: 'safeReply followUp' });
    }
    if (err?.code !== 10062) log.warn('Failed to reply to interaction', { code: err?.code, message: err?.message });
    return null;
  }
}

/**
 * Defer an interaction safely.
 * @param {import('discord.js').RepliableInteraction} interaction
 * @param {{ ephemeral?: boolean }} [options]
 * @returns {Promise<boolean>} whether the interaction is now deferred
 */
async function safeDefer(interaction, { ephemeral = true } = {}) {
  if (interaction.deferred || interaction.replied) return true;
  try {
    await interaction.deferReply(ephemeral ? { flags: MessageFlags.Ephemeral } : {});
    return true;
  } catch (err) {
    if (err?.code !== 10062) log.debug('Failed to defer interaction', { code: err?.code });
    return false;
  }
}

/** Defer a component update (button/select) without changing the message yet. */
async function safeDeferUpdate(interaction) {
  if (interaction.deferred || interaction.replied) return true;
  return Boolean(await attempt(() => interaction.deferUpdate(), { label: 'deferUpdate', fallback: false }));
}

/**
 * Fetch a guild member without throwing when they have left.
 * @param {import('discord.js').Guild} guild
 * @param {string} userId
 * @returns {Promise<import('discord.js').GuildMember|null>}
 */
function fetchMember(guild, userId) {
  if (!guild || !userId) return Promise.resolve(null);
  const cached = guild.members.cache.get(userId);
  if (cached) return Promise.resolve(cached);
  return attempt(() => guild.members.fetch({ user: userId, force: false }), { label: 'fetchMember' });
}

/**
 * Fetch a channel, returning null when it no longer exists.
 * @param {import('discord.js').Client|import('discord.js').Guild} source
 * @param {string} channelId
 */
function fetchChannel(source, channelId) {
  if (!source || !channelId) return Promise.resolve(null);
  const cache = source.channels?.cache?.get(channelId);
  if (cache) return Promise.resolve(cache);
  return attempt(() => source.channels.fetch(channelId), { label: 'fetchChannel' });
}

/**
 * Resolve a configured channel id into a live text channel.
 * @param {import('discord.js').Guild} guild
 * @param {string} channelId
 * @returns {Promise<import('discord.js').TextChannel|null>}
 */
async function resolveTextChannel(guild, channelId) {
  const channel = await fetchChannel(guild, channelId);
  if (!channel) return null;
  if (!channel.isTextBased?.() || channel.type === ChannelType.GuildVoice) return null;
  return channel;
}

/**
 * Send a message to a channel, tolerating deletion and missing permissions.
 * @param {import('discord.js').TextBasedChannel|null} channel
 * @param {import('discord.js').MessageCreateOptions|string} payload
 */
async function safeSend(channel, payload) {
  if (!channel?.isTextBased?.()) return null;
  const me = channel.guild?.members?.me;
  if (me) {
    const permissions = channel.permissionsFor(me);
    if (!permissions?.has(PermissionFlagsBits.SendMessages) || !permissions?.has(PermissionFlagsBits.ViewChannel)) {
      log.debug('Skipped send: missing channel permissions', { channelId: channel.id });
      return null;
    }
  }
  return attempt(() => channel.send(payload), { label: 'safeSend' });
}

/**
 * Direct-message a user. Returns false when their privacy settings block it —
 * a normal outcome that must never surface as an error.
 * @param {import('discord.js').User|import('discord.js').GuildMember} user
 * @param {import('discord.js').MessageCreateOptions|string} payload
 */
async function safeDm(user, payload) {
  if (!user) return false;
  const result = await attempt(() => user.send(payload), { label: 'safeDm' });
  return Boolean(result);
}

/**
 * Delete a message after a delay, tolerating it already being gone.
 * @param {import('discord.js').Message|null} message
 * @param {number} delayMs
 */
function deleteAfter(message, delayMs) {
  if (!message) return;
  setTimeout(() => {
    attempt(() => message.delete(), { label: 'deleteAfter' });
  }, Math.max(0, delayMs)).unref?.();
}

/**
 * Fetch the most recent audit log entry matching an action and target.
 * Discord populates audit logs asynchronously, so this retries briefly.
 *
 * @param {import('discord.js').Guild} guild
 * @param {number} type AuditLogEvent
 * @param {string|null} targetId
 * @param {{ retries?: number, maxAgeMs?: number }} [options]
 * @returns {Promise<import('discord.js').GuildAuditLogsEntry|null>}
 */
async function fetchAuditEntry(guild, type, targetId = null, { retries = 3, maxAgeMs = 15_000 } = {}) {
  if (!guild?.members?.me?.permissions?.has(PermissionFlagsBits.ViewAuditLog)) return null;

  for (let attemptIndex = 0; attemptIndex < retries; attemptIndex += 1) {
    const logs = await attempt(() => guild.fetchAuditLogs({ type, limit: 6 }), { label: 'fetchAuditLogs' });
    const entry = logs?.entries?.find((candidate) => {
      if (Date.now() - candidate.createdTimestamp > maxAgeMs) return false;
      if (!targetId) return true;
      const target = candidate.target;
      return target?.id === targetId || candidate.extra?.channel?.id === targetId;
    });
    if (entry) return entry;
    if (attemptIndex < retries - 1) await sleep(700);
  }
  return null;
}

/**
 * Delete a collection of Discord objects sequentially with a small delay so a
 * large teardown never trips the global rate limiter.
 *
 * @template T
 * @param {Iterable<T>} items
 * @param {(item: T) => Promise<unknown>} action
 * @param {{ delay?: number, onError?: (item: T, err: Error) => void }} [options]
 * @returns {Promise<{ succeeded: number, failed: Array<{ item: T, error: Error }> }>}
 */
async function sequential(items, action, { delay = BULK_DELAY_MS, onError } = {}) {
  let succeeded = 0;
  const failed = [];
  for (const item of items) {
    try {
      await action(item);
      succeeded += 1;
    } catch (err) {
      failed.push({ item, error: err });
      onError?.(item, err);
    }
    if (delay) await sleep(delay);
  }
  return { succeeded, failed };
}

/**
 * Fetch up to `limit` messages from a channel, paging past Discord's 100-per
 * request cap. Used by the transcript generator and `/purge`.
 *
 * @param {import('discord.js').TextBasedChannel} channel
 * @param {number} limit
 * @returns {Promise<import('discord.js').Message[]>} oldest-first
 */
async function fetchMessages(channel, limit = 500) {
  /** @type {import('discord.js').Message[]} */
  const collected = [];
  let before;

  while (collected.length < limit) {
    const batchSize = Math.min(100, limit - collected.length);
    const batch = await attempt(() => channel.messages.fetch({ limit: batchSize, before }), {
      label: 'fetchMessages',
      fallback: null,
    });
    if (!batch || batch.size === 0) break;
    const messages = [...batch.values()];
    collected.push(...messages);
    before = messages[messages.length - 1].id;
    if (batch.size < batchSize) break;
  }

  return collected.reverse();
}

/** Truncate a string to Discord's channel-name limit and normalise it. */
function toChannelName(value, max = 100) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .slice(0, max);
}

/** Build a jump link for a message. */
const messageLink = (guildId, channelId, messageId) => `https://discord.com/channels/${guildId}/${channelId}/${messageId}`;

/** Build a channel link. */
const channelLink = (guildId, channelId) => `https://discord.com/channels/${guildId}/${channelId}`;

module.exports = {
  attempt,
  sleep,
  safeReply,
  safeDefer,
  safeDeferUpdate,
  fetchMember,
  fetchChannel,
  resolveTextChannel,
  safeSend,
  safeDm,
  deleteAfter,
  fetchAuditEntry,
  sequential,
  fetchMessages,
  toChannelName,
  messageLink,
  channelLink,
};
