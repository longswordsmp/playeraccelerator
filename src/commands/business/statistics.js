'use strict';

/**
 * /statistics — the business dashboard.
 */

const { SlashCommandBuilder, version: djsVersion } = require('discord.js');

const statisticsService = require('../../services/statisticsService');
const reportService = require('../../services/reportService');
const database = require('../../database/connection');
const scheduler = require('../../services/schedulerService');
const embeds = require('../../utils/embeds');
const permissions = require('../../utils/permissions');
const { TICKET_TYPE_MAP } = require('../../config/server');
const { EMOJIS, stars } = require('../../config/branding');
const { safeReply, safeDefer } = require('../../utils/discord');
const { number, money, percent, duration, keyValueBlock, table, bytes } = require('../../utils/formatters');

module.exports = {
  access: 'everyone',
  cooldown: 10,
  requiresSetup: false,

  data: new SlashCommandBuilder()
    .setName('statistics')
    .setDescription('Studio performance metrics.')
    .setDMPermission(false)
    .addSubcommand((sub) => sub
      .setName('overview')
      .setDescription('The headline business numbers.'))
    .addSubcommand((sub) => sub
      .setName('tickets')
      .setDescription('Ticket volume, categories and response times.')
      .addIntegerOption((option) => option.setName('days').setDescription('Window in days (default 30).').setMinValue(1).setMaxValue(365)))
    .addSubcommand((sub) => sub
      .setName('reviews')
      .setDescription('Customer satisfaction breakdown.'))
    .addSubcommand((sub) => sub
      .setName('daily')
      .setDescription('Today\'s activity summary (staff only).'))
    .addSubcommand((sub) => sub
      .setName('weekly')
      .setDescription('The weekly business report (staff only).'))
    .addSubcommand((sub) => sub
      .setName('system')
      .setDescription('Bot runtime health (staff only).')),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ config: object, member: import('discord.js').GuildMember, client: object }} context
   */
  async execute(interaction, { config, member, client }) {
    const sub = interaction.options.getSubcommand();
    await safeDefer(interaction, { ephemeral: true });
    const symbol = config.business?.currencySymbol ?? '$';

    if (['daily', 'weekly', 'system'].includes(sub)) {
      permissions.assertLevel(member, 'support', config, 'view internal reports');
    }

    switch (sub) {
      case 'overview': {
        const stats = await statisticsService.overview(interaction.guildId);
        const isStaff = permissions.isStaff(member, config);

        return safeReply(interaction, {
          embeds: [embeds.info({
            config,
            title: `${EMOJIS.stats} Studio Overview`,
            description: 'Lifetime figures, with the last 30 days for context.',
            fields: [
              {
                name: 'Delivery',
                value: keyValueBlock([
                  ['Completed', number(stats.orders.completed)],
                  ['Active', number(stats.orders.active)],
                  ['Last 30d', number(stats.orders.completedLast30)],
                  ['Avg build', stats.performance.averageCompletionHours !== null ? `${stats.performance.averageCompletionHours}h` : '—'],
                ]),
                inline: true,
              },
              {
                name: 'Customers',
                value: keyValueBlock([
                  ['Total', number(stats.customers.total)],
                  ['VIP', number(stats.customers.vip)],
                  ['Returning', number(stats.customers.repeat)],
                  ['Repeat rate', `${stats.performance.repeatRate}%`],
                ]),
                inline: true,
              },
              {
                name: 'Support',
                value: keyValueBlock([
                  ['Open', number(stats.tickets.open)],
                  ['Closed', number(stats.tickets.closed)],
                  ['Opened 30d', number(stats.tickets.openedLast30)],
                  ['First reply', stats.performance.averageFirstResponseMinutes !== null
                    ? duration(stats.performance.averageFirstResponseMinutes * 60_000, { compact: true })
                    : '—'],
                ]),
                inline: true,
              },
              {
                name: 'Satisfaction',
                value: stats.reviews.total
                  ? `${stars(Math.round(stats.reviews.average))} **${stats.reviews.average.toFixed(2)} / 5** across ${number(stats.reviews.total)} reviews\n` +
                    `${percent(stats.reviews.positive, stats.reviews.total)} rated 4★ or higher`
                  : '_No reviews yet_',
              },
              ...(isStaff && config.business?.trackSpending !== false
                ? [{
                  name: 'Revenue (staff only)',
                  value: keyValueBlock([
                    ['Lifetime', money(stats.revenue.lifetime, symbol)],
                    ['Last 30 days', money(stats.revenue.last30, symbol)],
                  ]),
                  inline: true,
                }]
                : []),
              ...(isStaff
                ? [{
                  name: 'Moderation (staff only)',
                  value: keyValueBlock([
                    ['Warnings', number(stats.moderation.last30.warnings)],
                    ['Timeouts', number(stats.moderation.last30.timeouts)],
                    ['AutoMod', number(stats.moderation.last30.automodHits)],
                  ]),
                  inline: true,
                }]
                : []),
            ],
            footer: 'Updated live',
          })],
        }, { ephemeral: true });
      }

      case 'tickets': {
        const days = interaction.options.getInteger('days') ?? 30;
        const stats = await statisticsService.ticketStats(interaction.guildId, days);

        const typeRows = stats.byType.slice(0, 10).map((entry) => [
          (TICKET_TYPE_MAP[entry._id]?.label ?? entry._id).slice(0, 22),
          String(entry.count),
          entry.avgFirstResponse ? duration(entry.avgFirstResponse * 60_000, { compact: true }) : '—',
        ]);

        return safeReply(interaction, {
          embeds: [embeds.info({
            config,
            title: `${EMOJIS.ticket} Ticket Statistics · last ${days} days`,
            fields: [
              { name: 'By service', value: typeRows.length ? table(['Service', 'Count', 'First reply'], typeRows) : '_No tickets in this window_' },
              {
                name: 'By priority',
                value: keyValueBlock(stats.byPriority.map((entry) => [entry._id, String(entry.count)])) || '—',
                inline: true,
              },
              {
                name: 'By status (all time)',
                value: keyValueBlock(stats.byStatus.map((entry) => [entry._id, String(entry.count)])) || '—',
                inline: true,
              },
              { name: 'Unclaimed right now', value: String(stats.unclaimed), inline: true },
            ],
          })],
        }, { ephemeral: true });
      }

      case 'reviews': {
        const { Review } = require('../../database/models');
        const [summary, topServices] = await Promise.all([
          Review.summary(interaction.guildId),
          Review.topServices(interaction.guildId, 5),
        ]);

        const reviewService = require('../../services/reviewService');
        return safeReply(interaction, {
          embeds: [
            reviewService.summaryEmbed(summary, config, { topService: topServices[0] }),
            ...(topServices.length
              ? [embeds.info({
                config,
                title: 'By service',
                fields: topServices.map((entry) => ({
                  name: TICKET_TYPE_MAP[entry._id]?.label ?? entry._id,
                  value: `${stars(Math.round(entry.average))} **${entry.average.toFixed(2)}** from ${entry.count} review${entry.count === 1 ? '' : 's'}`,
                  inline: true,
                })),
              })]
              : []),
          ],
        }, { ephemeral: true });
      }

      case 'daily':
        return safeReply(interaction, {
          embeds: [await reportService.buildDaily(interaction.guild, config)],
        }, { ephemeral: true });

      case 'weekly':
        return safeReply(interaction, {
          embeds: [await reportService.buildWeekly(interaction.guild, config)],
        }, { ephemeral: true });

      case 'system': {
        const memory = process.memoryUsage();
        const health = database.health();

        return safeReply(interaction, {
          embeds: [embeds.info({
            config,
            title: `${EMOJIS.bolt} System Health`,
            fields: [
              {
                name: 'Runtime',
                value: keyValueBlock([
                  ['Uptime', duration(client.uptime)],
                  ['Node', process.version],
                  ['discord.js', `v${djsVersion}`],
                  ['Memory', bytes(memory.heapUsed)],
                ]),
                inline: true,
              },
              {
                name: 'Gateway',
                value: keyValueBlock([
                  ['Ping', `${Math.max(0, Math.round(client.ws.ping))}ms`],
                  ['Guilds', number(client.guilds.cache.size)],
                  ['Users cached', number(client.users.cache.size)],
                  ['Channels', number(client.channels.cache.size)],
                ]),
                inline: true,
              },
              {
                name: 'Database',
                value: keyValueBlock([
                  ['State', health.state],
                  ['Database', health.database ?? '—'],
                  ['Models', String(health.models)],
                ]),
                inline: true,
              },
              {
                name: 'Activity since boot',
                value: keyValueBlock([
                  ['Commands', number(client.metrics.commandsExecuted)],
                  ['Components', number(client.metrics.componentsHandled)],
                  ['Events', number(client.metrics.eventsHandled)],
                  ['Errors', number(client.metrics.errors)],
                ]),
                inline: true,
              },
              {
                name: 'Registered',
                value: keyValueBlock([
                  ['Commands', String(client.commands.size)],
                  ['Buttons', String(client.buttons.size)],
                  ['Menus', String(client.selectMenus.size)],
                  ['Modals', String(client.modals.size)],
                  ['Jobs', String(scheduler.status().length)],
                ]),
                inline: true,
              },
            ],
            footer: 'Staff diagnostics',
          })],
        }, { ephemeral: true });
      }

      default:
        return null;
    }
  },
};
