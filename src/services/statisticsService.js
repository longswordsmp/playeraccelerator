'use strict';

/**
 * Business analytics.
 *
 * Reads the denormalised daily metrics wherever possible and falls back to
 * indexed aggregations for point-in-time figures (open tickets, queue size).
 * Results are cached briefly because dashboards are refreshed frequently and
 * the numbers do not need to be accurate to the second.
 */

const { Ticket, Order, Review, User, GuildStats, StaffStats, Moderation } = require('../database/models');
const { registry } = require('../utils/rateLimiter');

/** Snapshot cache — short TTL, dashboards are re-rendered often. */
const CACHE_TTL_MS = 30_000;
/** @type {Map<string, { value: any, expiresAt: number }>} */
const cache = new Map();

registry.register({
  prune() {
    const now = Date.now();
    for (const [key, entry] of cache) if (entry.expiresAt <= now) cache.delete(key);
  },
});

/** Memoise an async producer for the cache TTL. */
async function cached(key, producer) {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const value = await producer();
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Invalidate a guild's cached snapshots after a significant write. */
function invalidate(guildId) {
  for (const key of cache.keys()) if (key.startsWith(`${guildId}:`)) cache.delete(key);
}

/**
 * Complete business overview used by `/statistics` and the statistics panel.
 * @param {string} guildId
 * @returns {Promise<object>}
 */
function overview(guildId) {
  return cached(`${guildId}:overview`, async () => {
    const since30 = new Date(Date.now() - 30 * 86_400_000);

    const [
      openTickets,
      totalTickets,
      closedTickets,
      totalOrders,
      completedOrders,
      activeOrders,
      customers,
      vips,
      reviewSummary,
      totalMembers,
      repeatCustomers,
      warningsIssued,
      monthly,
      revenueAgg,
      completionAgg,
      responseAgg,
    ] = await Promise.all([
      Ticket.countDocuments({ guildId, status: { $in: ['open', 'claimed', 'pending'] } }),
      Ticket.countDocuments({ guildId }),
      Ticket.countDocuments({ guildId, status: { $in: ['closed', 'archived'] } }),
      Order.countDocuments({ guildId }),
      Order.countDocuments({ guildId, status: 'completed' }),
      Order.countDocuments({ guildId, status: { $in: Order.ACTIVE_STATUSES } }),
      User.countDocuments({ guildId, isCustomer: true }),
      User.countDocuments({ guildId, isVip: true }),
      Review.summary(guildId),
      User.countDocuments({ guildId, inGuild: true }),
      User.countDocuments({ guildId, 'stats.completedOrders': { $gte: 2 } }),
      Moderation.countDocuments({ guildId, type: 'warn' }),
      GuildStats.range(guildId, 30),
      Order.aggregate([
        { $match: { guildId, status: 'completed' } },
        { $group: { _id: null, total: { $sum: { $ifNull: ['$quote.amount', 0] } } } },
      ]),
      Order.aggregate([
        { $match: { guildId, status: 'completed', completionHours: { $ne: null } } },
        { $group: { _id: null, average: { $avg: '$completionHours' } } },
      ]),
      Ticket.aggregate([
        { $match: { guildId, firstResponseMinutes: { $ne: null }, createdAt: { $gte: since30 } } },
        { $group: { _id: null, average: { $avg: '$firstResponseMinutes' } } },
      ]),
    ]);

    const trend = GuildStats.rollup(monthly);

    return {
      tickets: {
        open: openTickets,
        total: totalTickets,
        closed: closedTickets,
        openedLast30: trend.ticketsOpened,
        closedLast30: trend.ticketsClosed,
      },
      orders: {
        total: totalOrders,
        completed: completedOrders,
        active: activeOrders,
        completedLast30: trend.ordersCompleted,
      },
      customers: {
        total: customers,
        vip: vips,
        repeat: repeatCustomers,
        members: totalMembers,
        newLast30: trend.newCustomers,
      },
      reviews: reviewSummary,
      performance: {
        averageFirstResponseMinutes: responseAgg[0]?.average ? Math.round(responseAgg[0].average) : null,
        averageCompletionHours: completionAgg[0]?.average ? Math.round(completionAgg[0].average * 10) / 10 : null,
        satisfaction: reviewSummary.total ? Math.round((reviewSummary.positive / reviewSummary.total) * 1000) / 10 : null,
        repeatRate: customers ? Math.round((repeatCustomers / customers) * 1000) / 10 : 0,
      },
      moderation: {
        warningsIssued,
        last30: {
          warnings: trend.warnings,
          timeouts: trend.timeouts,
          kicks: trend.kicks,
          bans: trend.bans,
          automodHits: trend.automodHits,
        },
      },
      revenue: {
        lifetime: Math.round((revenueAgg[0]?.total ?? 0) * 100) / 100,
        last30: Math.round(trend.revenue * 100) / 100,
      },
      trend,
    };
  });
}

/**
 * Ticket statistics scoped to a window.
 * @param {string} guildId
 * @param {number} days
 */
function ticketStats(guildId, days = 30) {
  return cached(`${guildId}:tickets:${days}`, async () => {
    const since = new Date(Date.now() - days * 86_400_000);
    const [byType, byPriority, byStatus, unclaimed] = await Promise.all([
      Ticket.aggregate([
        { $match: { guildId, createdAt: { $gte: since } } },
        { $group: { _id: '$type', count: { $sum: 1 }, avgFirstResponse: { $avg: '$firstResponseMinutes' } } },
        { $sort: { count: -1 } },
      ]),
      Ticket.aggregate([
        { $match: { guildId, createdAt: { $gte: since } } },
        { $group: { _id: '$priority', count: { $sum: 1 } } },
      ]),
      Ticket.aggregate([
        { $match: { guildId } },
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      Ticket.countDocuments({ guildId, status: { $in: ['open', 'pending'] }, assignedTo: null }),
    ]);
    return { byType, byPriority, byStatus, unclaimed, days };
  });
}

/**
 * Staff leaderboard with review data merged in.
 * @param {string} guildId
 * @param {string} metric
 * @param {number} limit
 */
async function leaderboard(guildId, metric = 'tickets.closed', limit = 10) {
  return StaffStats.leaderboard(guildId, metric, limit);
}

/**
 * A single customer's complete profile.
 * @param {string} guildId
 * @param {string} userId
 */
async function customerProfile(guildId, userId) {
  const [user, tickets, orders, reviews, warnings] = await Promise.all([
    User.findOne({ guildId, userId }).lean(),
    Ticket.find({ guildId, userId }).sort({ createdAt: -1 }).limit(10).lean(),
    Order.find({ guildId, userId }).sort({ createdAt: -1 }).limit(10).lean(),
    Review.find({ guildId, userId }).sort({ createdAt: -1 }).limit(5).lean(),
    Moderation.countDocuments({ guildId, userId, type: 'warn', active: true, revoked: false }),
  ]);

  if (!user && !tickets.length && !orders.length) return null;

  const completed = orders.filter((order) => order.status === 'completed');
  const spend = completed.reduce((sum, order) => sum + (order.quote?.amount ?? 0), 0);
  const ratings = reviews.map((review) => review.rating);
  const serviceCounts = {};
  for (const order of orders) serviceCounts[order.serviceType] = (serviceCounts[order.serviceType] ?? 0) + 1;
  const favouriteService = Object.entries(serviceCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;

  return {
    user,
    tickets,
    orders,
    reviews,
    warnings,
    summary: {
      totalTickets: user?.stats?.totalTickets ?? tickets.length,
      totalOrders: orders.length,
      completedOrders: completed.length,
      totalSpent: Math.round(spend * 100) / 100,
      averageRatingGiven: ratings.length ? Math.round((ratings.reduce((a, b) => a + b, 0) / ratings.length) * 100) / 100 : null,
      favouriteService,
      isRepeat: completed.length >= 2,
      lastActivity: user?.lastActivityAt ?? tickets[0]?.createdAt ?? null,
    },
  };
}

/**
 * Daily summary payload for the automated staff report.
 * @param {string} guildId
 * @param {Date} [day]
 */
async function dailySummary(guildId, day = new Date()) {
  const key = GuildStats.dayKey(day);
  const [today, openTickets, queueSize, topStaff] = await Promise.all([
    GuildStats.findOne({ guildId, date: key }).lean(),
    Ticket.countDocuments({ guildId, status: { $in: ['open', 'claimed', 'pending'] } }),
    Order.countDocuments({ guildId, status: { $in: Order.ACTIVE_STATUSES } }),
    StaffStats.leaderboard(guildId, 'tickets.closed', 5),
  ]);

  return {
    date: key,
    totals: GuildStats.rollup(today ? [today] : []),
    openTickets,
    queueSize,
    topStaff,
  };
}

/**
 * Weekly report payload, including a day-by-day series suitable for charting.
 * @param {string} guildId
 */
async function weeklyReport(guildId) {
  const [week, previous, topStaff, reviews] = await Promise.all([
    GuildStats.range(guildId, 7),
    GuildStats.find({
      guildId,
      date: { $gte: GuildStats.dayKey(new Date(Date.now() - 13 * 86_400_000)), $lt: GuildStats.dayKey(new Date(Date.now() - 6 * 86_400_000)) },
    }).lean(),
    StaffStats.leaderboard(guildId, 'tickets.closed', 5),
    Review.summary(guildId, { since: new Date(Date.now() - 7 * 86_400_000) }),
  ]);

  const current = GuildStats.rollup(week);
  const prior = GuildStats.rollup(previous);

  /** Percentage change between two periods; null when there is no baseline. */
  const delta = (now, before) => (before ? Math.round(((now - before) / before) * 1000) / 10 : null);

  return {
    current,
    previous: prior,
    growth: {
      tickets: delta(current.ticketsOpened, prior.ticketsOpened),
      orders: delta(current.ordersCompleted, prior.ordersCompleted),
      revenue: delta(current.revenue, prior.revenue),
      customers: delta(current.newCustomers, prior.newCustomers),
      reviews: delta(current.reviews, prior.reviews),
    },
    /** Chart-ready series: one point per day. */
    series: week.map((doc) => ({
      date: doc.date,
      ticketsOpened: doc.tickets?.opened ?? 0,
      ticketsClosed: doc.tickets?.closed ?? 0,
      ordersCompleted: doc.orders?.completed ?? 0,
      revenue: doc.orders?.revenue ?? 0,
      joins: doc.members?.joins ?? 0,
      reviews: doc.reviews?.received ?? 0,
    })),
    topStaff,
    reviews,
  };
}

module.exports = {
  overview,
  ticketStats,
  leaderboard,
  customerProfile,
  dailySummary,
  weeklyReport,
  invalidate,
};
