'use strict';

/**
 * Staff performance record.
 *
 * Denormalised counters updated by the ticket, order and moderation services.
 * Leaderboards read one small document per staff member rather than
 * aggregating the whole ticket collection on every command.
 */

const { Schema, model } = require('mongoose');

const staffStatsSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true },
    userId: { type: String, required: true, index: true },
    username: { type: String, default: '' },

    tickets: {
      claimed: { type: Number, default: 0 },
      closed: { type: Number, default: 0 },
      transferredIn: { type: Number, default: 0 },
      transferredOut: { type: Number, default: 0 },
      reopened: { type: Number, default: 0 },
    },

    orders: {
      assigned: { type: Number, default: 0 },
      completed: { type: Number, default: 0 },
      cancelled: { type: Number, default: 0 },
      revenue: { type: Number, default: 0 },
    },

    responses: {
      /** Rolling samples in minutes; capped so the document stays small. */
      firstResponseSamples: [{ type: Number }],
      averageFirstResponseMinutes: { type: Number, default: null },
      averageResponseMinutes: { type: Number, default: null },
      averageResolutionMinutes: { type: Number, default: null },
      resolutionSamples: [{ type: Number }],
    },

    reviews: {
      count: { type: Number, default: 0 },
      ratingSum: { type: Number, default: 0 },
      average: { type: Number, default: 0 },
      fiveStar: { type: Number, default: 0 },
    },

    moderation: {
      warningsIssued: { type: Number, default: 0 },
      timeoutsIssued: { type: Number, default: 0 },
      kicksIssued: { type: Number, default: 0 },
      bansIssued: { type: Number, default: 0 },
      reportsHandled: { type: Number, default: 0 },
      messagesPurged: { type: Number, default: 0 },
    },

    activity: {
      commandsUsed: { type: Number, default: 0 },
      lastActiveAt: { type: Date, default: Date.now },
      firstSeenAt: { type: Date, default: Date.now },
    },
  },
  { timestamps: true },
);

staffStatsSchema.index({ guildId: 1, userId: 1 }, { unique: true });
staffStatsSchema.index({ guildId: 1, 'tickets.closed': -1 });
staffStatsSchema.index({ guildId: 1, 'reviews.average': -1 });

/**
 * Fetch or create a staff record.
 * @param {string} guildId
 * @param {string} userId
 * @param {string} [username]
 */
staffStatsSchema.statics.resolve = function resolve(guildId, userId, username = '') {
  return this.findOneAndUpdate(
    { guildId, userId },
    {
      $set: { ...(username ? { username } : {}), 'activity.lastActiveAt': new Date() },
      $setOnInsert: { guildId, userId, 'activity.firstSeenAt': new Date() },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
};

/** Increment counters atomically. */
staffStatsSchema.statics.bump = function bump(guildId, userId, increments, username = '') {
  return this.updateOne(
    { guildId, userId },
    {
      $inc: increments,
      $set: { 'activity.lastActiveAt': new Date(), ...(username ? { username } : {}) },
      $setOnInsert: { guildId, userId },
    },
    { upsert: true },
  );
};

/**
 * Record a first-response latency sample and recompute the average.
 * @param {number} minutes
 */
staffStatsSchema.methods.recordFirstResponse = function recordFirstResponse(minutes) {
  const samples = this.responses.firstResponseSamples;
  samples.push(Math.max(0, Math.round(minutes)));
  if (samples.length > 100) samples.shift();
  this.responses.averageFirstResponseMinutes = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  return this;
};

/** Record a full ticket resolution time in minutes. */
staffStatsSchema.methods.recordResolution = function recordResolution(minutes) {
  const samples = this.responses.resolutionSamples;
  samples.push(Math.max(0, Math.round(minutes)));
  if (samples.length > 100) samples.shift();
  this.responses.averageResolutionMinutes = Math.round(samples.reduce((a, b) => a + b, 0) / samples.length);
  return this;
};

/** Record a review rating against this staff member. */
staffStatsSchema.methods.recordReview = function recordReview(rating) {
  this.reviews.count += 1;
  this.reviews.ratingSum += rating;
  this.reviews.average = Math.round((this.reviews.ratingSum / this.reviews.count) * 100) / 100;
  if (rating === 5) this.reviews.fiveStar += 1;
  return this;
};

/**
 * Leaderboard ordered by a metric path.
 * @param {string} guildId
 * @param {string} metric dotted path, e.g. `tickets.closed`
 * @param {number} [limit]
 */
staffStatsSchema.statics.leaderboard = function leaderboard(guildId, metric = 'tickets.closed', limit = 10) {
  const allowed = new Set([
    'tickets.closed', 'tickets.claimed', 'orders.completed', 'orders.revenue',
    'reviews.average', 'reviews.count', 'moderation.warningsIssued', 'activity.commandsUsed',
  ]);
  const path = allowed.has(metric) ? metric : 'tickets.closed';
  return this.find({ guildId }).sort({ [path]: -1 }).limit(Math.min(25, limit)).lean();
};

module.exports = model('StaffStats', staffStatsSchema);
