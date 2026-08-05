'use strict';

/**
 * /order — manage the project pipeline.
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const orderService = require('../../services/orderService');
const embeds = require('../../utils/embeds');
const components = require('../../utils/components');
const customId = require('../../utils/customId');
const validators = require('../../utils/validators');
const errors = require('../../utils/errors');
const permissions = require('../../utils/permissions');
const { Order } = require('../../database/models');
const { ORDER_STATUSES } = require('../../config/server');
const { EMOJIS } = require('../../config/branding');
const { safeReply, safeDefer } = require('../../utils/discord');
const { padId, money, table, truncate } = require('../../utils/formatters');

module.exports = {
  access: 'support',
  cooldown: 3,
  requiresSetup: true,

  data: new SlashCommandBuilder()
    .setName('order')
    .setDescription('Manage customer orders and the delivery pipeline.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false)

    .addSubcommand((sub) => sub
      .setName('view')
      .setDescription('Show an order in full.')
      .addIntegerOption((option) => option.setName('number').setDescription('Order number.').setRequired(true).setMinValue(1)))

    .addSubcommand((sub) => sub
      .setName('list')
      .setDescription('List orders.')
      .addStringOption((option) => option
        .setName('status')
        .setDescription('Filter by status.')
        .addChoices(...Object.entries(ORDER_STATUSES).map(([value, meta]) => ({ name: meta.label, value }))))
      .addUserOption((option) => option.setName('customer').setDescription('Filter by customer.'))
      .addUserOption((option) => option.setName('developer').setDescription('Filter by assigned developer.')))

    .addSubcommand((sub) => sub
      .setName('status')
      .setDescription('Move an order to a new status.')
      .addIntegerOption((option) => option.setName('number').setDescription('Order number.').setRequired(true).setMinValue(1))
      .addStringOption((option) => option
        .setName('status')
        .setDescription('New status.')
        .setRequired(true)
        .addChoices(...Object.entries(ORDER_STATUSES).map(([value, meta]) => ({ name: `${meta.emoji} ${meta.label}`, value }))))
      .addStringOption((option) => option.setName('note').setDescription('Note shown to the customer.')))

    .addSubcommand((sub) => sub
      .setName('quote')
      .setDescription('Send a fixed-price quote to the customer.')
      .addIntegerOption((option) => option.setName('number').setDescription('Order number.').setRequired(true).setMinValue(1)))

    .addSubcommand((sub) => sub
      .setName('assign')
      .setDescription('Assign an order to a developer.')
      .addIntegerOption((option) => option.setName('number').setDescription('Order number.').setRequired(true).setMinValue(1))
      .addUserOption((option) => option.setName('developer').setDescription('Who takes it.').setRequired(true)))

    .addSubcommand((sub) => sub
      .setName('progress')
      .setDescription('Update the completion percentage of an order.')
      .addIntegerOption((option) => option.setName('number').setDescription('Order number.').setRequired(true).setMinValue(1))
      .addIntegerOption((option) => option.setName('percent').setDescription('0-100').setRequired(true).setMinValue(0).setMaxValue(100)))

    .addSubcommand((sub) => sub
      .setName('complete')
      .setDescription('Mark an order as delivered and complete.')
      .addIntegerOption((option) => option.setName('number').setDescription('Order number.').setRequired(true).setMinValue(1)))

    .addSubcommand((sub) => sub
      .setName('cancel')
      .setDescription('Cancel an order.')
      .addIntegerOption((option) => option.setName('number').setDescription('Order number.').setRequired(true).setMinValue(1))
      .addStringOption((option) => option.setName('reason').setDescription('Why it is being cancelled.')))

    .addSubcommand((sub) => sub
      .setName('move')
      .setDescription('Move an order to a different position in the queue.')
      .addIntegerOption((option) => option.setName('number').setDescription('Order number.').setRequired(true).setMinValue(1))
      .addIntegerOption((option) => option.setName('position').setDescription('New position, starting at 1.').setRequired(true).setMinValue(1))),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ config: object, member: import('discord.js').GuildMember }} context
   */
  async execute(interaction, { config, member }) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    const symbol = config.business?.currencySymbol ?? '$';

    if (sub === 'list') {
      await safeDefer(interaction, { ephemeral: true });
      const query = { guildId: guild.id };
      const status = interaction.options.getString('status');
      const customer = interaction.options.getUser('customer');
      const developer = interaction.options.getUser('developer');
      if (status) query.status = status;
      if (customer) query.userId = customer.id;
      if (developer) query.assignedTo = developer.id;

      const orders = await Order.find(query).sort({ createdAt: -1 }).limit(20).lean();
      if (!orders.length) {
        return safeReply(interaction, {
          embeds: [embeds.notice('No orders match that filter.', 'info', config)],
        }, { ephemeral: true });
      }

      const rows = orders.map((order) => [
        `#${padId(order.number)}`,
        truncate(order.title, 20),
        ORDER_STATUSES[order.status]?.label ?? order.status,
        order.quote?.amount !== null && order.quote?.amount !== undefined ? money(order.quote.amount, symbol) : '—',
      ]);

      return safeReply(interaction, {
        embeds: [embeds.info({
          config,
          title: `${EMOJIS.order} Orders`,
          description: table(['ID', 'Project', 'Status', 'Value'], rows),
          footer: `${orders.length} shown`,
        })],
      }, { ephemeral: true });
    }

    const order = await orderService.byNumber(guild.id, interaction.options.getInteger('number'));

    switch (sub) {
      case 'view':
        return safeReply(interaction, {
          embeds: [orderService.orderEmbed(order, config)],
          components: components.rows([
            components.button({ id: customId.build('order', 'quote', order._id.toString()), label: 'Send Quote', emoji: EMOJIS.pricing, style: 'primary' }),
            components.button({ id: customId.build('order', 'status', order._id.toString()), label: 'Update Status', emoji: EMOJIS.order, style: 'secondary' }),
            components.button({ id: customId.build('order', 'assign', order._id.toString()), label: 'Assign', emoji: EMOJIS.staff, style: 'secondary' }),
            components.button({ id: customId.build('order', 'complete', order._id.toString()), label: 'Complete', emoji: EMOJIS.success, style: 'success' }),
          ]),
        }, { ephemeral: true });

      case 'status': {
        const status = interaction.options.getString('status');
        const note = validators.clean(interaction.options.getString('note') ?? '', { max: 1000 });
        if (status === 'completed') {
          await orderService.complete({ guild, order, actor: member, config });
        } else {
          await orderService.setStatus(guild, order, status, member, config, note);
        }
        return safeReply(interaction, {
          embeds: [embeds.success({
            config,
            title: 'Order Updated',
            description: `Order **#${padId(order.number)}** is now **${ORDER_STATUSES[status].label}**.`,
          })],
        }, { ephemeral: true });
      }

      case 'quote':
        return interaction.showModal(components.modal({
          id: customId.build('order', 'quoteSubmit', order._id.toString()),
          title: `Quote · Order #${padId(order.number)}`,
          fields: [
            { id: 'amount', label: 'Quoted amount', placeholder: '250', max: 20 },
            { id: 'deadline', label: 'Delivery estimate', placeholder: 'e.g. 7 working days', required: false, max: 100 },
            { id: 'scope', label: 'What the quote covers', style: 'paragraph', required: false, max: 1200 },
          ],
        }));

      case 'assign': {
        permissions.assertLevel(member, 'manager', config, 'assign orders');
        const developer = await guild.members.fetch(interaction.options.getUser('developer').id).catch(() => null);
        if (!developer) throw new errors.NotFoundError('That member is not in this server.');
        if (!permissions.isStaff(developer, config)) {
          throw new errors.ValidationError('Orders can only be assigned to a member of the team.');
        }
        await orderService.assign(guild, order, developer, member, config);
        return safeReply(interaction, {
          embeds: [embeds.success({ config, title: 'Order Assigned', description: `Order **#${padId(order.number)}** is now with <@${developer.id}>.` })],
        }, { ephemeral: true });
      }

      case 'progress': {
        const value = interaction.options.getInteger('percent');
        order.progress = value;
        if (value > 0 && order.status === 'queued') {
          await orderService.setStatus(guild, order, 'in-progress', member, config, 'Work started');
        } else {
          await order.save();
        }
        return safeReply(interaction, {
          embeds: [embeds.success({ config, title: 'Progress Updated', description: `Order **#${padId(order.number)}** is **${value}%** complete.` })],
        }, { ephemeral: true });
      }

      case 'complete':
        return interaction.showModal(components.modal({
          id: customId.build('order', 'completeSubmit', order._id.toString()),
          title: `Complete Order #${padId(order.number)}`,
          fields: [
            { id: 'amount', label: 'Final invoiced amount', required: false, placeholder: order.quote?.amount ? String(order.quote.amount) : '250', max: 20 },
            { id: 'note', label: 'Delivery note', style: 'paragraph', required: false, max: 1000 },
          ],
        }));

      case 'cancel': {
        permissions.assertLevel(member, 'manager', config, 'cancel orders');
        const reason = validators.clean(interaction.options.getString('reason') ?? '', { max: 500 });
        await orderService.cancel(guild, order, member, config, reason);
        return safeReply(interaction, {
          embeds: [embeds.warning({ config, title: 'Order Cancelled', description: `Order **#${padId(order.number)}** has been cancelled.` })],
        }, { ephemeral: true });
      }

      case 'move': {
        const position = interaction.options.getInteger('position') - 1;
        const placed = await orderService.moveInQueue(guild.id, order, position);
        await orderService.recalculateEstimates(guild.id, config);
        return safeReply(interaction, {
          embeds: [embeds.success({
            config,
            title: 'Queue Updated',
            description: `Order **#${padId(order.number)}** is now at position **#${placed + 1}**.`,
          })],
        }, { ephemeral: true });
      }

      default:
        throw new errors.ValidationError('Unknown subcommand.');
    }
  },
};
