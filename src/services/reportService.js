'use strict';

/**
 * Automated business reporting.
 *
 * Produces the daily staff summary and the weekly business report, both posted
 * to the internal business-reports channel. The weekly report includes a
 * chart-ready data series so the numbers can be exported without re-querying.
 */

const statisticsService = require('./statisticsService');
const configService = require('./configService');
const orderService = require('./orderService');
const embeds = require('../utils/embeds');
const { EMOJIS, COLORS, stars } = require('../config/branding');
const { safeSend } = require('../utils/discord');
const { number, money, duration, medal, table, keyValueBlock } = require('../utils/formatters');
const { logger } = require('../utils/logger');

const log = logger.child('reports');

/** Format a growth delta as a signed percentage with a direction glyph. */
function growth(value) {
  if (value === null || value === undefined) return '—';
  const glyph = value > 0 ? '▲' : value < 0 ? '▼' : '▬';
  return `${glyph} ${value > 0 ? '+' : ''}${value}%`;
}

/**
 * Build the daily summary embed.
 * @param {import('discord.js').Guild} guild
 * @param {object} config
 */
async function buildDaily(guild, config) {
  const summary = await statisticsService.dailySummary(guild.id);
  const totals = summary.totals;
  const symbol = config.business?.currencySymbol ?? '$';

  const leaderboard = summary.topStaff.length
    ? summary.topStaff
      .map((entry, index) => `${medal(index)} <@${entry.userId}> — ${entry.tickets?.closed ?? 0} closed`)
      .join('\n')
    : '_No ticket activity recorded_';

  return embeds.base({
    config,
    color: COLORS.primary,
    title: `${EMOJIS.stats} Daily Summary · ${summary.date}`,
    description: 'Yesterday at a glance. Generated automatically.',
    fields: [
      {
        name: 'Customers',
        value: keyValueBlock([
          ['New members', number(totals.joins)],
          ['Departures', number(totals.leaves)],
          ['New customers', number(totals.newCustomers)],
        ]),
        inline: true,
      },
      {
        name: 'Tickets',
        value: keyValueBlock([
          ['Opened', number(totals.ticketsOpened)],
          ['Closed', number(totals.ticketsClosed)],
          ['Reopened', number(totals.ticketsReopened)],
          ['Open now', number(summary.openTickets)],
        ]),
        inline: true,
      },
      {
        name: 'Projects',
        value: keyValueBlock([
          ['Created', number(totals.ordersCreated)],
          ['Completed', number(totals.ordersCompleted)],
          ['Cancelled', number(totals.ordersCancelled)],
          ['In queue', number(summary.queueSize)],
        ]),
        inline: true,
      },
      {
        name: 'Service Levels',
        value: keyValueBlock([
          ['First response', totals.averageFirstResponse !== null ? duration(totals.averageFirstResponse * 60_000, { compact: true }) : '—'],
          ['Resolution', totals.averageResolution !== null ? duration(totals.averageResolution * 60_000, { compact: true }) : '—'],
          ['Reviews', `${number(totals.reviews)}${totals.averageRating ? ` (${totals.averageRating}★)` : ''}`],
          ['Revenue', money(totals.revenue, symbol)],
        ]),
        inline: true,
      },
      {
        name: 'Moderation',
        value: keyValueBlock([
          ['Warnings', number(totals.warnings)],
          ['Timeouts', number(totals.timeouts)],
          ['Kicks / bans', `${number(totals.kicks)} / ${number(totals.bans)}`],
          ['AutoMod hits', number(totals.automodHits)],
        ]),
        inline: true,
      },
      {
        name: 'System',
        value: keyValueBlock([
          ['Messages', number(totals.messages)],
          ['Commands', number(totals.commands)],
          ['Errors', number(totals.errors)],
          ['Security alerts', number(totals.raidAlerts + totals.nukeAlerts)],
        ]),
        inline: true,
      },
      { name: 'Top Performers', value: leaderboard },
    ],
    footer: 'Daily report',
  });
}

/**
 * Build the weekly business report.
 * @param {import('discord.js').Guild} guild
 * @param {object} config
 */
async function buildWeekly(guild, config) {
  const report = await statisticsService.weeklyReport(guild.id);
  const overview = await statisticsService.overview(guild.id);
  const snapshot = await orderService.queueSnapshot(guild.id);
  const symbol = config.business?.currencySymbol ?? '$';
  const { current, growth: delta } = report;

  const series = report.series.map((point) => [
    point.date.slice(5),
    String(point.ticketsOpened),
    String(point.ticketsClosed),
    String(point.ordersCompleted),
    money(point.revenue, symbol),
  ]);

  return embeds.base({
    config,
    color: COLORS.accent,
    title: `${EMOJIS.stats} Weekly Business Report`,
    description:
      `Performance over the last seven days, compared with the seven before it.\n\n` +
      `**Revenue** ${money(current.revenue, symbol)} · ${growth(delta.revenue)}\n` +
      `**Projects delivered** ${number(current.ordersCompleted)} · ${growth(delta.orders)}\n` +
      `**Tickets opened** ${number(current.ticketsOpened)} · ${growth(delta.tickets)}\n` +
      `**New customers** ${number(current.newCustomers)} · ${growth(delta.customers)}`,
    fields: [
      { name: 'Daily Breakdown', value: table(['Day', 'Open', 'Closed', 'Done', 'Revenue'], series) },
      {
        name: 'Service Quality',
        value: keyValueBlock([
          ['First response', current.averageFirstResponse !== null ? duration(current.averageFirstResponse * 60_000, { compact: true }) : '—'],
          ['Resolution', current.averageResolution !== null ? duration(current.averageResolution * 60_000, { compact: true }) : '—'],
          ['Build time', current.averageCompletionHours !== null ? `${current.averageCompletionHours}h` : '—'],
          ['Rating', report.reviews.total ? `${report.reviews.average}★ (${report.reviews.total})` : '—'],
        ]),
        inline: true,
      },
      {
        name: 'Pipeline',
        value: keyValueBlock([
          ['Awaiting quote', number(snapshot.counts.pending)],
          ['Queued', number(snapshot.counts.queued + snapshot.counts.accepted)],
          ['In progress', number(snapshot.counts.inProgress)],
          ['Under review', number(snapshot.counts.review)],
        ]),
        inline: true,
      },
      {
        name: 'Lifetime',
        value: keyValueBlock([
          ['Customers', number(overview.customers.total)],
          ['Repeat rate', `${overview.performance.repeatRate}%`],
          ['Projects', number(overview.orders.completed)],
          ['Avg rating', overview.reviews.total ? `${overview.reviews.average}★` : '—'],
        ]),
        inline: true,
      },
      {
        name: 'Team',
        value: report.topStaff.length
          ? report.topStaff.map((entry, index) => (
            `${medal(index)} <@${entry.userId}> — ${entry.tickets?.closed ?? 0} tickets` +
            `${entry.reviews?.count ? ` · ${stars(Math.round(entry.reviews.average))} ${entry.reviews.average}` : ''}`
          )).join('\n')
          : '_No data_',
      },
      {
        name: 'Safety',
        value: keyValueBlock([
          ['Warnings', number(current.warnings)],
          ['AutoMod hits', number(current.automodHits)],
          ['Blocked links', number(current.blockedLinks)],
          ['Raid / nuke alerts', `${number(current.raidAlerts)} / ${number(current.nukeAlerts)}`],
        ]),
        inline: true,
      },
    ],
    footer: 'Weekly report',
  });
}

/**
 * Generate and post the daily report.
 * @param {import('discord.js').Guild} guild
 */
async function postDaily(guild) {
  const config = await configService.get(guild);
  if (config.reports?.daily === false) return false;

  const channel = configService.logChannel(guild, config, 'business')
    ?? configService.channel(guild, config, 'staffChat');
  if (!channel) return false;

  const embed = await buildDaily(guild, config);
  await safeSend(channel, { embeds: [embed] });
  log.info(`Daily report posted for ${guild.name}`);
  return true;
}

/**
 * Generate and post the weekly report.
 * @param {import('discord.js').Guild} guild
 */
async function postWeekly(guild) {
  const config = await configService.get(guild);
  if (config.reports?.weekly === false) return false;

  const channel = configService.logChannel(guild, config, 'business')
    ?? configService.channel(guild, config, 'staffChat');
  if (!channel) return false;

  const embed = await buildWeekly(guild, config);
  await safeSend(channel, { embeds: [embed] });
  log.info(`Weekly report posted for ${guild.name}`);
  return true;
}

module.exports = { buildDaily, buildWeekly, postDaily, postWeekly, growth };
