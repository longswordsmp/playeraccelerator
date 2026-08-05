'use strict';

/**
 * Public panel publication.
 *
 * A "panel" is a branded message the bot owns and keeps up to date: the rules,
 * the ticket launcher, the live status board, the queue, the statistics
 * dashboard. Panels are stored by `panelKey -> { channelId, messageId }` so a
 * refresh edits in place instead of accumulating duplicates.
 */

const content = require('../config/content');
const { TICKET_TYPES, TICKET_TYPE_MAP, ORDER_STATUSES } = require('../config/server');
const configService = require('./configService');
const businessService = require('./businessService');
const statisticsService = require('./statisticsService');
const orderService = require('./orderService');
const reviewService = require('./reviewService');
const embeds = require('../utils/embeds');
const components = require('../utils/components');
const customId = require('../utils/customId');
const { Review, Portfolio } = require('../database/models');
const { EMOJIS, COLORS, stars } = require('../config/branding');
const { safeSend, resolveTextChannel, attempt } = require('../utils/discord');
const { money, number, duration, truncate, table, medal } = require('../utils/formatters');
const { logger } = require('../utils/logger');

const log = logger.child('panels');

// ── Panel builders ───────────────────────────────────────────────────────────
// Each builder returns `{ embeds, components? }` ready to send or edit.

/** Welcome / start-here panel. */
async function welcomePanel(guild, config) {
  const doc = content.WELCOME;
  const ticketChannel = config.channels?.createTicket;
  const pricingChannel = config.channels?.pricing;
  const portfolioChannel = config.channels?.portfolio;
  const reviewsChannel = config.channels?.reviews;

  return {
    embeds: [embeds.panel({
      config,
      title: `${EMOJIS.brand} ${doc.title}`,
      description:
        `${doc.intro}\n\n` +
        [
          ticketChannel ? `${EMOJIS.ticket} <#${ticketChannel}> — open a request` : null,
          pricingChannel ? `${EMOJIS.pricing} <#${pricingChannel}> — service pricing` : null,
          portfolioChannel ? `${EMOJIS.portfolio} <#${portfolioChannel}> — our work` : null,
          reviewsChannel ? `${EMOJIS.star} <#${reviewsChannel}> — customer reviews` : null,
        ].filter(Boolean).join('\n'),
      fields: doc.sections,
      footer: doc.footer,
    })],
    components: ticketChannel
      ? components.rows([
        components.button({ url: `https://discord.com/channels/${guild.id}/${ticketChannel}`, label: 'Start a Project', emoji: EMOJIS.ticket }),
      ])
      : [],
  };
}

/** Rules panel. */
const rulesPanel = async (guild, config) => ({ embeds: [embeds.fromDocument(content.RULES, { config, title: `${EMOJIS.logs} ${content.RULES.title}` })] });

/** FAQ panel. */
const faqPanel = async (guild, config) => ({ embeds: [embeds.fromDocument(content.FAQ, { config })] });

/** Terms of Service panel. */
const tosPanel = async (guild, config) => ({ embeds: [embeds.fromDocument(content.TOS, { config, color: COLORS.surface })] });

/** Pricing panel. */
async function pricingPanel(guild, config) {
  const doc = content.PRICING;
  const symbol = config.business?.currencySymbol ?? doc.currency;

  const rows = doc.services.map((service) => ({
    name: `${service.emoji} ${service.name}`,
    value: `${service.from !== null ? `**From ${money(service.from, symbol)}**` : '**Custom quote**'}\n${service.note}`,
    inline: true,
  }));

  return {
    embeds: [embeds.panel({
      config,
      title: `${EMOJIS.pricing} ${doc.title}`,
      description: doc.intro,
      fields: [...rows, { name: 'Good to know', value: doc.notes.map((note) => `${EMOJIS.bullet} ${note}`).join('\n') }],
      footer: doc.footer,
    })],
    components: config.channels?.createTicket
      ? components.rows([components.button({ id: customId.build('ticket', 'open'), label: 'Request a Quote', emoji: EMOJIS.ticket, style: 'primary' })])
      : [],
  };
}

/** Portfolio panel — the services overview plus the latest published entries. */
async function portfolioPanel(guild, config) {
  const doc = content.PORTFOLIO;
  const entries = await Portfolio.showcase(guild.id, { limit: 6 });

  const list = entries.length
    ? entries.map((entry) => `**${entry.featured ? `${EMOJIS.star} ` : ''}${truncate(entry.title, 60)}** — ${truncate(entry.description || entry.category, 90)}`).join('\n')
    : null;

  return {
    embeds: [embeds.panel({
      config,
      title: `${EMOJIS.portfolio} ${doc.title}`,
      description: doc.intro,
      fields: [
        ...doc.services,
        ...(list ? [{ name: 'Recent Work', value: truncate(list, 1024) }] : []),
      ],
      footer: doc.footer,
    })],
    components: components.rows([
      components.button({ id: customId.build('portfolio', 'browse'), label: 'Browse Projects', emoji: EMOJIS.portfolio, style: 'primary' }),
      components.button({ id: customId.build('ticket', 'open'), label: 'Start a Project', emoji: EMOJIS.ticket, style: 'secondary' }),
    ]),
  };
}

/** Reviews header panel — the satisfaction summary. */
async function reviewsPanel(guild, config) {
  const [summary, top] = await Promise.all([
    Review.summary(guild.id),
    Review.topServices(guild.id, 1),
  ]);

  return {
    embeds: [reviewService.summaryEmbed(summary, config, { topService: top[0] })],
    components: components.rows([
      components.button({ id: customId.build('review', 'start'), label: 'Leave a Review', emoji: EMOJIS.star, style: 'primary' }),
      components.button({ id: customId.build('review', 'featured'), label: 'Featured Reviews', emoji: '🏆', style: 'secondary' }),
    ]),
  };
}

/** The ticket launcher. */
async function ticketPanel(guild, config) {
  const enabled = config.tickets?.enabledTypes ?? [];
  const available = TICKET_TYPES.filter((type) => !enabled.length || enabled.includes(type.key));

  return {
    embeds: [embeds.panel({
      config,
      title: `${EMOJIS.ticket} Start a Request`,
      description:
        'Open a private channel with our team. Every request is logged, tracked and answered — ' +
        'nothing gets lost in a direct message.\n\n' +
        '**How it works**\n' +
        `${EMOJIS.arrow} Choose the service you need\n` +
        `${EMOJIS.arrow} Complete a short project brief\n` +
        `${EMOJIS.arrow} Receive a fixed-price quote before any work begins\n` +
        `${EMOJIS.arrow} Track progress and delivery in your own channel`,
      fields: [
        {
          name: 'Available Services',
          value: available.map((type) => `${type.emoji} **${type.label}** — ${type.description}`).join('\n'),
        },
        {
          name: 'Before you open a ticket',
          value:
            `${EMOJIS.bullet} One ticket per project, please\n` +
            `${EMOJIS.bullet} Include as much detail as you can\n` +
            `${EMOJIS.bullet} Never share passwords or tokens — we will never ask for them`,
        },
      ],
      footer: 'Your ticket is private: only you and the team can see it.',
    })],
    components: components.ticketPanelButtons(),
  };
}

/** Live developer status panel. */
const statusPanel = async (guild, config) => ({ embeds: [businessService.statusEmbed(config)] });

/** Office hours panel. */
const hoursPanel = async (guild, config) => ({ embeds: [businessService.hoursEmbed(config)] });

/** Public statistics dashboard. */
async function statisticsPanel(guild, config) {
  const stats = await statisticsService.overview(guild.id);

  return {
    embeds: [embeds.panel({
      config,
      title: `${EMOJIS.stats} Studio Performance`,
      description: 'Live metrics, updated automatically. Numbers we are happy to be judged on.',
      fields: [
        { name: 'Projects Delivered', value: `**${number(stats.orders.completed)}**\n${number(stats.orders.completedLast30)} in the last 30 days`, inline: true },
        { name: 'Customers Served', value: `**${number(stats.customers.total)}**\n${number(stats.customers.repeat)} returning`, inline: true },
        { name: 'Tickets Handled', value: `**${number(stats.tickets.closed)}**\n${number(stats.tickets.open)} open now`, inline: true },
        {
          name: 'Average Rating',
          value: stats.reviews.total ? `**${stats.reviews.average.toFixed(2)} / 5**\n${stars(Math.round(stats.reviews.average))}` : '_No reviews yet_',
          inline: true,
        },
        {
          name: 'First Response',
          value: stats.performance.averageFirstResponseMinutes !== null
            ? `**${duration(stats.performance.averageFirstResponseMinutes * 60_000, { compact: true })}**\naverage, last 30 days`
            : '_Not enough data_',
          inline: true,
        },
        {
          name: 'Satisfaction',
          value: stats.performance.satisfaction !== null
            ? `**${stats.performance.satisfaction}%**\n4★ or higher`
            : '_Not enough data_',
          inline: true,
        },
        {
          name: 'Delivery',
          value: stats.performance.averageCompletionHours !== null
            ? `Average build time: **${stats.performance.averageCompletionHours}h**`
            : 'Average build time: _not enough data_',
        },
      ],
      footer: 'Refreshed automatically',
    })],
  };
}

/** Public project queue. */
async function queuePanel(guild, config) {
  const snapshot = await orderService.queueSnapshot(guild.id);
  const capacity = config.queue?.concurrentCapacity ?? 3;

  const rows = snapshot.active.slice(0, 10).map((order, index) => [
    `#${index + 1}`,
    truncate(TICKET_TYPE_MAP[order.serviceType]?.label ?? order.serviceType, 18),
    ORDER_STATUSES[order.status]?.label ?? order.status,
    order.estimatedDelivery ? new Date(order.estimatedDelivery).toISOString().slice(0, 10) : 'TBC',
  ]);

  return {
    embeds: [embeds.panel({
      config,
      color: snapshot.size >= capacity * 2 ? COLORS.warning : COLORS.primary,
      title: `${EMOJIS.queue} Project Queue`,
      description: snapshot.size
        ? `**${snapshot.size}** project${snapshot.size === 1 ? '' : 's'} in the pipeline. ` +
          `We work on **${capacity}** at a time so nothing is rushed.`
        : 'The queue is currently empty — new projects start immediately.',
      fields: [
        { name: 'In Progress', value: String(snapshot.counts.inProgress), inline: true },
        { name: 'Queued', value: String(snapshot.counts.queued + snapshot.counts.accepted), inline: true },
        { name: 'Under Review', value: String(snapshot.counts.review), inline: true },
        { name: 'Awaiting Quote', value: String(snapshot.counts.pending), inline: true },
        { name: 'Paused', value: String(snapshot.counts.paused), inline: true },
        { name: 'Delivered (30d)', value: String(snapshot.counts.completedLast30), inline: true },
        ...(rows.length ? [{ name: 'Pipeline', value: table(['#', 'Service', 'Status', 'ETA'], rows) }] : []),
      ],
      footer: 'Project titles and customers are kept private.',
    })],
    components: components.rows([
      components.button({ id: customId.build('queue', 'mine'), label: 'My Position', emoji: EMOJIS.user, style: 'secondary' }),
    ]),
  };
}

/** Internal staff performance board. */
async function performancePanel(guild, config) {
  const [byClosed, byRating] = await Promise.all([
    statisticsService.leaderboard(guild.id, 'tickets.closed', 5),
    statisticsService.leaderboard(guild.id, 'reviews.average', 5),
  ]);

  const format = (entries, render) => (entries.length
    ? entries.map((entry, index) => `${medal(index)} <@${entry.userId}> — ${render(entry)}`).join('\n')
    : '_No data yet_');

  return {
    embeds: [embeds.panel({
      config,
      title: `${EMOJIS.staff} Team Performance`,
      description: 'Internal leaderboard. Updated as tickets close and reviews arrive.',
      fields: [
        { name: 'Tickets Closed', value: format(byClosed, (entry) => `**${entry.tickets?.closed ?? 0}** closed · ${entry.tickets?.claimed ?? 0} claimed`) },
        {
          name: 'Customer Rating',
          value: format(
            byRating.filter((entry) => (entry.reviews?.count ?? 0) > 0),
            (entry) => `**${(entry.reviews?.average ?? 0).toFixed(2)}** from ${entry.reviews?.count ?? 0} reviews`,
          ),
        },
        {
          name: 'Response Times',
          value: format(
            byClosed.filter((entry) => entry.responses?.averageFirstResponseMinutes !== null),
            (entry) => `first reply **${duration((entry.responses?.averageFirstResponseMinutes ?? 0) * 60_000, { compact: true })}**`,
          ),
        },
      ],
      footer: 'Staff only',
    })],
    components: components.statusButtons(),
  };
}

/** Registry of every panel the bot owns. */
const PANELS = {
  welcome: { build: welcomePanel, channel: 'welcome' },
  rules: { build: rulesPanel, channel: 'rules' },
  faq: { build: faqPanel, channel: 'faq' },
  tos: { build: tosPanel, channel: 'tos' },
  pricing: { build: pricingPanel, channel: 'pricing' },
  portfolio: { build: portfolioPanel, channel: 'portfolio' },
  reviews: { build: reviewsPanel, channel: 'reviews' },
  ticket: { build: ticketPanel, channel: 'createTicket' },
  status: { build: statusPanel, channel: 'developerStatus' },
  hours: { build: hoursPanel, channel: 'workingHours' },
  statistics: { build: statisticsPanel, channel: 'statistics' },
  queue: { build: queuePanel, channel: 'queue' },
  performance: { build: performancePanel, channel: 'staffPerformance' },
};

// ── Publication ──────────────────────────────────────────────────────────────

/**
 * Publish (or re-publish) a single panel.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} config
 * @param {string} key panel key
 * @param {string} [channelId] override the configured destination
 * @returns {Promise<import('discord.js').Message|null>}
 */
async function publish(guild, config, key, channelId = null) {
  const definition = PANELS[key];
  if (!definition) throw new Error(`Unknown panel: ${key}`);

  const targetId = channelId ?? config.channels?.[definition.channel];
  const channel = targetId ? await resolveTextChannel(guild, targetId) : null;
  if (!channel) return null;

  const payload = await definition.build(guild, config);
  const stored = config.panels?.[key];

  // Edit in place when the stored message still exists.
  if (stored?.messageId && stored.channelId === channel.id) {
    const existing = await attempt(() => channel.messages.fetch(stored.messageId), { label: `fetch ${key} panel` });
    if (existing?.editable) {
      const edited = await attempt(() => existing.edit(payload), { label: `edit ${key} panel` });
      if (edited) return edited;
    }
  }

  const message = await safeSend(channel, payload);
  if (!message) return null;

  await configService.update(guild, (cfg) => {
    cfg.setPath(`panels.${key}`, { channelId: channel.id, messageId: message.id, updatedAt: new Date() });
  });

  // Panels that anchor a channel are pinned so they stay reachable.
  if (['ticket', 'status', 'queue', 'reviews'].includes(key)) {
    await attempt(() => message.pin(), { label: `pin ${key} panel` });
  }

  return message;
}

/**
 * Refresh a panel in place. Silently does nothing when the panel was never
 * published — refresh must never create surprise messages.
 */
async function refresh(guild, config, key) {
  const stored = config.panels?.[key];
  if (!stored?.messageId) return null;
  return publish(guild, config, key);
}

/**
 * Refresh every panel that changes over time.
 * Called by the scheduler on a slow cadence.
 */
async function refreshDynamic(guild, config) {
  const dynamic = ['status', 'hours', 'statistics', 'queue', 'reviews', 'performance'];
  let refreshed = 0;
  for (const key of dynamic) {
    // eslint-disable-next-line no-await-in-loop -- sequential to respect rate limits
    const message = await refresh(guild, config, key).catch(() => null);
    if (message) refreshed += 1;
  }
  return refreshed;
}

/**
 * Publish every panel during setup.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} config
 * @param {Array<{panel: string, channelId: string}>} targets
 * @param {(message: string) => void} [onWarning]
 */
async function publishAll(guild, config, targets, onWarning = () => {}) {
  let published = 0;
  for (const target of targets) {
    if (!PANELS[target.panel]) continue;
    try {
      // eslint-disable-next-line no-await-in-loop -- sequential to respect rate limits
      const message = await publish(guild, await configService.get(guild, { fresh: true }), target.panel, target.channelId);
      if (message) published += 1;
      else onWarning(`Panel \`${target.panel}\` could not be published.`);
    } catch (err) {
      onWarning(`Panel \`${target.panel}\` failed: ${err.message}`);
      log.warn(`Panel ${target.panel} failed`, { message: err.message });
    }
  }
  return published;
}

module.exports = { PANELS, publish, refresh, refreshDynamic, publishAll };
