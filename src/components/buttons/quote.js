'use strict';

/**
 * Customer-facing quote actions.
 *
 * Only the customer who owns the order may accept it — the ownership check is
 * the whole point of this handler.
 */

const orderService = require('../../services/orderService');
const embeds = require('../../utils/embeds');
const errors = require('../../utils/errors');
const validators = require('../../utils/validators');
const { Order } = require('../../database/models');
const { safeReply, safeSend, resolveTextChannel } = require('../../utils/discord');
const { padId, money, timestamp } = require('../../utils/formatters');

/** Resolve the order and verify the presser owns it. */
async function resolveOwnOrder(interaction, args) {
  const order = await Order.findOne({ _id: validators.objectId(args[0], 'order'), guildId: interaction.guildId });
  if (!order) throw new errors.NotFoundError('That order no longer exists.');
  if (order.userId !== interaction.user.id) {
    // Staff can look, but only the customer can accept on their behalf.
    const permissions = require('../../utils/permissions');
    const config = await require('../../services/configService').get(interaction.guild);
    if (!permissions.isStaff(interaction.member, config)) {
      throw new errors.PermissionError('Only the customer who placed this order can respond to the quote.');
    }
  }
  return order;
}

module.exports = {
  namespace: 'quote',
  access: 'everyone',

  actions: {
    accept: {
      async run(interaction, { config, member, args }) {
        const order = await resolveOwnOrder(interaction, args);

        if (order.quote?.acceptedAt) {
          throw new errors.ConflictError('This quote has already been accepted.');
        }
        if (!order.quote?.amount && order.quote?.amount !== 0) {
          throw new errors.ConflictError('No quote has been sent for this order yet.');
        }

        order.quote.acceptedAt = new Date();
        await order.save();
        await orderService.setStatus(interaction.guild, order, 'accepted', member, config, 'Quote accepted by the customer');
        await orderService.recalculateEstimates(interaction.guildId, config);

        const fresh = await Order.findById(order._id).lean();
        const symbol = config.business?.currencySymbol ?? '$';

        // Confirm publicly in the ticket so staff see it without being pinged.
        const channel = await resolveTextChannel(interaction.guild, order.channelId);
        await safeSend(channel, {
          embeds: [embeds.success({
            config,
            title: 'Quote Accepted',
            description:
              `<@${order.userId}> accepted the quote of **${money(order.quote.amount, symbol)}** for ` +
              `**${order.title}**.\n\nThe project has been added to the queue.`,
            fields: [
              { name: 'Queue position', value: fresh?.queuePosition !== null && fresh?.queuePosition !== undefined ? `#${fresh.queuePosition + 1}` : 'Calculating…', inline: true },
              ...(fresh?.estimatedStart ? [{ name: 'Estimated start', value: timestamp(fresh.estimatedStart, 'longDate'), inline: true }] : []),
              ...(fresh?.estimatedDelivery ? [{ name: 'Estimated delivery', value: timestamp(fresh.estimatedDelivery, 'longDate'), inline: true }] : []),
              { name: 'Next step', value: 'An invoice for the deposit follows shortly. Work begins once it clears.' },
            ],
            footer: `Order #${padId(order.number)}`,
          })],
        });

        // Disable the buttons so the quote cannot be accepted twice.
        await interaction.update({ components: [] }).catch(() => null);

        return safeReply(interaction, {
          embeds: [embeds.notice('Thank you — your project is queued. Watch this channel for the invoice.', 'success', config)],
        }, { ephemeral: true, followUp: true });
      },
    },

    question: {
      async run(interaction, { config }) {
        return safeReply(interaction, {
          embeds: [embeds.info({
            config,
            title: 'Ask away',
            description:
              'Post your question in this channel and a member of the team will answer it.\n\n' +
              'Quotes are fixed-price and valid for 14 days, so there is no rush to decide.',
          })],
        }, { ephemeral: true });
      },
    },
  },
};
