'use strict';

/**
 * Promotion partnership application.
 *
 * Applications are reviewed individually — the model records the full
 * submission, the decision, who made it and the internal reasoning, so a
 * declined applicant can always be given a straight answer.
 */

const { Schema, model } = require('mongoose');

const promotionSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true },
    number: { type: Number, required: true },

    // ── Applicant ───────────────────────────────────────────────────────────
    userId: { type: String, required: true, index: true },
    username: { type: String, default: '' },
    ticketId: { type: Schema.Types.ObjectId, ref: 'Ticket', default: null },
    ticketNumber: { type: Number, default: null },

    // ── Submission ──────────────────────────────────────────────────────────
    serverName: { type: String, required: true, maxlength: 120 },
    serverIp: { type: String, default: '' },
    version: { type: String, default: '' },
    description: { type: String, default: '', maxlength: 2000 },
    features: { type: String, default: '', maxlength: 1500 },
    playerCount: { type: Number, default: null },
    website: { type: String, default: '' },
    discordInvite: { type: String, default: '' },
    trailerUrl: { type: String, default: '' },
    screenshots: [{ type: String }],
    pitch: { type: String, default: '', maxlength: 1500 },
    additional: { type: String, default: '', maxlength: 1000 },

    // ── Review ──────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ['pending', 'reviewing', 'changes-requested', 'approved', 'declined', 'archived'],
      default: 'pending',
      index: true,
    },
    decisionBy: { type: String, default: '' },
    decisionByName: { type: String, default: '' },
    decisionAt: { type: Date, default: null },
    decisionReason: { type: String, default: '', maxlength: 1000 },

    /** Internal notes — never shown to the applicant. */
    staffNotes: [
      {
        content: { type: String, required: true, maxlength: 1000 },
        authorId: String,
        authorName: String,
        createdAt: { type: Date, default: Date.now },
      },
    ],

    /** Set once the promotion has actually run. */
    promoted: { type: Boolean, default: false },
    promotedAt: { type: Date, default: null },
    promotionNotes: { type: String, default: '' },

    reviewMessageId: { type: String, default: '' },
    reviewChannelId: { type: String, default: '' },
  },
  { timestamps: true },
);

promotionSchema.index({ guildId: 1, number: 1 }, { unique: true });
promotionSchema.index({ guildId: 1, status: 1, createdAt: -1 });

promotionSchema.virtual('display').get(function display() {
  return `#${String(this.number).padStart(3, '0')}`;
});

/** Applications awaiting a decision. */
promotionSchema.statics.pending = function pending(guildId, limit = 25) {
  return this.find({ guildId, status: { $in: ['pending', 'reviewing', 'changes-requested'] } })
    .sort({ createdAt: 1 })
    .limit(limit)
    .lean();
};

module.exports = model('Promotion', promotionSchema);
