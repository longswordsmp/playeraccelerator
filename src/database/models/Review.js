'use strict';

/**
 * Customer review.
 *
 * Reviews are immutable once published — staff can hide or feature them, but
 * the written content is never edited, which is what makes the reviews channel
 * worth reading.
 */

const { Schema, model } = require('mongoose');

const reviewSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true },
    number: { type: Number, required: true },

    // ── Subject ─────────────────────────────────────────────────────────────
    userId: { type: String, required: true, index: true },
    username: { type: String, default: '' },
    avatar: { type: String, default: '' },

    ticketId: { type: Schema.Types.ObjectId, ref: 'Ticket', default: null },
    ticketNumber: { type: Number, default: null },
    orderId: { type: Schema.Types.ObjectId, ref: 'Order', default: null },
    orderNumber: { type: Number, default: null },

    serviceType: { type: String, default: '', index: true },
    serviceLabel: { type: String, default: '' },

    /** Staff member credited with the delivery. */
    staffId: { type: String, default: null, index: true },
    staffName: { type: String, default: '' },

    // ── Content ─────────────────────────────────────────────────────────────
    rating: { type: Number, required: true, min: 1, max: 5, index: true },
    feedback: { type: String, default: '', maxlength: 2000 },
    liked: { type: String, default: '', maxlength: 1000 },
    improvements: { type: String, default: '', maxlength: 1000 },
    recommend: { type: String, default: '', maxlength: 200 },
    additional: { type: String, default: '', maxlength: 1000 },

    // ── Publication state ───────────────────────────────────────────────────
    approved: { type: Boolean, default: true, index: true },
    approvedBy: { type: String, default: '' },
    approvedAt: { type: Date, default: null },
    rejected: { type: Boolean, default: false },
    rejectReason: { type: String, default: '' },
    hidden: { type: Boolean, default: false },
    featured: { type: Boolean, default: false, index: true },
    featuredAt: { type: Date, default: null },
    featuredBy: { type: String, default: '' },

    /** Where the review was published, so it can be edited or removed later. */
    publishedChannelId: { type: String, default: '' },
    publishedMessageId: { type: String, default: '' },
    publishedAt: { type: Date, default: null },
    pinned: { type: Boolean, default: false },

    /** Hours from order start to completion, captured at review time. */
    completionHours: { type: Number, default: null },
    completedAt: { type: Date, default: null },
  },
  { timestamps: true },
);

reviewSchema.index({ guildId: 1, number: 1 }, { unique: true });
reviewSchema.index({ guildId: 1, approved: 1, hidden: 1, createdAt: -1 });
reviewSchema.index({ guildId: 1, staffId: 1, rating: -1 });

reviewSchema.virtual('display').get(function display() {
  return `#${String(this.number).padStart(4, '0')}`;
});

/** Whether this review is visible on public surfaces. */
reviewSchema.virtual('isPublic').get(function isPublic() {
  return this.approved && !this.hidden && !this.rejected;
});

/**
 * Aggregate review statistics for a guild, optionally scoped to a staff member
 * or a service type.
 * @param {string} guildId
 * @param {{ staffId?: string, serviceType?: string, since?: Date }} [filters]
 */
reviewSchema.statics.summary = async function summary(guildId, filters = {}) {
  const match = { guildId, approved: true, hidden: false, rejected: false };
  if (filters.staffId) match.staffId = filters.staffId;
  if (filters.serviceType) match.serviceType = filters.serviceType;
  if (filters.since) match.createdAt = { $gte: filters.since };

  const [result] = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        total: { $sum: 1 },
        average: { $avg: '$rating' },
        fiveStar: { $sum: { $cond: [{ $eq: ['$rating', 5] }, 1, 0] } },
        fourStar: { $sum: { $cond: [{ $eq: ['$rating', 4] }, 1, 0] } },
        threeStar: { $sum: { $cond: [{ $eq: ['$rating', 3] }, 1, 0] } },
        twoStar: { $sum: { $cond: [{ $eq: ['$rating', 2] }, 1, 0] } },
        oneStar: { $sum: { $cond: [{ $eq: ['$rating', 1] }, 1, 0] } },
        positive: { $sum: { $cond: [{ $gte: ['$rating', 4] }, 1, 0] } },
        negative: { $sum: { $cond: [{ $lte: ['$rating', 2] }, 1, 0] } },
      },
    },
  ]);

  return {
    total: result?.total ?? 0,
    average: result?.average ? Math.round(result.average * 100) / 100 : 0,
    distribution: {
      5: result?.fiveStar ?? 0,
      4: result?.fourStar ?? 0,
      3: result?.threeStar ?? 0,
      2: result?.twoStar ?? 0,
      1: result?.oneStar ?? 0,
    },
    positive: result?.positive ?? 0,
    negative: result?.negative ?? 0,
  };
};

/** Most reviewed service types, highest first. */
reviewSchema.statics.topServices = function topServices(guildId, limit = 5) {
  return this.aggregate([
    { $match: { guildId, approved: true, hidden: false } },
    { $group: { _id: '$serviceType', count: { $sum: 1 }, average: { $avg: '$rating' } } },
    { $sort: { count: -1 } },
    { $limit: limit },
  ]);
};

module.exports = model('Review', reviewSchema);
