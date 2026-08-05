'use strict';

/**
 * Moderation case record.
 *
 * One document per action — warn, timeout, kick, ban, note, automod hit. Cases
 * are never deleted, only revoked, so the history is a genuine audit trail.
 */

const { Schema, model } = require('mongoose');

const moderationSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true },
    /** Sequential per-guild case number. */
    caseId: { type: Number, required: true },

    type: {
      type: String,
      required: true,
      enum: ['warn', 'unwarn', 'mute', 'unmute', 'timeout', 'untimeout', 'kick', 'ban', 'unban', 'softban', 'note', 'purge', 'automod', 'lockdown', 'antinuke', 'antiraid'],
      index: true,
    },

    userId: { type: String, required: true, index: true },
    username: { type: String, default: '' },

    moderatorId: { type: String, required: true },
    moderatorName: { type: String, default: '' },
    /** True when the action was taken by an automated system. */
    automated: { type: Boolean, default: false },
    /** Which automod module or security system produced this case. */
    source: { type: String, default: '' },

    reason: { type: String, default: 'No reason provided', maxlength: 1000 },
    evidence: [{ type: String }],
    /** Snapshot of the offending content, for automod cases. */
    context: {
      channelId: { type: String, default: '' },
      messageId: { type: String, default: '' },
      content: { type: String, default: '', maxlength: 1000 },
    },

    /** Duration in milliseconds for timed punishments. */
    duration: { type: Number, default: null },
    expiresAt: { type: Date, default: null, index: true },

    active: { type: Boolean, default: true, index: true },
    revoked: { type: Boolean, default: false },
    revokedBy: { type: String, default: '' },
    revokedAt: { type: Date, default: null },
    revokeReason: { type: String, default: '' },

    /** Set when this case was produced by warning escalation. */
    escalatedFrom: { type: Number, default: null },
  },
  { timestamps: true },
);

moderationSchema.index({ guildId: 1, caseId: 1 }, { unique: true });
moderationSchema.index({ guildId: 1, userId: 1, type: 1, active: 1 });
moderationSchema.index({ guildId: 1, createdAt: -1 });
moderationSchema.index({ expiresAt: 1, active: 1 }, { sparse: true });

/**
 * Count a member's active (non-expired, non-revoked) warnings.
 * @param {string} guildId
 * @param {string} userId
 * @param {number} [expiryDays] warnings older than this no longer count
 */
moderationSchema.statics.activeWarnings = function activeWarnings(guildId, userId, expiryDays = 0) {
  const query = { guildId, userId, type: 'warn', active: true, revoked: false };
  if (expiryDays > 0) {
    query.createdAt = { $gte: new Date(Date.now() - expiryDays * 86_400_000) };
  }
  return this.countDocuments(query);
};

/** Full case history for a member, newest first. */
moderationSchema.statics.historyFor = function historyFor(guildId, userId, limit = 25) {
  return this.find({ guildId, userId }).sort({ createdAt: -1 }).limit(limit).lean();
};

/** Punishments whose duration has elapsed and that need lifting. */
moderationSchema.statics.dueForExpiry = function dueForExpiry() {
  return this.find({ active: true, revoked: false, expiresAt: { $ne: null, $lte: new Date() } }).limit(100);
};

/** Moderation volume for a guild over a window, grouped by type. */
moderationSchema.statics.volume = function volume(guildId, since) {
  return this.aggregate([
    { $match: { guildId, createdAt: { $gte: since } } },
    { $group: { _id: '$type', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
};

module.exports = model('Moderation', moderationSchema);
