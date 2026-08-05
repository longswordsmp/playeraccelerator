'use strict';

/**
 * /leaderboard — team performance rankings.
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const statisticsService = require('../../services/statisticsService');
const embeds = require('../../utils/embeds');
const { EMOJIS, stars } = require('../../config/branding');
const { safeReply, safeDefer } = require('../../utils/discord');
const { medal, duration, money } = require('../../utils/formatters');

/** Which metrics can be ranked, and how each row renders. */
const METRICS = {
  'tickets.closed': {
    label: 'Tickets Closed',
    render: (entry) => `**${entry.tickets?.closed ?? 0}** closed · ${entry.tickets?.claimed ?? 0} claimed`,
  },
  'tickets.claimed': {
    label: 'Tickets Claimed',
    render: (entry) => `**${entry.tickets?.claimed ?? 0}** claimed`,
  },
  'orders.completed': {
    label: 'Projects Delivered',
    render: (entry) => `**${entry.orders?.completed ?? 0}** delivered · ${entry.orders?.assigned ?? 0} assigned`,
  },
  'orders.revenue': {
    label: 'Revenue Delivered',
    render: (entry, symbol) => `**${money(entry.orders?.revenue ?? 0, symbol)}**`,
    staffOnly: true,
  },
  'reviews.average': {
    label: 'Customer Rating',
    render: (entry) => (entry.reviews?.count
      ? `${stars(Math.round(entry.reviews.average))} **${entry.reviews.average.toFixed(2)}** from ${entry.reviews.count} review${entry.reviews.count === 1 ? '' : 's'}`
      : '_no reviews yet_'),
    filter: (entry) => (entry.reviews?.count ?? 0) > 0,
  },
  'moderation.warningsIssued': {
    label: 'Moderation Actions',
    render: (entry) => (
      `**${entry.moderation?.warningsIssued ?? 0}** warnings · ` +
      `${entry.moderation?.timeoutsIssued ?? 0} timeouts · ` +
      `${entry.moderation?.bansIssued ?? 0} bans`
    ),
  },
};

module.exports = {
  access: 'support',
  cooldown: 10,
  requiresSetup: false,

  data: new SlashCommandBuilder()
    .setName('leaderboard')
    .setDescription('Team performance rankings.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false)
    .addStringOption((option) => option
      .setName('metric')
      .setDescription('What to rank by.')
      .addChoices(...Object.entries(METRICS).map(([value, meta]) => ({ name: meta.label, value }))))
    .addIntegerOption((option) => option
      .setName('limit')
      .setDescription('How many places to show (default 10).')
      .setMinValue(3)
      .setMaxValue(25)),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ config: object }} context
   */
  async execute(interaction, { config }) {
    await safeDefer(interaction, { ephemeral: true });

    const metric = interaction.options.getString('metric') ?? 'tickets.closed';
    const limit = interaction.options.getInteger('limit') ?? 10;
    const definition = METRICS[metric] ?? METRICS['tickets.closed'];
    const symbol = config.business?.currencySymbol ?? '$';

    const entries = await statisticsService.leaderboard(interaction.guildId, metric, limit);
    const filtered = definition.filter ? entries.filter(definition.filter) : entries;

    if (!filtered.length) {
      return safeReply(interaction, {
        embeds: [embeds.notice('No performance data has been recorded yet.', 'info', config)],
      }, { ephemeral: true });
    }

    // Show a second view of response times — the metric customers actually feel.
    const responders = [...entries]
      .filter((entry) => entry.responses?.averageFirstResponseMinutes !== null && entry.responses?.averageFirstResponseMinutes !== undefined)
      .sort((a, b) => a.responses.averageFirstResponseMinutes - b.responses.averageFirstResponseMinutes)
      .slice(0, 5);

    return safeReply(interaction, {
      embeds: [embeds.info({
        config,
        title: `${EMOJIS.staff} Leaderboard · ${definition.label}`,
        description: filtered
          .map((entry, index) => `${medal(index)} <@${entry.userId}> — ${definition.render(entry, symbol)}`)
          .join('\n'),
        fields: responders.length
          ? [{
            name: 'Fastest first response',
            value: responders
              .map((entry, index) => `${medal(index)} <@${entry.userId}> — **${duration(entry.responses.averageFirstResponseMinutes * 60_000, { compact: true })}**`)
              .join('\n'),
          }]
          : [],
        footer: `Top ${filtered.length}`,
      })],
    }, { ephemeral: true });
  },
};
