'use strict';

/**
 * Order modals: sending a quote and completing a project.
 */

const orderService = require('../../services/orderService');
const embeds = require('../../utils/embeds');
const componentsUtil = require('../../utils/components');
const customId = require('../../utils/customId');
const validators = require('../../utils/validators');
const errors = require('../../utils/errors');
const { Order } = require('../../database/models');
const { EMOJIS } = require('../../config/branding');
const { safeReply, safeDefer, safeSend, resolveTextChannel } = require('../../utils/discord');
const { padId, money, safeField } = require('../../utils/formatters');

/** Resolve the order a modal refers to. */
async function resolveOrder(interaction, args) {
  const order = await Order.findOne({ _id: validators.objectId(args[0], 'order'), guildId: interaction.guildId });
  if (!order) throw new errors.NotFoundError('That order no longer exists.');
  return order;
}

module.exports = {
  namespace: 'order',
  access: 'support',

  actions: {
    quoteSubmit: {
      async run(interaction, { config, member, args }) {
        const order = await resolveOrder(interaction, args);
        await safeDefer(interaction, { ephemeral: true });

        const amount = validators.num(interaction.fields.getTextInputValue('amount'), 'Quoted amount', {
          min: 0,
          max: 1_000_000,
        });
        const deadline = validators.clean(interaction.fields.getTextInputValue('deadline'), { max: 150, allowNewlines: false });
        const scope = validators.clean(interaction.fields.getTextInputValue('scope'), { max: 1500 });

        const symbol = config.business?.currencySymbol ?? '$';
        order.quote = {
          amount,
          currency: config.business?.currency ?? 'USD',
          sentAt: new Date(),
          acceptedAt: null,
          quotedBy: member.id,
        };
        if (deadline) order.requestedDeadline = deadline;
        if (scope) order.requirements = scope;
        await order.save();
        await orderService.setStatus(interaction.guild, order, 'quoted', member, config, scope);

        // Give the customer a one-click accept.
        const channel = await resolveTextChannel(interaction.guild, order.channelId);
        await safeSend(channel, {
          content: `<@${order.userId}>`,
          embeds: [embeds.base({
            config,
            title: `${EMOJIS.pricing} Your Quote`,
            description:
              `**${money(amount, symbol)}** for **${safeField(order.title, 150)}**.\n\n` +
              'This is a fixed price. Accepting adds your project to the queue and an invoice follows.',
            fields: [
              { name: 'Order', value: `\`#${padId(order.number)}\``, inline: true },
              { name: 'Price', value: money(amount, symbol), inline: true },
              ...(deadline ? [{ name: 'Delivery estimate', value: safeField(deadline, 200), inline: true }] : []),
              ...(scope ? [{ name: 'What this covers', value: safeField(scope, 1024) }] : []),
              { name: 'Terms', value: 'A 50% deposit secures your slot; the balance is due on delivery. Two rounds of revisions are included.' },
            ],
            footer: 'Quotes are valid for 14 days.',
          })],
          components: componentsUtil.rows([
            componentsUtil.button({ id: customId.build('quote', 'accept', order._id.toString()), label: 'Accept Quote', emoji: EMOJIS.success, style: 'success' }),
            componentsUtil.button({ id: customId.build('quote', 'question', order._id.toString()), label: 'I have a question', emoji: EMOJIS.info, style: 'secondary' }),
          ]),
        });

        return safeReply(interaction, {
          embeds: [embeds.notice(`Quote of ${money(amount, symbol)} sent for order **#${padId(order.number)}**.`, 'success', config)],
        }, { ephemeral: true });
      },
    },

    completeSubmit: {
      async run(interaction, { config, member, args }) {
        const order = await resolveOrder(interaction, args);
        await safeDefer(interaction, { ephemeral: true });

        const amountRaw = interaction.fields.getTextInputValue('amount');
        const amount = amountRaw
          ? validators.num(amountRaw, 'Final amount', { min: 0, max: 1_000_000, required: false })
          : null;
        const note = validators.clean(interaction.fields.getTextInputValue('note'), { max: 1000 });

        if (note) {
          order.notes = note;
          await order.save();
        }

        await orderService.complete({ guild: interaction.guild, order, actor: member, config, amount });

        return safeReply(interaction, {
          embeds: [embeds.notice(
            `Order **#${padId(order.number)}** marked complete. The customer has been notified and a review requested when the ticket closes.`,
            'success',
            config,
          )],
        }, { ephemeral: true });
      },
    },
  },
};
