'use strict';

/**
 * Customer review collection and publication.
 *
 * Flow: ticket closes → rating buttons are posted → customer picks stars → a
 * modal collects written feedback → the review is stored, credited to the staff
 * member who handled the ticket, and published to the reviews channel.
 */

const { Review, Ticket, Order, User, Counter, StaffStats, GuildStats } = require('../database/models');
const configService = require('./configService');
const logService = require('./logService');
const statisticsService = require('./statisticsService');
const embeds = require('../utils/embeds');
const components = require('../utils/components');
const errors = require('../utils/errors');
const { TICKET_TYPE_MAP } = require('../config/server');
const { EMOJIS, COLORS, stars } = require('../config/branding');
const { safeSend, safeDm, resolveTextChannel, fetchMember, attempt } = require('../utils/discord');
const { timestamp, padId, safeField, percent, progressBar, number: fmtNumber } = require('../utils/formatters');
const { logger } = require('../utils/logger');

const log = logger.child('reviews');

// ── Rendering ────────────────────────────────────────────────────────────────

/**
 * The public review card posted in the reviews channel.
 * @param {object} review
 * @param {object} config
 */
function reviewEmbed(review, config) {
  const service = TICKET_TYPE_MAP[review.serviceType];
  const color = review.rating >= 4 ? COLORS.success : review.rating === 3 ? COLORS.warning : COLORS.danger;

  const fields = [
    { name: 'Service', value: `${service?.emoji ?? EMOJIS.order} ${review.serviceLabel || service?.label || review.serviceType || 'Development'}`, inline: true },
    { name: 'Rating', value: `${stars(review.rating)} ${review.rating}/5`, inline: true },
    { name: 'Completed', value: timestamp(review.completedAt ?? review.createdAt, 'longDate'), inline: true },
  ];

  if (review.liked) fields.push({ name: 'What stood out', value: safeField(review.liked, 1024) });
  if (review.improvements) fields.push({ name: 'Room to improve', value: safeField(review.improvements, 1024) });
  if (review.recommend) fields.push({ name: 'Would recommend', value: safeField(review.recommend, 256), inline: true });
  if (review.staffId) fields.push({ name: 'Handled by', value: `<@${review.staffId}>`, inline: true });
  if (review.completionHours) fields.push({ name: 'Build time', value: `${review.completionHours}h`, inline: true });

  return embeds.base({
    config,
    color,
    author: { name: review.username || 'Verified customer', iconURL: review.avatar || undefined },
    title: review.featured ? `${EMOJIS.star} Featured Review` : undefined,
    description: review.feedback ? `>>> ${safeField(review.feedback, 1800)}` : '_No written feedback provided._',
    fields,
    thumbnail: null,
    footer: `Review #${padId(review.number)} · Verified purchase`,
  });
}

/** Summary panel for the reviews channel header and `/reviewstats`. */
function summaryEmbed(summary, config, extra = {}) {
  const total = summary.total || 1;
  const distribution = [5, 4, 3, 2, 1]
    .map((rating) => `${stars(rating).slice(0, rating * 2)} \`${String(summary.distribution[rating]).padStart(3)}\` ${progressBar(summary.distribution[rating], total, 10)}`)
    .join('\n');

  return embeds.panel({
    config,
    title: `${EMOJIS.star} Customer Satisfaction`,
    description: summary.total
      ? `**${summary.average.toFixed(2)} / 5.00** average across **${fmtNumber(summary.total)}** verified reviews.`
      : 'No reviews have been published yet. Yours could be the first.',
    fields: [
      ...(summary.total ? [{ name: 'Rating Distribution', value: distribution }] : []),
      ...(summary.total
        ? [
          { name: 'Five Star', value: percent(summary.distribution[5], summary.total), inline: true },
          { name: 'Positive (4★+)', value: percent(summary.positive, summary.total), inline: true },
          { name: 'Negative (2★-)', value: percent(summary.negative, summary.total), inline: true },
        ]
        : []),
      ...(extra.topService
        ? [{ name: 'Most Reviewed Service', value: `${TICKET_TYPE_MAP[extra.topService._id]?.label ?? extra.topService._id} · ${extra.topService.count} reviews`, inline: false }]
        : []),
    ],
    footer: 'Every review comes from a completed, paid engagement.',
  });
}

// ── Collection ───────────────────────────────────────────────────────────────

/**
 * Ask a customer to review a completed ticket.
 * Sends in-channel and by DM so the request is not missed.
 *
 * @param {object} params
 * @param {import('discord.js').Guild} params.guild
 * @param {object} params.ticket
 * @param {object} params.config
 */
async function requestReview({ guild, ticket, config }) {
  if (ticket.review?.submitted) return null;
  if (config.reviews?.enabled === false) return null;

  ticket.review = { ...(ticket.review ?? {}), requested: true, requestedAt: new Date() };
  await ticket.save();

  const embed = embeds.base({
    config,
    color: COLORS.accent,
    title: `${EMOJIS.star} How did we do?`,
    description:
      'Your feedback shapes how we work and helps other customers decide whether to trust us.\n\n' +
      'Pick a rating below — it takes about thirty seconds.',
    fields: [
      { name: 'Ticket', value: `\`#${padId(ticket.number)}\``, inline: true },
      { name: 'Service', value: ticket.typeLabel || ticket.type, inline: true },
      ...(ticket.assignedTo ? [{ name: 'Handled by', value: `<@${ticket.assignedTo}>`, inline: true }] : []),
    ],
    footer: 'Reviews are published publicly and are never edited.',
  });

  const payload = { embeds: [embed], components: components.reviewStars(ticket._id.toString()) };

  const channel = ticket.channelId ? await resolveTextChannel(guild, ticket.channelId) : null;
  if (channel) await safeSend(channel, { content: `<@${ticket.userId}>`, ...payload });

  const member = await fetchMember(guild, ticket.userId);
  if (member) await safeDm(member.user, payload);

  return ticket;
}

/**
 * Record a submitted review.
 *
 * @param {object} params
 * @param {import('discord.js').Guild} params.guild
 * @param {object} params.ticket
 * @param {import('discord.js').User} params.user
 * @param {number} params.rating
 * @param {object} params.answers written responses
 * @param {object} params.config
 * @returns {Promise<object>} the review document
 */
async function submit({ guild, ticket, user, rating, answers, config }) {
  if (config.reviews?.onePerTicket !== false && ticket.review?.submitted) {
    throw new errors.ConflictError('You have already left a review for this ticket. Thank you!');
  }
  if (ticket.userId !== user.id) {
    throw new errors.PermissionError('Only the customer who opened this ticket can review it.');
  }
  if (rating < 1 || rating > 5) throw new errors.ValidationError('Rating must be between 1 and 5 stars.');

  const order = ticket.orderId ? await Order.findById(ticket.orderId).lean() : null;
  const reviewNumber = await Counter.next(guild.id, 'review');

  const requireApproval = config.reviews?.requireApproval === true
    || rating < (config.reviews?.autoPublishMinRating ?? 1);

  const review = await Review.create({
    guildId: guild.id,
    number: reviewNumber,
    userId: user.id,
    username: user.globalName ?? user.username,
    avatar: user.displayAvatarURL?.({ size: 128 }) ?? '',
    ticketId: ticket._id,
    ticketNumber: ticket.number,
    orderId: order?._id ?? null,
    orderNumber: order?.number ?? null,
    serviceType: ticket.type,
    serviceLabel: ticket.typeLabel,
    staffId: ticket.assignedTo,
    staffName: ticket.assignedName,
    rating,
    feedback: answers.feedback ?? '',
    liked: answers.liked ?? '',
    improvements: answers.improvements ?? '',
    recommend: answers.recommend ?? '',
    additional: answers.additional ?? '',
    approved: !requireApproval,
    approvedAt: requireApproval ? null : new Date(),
    completionHours: order?.completionHours ?? null,
    completedAt: order?.completedAt ?? ticket.closedAt,
  });

  ticket.review = { ...(ticket.review ?? {}), submitted: true, reviewId: review._id, rating };
  await ticket.save();

  if (order) {
    await Order.updateOne({ _id: order._id }, { $set: { reviewId: review._id } });
  }

  // Update denormalised averages.
  const userDoc = await User.findOneAndUpdate(
    { guildId: guild.id, userId: user.id },
    { $inc: { 'stats.reviewsSubmitted': 1 }, $setOnInsert: { guildId: guild.id, userId: user.id } },
    { new: true, upsert: true, setDefaultsOnInsert: true },
  );
  const given = await Review.aggregate([
    { $match: { guildId: guild.id, userId: user.id } },
    { $group: { _id: null, average: { $avg: '$rating' } } },
  ]);
  if (given[0]?.average) {
    userDoc.stats.averageRatingGiven = Math.round(given[0].average * 100) / 100;
    await userDoc.save();
  }

  if (review.staffId) {
    const staff = await StaffStats.resolve(guild.id, review.staffId, review.staffName);
    staff.recordReview(rating);
    await staff.save();
  }

  await GuildStats.bump(guild.id, {
    'reviews.received': 1,
    'reviews.ratingSum': rating,
    ...(rating === 5 ? { 'reviews.fiveStar': 1 } : {}),
  });

  if (review.approved && config.reviews?.autoPublish !== false) {
    await publish(guild, review, config);
  } else if (requireApproval) {
    await notifyStaffForApproval(guild, review, config);
  }

  await logService.record(guild, {
    category: 'review',
    event: 'review.submit',
    title: `${EMOJIS.star} Review Submitted`,
    summary: `${stars(rating)} from ${user.tag ?? user.username} for ticket #${padId(ticket.number)}`,
    actorId: user.id,
    targetId: review.staffId ?? '',
    fields: { Rating: `${rating}/5`, Service: ticket.typeLabel || ticket.type, Approved: review.approved ? 'Yes' : 'Pending' },
  }, config);

  statisticsService.invalidate(guild.id);
  log.info(`Review #${padId(reviewNumber)} submitted`, { guildId: guild.id, rating });

  return review;
}

/** Send a low-rated or approval-gated review to staff for a decision. */
async function notifyStaffForApproval(guild, review, config) {
  const channel = configService.logChannel(guild, config, 'ticket')
    ?? configService.channel(guild, config, 'staffChat');
  if (!channel) return;

  await safeSend(channel, {
    embeds: [embeds.warning({
      config,
      title: 'Review Awaiting Approval',
      description: `A **${review.rating}★** review needs a decision before it is published.`,
      fields: [
        { name: 'Customer', value: `<@${review.userId}>`, inline: true },
        { name: 'Ticket', value: `\`#${padId(review.ticketNumber ?? 0)}\``, inline: true },
        { name: 'Review', value: `\`#${padId(review.number)}\``, inline: true },
        ...(review.feedback ? [{ name: 'Feedback', value: safeField(review.feedback, 1024) }] : []),
      ],
      footer: 'Use /review approve or /review reject',
    })],
  });
}

// ── Publication ──────────────────────────────────────────────────────────────

/**
 * Publish an approved review to the reviews channel.
 * @param {import('discord.js').Guild} guild
 * @param {object} review
 * @param {object} config
 */
async function publish(guild, review, config) {
  const channel = configService.channel(guild, config, 'reviews');
  if (!channel) return null;

  // Re-publishing edits in place rather than duplicating.
  if (review.publishedMessageId) {
    const existing = await attempt(() => channel.messages.fetch(review.publishedMessageId), { label: 'fetch published review' });
    if (existing) {
      await attempt(() => existing.edit({ embeds: [reviewEmbed(review, config)] }), { label: 'edit published review' });
      return existing;
    }
  }

  const message = await safeSend(channel, { embeds: [reviewEmbed(review, config)] });
  if (!message) return null;

  review.publishedChannelId = channel.id;
  review.publishedMessageId = message.id;
  review.publishedAt = new Date();
  await review.save();

  if (review.featured && config.reviews?.pinFeatured !== false) {
    await attempt(() => message.pin(), { label: 'pin featured review' });
    review.pinned = true;
    await review.save();
  }

  return message;
}

/** Remove a published review message. */
async function unpublish(guild, review) {
  if (!review.publishedChannelId || !review.publishedMessageId) return;
  const channel = await resolveTextChannel(guild, review.publishedChannelId);
  if (!channel) return;
  const message = await attempt(() => channel.messages.fetch(review.publishedMessageId), { label: 'fetch review message' });
  if (message) await attempt(() => message.delete(), { label: 'delete review message' });
  review.publishedMessageId = '';
  review.pinned = false;
  await review.save();
}

/** Approve a pending review. */
async function approve(guild, review, actor, config) {
  if (review.approved && !review.rejected) throw new errors.ConflictError('That review is already approved.');
  review.approved = true;
  review.rejected = false;
  review.hidden = false;
  review.approvedBy = actor.id;
  review.approvedAt = new Date();
  await review.save();
  await publish(guild, review, config);

  await logService.record(guild, {
    category: 'review',
    event: 'review.approve',
    title: `${EMOJIS.success} Review Approved`,
    summary: `Review #${padId(review.number)} published`,
    actorId: actor.id,
  }, config);
  statisticsService.invalidate(guild.id);
  return review;
}

/** Reject a review so it is never published. */
async function reject(guild, review, actor, config, reason = '') {
  review.approved = false;
  review.rejected = true;
  review.rejectReason = reason;
  await review.save();
  await unpublish(guild, review);

  await logService.record(guild, {
    category: 'review',
    event: 'review.reject',
    title: `${EMOJIS.error} Review Rejected`,
    summary: `Review #${padId(review.number)}${reason ? `: ${reason}` : ''}`,
    actorId: actor.id,
    severity: 'warn',
  }, config);
  statisticsService.invalidate(guild.id);
  return review;
}

/** Feature or unfeature a review. */
async function setFeatured(guild, review, featured, actor, config) {
  const threshold = config.reviews?.featureThreshold ?? 5;
  if (featured && review.rating < threshold) {
    throw new errors.ValidationError(`Only reviews rated **${threshold}★ or higher** can be featured.`);
  }

  review.featured = featured;
  review.featuredAt = featured ? new Date() : null;
  review.featuredBy = featured ? actor.id : '';
  await review.save();

  const message = await publish(guild, review, config);
  if (message) {
    if (featured && config.reviews?.pinFeatured !== false) await attempt(() => message.pin(), { label: 'pin review' });
    else if (!featured && review.pinned) await attempt(() => message.unpin(), { label: 'unpin review' });
    review.pinned = featured;
    await review.save();
  }

  await logService.record(guild, {
    category: 'review',
    event: featured ? 'review.feature' : 'review.unfeature',
    title: `${EMOJIS.star} Review ${featured ? 'Featured' : 'Unfeatured'}`,
    summary: `Review #${padId(review.number)}`,
    actorId: actor.id,
  }, config);
  return review;
}

/** Hide a published review without deleting the record. */
async function setHidden(guild, review, hidden, actor, config) {
  review.hidden = hidden;
  await review.save();
  if (hidden) await unpublish(guild, review);
  else await publish(guild, review, config);

  await logService.record(guild, {
    category: 'review',
    event: hidden ? 'review.hide' : 'review.show',
    title: `Review ${hidden ? 'Hidden' : 'Restored'}`,
    summary: `Review #${padId(review.number)}`,
    actorId: actor.id,
  }, config);
  statisticsService.invalidate(guild.id);
  return review;
}

/** Permanently remove a review. */
async function remove(guild, review, actor, config) {
  await unpublish(guild, review);
  if (review.ticketId) {
    await Ticket.updateOne({ _id: review.ticketId }, { $set: { 'review.submitted': false, 'review.reviewId': null, 'review.rating': null } });
  }
  if (review.staffId) {
    // Recompute the staff average from scratch so it stays truthful.
    const summary = await Review.summary(guild.id, { staffId: review.staffId });
    await StaffStats.updateOne(
      { guildId: guild.id, userId: review.staffId },
      { $set: { 'reviews.count': summary.total, 'reviews.average': summary.average, 'reviews.ratingSum': Math.round(summary.average * summary.total) } },
    );
  }
  await Review.deleteOne({ _id: review._id });

  await logService.record(guild, {
    category: 'review',
    event: 'review.delete',
    title: `${EMOJIS.trash} Review Deleted`,
    summary: `Review #${padId(review.number)} permanently removed`,
    actorId: actor.id,
    severity: 'warn',
  }, config);
  statisticsService.invalidate(guild.id);
}

/**
 * Reviews that qualify as outstanding: five stars with substantive feedback.
 * @param {string} guildId
 */
function outstanding(guildId, limit = 10) {
  return Review.find({
    guildId,
    approved: true,
    hidden: false,
    rejected: false,
    rating: 5,
    featured: false,
    $expr: { $gte: [{ $strLenCP: { $ifNull: ['$feedback', ''] } }, 80] },
  })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
}

/** Look up a review by its number. */
async function byNumber(guildId, num) {
  const review = await Review.findOne({ guildId, number: num });
  if (!review) throw new errors.NotFoundError(`Review \`#${padId(num)}\` does not exist.`);
  return review;
}

module.exports = {
  reviewEmbed,
  summaryEmbed,
  requestReview,
  submit,
  publish,
  unpublish,
  approve,
  reject,
  setFeatured,
  setHidden,
  remove,
  outstanding,
  byNumber,
};
