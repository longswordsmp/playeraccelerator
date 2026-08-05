'use strict';

/**
 * Order select menus: status transitions and developer assignment.
 */

const orderService = require('../../services/orderService');
const embeds = require('../../utils/embeds');
const errors = require('../../utils/errors');
const permissions = require('../../utils/permissions');
const { Order } = require('../../database/models');
const { ORDER_STATUSES } = require('../../config/server');
const { padId } = require('../../utils/formatters');

/** Resolve the order a menu refers to. */
async function resolveOrder(interaction, args) {
  const order = await Order.findOne({ _id: args[0], guildId: interaction.guildId });
  if (!order) throw new errors.NotFoundError('That order no longer exists.');
  return order;
}

module.exports = {
  namespace: 'order',
  access: 'support',

  actions: {
    statusSelect: {
      async run(interaction, { config, member, args }) {
        const order = await resolveOrder(interaction, args);
        const status = interaction.values[0];

        if (status === 'completed') {
          await orderService.complete({ guild: interaction.guild, order, actor: member, config });
        } else {
          await orderService.setStatus(interaction.guild, order, status, member, config);
        }

        return interaction.update({
          embeds: [embeds.notice(
            `Order **#${padId(order.number)}** is now **${ORDER_STATUSES[status].label}**.`,
            'success',
            config,
          )],
          components: [],
        }).catch(() => null);
      },
    },

    assignTo: {
      access: 'manager',
      async run(interaction, { config, member, args }) {
        const order = await resolveOrder(interaction, args);
        const developer = await interaction.guild.members.fetch(interaction.values[0]).catch(() => null);
        if (!developer) throw new errors.NotFoundError('That member is not in this server.');
        if (!permissions.isStaff(developer, config)) {
          throw new errors.ValidationError('Orders can only be assigned to a member of the team.');
        }

        await orderService.assign(interaction.guild, order, developer, member, config);
        return interaction.update({
          embeds: [embeds.notice(`Order **#${padId(order.number)}** assigned to <@${developer.id}>.`, 'success', config)],
          components: [],
        }).catch(() => null);
      },
    },
  },
};
