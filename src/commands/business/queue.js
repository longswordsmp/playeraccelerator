'use strict';

/**
 * /queue — the public project pipeline.
 */

const { SlashCommandBuilder } = require('discord.js');

const orderService = require('../../services/orderService');
const embeds = require('../../utils/embeds');
const permissions = require('../../utils/permissions');
const { ORDER_STATUSES, TICKET_TYPE_MAP } = require('../../config/server');
const { EMOJIS } = require('../../config/branding');
const { safeReply, safeDefer } = require('../../utils/discord');
const { padId, timestamp, table, truncate } = require('../../utils/formatters');

module.exports = {
  access: 'everyone',
  cooldown: 5,
  requiresSetup: true,

  data: new SlashCommandBuilder()
    .setName('queue')
    .setDescription('See the current project queue.')
    .setDMPermission(false)
    .addBooleanOption((option) => option
      .setName('detailed')
      .setDescription('Show project names and customers (staff only).')),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ config: object, member: import('discord.js').GuildMember }} context
   */
  async execute(interaction, { config, member }) {
    await safeDefer(interaction, { ephemeral: true });

    const detailed = interaction.options.getBoolean('detailed') && permissions.isStaff(member, config);
    const snapshot = await orderService.queueSnapshot(interaction.guildId);
    const capacity = config.queue?.concurrentCapacity ?? 3;

    const rows = snapshot.active.slice(0, 15).map((order, index) => (detailed
      ? [
        `#${index + 1}`,
        `#${padId(order.number)}`,
        truncate(order.title, 20),
        ORDER_STATUSES[order.status]?.label ?? order.status,
      ]
      : [
        `#${index + 1}`,
        truncate(TICKET_TYPE_MAP[order.serviceType]?.label ?? order.serviceType, 20),
        ORDER_STATUSES[order.status]?.label ?? order.status,
        order.estimatedDelivery ? new Date(order.estimatedDelivery).toISOString().slice(0, 10) : 'TBC',
      ]));

    const mine = await orderService.positionFor(interaction.guildId, interaction.user.id);

    return safeReply(interaction, {
      embeds: [embeds.info({
        config,
        title: `${EMOJIS.queue} Project Queue`,
        description: snapshot.size
          ? `**${snapshot.size}** active project${snapshot.size === 1 ? '' : 's'} · we work on **${capacity}** at a time.`
          : 'The queue is empty — new projects start immediately.',
        fields: [
          { name: 'In progress', value: String(snapshot.counts.inProgress), inline: true },
          { name: 'Queued', value: String(snapshot.counts.queued + snapshot.counts.accepted), inline: true },
          { name: 'Under review', value: String(snapshot.counts.review), inline: true },
          { name: 'Awaiting quote', value: String(snapshot.counts.pending), inline: true },
          { name: 'Paused', value: String(snapshot.counts.paused), inline: true },
          { name: 'Delivered (30d)', value: String(snapshot.counts.completedLast30), inline: true },
          ...(rows.length
            ? [{
              name: 'Pipeline',
              value: table(detailed ? ['#', 'ID', 'Project', 'Status'] : ['#', 'Service', 'Status', 'ETA'], rows),
            }]
            : []),
          ...(mine.length
            ? [{
              name: 'Your projects',
              value: mine.map((entry) => (
                `**#${padId(entry.number)}** ${truncate(entry.title, 40)} — position **#${entry.position}**` +
                (entry.estimatedDelivery ? ` · delivery ${timestamp(entry.estimatedDelivery, 'longDate')}` : '')
              )).join('\n'),
            }]
            : []),
        ],
        footer: 'Estimates are projections based on current capacity, not commitments.',
      })],
    }, { ephemeral: true });
  },
};
