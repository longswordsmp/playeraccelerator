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
const { DEFAULT_CONFIG } = require('../config/defaults');

const { clone } = Configuration;
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

/**
 * Sections `applyProfile` must never overwrite.
 *
 * The first six are the wiring `/setup` produced — role ids, channel ids, the
 * message ids of every published panel. Resetting them would orphan the entire
 * server: the bot would forget which channel is which and every panel would be
 * republished as a duplicate. `launch` is here because closing a live, publicly
 * announced promotion as a side effect of a config tidy-up would be worse than
 * leaving it slightly stale.
 */
const PRESERVED = Object.freeze([
  'roles', 'channels', 'categories', 'logChannels', 'panels', 'setup', 'launch',
]);

/**
 * Bring one configuration document to the studio profile, in memory.
 *
 * Shared by `/config apply` and `npm run configure` so the two can never drift.
 * It takes a document rather than a guild id and writes nothing, which also
 * makes it testable without a database — Mongoose hydrates, sets and marks
 * documents entirely offline, so the dangerous part (never clobbering the
 * wiring) is provable rather than hoped for.
 *
 * @param {import('mongoose').HydratedDocument<any>} config
 * @param {{ timezone: string, hours: object, outOfHoursMessage: string, scheduleOnly?: boolean }} profile
 * @returns {{ changed: string[] }} the sections whose contents actually differ
 */
function applyProfile(config, { timezone, hours, outOfHoursMessage, scheduleOnly = false }) {
  const before = {};
  for (const section of Object.keys(DEFAULT_CONFIG)) {
    before[section] = JSON.stringify(config[section] ?? null);
  }

  // 1. Reset everything that is not wiring back to the shipped defaults.
  if (!scheduleOnly) {
    for (const section of Object.keys(DEFAULT_CONFIG)) {
      if (PRESERVED.includes(section)) continue;
      config.set(section, clone(DEFAULT_CONFIG[section]));
      config.markModified(section);
    }
  }

  // 2. Overlay the operating schedule — the part that is genuinely this
  //    studio's rather than a shipped default.
  config.setPath('business.timezone', timezone);
  config.setPath('business.hours', hours);
  config.setPath('business.outOfHoursMessage', outOfHoursMessage);
  config.setPath('status.autoFromHours', true);
  config.setPath('status.auto', true);

  // 3. Point the verification gate back at the role /setup created. Step 1
  //    blanked `verify.roleId`, and the id itself lives in the preserved
  //    `roles` section — without this the gate would have nothing to grant and
  //    every verify press would fail.
  const verifiedRole = config.roles?.verified;
  if (verifiedRole) config.setPath('verify.roleId', verifiedRole);

  const changed = Object.keys(DEFAULT_CONFIG)
    .filter((section) => before[section] !== JSON.stringify(config[section] ?? null));

  return { changed };
}

module.exports = { get, save, update, setPaths, invalidate, invalidateAll, channel, logChannel, role, isConfigured, stats, applyProfile, PRESERVED };
