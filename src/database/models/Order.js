'use strict';

/**
 * Order / project record.
 *
 * Orders are the business object; tickets are the conversation around them.
 * The queue, the pipeline dashboards, revenue reporting and delivery estimates
 * all read from this collection.
 */

const { Schema, model } = require('mongoose');

const orderSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true },
    number: { type: Number, required: true },

    // ── Customer ────────────────────────────────────────────────────────────
    userId: { type: String, required: true, index: true },
    username: { type: String, default: '' },
    ticketId: { type: Schema.Types.ObjectId, ref: 'Ticket', default: null },
    ticketNumber: { type: Number, default: null },
    channelId: { type: String, default: '' },

    // ── Brief ───────────────────────────────────────────────────────────────
    title: { type: String, required: true, maxlength: 200 },
    serviceType: { type: String, required: true, index: true },
    description: { type: String, default: '', maxlength: 4000 },
    requirements: { type: String, default: '', maxlength: 2000 },
    references: [{ type: String }],
    contactMethod: { type: String, default: '' },
    notes: { type: String, default: '', maxlength: 2000 },

    // ── Commercials ─────────────────────────────────────────────────────────
    budget: {
      raw: { type: String, default: '' },
      amount: { type: Number, default: null },
    },
    quote: {
      amount: { type: Number, default: null },
      currency: { type: String, default: 'USD' },
      sentAt: { type: Date, default: null },
      acceptedAt: { type: Date, default: null },
      quotedBy: { type: String, default: '' },
    },
    payment: {
      deposit: { type: Number, default: 0 },
      paid: { type: Number, default: 0 },
      method: { type: String, default: '' },
      paidInFull: { type: Boolean, default: false },
      paidAt: { type: Date, default: null },
    },
    /** Free portfolio commissions are tracked but never billed. */
    isFreeCommission: { type: Boolean, default: false },

    // ── Delivery ────────────────────────────────────────────────────────────
    status: {
      type: String,
      enum: ['pending', 'quoted', 'accepted', 'queued', 'in-progress', 'review', 'delivered', 'completed', 'paused', 'cancelled'],
      default: 'pending',
      index: true,
    },
    /** Position in the delivery queue; lower runs first. */
    queuePosition: { type: Number, default: null, index: true },
    priority: { type: String, enum: ['low', 'normal', 'high', 'urgent'], default: 'normal' },
    progress: { type: Number, default: 0, min: 0, max: 100 },

    assignedTo: { type: String, default: null, index: true },
    assignedName: { type: String, default: '' },

    requestedDeadline: { type: String, default: '' },
    estimatedStart: { type: Date, default: null },
    estimatedDelivery: { type: Date, default: null },
    startedAt: { type: Date, default: null },
    deliveredAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    cancelledAt: { type: Date, default: null },
    cancelReason: { type: String, default: '' },
    /** Hours from start to completion. */
    completionHours: { type: Number, default: null },

    revisions: { type: Number, default: 0 },
    revisionLimit: { type: Number, default: 2 },

    // ── Post-delivery ───────────────────────────────────────────────────────
    reviewId: { type: Schema.Types.ObjectId, ref: 'Review', default: null },
    portfolioId: { type: Schema.Types.ObjectId, ref: 'Portfolio', default: null },
    portfolioPermission: { type: Boolean, default: false },

    /** Append-only audit of status transitions. */
    history: [
      {
        status: String,
        at: { type: Date, default: Date.now },
        byId: String,
        byName: String,
        note: String,
      },
    ],
  },
  { timestamps: true },
);

orderSchema.index({ guildId: 1, number: 1 }, { unique: true });
orderSchema.index({ guildId: 1, status: 1, queuePosition: 1 });
orderSchema.index({ guildId: 1, userId: 1, createdAt: -1 });
orderSchema.index({ guildId: 1, assignedTo: 1, status: 1 });

orderSchema.virtual('display').get(function display() {
  return `#${String(this.number).padStart(4, '0')}`;
});

/** Statuses that occupy a slot in the delivery queue. */
orderSchema.statics.ACTIVE_STATUSES = ['accepted', 'queued', 'in-progress', 'review'];

/**
 * Move the order to a new status, recording who did it.
 * @param {string} status
 * @param {{ id?: string, name?: string }} actor
 * @param {string} [note]
 */
orderSchema.methods.transition = function transition(status, actor = {}, note = '') {
  const now = new Date();
  this.status = status;
  this.history.push({ status, at: now, byId: actor.id ?? '', byName: actor.name ?? '', note });
  if (this.history.length > 100) this.history.shift();

  if (status === 'in-progress' && !this.startedAt) this.startedAt = now;
  if (status === 'delivered' && !this.deliveredAt) this.deliveredAt = now;
  if (status === 'completed') {
    this.completedAt = now;
    this.progress = 100;
    this.queuePosition = null;
    if (this.startedAt) this.completionHours = Math.round(((now - this.startedAt) / 3_600_000) * 10) / 10;
  }
  if (status === 'cancelled') {
    this.cancelledAt = now;
    this.queuePosition = null;
  }
  return this;
};

/** Orders currently occupying the queue, in running order. */
orderSchema.statics.queue = function queue(guildId) {
  return this.find({ guildId, status: { $in: this.ACTIVE_STATUSES } })
    .sort({ queuePosition: 1, createdAt: 1 })
    .lean();
};

module.exports = model('Order', orderSchema);
