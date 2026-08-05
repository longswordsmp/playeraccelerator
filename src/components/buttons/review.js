'use strict';

/**
 * Review buttons: the star picker, the "leave a review" entry point, and the
 * featured-review browser.
 */

const reviewService = require('../../services/reviewService');
const forms = require('../forms');
const embeds = require('../../utils/embeds');
const components = require('../../utils/components');
const customId = require('../../utils/customId');
const errors = require('../../utils/errors');
const validators = require('../../utils/validators');
const { Ticket, Review } = require('../../database/models');
const { EMOJIS } = require('../../config/branding');
const { safeReply } = require('../../utils/discord');
const { padId, truncate } = require('../../utils/formatters');

module.exports = {
  namespace: 'review',
  access: 'everyone',

  actions: {
    // ── Entry point: pick which completed ticket to review ─────────────────
    start: {
      async run(interaction, { config }) {
        if (config.reviews?.enabled === false) {
          throw new errors.ConflictError('Reviews are not being collected at the moment.');
        }

        const reviewable = await Ticket.find({
          guildId: interaction.guildId,
          userId: interaction.user.id,
          status: { $in: ['closed', 'archived'] },
          'review.submitted': { $ne: true },
        })
          .sort({ closedAt: -1 })
          .limit(20)
          .lean();

        if (!reviewable.length) {
          return safeReply(interaction, {
            embeds: [embeds.info({
              config,
              title: 'Nothing to review yet',
              description:
                'Reviews can only be left for a completed engagement, so that every review on this server ' +
                'comes from a real customer.\n\n' +
                'Once one of your tickets is closed you will be asked automatically.',
            })],
          }, { ephemeral: true });
        }

        return safeReply(interaction, {
          embeds: [embeds.info({
            config,
            title: `${EMOJIS.star} Leave a Review`,
            description: 'Which engagement would you like to review?',
          })],
          components: [components.row(components.select({
            id: customId.build('review', 'pick'),
            placeholder: 'Choose a completed ticket…',
            options: reviewable.map((ticket) => ({
              label: `#${padId(ticket.number)} · ${truncate(ticket.typeLabel || ticket.type, 40)}`,
              value: ticket._id.toString(),
              description: ticket.closedAt ? `Closed ${new Date(ticket.closedAt).toISOString().slice(0, 10)}` : undefined,
            })),
          }))],
        }, { ephemeral: true });
      },
    },

    // ── Star rating → open the written form ───────────────────────────────
    rate: {
      async run(interaction, { config, args }) {
        const [ticketId, ratingRaw] = args;
        const rating = Number(ratingRaw);
        if (!Number.isInteger(rating) || rating < 1 || rating > 5) {
          throw new errors.ValidationError('That rating is not valid.');
        }

        const ticket = await Ticket.findOne({ _id: validators.objectId(ticketId, 'ticket'), guildId: interaction.guildId });
        if (!ticket) throw new errors.NotFoundError('That ticket no longer exists.');
        if (ticket.userId !== interaction.user.id) {
          throw new errors.PermissionError('Only the customer who opened this ticket can review it.');
        }
        if (ticket.review?.submitted) {
          throw new errors.ConflictError('You have already reviewed this ticket. Thank you!');
        }

        return interaction.showModal(forms.reviewModal(ticketId, rating));
      },
    },

    // ── Featured reviews ──────────────────────────────────────────────────
    featured: {
      async run(interaction, { config }) {
        const featured = await Review.find({
          guildId: interaction.guildId,
          featured: true,
          approved: true,
          hidden: false,
        })
          .sort({ featuredAt: -1 })
          .limit(5)
          .lean();

        if (!featured.length) {
          return safeReply(interaction, {
            embeds: [embeds.info({
              config,
              title: 'No featured reviews yet',
              description: 'Outstanding reviews get highlighted here as they come in.',
            })],
          }, { ephemeral: true });
        }

        return safeReply(interaction, {
          embeds: featured.map((review) => reviewService.reviewEmbed(review, config)),
        }, { ephemeral: true });
      },
    },
  },
};
