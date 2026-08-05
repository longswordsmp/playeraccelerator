'use strict';

/**
 * Order lifecycle and the delivery queue.
 *
 * An order is created from a submitted project brief, moves through the
 * pipeline, and on completion triggers the customer promotion, the review
 * request and the portfolio offer.
 */

const { Order, User, Counter, StaffStats, GuildStats } = require('../database/models');
const configService = require('./configService');
const logService = require('./logService');
const statisticsService = require('./statisticsService');
const embeds = require('../utils/embeds');
const errors = require('../utils/errors');
const { ORDER_STATUSES, TICKET_TYPE_MAP, PRIORITIES } = require('../config/server');
const { EMOJIS } = require('../config/branding');
const { safeSend, resolveTextChannel, fetchMember, attempt } = require('../utils/discord');
const { timestamp, money, padId, safeField, truncate, duration } = require('../utils/formatters');
const { logger } = require('../utils/logger');

const log = logger.child('orders');

/** Statuses that occupy a queue slot. */
const ACTIVE_STATUSES = Order.ACTIVE_STATUSES;

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * Full order embed used in tickets, the active-orders channel and `/order view`.
 * @param {object} order
 * @param {object} config
 */
function orderEmbed(order, config) {
  const status = ORDER_STATUSES[order.status] ?? ORDER_STATUSES.pending;
  const symbol = config?.business?.currencySymbol ?? '$';
  const type = TICKET_TYPE_MAP[order.serviceType];

  const fields = [
    { name: 'Order', value: `\`#${padId(order.number)}\``, inline: true },
    { name: 'Customer', value: `<@${order.userId}>`, inline: true },
    { name: 'Service', value: `${type?.emoji ?? EMOJIS.order} ${type?.label ?? order.serviceType}`, inline: true },
    { name: 'Status', value: `${status.emoji} ${status.label}`, inline: true },
    { name: 'Priority', value: `${PRIORITIES[order.priority]?.emoji ?? ''} ${PRIORITIES[order.priority]?.label ?? order.priority}`, inline: true },
    { name: 'Developer', value: order.assignedTo ? `<@${order.assignedTo}>` : '_Unassigned_', inline: true },
  ];

  if (order.isFreeCommission) {
    fields.push({ name: 'Programme', value: '🎨 Free Portfolio Commission', inline: true });
  } else {
    fields.push({ name: 'Budget', value: order.budget?.raw ? safeField(order.budget.raw, 100) : '_Not specified_', inline: true });
    fields.push({ name: 'Quote', value: order.quote?.amount !== null && order.quote?.amount !== undefined ? money(order.quote.amount, symbol) : '_Pending_', inline: true });
  }

  if (order.queuePosition !== null && order.queuePosition !== undefined) {
    fields.push({ name: 'Queue Position', value: `#${order.queuePosition + 1}`, inline: true });
  }
  if (order.progress > 0 && order.status !== 'completed') {
    fields.push({ name: 'Progress', value: `${order.progress}%`, inline: true });
  }
  if (order.requestedDeadline) fields.push({ name: 'Requested Deadline', value: safeField(order.requestedDeadline, 100), inline: true });
  if (order.estimatedDelivery) fields.push({ name: 'Estimated Delivery', value: timestamp(order.estimatedDelivery, 'longDate'), inline: true });
  if (order.completedAt) fields.push({ name: 'Completed', value: timestamp(order.completedAt, 'full'), inline: true });
  if (order.completionHours) fields.push({ name: 'Build Time', value: `${order.completionHours}h`, inline: true });
  if (order.references?.length) {
    fields.push({ name: 'References', value: truncate(order.references.map((ref) => `• ${ref}`).join('\n'), 1024), inline: false });
  }
  if (order.notes) fields.push({ name: 'Notes', value: safeField(order.notes, 1024), inline: false });

  return embeds.base({
    config,
    color: status.color,
    title: `${EMOJIS.order} ${truncate(order.title, 200)}`,
    description: order.description ? safeField(order.description, 2000) : undefined,
    fields,
    footer: `Order #${padId(order.number)}`,
  });
}

// ── Creation ─────────────────────────────────────────────────────────────────

/**
 * Create an order from a submitted brief.
 *
 * @param {object} params
 * @param {import('discord.js').Guild} params.guild
 * @param {object} params.ticket
 * @param {object} params.brief normalised form payload
 * @param {object} [params.config]
 * @returns {Promise<object>} the order document
 */
async function createFromBrief({ guild, ticket, brief, config = null }) {
  const cfg = config ?? (await configService.get(guild));
  const number = await Counter.next(guild.id, 'order');

  const order = await Order.create({
    guildId: guild.id,
    number,
    userId: ticket.userId,
    username: ticket.username,
    ticketId: ticket._id,
    ticketNumber: ticket.number,
    channelId: ticket.channelId,
    title: brief.title,
    serviceType: brief.serviceType ?? ticket.type,
    description: brief.description ?? '',
    requirements: brief.requirements ?? '',
    references: brief.references ?? [],
    contactMethod: brief.contactMethod ?? '',
    notes: brief.notes ?? '',
    budget: brief.budget ?? { raw: '', amount: null },
    requestedDeadline: brief.deadline ?? '',
    priority: ticket.priority,
    isFreeCommission: Boolean(brief.isFreeCommission),
    status: 'pending',
    history: [{ status: 'pending', at: new Date(), byId: ticket.userId, byName: ticket.username, note: 'Brief submitted' }],
  });

  ticket.orderId = order._id;
  ticket.orderNumber = order.number;
  ticket.subject = brief.title;
  await ticket.save();

  await Promise.all([
    User.bump(guild.id, ticket.userId, { 'stats.totalOrders': 1 }),
    GuildStats.bump(guild.id, { 'orders.created': 1 }),
    logService.record(guild, {
      category: 'order',
      event: 'order.create',
      title: `${EMOJIS.order} Order Created`,
      summary: `Order #${padId(number)} — ${truncate(brief.title, 120)}`,
      actorId: ticket.userId,
      actorName: ticket.username,
      channelId: ticket.channelId,
      fields: { Service: brief.serviceType ?? ticket.type, Budget: brief.budget?.raw || '—' },
    }, cfg),
  ]);

  statisticsService.invalidate(guild.id);
  log.info(`Order #${padId(number)} created`, { guildId: guild.id, ticket: ticket.number });

  return order;
}

// ── Pipeline ─────────────────────────────────────────────────────────────────

/**
 * Move an order to a new status, keeping the queue and channels in sync.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} order
 * @param {string} status
 * @param {import('discord.js').GuildMember} actor
 * @param {object} config
 * @param {string} [note]
 */
async function setStatus(guild, order, status, actor, config, note = '') {
  if (!ORDER_STATUSES[status]) throw new errors.ValidationError('Unknown order status.');
  if (order.status === status) throw new errors.ConflictError(`This order is already **${ORDER_STATUSES[status].label}**.`);

  const previous = order.status;
  order.transition(status, { id: actor.id, name: actor.user?.tag ?? actor.user?.username ?? 'System' }, note);

  // Entering the queue assigns a position; leaving it frees one.
  if (['accepted', 'queued'].includes(status) && order.queuePosition === null) {
    order.queuePosition = await nextQueuePosition(guild.id);
  }
  await order.save();

  if (['completed', 'cancelled'].includes(status)) await compactQueue(guild.id);
  await recalculateEstimates(guild.id, config);

  // Mirror the change into the ticket channel so the customer sees it.
  const channel = order.channelId ? await resolveTextChannel(guild, order.channelId) : null;
  await safeSend(channel, {
    embeds: [embeds.base({
      config,
      color: ORDER_STATUSES[status].color,
      title: `${ORDER_STATUSES[status].emoji} Order ${ORDER_STATUSES[status].label}`,
      description: note ? safeField(note, 1000) : `Your order is now **${ORDER_STATUSES[status].label}**.`,
      fields: [
        { name: 'Order', value: `\`#${padId(order.number)}\``, inline: true },
        { name: 'Previous', value: ORDER_STATUSES[previous]?.label ?? previous, inline: true },
        ...(order.estimatedDelivery ? [{ name: 'Estimated Delivery', value: timestamp(order.estimatedDelivery, 'longDate'), inline: true }] : []),
      ],
      footer: `Updated by ${actor.user?.tag ?? 'staff'}`,
    })],
  });

  await logService.record(guild, {
    category: 'order',
    event: 'order.status',
    title: `${EMOJIS.order} Order Status Changed`,
    summary: `Order #${padId(order.number)}: ${previous} → ${status}`,
    actorId: actor.id,
    targetId: order.userId,
    fields: { Order: `#${padId(order.number)}`, Note: note || '—' },
  }, config);

  statisticsService.invalidate(guild.id);
  return order;
}

/**
 * Complete an order and run the whole post-delivery workflow.
 *
 * @param {object} params
 * @param {import('discord.js').Guild} params.guild
 * @param {object} params.order
 * @param {import('discord.js').GuildMember} params.actor
 * @param {object} params.config
 * @param {number} [params.amount] final invoiced amount
 */
async function complete({ guild, order, actor, config, amount = null }) {
  if (order.status === 'completed') throw new errors.ConflictError('That order is already completed.');

  if (amount !== null && !order.isFreeCommission) {
    order.quote.amount = amount;
    order.payment.paid = amount;
    order.payment.paidInFull = true;
    order.payment.paidAt = new Date();
  }

  order.transition('completed', { id: actor.id, name: actor.user?.tag ?? 'System' }, 'Delivered and accepted');
  await order.save();
  await compactQueue(guild.id);

  const revenue = order.isFreeCommission ? 0 : order.quote?.amount ?? 0;

  // Customer promotion + lifetime metrics.
  const user = await User.findOneAndUpdate(
    { guildId: guild.id, userId: order.userId },
    {
      $inc: { 'stats.completedOrders': 1, 'stats.totalSpent': revenue },
      $setOnInsert: { guildId: guild.id, userId: order.userId },
    },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );

  const promoted = await promoteCustomer(guild, user, config);

  await Promise.all([
    GuildStats.bump(guild.id, {
      'orders.completed': 1,
      'orders.revenue': revenue,
      ...(order.completionHours ? { 'orders.completionHoursSum': order.completionHours, 'orders.completionCount': 1 } : {}),
    }),
    order.assignedTo
      ? StaffStats.bump(guild.id, order.assignedTo, { 'orders.completed': 1, 'orders.revenue': revenue }, order.assignedName)
      : null,
    logService.record(guild, {
      category: 'order',
      event: 'order.complete',
      title: `${EMOJIS.success} Order Completed`,
      summary: `Order #${padId(order.number)} — ${truncate(order.title, 120)}`,
      actorId: actor.id,
      targetId: order.userId,
      fields: {
        Value: order.isFreeCommission ? 'Free commission' : money(revenue, config.business?.currencySymbol ?? '$'),
        'Build time': order.completionHours ? `${order.completionHours}h` : '—',
      },
    }, config),
  ].filter(Boolean));

  // Publish to the completed-orders channel.
  const completedChannel = configService.channel(guild, config, 'completedOrders');
  if (completedChannel) {
    await safeSend(completedChannel, {
      embeds: [embeds.success({
        config,
        title: 'Project Delivered',
        description: `**${truncate(order.title, 200)}**`,
        fields: [
          { name: 'Service', value: TICKET_TYPE_MAP[order.serviceType]?.label ?? order.serviceType, inline: true },
          { name: 'Delivered', value: timestamp(order.completedAt, 'longDate'), inline: true },
          ...(order.completionHours ? [{ name: 'Build Time', value: `${order.completionHours}h`, inline: true }] : []),
          ...(order.assignedTo ? [{ name: 'Developer', value: `<@${order.assignedTo}>`, inline: true }] : []),
        ],
        footer: `Order #${padId(order.number)}`,
      })],
    });
  }

  // Notify the customer in their ticket.
  const channel = order.channelId ? await resolveTextChannel(guild, order.channelId) : null;
  await safeSend(channel, {
    content: `<@${order.userId}>`,
    embeds: [embeds.success({
      config,
      title: 'Your project is complete',
      description:
        `**${truncate(order.title, 200)}** has been delivered.\n\n` +
        'Thank you for working with us. If anything needs adjusting, let us know here — ' +
        'defects are covered free of charge for 30 days.' +
        (promoted ? '\n\nYou have been granted the **Customer** role.' : ''),
      footer: `Order #${padId(order.number)}`,
    })],
  });

  await recalculateEstimates(guild.id, config);
  statisticsService.invalidate(guild.id);
  log.info(`Order #${padId(order.number)} completed`, { guildId: guild.id, revenue });

  return order;
}

/**
 * Grant the customer / VIP roles once thresholds are met.
 * @returns {Promise<boolean>} whether a new role was granted
 */
async function promoteCustomer(guild, user, config) {
  const member = await fetchMember(guild, user.userId);
  if (!member) return false;

  let granted = false;

  const customerRoleId = config.autoRoles?.onFirstPurchase || config.roles?.customer;
  if (customerRoleId && !member.roles.cache.has(customerRoleId)) {
    const added = await attempt(() => member.roles.add(customerRoleId, 'First completed order'), { label: 'grant customer role' });
    granted = Boolean(added);
  }
  if (!user.isCustomer) {
    user.isCustomer = true;
    user.customerSince = new Date();
    await user.save();
    await GuildStats.bump(guild.id, { 'members.newCustomers': 1 });
  }

  // VIP thresholds.
  const orderThreshold = config.business?.vipThresholdOrders ?? 0;
  const spendThreshold = config.business?.vipThresholdSpend ?? 0;
  const qualifies =
    (orderThreshold > 0 && user.stats.completedOrders >= orderThreshold) ||
    (spendThreshold > 0 && user.stats.totalSpent >= spendThreshold);

  if (qualifies && !user.isVip) {
    const vipRoleId = config.autoRoles?.onVip || config.roles?.vip;
    if (vipRoleId && !member.roles.cache.has(vipRoleId)) {
      await attempt(() => member.roles.add(vipRoleId, 'VIP threshold reached'), { label: 'grant vip role' });
      granted = true;
    }
    user.isVip = true;
    await user.save();
  }

  return granted;
}

// ── Queue management ─────────────────────────────────────────────────────────

/** The next free queue position. */
async function nextQueuePosition(guildId) {
  const last = await Order.findOne({ guildId, queuePosition: { $ne: null } }).sort({ queuePosition: -1 }).lean();
  return last?.queuePosition !== undefined && last?.queuePosition !== null ? last.queuePosition + 1 : 0;
}

/** Remove gaps left by completed or cancelled orders. */
async function compactQueue(guildId) {
  const queued = await Order.find({ guildId, status: { $in: ACTIVE_STATUSES } })
    .sort({ queuePosition: 1, createdAt: 1 })
    .select('_id queuePosition');

  const writes = queued
    .map((order, index) => (order.queuePosition === index ? null : { updateOne: { filter: { _id: order._id }, update: { $set: { queuePosition: index } } } }))
    .filter(Boolean);

  if (writes.length) await Order.bulkWrite(writes);
  return queued.length;
}

/**
 * Move an order to a specific position in the queue.
 * @param {string} guildId
 * @param {object} order
 * @param {number} position zero-based
 */
async function moveInQueue(guildId, order, position) {
  if (!ACTIVE_STATUSES.includes(order.status)) {
    throw new errors.ConflictError('Only active orders occupy a queue slot.');
  }
  const queued = await Order.find({ guildId, status: { $in: ACTIVE_STATUSES } }).sort({ queuePosition: 1, createdAt: 1 });
  const target = Math.max(0, Math.min(position, queued.length - 1));

  const reordered = queued.filter((item) => item._id.toString() !== order._id.toString());
  reordered.splice(target, 0, order);

  await Order.bulkWrite(
    reordered.map((item, index) => ({ updateOne: { filter: { _id: item._id }, update: { $set: { queuePosition: index } } } })),
  );
  return target;
}

/**
 * Recompute estimated start and delivery dates for every queued order.
 * Uses the configured concurrency and average project length — an honest
 * projection rather than a promise.
 */
async function recalculateEstimates(guildId, config) {
  const capacity = Math.max(1, config?.queue?.concurrentCapacity ?? 3);
  const averageDays = Math.max(1, config?.queue?.averageProjectDays ?? 5);

  const queued = await Order.find({ guildId, status: { $in: ACTIVE_STATUSES } }).sort({ queuePosition: 1, createdAt: 1 });
  const writes = [];

  queued.forEach((order, index) => {
    // Orders already in progress start now; queued ones start after the batch
    // ahead of them clears.
    const batchesAhead = order.status === 'in-progress' ? 0 : Math.floor(index / capacity);
    const start = new Date(Date.now() + batchesAhead * averageDays * 86_400_000);
    const delivery = new Date(start.getTime() + averageDays * 86_400_000);

    writes.push({
      updateOne: {
        filter: { _id: order._id },
        update: { $set: { estimatedStart: order.startedAt ?? start, estimatedDelivery: delivery } },
      },
    });
  });

  if (writes.length) await Order.bulkWrite(writes);
  return queued.length;
}

/**
 * Full queue snapshot for the public queue panel.
 * @param {string} guildId
 */
async function queueSnapshot(guildId) {
  const [active, byStatus, completedThisMonth] = await Promise.all([
    Order.find({ guildId, status: { $in: ACTIVE_STATUSES } }).sort({ queuePosition: 1, createdAt: 1 }).limit(25).lean(),
    Order.aggregate([
      { $match: { guildId, status: { $in: [...ACTIVE_STATUSES, 'paused', 'pending'] } } },
      { $group: { _id: '$status', count: { $sum: 1 } } },
    ]),
    Order.countDocuments({ guildId, status: 'completed', completedAt: { $gte: new Date(Date.now() - 30 * 86_400_000) } }),
  ]);

  const counts = Object.fromEntries(byStatus.map((entry) => [entry._id, entry.count]));
  return {
    active,
    counts: {
      pending: counts.pending ?? 0,
      accepted: counts.accepted ?? 0,
      queued: counts.queued ?? 0,
      inProgress: counts['in-progress'] ?? 0,
      review: counts.review ?? 0,
      paused: counts.paused ?? 0,
      completedLast30: completedThisMonth,
    },
    size: active.length,
  };
}

/**
 * A customer's position in the queue.
 * @param {string} guildId
 * @param {string} userId
 */
async function positionFor(guildId, userId) {
  const orders = await Order.find({ guildId, userId, status: { $in: ACTIVE_STATUSES } })
    .sort({ queuePosition: 1 })
    .lean();
  return orders.map((order) => ({
    number: order.number,
    title: order.title,
    position: (order.queuePosition ?? 0) + 1,
    status: order.status,
    estimatedStart: order.estimatedStart,
    estimatedDelivery: order.estimatedDelivery,
  }));
}

/** Assign an order to a developer. */
async function assign(guild, order, developer, actor, config) {
  order.assignedTo = developer.id;
  order.assignedName = developer.user.tag ?? developer.user.username;
  if (order.status === 'pending') order.transition('accepted', { id: actor.id, name: actor.user?.tag }, 'Assigned to a developer');
  await order.save();

  await StaffStats.bump(guild.id, developer.id, { 'orders.assigned': 1 }, order.assignedName);
  await logService.record(guild, {
    category: 'order',
    event: 'order.assign',
    title: `${EMOJIS.order} Order Assigned`,
    summary: `Order #${padId(order.number)} → <@${developer.id}>`,
    actorId: actor.id,
    targetId: developer.id,
  }, config);

  return order;
}

/** Cancel an order. */
async function cancel(guild, order, actor, config, reason = '') {
  if (['completed', 'cancelled'].includes(order.status)) {
    throw new errors.ConflictError('That order can no longer be cancelled.');
  }
  order.cancelReason = truncate(reason, 500);
  order.transition('cancelled', { id: actor.id, name: actor.user?.tag ?? 'System' }, reason);
  await order.save();
  await compactQueue(guild.id);
  await recalculateEstimates(guild.id, config);

  await Promise.all([
    User.bump(guild.id, order.userId, { 'stats.cancelledOrders': 1 }),
    GuildStats.bump(guild.id, { 'orders.cancelled': 1 }),
    order.assignedTo ? StaffStats.bump(guild.id, order.assignedTo, { 'orders.cancelled': 1 }) : null,
    logService.record(guild, {
      category: 'order',
      event: 'order.cancel',
      title: `${EMOJIS.error} Order Cancelled`,
      summary: `Order #${padId(order.number)}${reason ? `: ${truncate(reason, 200)}` : ''}`,
      actorId: actor.id,
      targetId: order.userId,
      severity: 'warn',
    }, config),
  ].filter(Boolean));

  const channel = order.channelId ? await resolveTextChannel(guild, order.channelId) : null;
  await safeSend(channel, {
    embeds: [embeds.warning({
      config,
      title: 'Order Cancelled',
      description: reason ? safeField(reason, 1000) : 'This order has been cancelled.',
      footer: `Order #${padId(order.number)}`,
    })],
  });

  statisticsService.invalidate(guild.id);
  return order;
}

/**
 * Look up an order by its number.
 * @param {string} guildId
 * @param {number} number
 */
async function byNumber(guildId, number) {
  const order = await Order.findOne({ guildId, number });
  if (!order) throw new errors.NotFoundError(`Order \`#${padId(number)}\` does not exist.`);
  return order;
}

module.exports = {
  ACTIVE_STATUSES,
  orderEmbed,
  createFromBrief,
  setStatus,
  complete,
  cancel,
  assign,
  promoteCustomer,
  nextQueuePosition,
  compactQueue,
  moveInQueue,
  recalculateEstimates,
  queueSnapshot,
  positionFor,
  byNumber,
  duration,
};
