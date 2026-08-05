'use strict';

/**
 * /customer — the customer profile: orders, tickets, reviews and history.
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const statisticsService = require('../../services/statisticsService');
const embeds = require('../../utils/embeds');
const permissions = require('../../utils/permissions');
const { ORDER_STATUSES, TICKET_TYPE_MAP } = require('../../config/server');
const { EMOJIS, stars } = require('../../config/branding');
const { safeReply, safeDefer } = require('../../utils/discord');
const { padId, money, timestamp, keyValueBlock, truncate, number } = require('../../utils/formatters');

module.exports = {
  access: 'support',
  cooldown: 5,
  requiresSetup: false,

  data: new SlashCommandBuilder()
    .setName('customer')
    .setDescription('Look up a customer profile.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false)
    .addUserOption((option) => option
      .setName('user')
      .setDescription('Whose profile to open. Defaults to you.')),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ config: object, member: import('discord.js').GuildMember }} context
   */
  async execute(interaction, { config, member }) {
    const target = interaction.options.getUser('user') ?? interaction.user;

    // Customers may look at their own profile; staff may look at anyone's.
    if (target.id !== interaction.user.id) {
      permissions.assertLevel(member, 'support', config, 'view other customers\' profiles');
    }

    await safeDefer(interaction, { ephemeral: true });
    const profile = await statisticsService.customerProfile(interaction.guildId, target.id);

    if (!profile) {
      return safeReply(interaction, {
        embeds: [embeds.notice(`No records exist for ${target.tag} in this server.`, 'info', config)],
      }, { ephemeral: true });
    }

    const { user, summary, orders, tickets, reviews, warnings } = profile;
    const symbol = config.business?.currencySymbol ?? '$';
    const isStaff = permissions.isStaff(member, config);

    const orderLines = orders.slice(0, 5).map((order) => (
      `${ORDER_STATUSES[order.status]?.emoji ?? ''} **#${padId(order.number)}** ${truncate(order.title, 40)} — ` +
      `${ORDER_STATUSES[order.status]?.label ?? order.status}` +
      (order.quote?.amount ? ` · ${money(order.quote.amount, symbol)}` : '')
    ));

    const ticketLines = tickets.slice(0, 5).map((ticket) => (
      `**#${padId(ticket.number)}** ${truncate(ticket.typeLabel || ticket.type, 30)} — ${ticket.status}` +
      ` · ${timestamp(ticket.createdAt, 'relative')}`
    ));

    return safeReply(interaction, {
      embeds: [embeds.info({
        config,
        author: { name: target.tag, iconURL: target.displayAvatarURL({ size: 128 }) },
        title: `${user?.isVip ? '💎 ' : user?.isCustomer ? `${EMOJIS.customer} ` : `${EMOJIS.user} `}Customer Profile`,
        description:
          `<@${target.id}>\n` +
          `${user?.isVip ? '**VIP customer**' : user?.isCustomer ? '**Customer**' : 'Not yet a customer'}` +
          `${user?.customerSince ? ` since ${timestamp(user.customerSince, 'longDate')}` : ''}`,
        thumbnail: target.displayAvatarURL({ size: 256 }),
        fields: [
          {
            name: 'Engagement',
            value: keyValueBlock([
              ['Orders', number(summary.totalOrders)],
              ['Completed', number(summary.completedOrders)],
              ['Tickets', number(summary.totalTickets)],
              ['Reviews', number(reviews.length)],
            ]),
            inline: true,
          },
          {
            name: 'Standing',
            value: keyValueBlock([
              ['Repeat', summary.isRepeat ? 'Yes' : 'No'],
              ['Favourite', summary.favouriteService ? (TICKET_TYPE_MAP[summary.favouriteService]?.label ?? summary.favouriteService).slice(0, 18) : '—'],
              ['Rating given', summary.averageRatingGiven !== null ? `${summary.averageRatingGiven}` : '—'],
              ['Last active', summary.lastActivity ? new Date(summary.lastActivity).toISOString().slice(0, 10) : '—'],
            ]),
            inline: true,
          },
          ...(isStaff && config.business?.trackSpending !== false
            ? [{
              name: 'Commercial',
              value: keyValueBlock([
                ['Lifetime spend', money(summary.totalSpent, symbol)],
                ['Joined', user?.firstJoinedAt ? new Date(user.firstJoinedAt).toISOString().slice(0, 10) : '—'],
                ['Warnings', String(warnings)],
              ]),
              inline: true,
            }]
            : []),
          ...(orderLines.length ? [{ name: 'Recent orders', value: orderLines.join('\n') }] : []),
          ...(isStaff && ticketLines.length ? [{ name: 'Recent tickets', value: ticketLines.join('\n') }] : []),
          ...(reviews.length
            ? [{
              name: 'Reviews left',
              value: reviews.slice(0, 3).map((review) => (
                `${stars(review.rating)} — ${truncate(review.feedback || '_no written feedback_', 120)}`
              )).join('\n'),
            }]
            : []),
        ],
        footer: isStaff && warnings > 0 ? `${warnings} active warning(s) — see /history` : undefined,
      })],
    }, { ephemeral: true });
  },
};
