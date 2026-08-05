'use strict';

/**
 * Ticket record — the spine of the support platform.
 *
 * Every ticket carries its own SLA telemetry (first response, response times,
 * lifetime) so staff performance and customer satisfaction can be reported on
 * without reconstructing anything from Discord message history.
 */

const { Schema, model } = require('mongoose');

const noteSchema = new Schema(
  {
    content: { type: String, required: true, maxlength: 2000 },
    authorId: { type: String, required: true },
    authorName: { type: String, default: '' },
    internal: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
);

const ticketSchema = new Schema(
  {
    // ── Identity ────────────────────────────────────────────────────────────
    guildId: { type: String, required: true, index: true },
    /** Sequential, human-quotable number: "Ticket #0042". */
    number: { type: Number, required: true },
    channelId: { type: String, default: '', index: true },
    /** Retained after the channel is deleted, for transcript lookups. */
    channelName: { type: String, default: '' },
    panelMessageId: { type: String, default: '' },

    // ── Participants ────────────────────────────────────────────────────────
    userId: { type: String, required: true, index: true },
    username: { type: String, default: '' },
    /** Extra members explicitly added to the ticket. */
    participants: [{ type: String }],

    assignedTo: { type: String, default: null, index: true },
    assignedName: { type: String, default: '' },
    claimedAt: { type: Date, default: null },
    /** Every staff member who has ever been assigned, for auditing transfers. */
    assignmentHistory: [
      {
        staffId: String,
        staffName: String,
        assignedAt: { type: Date, default: Date.now },
        releasedAt: Date,
        transferredBy: String,
      },
    ],

    // ── Classification ──────────────────────────────────────────────────────
    type: { type: String, required: true, index: true },
    typeLabel: { type: String, default: '' },
    priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal', index: true },
    tags: [{ type: String }],
    subject: { type: String, default: '' },

    status: {
      type: String,
      enum: ['open', 'claimed', 'pending', 'closed', 'archived', 'deleted'],
      default: 'open',
      index: true,
    },

    // ── Submitted form payload (shape varies by ticket type) ────────────────
    form: { type: Schema.Types.Mixed, default: () => ({}) },
    /** Linked order, when the ticket produced one. */
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
    orderNumber: { type: Number, default: null },

    // ── SLA telemetry ───────────────────────────────────────────────────────
    createdAt: { type: Date, default: Date.now, index: true },
    firstStaffReplyAt: { type: Date, default: null },
    /** Minutes between creation and the first staff message. */
    firstResponseMinutes: { type: Number, default: null },
    lastMessageAt: { type: Date, default: Date.now },
    lastStaffMessageAt: { type: Date, default: null },
    lastCustomerMessageAt: { type: Date, default: null },
    /** Rolling sample of staff reply latencies, in minutes. */
    responseSamples: [{ type: Number }],
    averageResponseMinutes: { type: Number, default: null },
    messageCount: { type: Number, default: 0 },

    closedAt: { type: Date, default: null },
    closedBy: { type: String, default: null },
    closedByName: { type: String, default: '' },
    closeReason: { type: String, default: '' },
    /** Minutes from creation to close. */
    durationMinutes: { type: Number, default: null },
    reopenCount: { type: Number, default: 0 },
    reopenedAt: { type: Date, default: null },

    // ── Artefacts ───────────────────────────────────────────────────────────
    transcript: {
      generated: { type: Boolean, default: false },
      htmlPath: { type: String, default: '' },
      markdownPath: { type: String, default: '' },
      url: { type: String, default: '' },
      messageCount: { type: Number, default: 0 },
      generatedAt: { type: Date, default: null },
    },

    review: {
      requested: { type: Boolean, default: false },
      requestedAt: { type: Date, default: null },
      submitted: { type: Boolean, default: false },
      reviewId: { type: Schema.Types.ObjectId, ref: 'Review', default: null },
      rating: { type: Number, default: null },
    },

    notes: [noteSchema],

    /** Set when the ticket is archived rather than deleted. */
    archivedAt: { type: Date, default: null },
    /** Scheduled hard-delete time for archived tickets. */
    purgeAt: { type: Date, default: null },
  },
  { timestamps: true },
);

ticketSchema.index({ guildId: 1, number: 1 }, { unique: true });
ticketSchema.index({ guildId: 1, status: 1, createdAt: -1 });
ticketSchema.index({ guildId: 1, userId: 1, status: 1 });
ticketSchema.index({ guildId: 1, assignedTo: 1, status: 1 });
ticketSchema.index({ purgeAt: 1 }, { sparse: true });

/** Display id used everywhere in the UI. */
ticketSchema.virtual('display').get(function display() {
  return `#${String(this.number).padStart(4, '0')}`;
});

/** Whether the ticket is currently actionable. */
ticketSchema.virtual('isOpen').get(function isOpen() {
  return ['open', 'claimed', 'pending'].includes(this.status);
});

/**
 * Record a staff reply and update SLA telemetry.
 * @param {Date} at
 */
ticketSchema.methods.recordStaffReply = function recordStaffReply(at = new Date()) {
  if (!this.firstStaffReplyAt) {
    this.firstStaffReplyAt = at;
    this.firstResponseMinutes = Math.max(0, Math.round((at - this.createdAt) / 60_000));
  } else if (this.lastCustomerMessageAt && this.lastCustomerMessageAt > (this.lastStaffMessageAt ?? 0)) {
    // Latency for this specific customer question.
    const latency = Math.max(0, Math.round((at - this.lastCustomerMessageAt) / 60_000));
    this.responseSamples.push(latency);
    if (this.responseSamples.length > 50) this.responseSamples.shift();
    const total = this.responseSamples.reduce((sum, value) => sum + value, 0);
    this.averageResponseMinutes = Math.round(total / this.responseSamples.length);
  }
  this.lastStaffMessageAt = at;
  this.lastMessageAt = at;
  return this;
};

/** Record a customer message. */
ticketSchema.methods.recordCustomerMessage = function recordCustomerMessage(at = new Date()) {
  this.lastCustomerMessageAt = at;
  this.lastMessageAt = at;
  return this;
};

/** Count a member's currently open tickets. */
ticketSchema.statics.countOpenFor = function countOpenFor(guildId, userId) {
  return this.countDocuments({ guildId, userId, status: { $in: ['open', 'claimed', 'pending'] } });
};

/** Fetch a ticket by its channel. */
ticketSchema.statics.byChannel = function byChannel(guildId, channelId) {
  return this.findOne({ guildId, channelId });
};

module.exports = model('Ticket', ticketSchema);
