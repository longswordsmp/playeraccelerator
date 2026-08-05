'use strict';

/**
 * Guild configuration access with a write-through cache.
 *
 * Every command, event and security module reads configuration on the hot path,
 * so hitting MongoDB each time would be wasteful. Documents are cached per guild
 * and invalidated on write; the cache also expires on a TTL so a change made by
 * another shard/process is picked up within a minute.
 */

const { Configuration } = require('../database/models');
const { logger } = require('../utils/logger');
const { registry } = require('../utils/rateLimiter');

const log = logger.child('config');

/** Cache TTL — short enough for multi-process deployments to converge. */
const TTL_MS = 60_000;

/** @type {Map<string, { doc: any, expiresAt: number }>} */
const cache = new Map();

// Sweep expired entries so long-lived processes never accumulate dead guilds.
registry.register({
  prune() {
    const now = Date.now();
    for (const [guildId, entry] of cache) {
      if (entry.expiresAt <= now) cache.delete(guildId);
    }
  },
});

/**
 * Fetch a guild's configuration, creating it on first use.
 * @param {import('discord.js').Guild|string} guild
 * @param {{ fresh?: boolean }} [options]
 * @returns {Promise<import('mongoose').HydratedDocument<any>>}
 */
async function get(guild, { fresh = false } = {}) {
  const guildId = typeof guild === 'string' ? guild : guild.id;
  const guildName = typeof guild === 'string' ? '' : guild.name;

  if (!fresh) {
    const cached = cache.get(guildId);
    if (cached && cached.expiresAt > Date.now()) return cached.doc;
  }

  const doc = await Configuration.resolve(guildId, guildName);
  cache.set(guildId, { doc, expiresAt: Date.now() + TTL_MS });
  return doc;
}

/**
 * Persist a configuration document and refresh the cache.
 * @param {import('mongoose').HydratedDocument<any>} doc
 */
async function save(doc) {
  await doc.save();
  cache.set(doc.guildId, { doc, expiresAt: Date.now() + TTL_MS });
  return doc;
}

/**
 * Apply a mutation to a guild's configuration and save it.
 *
 * @param {import('discord.js').Guild|string} guild
 * @param {(config: import('mongoose').HydratedDocument<any>) => void|Promise<void>} mutator
 * @returns {Promise<import('mongoose').HydratedDocument<any>>}
 */
async function update(guild, mutator) {
  const doc = await get(guild, { fresh: true });
  await mutator(doc);
  return save(doc);
}

/**
 * Set one or more dotted paths in a single write.
 * @param {import('discord.js').Guild|string} guild
 * @param {Record<string, unknown>} values
 */
function setPaths(guild, values) {
  return update(guild, (config) => {
    for (const [path, value] of Object.entries(values)) config.setPath(path, value);
  });
}

/** Drop a guild from the cache (used after `/setup` rewires everything). */
function invalidate(guildId) {
  cache.delete(typeof guildId === 'string' ? guildId : guildId?.id);
}

/** Drop the whole cache. */
function invalidateAll() {
  cache.clear();
  log.debug('Configuration cache cleared.');
}

/**
 * Resolve a configured channel id to a live channel object.
 * @param {import('discord.js').Guild} guild
 * @param {object} config
 * @param {string} key channel key from the server blueprint
 * @returns {import('discord.js').GuildBasedChannel|null}
 */
function channel(guild, config, key) {
  const id = config?.channels?.[key];
  return id ? guild.channels.cache.get(id) ?? null : null;
}

/**
 * Resolve a configured log destination.
 * @param {import('discord.js').Guild} guild
 * @param {object} config
 * @param {string} logKey `ticket` | `audit` | `moderation` | `bot` | `security` | `report` | `business`
 */
function logChannel(guild, config, logKey) {
  const id = config?.logChannels?.[logKey];
  return id ? guild.channels.cache.get(id) ?? null : null;
}

/**
 * Resolve a configured role.
 * @param {import('discord.js').Guild} guild
 * @param {object} config
 * @param {string} key role key from the server blueprint
 */
function role(guild, config, key) {
  const id = config?.roles?.[key];
  return id ? guild.roles.cache.get(id) ?? null : null;
}

/** Whether `/setup` has completed for this guild. */
const isConfigured = (config) => Boolean(config?.setup?.completed);

/** Cache statistics for the diagnostics command. */
const stats = () => ({ cachedGuilds: cache.size, ttlMs: TTL_MS });

module.exports = { get, save, update, setPaths, invalidate, invalidateAll, channel, logChannel, role, isConfigured, stats };
