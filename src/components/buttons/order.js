'use strict';

/**
 * Order controls posted alongside a project brief: quote, status and assignment.
 */

const embeds = require('../../utils/embeds');
const componentsUtil = require('../../utils/components');
const customId = require('../../utils/customId');
const errors = require('../../utils/errors');
const { Order } = require('../../database/models');
const { ORDER_STATUSES } = require('../../config/server');
const { EMOJIS } = require('../../config/branding');
const { safeReply } = require('../../utils/discord');
const { padId } = require('../../utils/formatters');

/** Resolve the order a control refers to. */
async function resolveOrder(interaction, args) {
  const order = await Order.findOne({ _id: args[0], guildId: interaction.guildId });
  if (!order) throw new errors.NotFoundError('That order no longer exists.');
  return order;
}

module.exports = {
  namespace: 'order',
  access: 'support',

  actions: {
    quote: {
      async run(interaction, { args }) {
        const order = await resolveOrder(interaction, args);
        return interaction.showModal(componentsUtil.modal({
          id: customId.build('order', 'quoteSubmit', order._id.toString()),
          title: `Quote · Order #${padId(order.number)}`,
          fields: [
            { id: 'amount', label: 'Quoted amount', placeholder: '250', max: 20 },
            { id: 'deadline', label: 'Delivery estimate', placeholder: 'e.g. 7 working days', required: false, max: 100 },
            {
              id: 'scope',
              label: 'What the quote covers',
              style: 'paragraph',
              required: false,
              placeholder: 'Deliverables, revisions included, anything explicitly out of scope.',
              max: 1200,
            },
          ],
        }));
      },
    },

    status: {
      async run(interaction, { config, args }) {
        const order = await resolveOrder(interaction, args);
        return safeReply(interaction, {
          embeds: [embeds.info({
            config,
            title: `${EMOJIS.order} Update Order #${padId(order.number)}`,
            description: `Currently **${ORDER_STATUSES[order.status]?.label ?? order.status}**.`,
          })],
          components: [componentsUtil.row(componentsUtil.select({
            id: customId.build('order', 'statusSelect', order._id.toString()),
            placeholder: 'Move this order to…',
            options: Object.entries(ORDER_STATUSES)
              .filter(([key]) => key !== order.status)
              .slice(0, 25)
              .map(([key, meta]) => ({ label: meta.label, value: key, emoji: meta.emoji })),
          }))],
        }, { ephemeral: true });
      },
    },

    assign: {
      access: 'manager',
      async run(interaction, { config, args }) {
        const order = await resolveOrder(interaction, args);
        return safeReply(interaction, {
          embeds: [embeds.info({
            config,
            title: `${EMOJIS.staff} Assign Order #${padId(order.number)}`,
            description: order.assignedTo ? `Currently assigned to <@${order.assignedTo}>.` : 'This order is unassigned.',
          })],
          components: [componentsUtil.row(componentsUtil.userSelect({
            id: customId.build('order', 'assignTo', order._id.toString()),
            placeholder: 'Choose a developer…',
          }))],
        }, { ephemeral: true });
      },
    },

    complete: {
      async run(interaction, { args }) {
        const order = await resolveOrder(interaction, args);
        return interaction.showModal(componentsUtil.modal({
          id: customId.build('order', 'completeSubmit', order._id.toString()),
          title: `Complete Order #${padId(order.number)}`,
          fields: [
            {
              id: 'amount',
              label: 'Final invoiced amount',
              placeholder: order.quote?.amount ? String(order.quote.amount) : '250',
              required: false,
              max: 20,
            },
            { id: 'note', label: 'Delivery note', style: 'paragraph', required: false, placeholder: 'What was delivered, and where.', max: 1000 },
          ],
        }));
      },
    },
  },
};
