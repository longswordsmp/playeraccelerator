'use strict';

/**
 * Persistent event log.
 *
 * Channel logs are for humans reading in real time; this collection is for
 * investigations after the fact. Entries expire automatically via a TTL index
 * so the collection never grows without bound.
 */

const { Schema, model } = require('mongoose');

const logSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true },

    /** Broad channel: message | member | channel | role | moderation | security | ticket | order | review | command | error | system */
    category: { type: String, required: true, index: true },
    /** Specific event, e.g. `messageDelete`, `ticketClose`, `antinuke.channelDelete`. */
    event: { type: String, required: true, index: true },

    /** Who caused it. */
    actorId: { type: String, default: '' },
    actorName: { type: String, default: '' },
    /** What it happened to. */
    targetId: { type: String, default: '' },
    targetName: { type: String, default: '' },

    channelId: { type: String, default: '' },
    messageId: { type: String, default: '' },

    summary: { type: String, default: '', maxlength: 500 },
    /** Structured payload — searchable, but never used for query keys. */
    details: { type: Schema.Types.Mixed, default: () => ({}) },

    severity: { type: String, enum: ['debug', 'info', 'warn', 'error', 'critical'], default: 'info', index: true },

    createdAt: { type: Date, default: Date.now, index: true },
    /** TTL anchor; defaults to 90 days from creation. */
    expiresAt: { type: Date, default: () => new Date(Date.now() + 90 * 86_400_000) },
  },
  { versionKey: false },
);

logSchema.index({ guildId: 1, category: 1, createdAt: -1 });
logSchema.index({ guildId: 1, actorId: 1, createdAt: -1 });
logSchema.index({ guildId: 1, event: 1, createdAt: -1 });
/** MongoDB removes documents once `expiresAt` passes. */
logSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

/**
 * Write an entry. Never throws — logging must not be able to break a feature.
 * @param {object} entry
 */
logSchema.statics.record = async function record(entry) {
  try {
    // Critical events are retained for a year; routine noise for 90 days.
    const retentionDays = ['error', 'critical'].includes(entry.severity) ? 365 : 90;
    await this.create({ ...entry, expiresAt: new Date(Date.now() + retentionDays * 86_400_000) });
  } catch {
    /* swallowed by design */
  }
};

/** Recent entries for an investigation surface. */
logSchema.statics.recent = function recent(guildId, { category, event, actorId, limit = 25 } = {}) {
  const query = { guildId };
  if (category) query.category = category;
  if (event) query.event = event;
  if (actorId) query.actorId = actorId;
  return this.find(query).sort({ createdAt: -1 }).limit(Math.min(100, limit)).lean();
};

module.exports = model('Log', logSchema);
