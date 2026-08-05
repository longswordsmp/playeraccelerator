'use strict';

/**
 * /review — staff management of customer reviews.
 * /reviews — the public browsing surface.
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const reviewService = require('../../services/reviewService');
const embeds = require('../../utils/embeds');
const validators = require('../../utils/validators');
const errors = require('../../utils/errors');
const { Review } = require('../../database/models');
const { TICKET_TYPE_MAP } = require('../../config/server');
const { EMOJIS } = require('../../config/branding');
const { safeReply, safeDefer } = require('../../utils/discord');
const { padId, timestamp, truncate, table } = require('../../utils/formatters');

module.exports = {
  access: 'support',
  cooldown: 3,
  requiresSetup: true,

  data: new SlashCommandBuilder()
    .setName('review')
    .setDescription('Manage customer reviews.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false)

    .addSubcommand((sub) => sub
      .setName('view')
      .setDescription('Show a review in full.')
      .addIntegerOption((option) => option.setName('number').setDescription('Review number.').setRequired(true).setMinValue(1)))

    .addSubcommand((sub) => sub
      .setName('list')
      .setDescription('List reviews.')
      .addStringOption((option) => option
        .setName('filter')
        .setDescription('Which reviews to show.')
        .addChoices(
          { name: 'All', value: 'all' },
          { name: 'Awaiting approval', value: 'pending' },
          { name: 'Featured', value: 'featured' },
          { name: 'Hidden', value: 'hidden' },
          { name: 'Negative (2★ or lower)', value: 'negative' },
        ))
      .addUserOption((option) => option.setName('customer').setDescription('Filter by customer.'))
      .addUserOption((option) => option.setName('staff').setDescription('Filter by the staff member credited.')))

    .addSubcommand((sub) => sub
      .setName('approve')
      .setDescription('Approve and publish a review.')
      .addIntegerOption((option) => option.setName('number').setDescription('Review number.').setRequired(true).setMinValue(1)))

    .addSubcommand((sub) => sub
      .setName('reject')
      .setDescription('Reject a review so it is never published.')
      .addIntegerOption((option) => option.setName('number').setDescription('Review number.').setRequired(true).setMinValue(1))
      .addStringOption((option) => option.setName('reason').setDescription('Why it was rejected (internal).')))

    .addSubcommand((sub) => sub
      .setName('feature')
      .setDescription('Feature or unfeature a review.')
      .addIntegerOption((option) => option.setName('number').setDescription('Review number.').setRequired(true).setMinValue(1))
      .addBooleanOption((option) => option.setName('featured').setDescription('Feature it (default: true).')))

    .addSubcommand((sub) => sub
      .setName('hide')
      .setDescription('Hide or restore a published review.')
      .addIntegerOption((option) => option.setName('number').setDescription('Review number.').setRequired(true).setMinValue(1))
      .addBooleanOption((option) => option.setName('hidden').setDescription('Hide it (default: true).')))

    .addSubcommand((sub) => sub
      .setName('delete')
      .setDescription('Permanently delete a review.')
      .addIntegerOption((option) => option.setName('number').setDescription('Review number.').setRequired(true).setMinValue(1)))

    .addSubcommand((sub) => sub
      .setName('outstanding')
      .setDescription('Show five-star reviews with detailed feedback that are not yet featured.')),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ config: object, member: import('discord.js').GuildMember }} context
   */
  async execute(interaction, { config, member }) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;

    if (sub === 'list') {
      await safeDefer(interaction, { ephemeral: true });
      const filter = interaction.options.getString('filter') ?? 'all';
      const customer = interaction.options.getUser('customer');
      const staff = interaction.options.getUser('staff');

      const query = { guildId: guild.id };
      if (filter === 'pending') Object.assign(query, { approved: false, rejected: false });
      if (filter === 'featured') query.featured = true;
      if (filter === 'hidden') query.hidden = true;
      if (filter === 'negative') query.rating = { $lte: 2 };
      if (customer) query.userId = customer.id;
      if (staff) query.staffId = staff.id;

      const reviews = await Review.find(query).sort({ createdAt: -1 }).limit(20).lean();
      if (!reviews.length) {
        return safeReply(interaction, {
          embeds: [embeds.notice('No reviews match that filter.', 'info', config)],
        }, { ephemeral: true });
      }

      const rows = reviews.map((review) => [
        `#${padId(review.number)}`,
        `${review.rating}★`,
        truncate(review.username || review.userId, 16),
        truncate(TICKET_TYPE_MAP[review.serviceType]?.label ?? review.serviceType ?? '—', 16),
        review.featured ? 'featured' : review.hidden ? 'hidden' : review.approved ? 'live' : 'pending',
      ]);

      return safeReply(interaction, {
        embeds: [embeds.info({
          config,
          title: `${EMOJIS.star} Reviews`,
          description: table(['ID', 'Rating', 'Customer', 'Service', 'State'], rows),
          footer: `${reviews.length} shown`,
        })],
      }, { ephemeral: true });
    }

    if (sub === 'outstanding') {
      await safeDefer(interaction, { ephemeral: true });
      const candidates = await reviewService.outstanding(guild.id, 5);
      if (!candidates.length) {
        return safeReply(interaction, {
          embeds: [embeds.notice('No unfeatured five-star reviews with detailed feedback right now.', 'info', config)],
        }, { ephemeral: true });
      }
      return safeReply(interaction, {
        embeds: [
          embeds.info({
            config,
            title: `${EMOJIS.star} Feature-worthy reviews`,
            description: `${candidates.length} five-star review${candidates.length === 1 ? '' : 's'} with substantial written feedback.\nFeature one with \`/review feature number:<id>\`.`,
          }),
          ...candidates.slice(0, 4).map((review) => reviewService.reviewEmbed(review, config)),
        ],
      }, { ephemeral: true });
    }

    const review = await reviewService.byNumber(guild.id, interaction.options.getInteger('number'));

    switch (sub) {
      case 'view':
        return safeReply(interaction, {
          embeds: [
            reviewService.reviewEmbed(review, config),
            embeds.info({
              config,
              title: 'Internal detail',
              fields: [
                { name: 'State', value: review.rejected ? 'Rejected' : review.hidden ? 'Hidden' : review.approved ? 'Published' : 'Awaiting approval', inline: true },
                { name: 'Featured', value: review.featured ? 'Yes' : 'No', inline: true },
                { name: 'Ticket', value: review.ticketNumber ? `#${padId(review.ticketNumber)}` : '—', inline: true },
                { name: 'Order', value: review.orderNumber ? `#${padId(review.orderNumber)}` : '—', inline: true },
                { name: 'Submitted', value: timestamp(review.createdAt, 'relative'), inline: true },
                ...(review.additional ? [{ name: 'Additional comments', value: truncate(review.additional, 1000) }] : []),
                ...(review.rejectReason ? [{ name: 'Rejection reason', value: truncate(review.rejectReason, 500) }] : []),
              ],
            }),
          ],
        }, { ephemeral: true });

      case 'approve':
        await reviewService.approve(guild, review, member, config);
        return safeReply(interaction, {
          embeds: [embeds.success({ config, title: 'Review Approved', description: `Review \`#${padId(review.number)}\` is now published.` })],
        }, { ephemeral: true });

      case 'reject': {
        const reason = validators.clean(interaction.options.getString('reason') ?? '', { max: 500 });
        await reviewService.reject(guild, review, member, config, reason);
        return safeReply(interaction, {
          embeds: [embeds.warning({ config, title: 'Review Rejected', description: `Review \`#${padId(review.number)}\` will not be published.` })],
        }, { ephemeral: true });
      }

      case 'feature': {
        const featured = interaction.options.getBoolean('featured') ?? true;
        await reviewService.setFeatured(guild, review, featured, member, config);
        return safeReply(interaction, {
          embeds: [embeds.success({
            config,
            title: featured ? 'Review Featured' : 'Review Unfeatured',
            description: `Review \`#${padId(review.number)}\` has been ${featured ? 'featured and pinned' : 'unfeatured'}.`,
          })],
        }, { ephemeral: true });
      }

      case 'hide': {
        const hidden = interaction.options.getBoolean('hidden') ?? true;
        await reviewService.setHidden(guild, review, hidden, member, config);
        return safeReply(interaction, {
          embeds: [embeds.success({
            config,
            title: hidden ? 'Review Hidden' : 'Review Restored',
            description: `Review \`#${padId(review.number)}\` is now ${hidden ? 'hidden from the public channel' : 'visible again'}.`,
          })],
        }, { ephemeral: true });
      }

      case 'delete': {
        require('../../utils/permissions').assertLevel(member, 'manager', config, 'delete reviews');
        await reviewService.remove(guild, review, member, config);
        return safeReply(interaction, {
          embeds: [embeds.warning({
            config,
            title: 'Review Deleted',
            description: `Review \`#${padId(review.number)}\` has been permanently removed and the staff average recalculated.`,
          })],
        }, { ephemeral: true });
      }

      default:
        throw new errors.ValidationError('Unknown subcommand.');
    }
  },
};
