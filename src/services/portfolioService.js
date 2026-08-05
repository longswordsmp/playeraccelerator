'use strict';

/**
 * Portfolio showcase.
 *
 * Publishes delivered work as case studies. Customer consent is enforced when
 * the guild requires it — a studio should never publish a client's project
 * without permission, and the model records that decision explicitly.
 */

const { Portfolio, Counter, Order } = require('../database/models');
const configService = require('./configService');
const logService = require('./logService');
const embeds = require('../utils/embeds');
const errors = require('../utils/errors');
const { TICKET_TYPE_MAP } = require('../config/server');
const { EMOJIS, COLORS } = require('../config/branding');
const { safeSend, resolveTextChannel, attempt } = require('../utils/discord');
const { timestamp, truncate, safeField, padId } = require('../utils/formatters');

/**
 * Render a portfolio entry.
 * @param {object} entry
 * @param {object} config
 */
function entryEmbed(entry, config) {
  const type = TICKET_TYPE_MAP[entry.category];
  const links = [
    entry.demoUrl ? `[Live demo](${entry.demoUrl})` : null,
    entry.githubUrl ? `[Source](${entry.githubUrl})` : null,
    entry.videoUrl ? `[Video](${entry.videoUrl})` : null,
  ].filter(Boolean);

  return embeds.base({
    config,
    color: entry.featured ? COLORS.accent : type?.color ?? COLORS.primary,
    title: `${entry.featured ? `${EMOJIS.star} ` : ''}${truncate(entry.title, 200)}`,
    description: entry.description ? safeField(entry.description, 2000) : undefined,
    fields: [
      { name: 'Category', value: `${type?.emoji ?? EMOJIS.portfolio} ${type?.label ?? entry.category}`, inline: true },
      { name: 'Delivered', value: timestamp(entry.completedAt, 'longDate'), inline: true },
      ...(entry.technologies?.length
        ? [{ name: 'Built with', value: entry.technologies.map((tech) => `\`${tech}\``).join(' '), inline: false }]
        : []),
      ...(links.length ? [{ name: 'Links', value: links.join(' · '), inline: false }] : []),
      ...(entry.customerName && !entry.anonymised
        ? [{ name: 'Client', value: safeField(entry.customerName, 100), inline: true }]
        : []),
    ],
    image: entry.images?.[0] ?? undefined,
    footer: `Project ${padId(entry.number, 3)}`,
  });
}

/**
 * Add a portfolio entry.
 *
 * @param {object} params
 * @param {import('discord.js').Guild} params.guild
 * @param {object} params.data
 * @param {import('discord.js').GuildMember} params.actor
 * @param {object} params.config
 */
async function add({ guild, data, actor, config }) {
  if (config.portfolio?.requireCustomerPermission !== false && data.customerId && !data.customerPermission) {
    throw new errors.ValidationError(
      'This guild requires explicit customer permission before publishing their project. ' +
      'Set `permission: true` once the customer has agreed, or publish it anonymised.',
    );
  }

  const number = await Counter.next(guild.id, 'portfolio');
  const entry = await Portfolio.create({
    guildId: guild.id,
    number,
    title: data.title,
    category: data.category,
    description: data.description ?? '',
    technologies: data.technologies ?? [],
    images: data.images ?? [],
    videoUrl: data.videoUrl ?? '',
    githubUrl: data.githubUrl ?? '',
    demoUrl: data.demoUrl ?? '',
    customerId: data.customerId ?? '',
    customerName: data.customerName ?? '',
    customerPermission: Boolean(data.customerPermission),
    anonymised: Boolean(data.anonymised),
    orderId: data.orderId ?? null,
    orderNumber: data.orderNumber ?? null,
    completedAt: data.completedAt ?? new Date(),
    addedBy: actor.id,
    addedByName: actor.user?.tag ?? '',
    featured: Boolean(data.featured),
    published: data.published !== false,
  });

  if (data.orderId) {
    await Order.updateOne({ _id: data.orderId }, { $set: { portfolioId: entry._id, portfolioPermission: Boolean(data.customerPermission) } });
  }

  if (entry.published && config.portfolio?.autoPublish !== false) {
    await publish(guild, entry, config);
  }

  await logService.record(guild, {
    category: 'business',
    event: 'portfolio.add',
    title: `${EMOJIS.portfolio} Portfolio Entry Added`,
    summary: truncate(entry.title, 200),
    actorId: actor.id,
    fields: { Category: entry.category, Featured: entry.featured ? 'Yes' : 'No' },
  }, config);

  // Refresh the portfolio channel header so the "recent work" list stays current.
  const panelService = require('./panelService');
  await panelService.refresh(guild, config, 'portfolio').catch(() => null);

  return entry;
}

/** Publish (or re-publish) an entry to the portfolio channel. */
async function publish(guild, entry, config) {
  const channel = configService.channel(guild, config, 'portfolio');
  if (!channel) return null;

  if (entry.publishedMessageId) {
    const existing = await attempt(() => channel.messages.fetch(entry.publishedMessageId), { label: 'fetch portfolio message' });
    if (existing) {
      await attempt(() => existing.edit({ embeds: [entryEmbed(entry, config)] }), { label: 'edit portfolio message' });
      return existing;
    }
  }

  const message = await safeSend(channel, { embeds: [entryEmbed(entry, config)] });
  if (!message) return null;

  entry.publishedChannelId = channel.id;
  entry.publishedMessageId = message.id;
  await entry.save();
  return message;
}

/** Remove an entry's published message. */
async function unpublish(guild, entry) {
  if (!entry.publishedChannelId || !entry.publishedMessageId) return;
  const channel = await resolveTextChannel(guild, entry.publishedChannelId);
  const message = channel
    ? await attempt(() => channel.messages.fetch(entry.publishedMessageId), { label: 'fetch portfolio message' })
    : null;
  if (message) await attempt(() => message.delete(), { label: 'delete portfolio message' });
  entry.publishedMessageId = '';
  await entry.save();
}

/** Edit an entry. */
async function edit(guild, entry, changes, actor, config) {
  const allowed = ['title', 'description', 'category', 'technologies', 'images', 'videoUrl', 'githubUrl', 'demoUrl', 'anonymised', 'sortOrder'];
  for (const [key, value] of Object.entries(changes)) {
    if (allowed.includes(key) && value !== undefined && value !== null) entry[key] = value;
  }
  await entry.save();
  await publish(guild, entry, config);

  await logService.record(guild, {
    category: 'business',
    event: 'portfolio.edit',
    title: `${EMOJIS.pencil} Portfolio Entry Updated`,
    summary: truncate(entry.title, 200),
    actorId: actor.id,
  }, config);
  return entry;
}

/** Feature or unfeature an entry. */
async function setFeatured(guild, entry, featured, actor, config) {
  entry.featured = featured;
  await entry.save();
  const message = await publish(guild, entry, config);
  if (message) {
    if (featured) await attempt(() => message.pin(), { label: 'pin portfolio entry' });
    else await attempt(() => message.unpin(), { label: 'unpin portfolio entry' });
  }
  await logService.record(guild, {
    category: 'business',
    event: featured ? 'portfolio.feature' : 'portfolio.unfeature',
    title: `${EMOJIS.star} Portfolio Entry ${featured ? 'Featured' : 'Unfeatured'}`,
    summary: truncate(entry.title, 200),
    actorId: actor.id,
  }, config);
  return entry;
}

/** Delete an entry. */
async function remove(guild, entry, actor, config) {
  await unpublish(guild, entry);
  await Portfolio.deleteOne({ _id: entry._id });
  await logService.record(guild, {
    category: 'business',
    event: 'portfolio.remove',
    title: `${EMOJIS.trash} Portfolio Entry Removed`,
    summary: truncate(entry.title, 200),
    actorId: actor.id,
    severity: 'warn',
  }, config);
}

/** Look up an entry by number. */
async function byNumber(guildId, number) {
  const entry = await Portfolio.findOne({ guildId, number });
  if (!entry) throw new errors.NotFoundError(`Portfolio entry \`#${padId(number, 3)}\` does not exist.`);
  return entry;
}

/** Categories that currently have published entries, for browsing. */
async function categories(guildId) {
  return Portfolio.aggregate([
    { $match: { guildId, published: true } },
    { $group: { _id: '$category', count: { $sum: 1 } } },
    { $sort: { count: -1 } },
  ]);
}

module.exports = { entryEmbed, add, edit, publish, unpublish, setFeatured, remove, byNumber, categories };
