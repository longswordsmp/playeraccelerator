'use strict';

/**
 * Daily business metrics.
 *
 * One document per guild per UTC day. Written incrementally as events happen,
 * which makes trend charts, the daily summary and the weekly report a single
 * indexed range scan instead of an expensive aggregation over every collection.
 */

const { Schema, model } = require('mongoose');

const guildStatsSchema = new Schema(
  {
    guildId: { type: String, required: true, index: true },
    /** UTC day key: `YYYY-MM-DD`. */
    date: { type: String, required: true, index: true },

    members: {
      joins: { type: Number, default: 0 },
      leaves: { type: Number, default: 0 },
      total: { type: Number, default: 0 },
      newCustomers: { type: Number, default: 0 },
    },

    tickets: {
      opened: { type: Number, default: 0 },
      closed: { type: Number, default: 0 },
      reopened: { type: Number, default: 0 },
      deleted: { type: Number, default: 0 },
      /** Sum + count so averages can be recomputed over any range. */
      firstResponseSum: { type: Number, default: 0 },
      firstResponseCount: { type: Number, default: 0 },
      resolutionSum: { type: Number, default: 0 },
      resolutionCount: { type: Number, default: 0 },
      byType: { type: Schema.Types.Mixed, default: () => ({}) },
    },

    orders: {
      created: { type: Number, default: 0 },
      completed: { type: Number, default: 0 },
      cancelled: { type: Number, default: 0 },
      revenue: { type: Number, default: 0 },
      completionHoursSum: { type: Number, default: 0 },
      completionCount: { type: Number, default: 0 },
    },

    reviews: {
      received: { type: Number, default: 0 },
      ratingSum: { type: Number, default: 0 },
      fiveStar: { type: Number, default: 0 },
    },

    moderation: {
      warnings: { type: Number, default: 0 },
      timeouts: { type: Number, default: 0 },
      kicks: { type: Number, default: 0 },
      bans: { type: Number, default: 0 },
      automodHits: { type: Number, default: 0 },
      messagesDeleted: { type: Number, default: 0 },
    },

    security: {
      raidAlerts: { type: Number, default: 0 },
      nukeAlerts: { type: Number, default: 0 },
      blockedLinks: { type: Number, default: 0 },
      flaggedAccounts: { type: Number, default: 0 },
    },

    activity: {
      messages: { type: Number, default: 0 },
      commands: { type: Number, default: 0 },
      errors: { type: Number, default: 0 },
    },
  },
  { timestamps: true },
);

guildStatsSchema.index({ guildId: 1, date: 1 }, { unique: true });
guildStatsSchema.index({ guildId: 1, createdAt: -1 });

/** The UTC day key for a date. */
const dayKey = (date = new Date()) => date.toISOString().slice(0, 10);

/**
 * Increment counters for today (or a given day).
 * @param {string} guildId
 * @param {Record<string, number>} increments dotted paths
 * @param {Date} [date]
 */
guildStatsSchema.statics.bump = function bump(guildId, increments, date = new Date()) {
  const key = dayKey(date);
  // MongoDB rejects an empty `$inc`, so a call with no counters becomes a plain
  // upsert — callers use that form to guarantee today's document exists.
  const update = Object.keys(increments ?? {}).length
    ? { $inc: increments, $setOnInsert: { guildId, date: key } }
    : { $setOnInsert: { guildId, date: key } };

  return this.updateOne({ guildId, date: key }, update, { upsert: true })
    .catch(() => null); // metrics must never break a feature
};

/**
 * Fetch a contiguous range of daily documents, oldest first.
 * @param {string} guildId
 * @param {number} days
 */
guildStatsSchema.statics.range = function range(guildId, days = 7) {
  const from = dayKey(new Date(Date.now() - (days - 1) * 86_400_000));
  return this.find({ guildId, date: { $gte: from } }).sort({ date: 1 }).lean();
};

/**
 * Roll a range of days up into a single totals object.
 * @param {Array<object>} documents
 */
guildStatsSchema.statics.rollup = function rollup(documents) {
  const totals = {
    joins: 0, leaves: 0, newCustomers: 0,
    ticketsOpened: 0, ticketsClosed: 0, ticketsReopened: 0,
    firstResponseSum: 0, firstResponseCount: 0, resolutionSum: 0, resolutionCount: 0,
    ordersCreated: 0, ordersCompleted: 0, ordersCancelled: 0, revenue: 0,
    completionHoursSum: 0, completionCount: 0,
    reviews: 0, ratingSum: 0, fiveStar: 0,
    warnings: 0, timeouts: 0, kicks: 0, bans: 0, automodHits: 0,
    raidAlerts: 0, nukeAlerts: 0, blockedLinks: 0,
    messages: 0, commands: 0, errors: 0,
  };

  for (const doc of documents) {
    totals.joins += doc.members?.joins ?? 0;
    totals.leaves += doc.members?.leaves ?? 0;
    totals.newCustomers += doc.members?.newCustomers ?? 0;
    totals.ticketsOpened += doc.tickets?.opened ?? 0;
    totals.ticketsClosed += doc.tickets?.closed ?? 0;
    totals.ticketsReopened += doc.tickets?.reopened ?? 0;
    totals.firstResponseSum += doc.tickets?.firstResponseSum ?? 0;
    totals.firstResponseCount += doc.tickets?.firstResponseCount ?? 0;
    totals.resolutionSum += doc.tickets?.resolutionSum ?? 0;
    totals.resolutionCount += doc.tickets?.resolutionCount ?? 0;
    totals.ordersCreated += doc.orders?.created ?? 0;
    totals.ordersCompleted += doc.orders?.completed ?? 0;
    totals.ordersCancelled += doc.orders?.cancelled ?? 0;
    totals.revenue += doc.orders?.revenue ?? 0;
    totals.completionHoursSum += doc.orders?.completionHoursSum ?? 0;
    totals.completionCount += doc.orders?.completionCount ?? 0;
    totals.reviews += doc.reviews?.received ?? 0;
    totals.ratingSum += doc.reviews?.ratingSum ?? 0;
    totals.fiveStar += doc.reviews?.fiveStar ?? 0;
    totals.warnings += doc.moderation?.warnings ?? 0;
    totals.timeouts += doc.moderation?.timeouts ?? 0;
    totals.kicks += doc.moderation?.kicks ?? 0;
    totals.bans += doc.moderation?.bans ?? 0;
    totals.automodHits += doc.moderation?.automodHits ?? 0;
    totals.raidAlerts += doc.security?.raidAlerts ?? 0;
    totals.nukeAlerts += doc.security?.nukeAlerts ?? 0;
    totals.blockedLinks += doc.security?.blockedLinks ?? 0;
    totals.messages += doc.activity?.messages ?? 0;
    totals.commands += doc.activity?.commands ?? 0;
    totals.errors += doc.activity?.errors ?? 0;
  }

  totals.averageFirstResponse = totals.firstResponseCount ? Math.round(totals.firstResponseSum / totals.firstResponseCount) : null;
  totals.averageResolution = totals.resolutionCount ? Math.round(totals.resolutionSum / totals.resolutionCount) : null;
  totals.averageCompletionHours = totals.completionCount ? Math.round((totals.completionHoursSum / totals.completionCount) * 10) / 10 : null;
  totals.averageRating = totals.reviews ? Math.round((totals.ratingSum / totals.reviews) * 100) / 100 : null;

  return totals;
};

module.exports = model('GuildStats', guildStatsSchema);
module.exports.dayKey = dayKey;
