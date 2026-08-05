'use strict';

/**
 * Server structure snapshot.
 *
 * Stores the guild's roles, categories, channels, permission overwrites and bot
 * configuration so a destroyed structure can be rebuilt.
 *
 * Discord API limitation: message history, attachments, member roles-at-time,
 * audit log history and emoji/sticker binaries cannot be restored by a bot.
 * A snapshot restores *structure*, never *content*. This is stated plainly in
 * the restore confirmation so nobody is misled.
 */

const { Schema, model } = require('mongoose');

const backupSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true },
    guildName: { type: String, default: '' },

    /** Short human-quotable id, e.g. `A1B2C3`. */
    code: { type: String, required: true, index: true },
    label: { type: String, default: '' },

    trigger: { type: String, enum: ['manual', 'scheduled', 'pre-setup', 'pre-restore', 'incident'], default: 'manual' },
    createdBy: { type: String, default: '' },
    createdByName: { type: String, default: '' },

    /** Counts surfaced in the backup list without loading the payload. */
    summary: {
      roles: { type: Number, default: 0 },
      categories: { type: Number, default: 0 },
      textChannels: { type: Number, default: 0 },
      voiceChannels: { type: Number, default: 0 },
      overwrites: { type: Number, default: 0 },
    },

    /** Full structural snapshot. */
    payload: { type: Schema.Types.Mixed, default: () => ({}) },
    /** Path to the on-disk JSON copy. */
    filePath: { type: String, default: '' },
    sizeBytes: { type: Number, default: 0 },

    restoredAt: { type: Date, default: null },
    restoredBy: { type: String, default: '' },
  },
  { timestamps: true },
);

backupSchema.index({ guildId: 1, createdAt: -1 });
backupSchema.index({ guildId: 1, code: 1 }, { unique: true });

/** Most recent snapshots for a guild. */
backupSchema.statics.list = function list(guildId, limit = 15) {
  return this.find({ guildId }).select('-payload').sort({ createdAt: -1 }).limit(limit).lean();
};

module.exports = model('Backup', backupSchema);
