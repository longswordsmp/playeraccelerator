'use strict';

/**
 * Per-guild configuration.
 *
 * The document uses `Schema.Types.Mixed` sub-trees deliberately: the shipped
 * defaults in `config/defaults.js` are the schema, and deep-merging them on read
 * means new options roll out to existing guilds automatically without a
 * migration. `markModified` is handled by the helpers below so callers cannot
 * forget it.
 */

const { Schema, model } = require('mongoose');
const { DEFAULT_CONFIG } = require('../../config/defaults');

/**
 * Is this a plain `{}` object, as opposed to a Date, ObjectId, Buffer or any
 * other class instance? Only plain objects are safe to recurse into — anything
 * else is a *value* and must be carried across whole.
 */
function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * Deep clone for configuration trees.
 *
 * Written by hand rather than with `JSON.parse(JSON.stringify(…))`, because
 * that round-trip silently converts every `Date` into a string — and these
 * trees hold real dates (`setup.completedAt`, `status.updatedAt`,
 * `lockdown.startedAt`).
 */
function clone(value) {
  if (value instanceof Date) return new Date(value.getTime());
  if (Array.isArray(value)) return value.map(clone);
  if (!isPlainObject(value)) return value;

  const out = {};
  for (const [key, entry] of Object.entries(value)) out[key] = clone(entry);
  return out;
}

/**
 * Recursively merge `source` over `target` without mutating either.
 *
 * Arrays are replaced wholesale — a configuration list is a value, not a set to
 * union. Dates and other non-plain objects are likewise carried across intact
 * instead of being recursed into, which would flatten them to `{}`.
 */
function deepMerge(target, source) {
  if (source === undefined) return clone(target);
  if (source === null) return null;
  // Anything that is not a plain object is a leaf value.
  if (!isPlainObject(source)) return clone(source);

  const out = isPlainObject(target) ? { ...target } : {};
  for (const [key, value] of Object.entries(source)) {
    out[key] = key in out ? deepMerge(out[key], value) : clone(value);
  }
  return out;
}

const configurationSchema = new Schema(
  {
    guildId: { type: String, required: true, unique: true, index: true },
    guildName: { type: String, default: '' },

    brand: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.brand) },
    theme: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.theme) },

    roles: { type: Schema.Types.Mixed, default: () => ({}) },
    channels: { type: Schema.Types.Mixed, default: () => ({}) },
    categories: { type: Schema.Types.Mixed, default: () => ({}) },
    logChannels: { type: Schema.Types.Mixed, default: () => ({}) },
    panels: { type: Schema.Types.Mixed, default: () => ({}) },
    setup: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.setup) },

    tickets: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.tickets) },
    business: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.business) },
    status: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.status) },
    queue: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.queue) },
    reviews: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.reviews) },
    portfolio: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.portfolio) },
    promotion: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.promotion) },
    announcements: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.announcements) },
    autoRoles: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.autoRoles) },
    welcome: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.welcome) },
    verify: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.verify) },
    referrals: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.referrals) },
    launch: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.launch) },

    moderation: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.moderation) },
    automod: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.automod) },
    links: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.links) },
    antiRaid: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.antiRaid) },
    antiNuke: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.antiNuke) },
    logging: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.logging) },
    security: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.security) },
    lockdown: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.lockdown) },
    backups: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.backups) },
    reports: { type: Schema.Types.Mixed, default: () => clone(DEFAULT_CONFIG.reports) },

    /** Bumped whenever /config writes, so caches can be invalidated cheaply. */
    revision: { type: Number, default: 0 },
  },
  { timestamps: true, minimize: false },
);

/**
 * Fetch (or create) a guild's configuration, deep-merged over the shipped
 * defaults so newly added options are always present.
 * @param {string} guildId
 * @param {string} [guildName]
 * @returns {Promise<import('mongoose').HydratedDocument<any>>}
 */
configurationSchema.statics.resolve = async function resolve(guildId, guildName = '') {
  let doc = await this.findOne({ guildId });
  if (!doc) {
    doc = await this.create({ guildId, guildName, ...clone(DEFAULT_CONFIG) });
    return doc;
  }

  // Backfill any option added since this document was written.
  let changed = false;
  for (const [key, defaults] of Object.entries(DEFAULT_CONFIG)) {
    const merged = deepMerge(clone(defaults), doc[key] ?? {});
    if (JSON.stringify(merged) !== JSON.stringify(doc[key])) {
      doc.set(key, merged);
      doc.markModified(key);
      changed = true;
    }
  }
  if (guildName && doc.guildName !== guildName) {
    doc.guildName = guildName;
    changed = true;
  }
  if (changed) await doc.save();
  return doc;
};

/**
 * Set a value at a dotted path, marking the owning sub-tree modified.
 * @param {string} path e.g. `tickets.maxOpenPerUser`
 * @param {unknown} value
 */
configurationSchema.methods.setPath = function setPath(path, value) {
  const [root] = path.split('.');
  this.set(path, value);
  this.markModified(root);
  this.revision += 1;
  return this;
};

/**
 * Read a value at a dotted path with a fallback.
 * @param {string} path
 * @param {unknown} [fallback]
 */
configurationSchema.methods.getPath = function getPath(path, fallback = undefined) {
  const value = path.split('.').reduce((acc, key) => (acc === null || acc === undefined ? acc : acc[key]), this.toObject());
  return value === undefined ? fallback : value;
};

/** Reset a whole configuration section back to its shipped defaults. */
configurationSchema.methods.resetSection = function resetSection(section) {
  if (!(section in DEFAULT_CONFIG)) return false;
  this.set(section, clone(DEFAULT_CONFIG[section]));
  this.markModified(section);
  this.revision += 1;
  return true;
};

module.exports = model('Configuration', configurationSchema);
module.exports.deepMerge = deepMerge;
