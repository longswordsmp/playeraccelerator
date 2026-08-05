'use strict';

/**
 * Review submission.
 */

const reviewService = require('../../services/reviewService');
const embeds = require('../../utils/embeds');
const validators = require('../../utils/validators');
const errors = require('../../utils/errors');
const { Ticket } = require('../../database/models');
const { stars } = require('../../config/branding');
const { safeReply, safeDefer } = require('../../utils/discord');

module.exports = {
  namespace: 'review',
  access: 'everyone',

  actions: {
    submit: {
      async run(interaction, { config, args }) {
        const [ticketId, ratingRaw] = args;
        const rating = Number(ratingRaw);

        const ticket = await Ticket.findOne({ _id: ticketId, guildId: interaction.guildId });
        if (!ticket) throw new errors.NotFoundError('That ticket no longer exists.');

        await safeDefer(interaction, { ephemeral: true });

        const get = (id) => {
          try {
            return interaction.fields.getTextInputValue(id);
          } catch {
            return '';
          }
        };

        const review = await reviewService.submit({
          guild: interaction.guild,
          ticket,
          user: interaction.user,
          rating,
          answers: {
            feedback: validators.text(get('feedback'), 'Feedback', { max: 2000, min: 5 }),
            liked: validators.clean(get('liked'), { max: 1000 }),
            improvements: validators.clean(get('improvements'), { max: 1000 }),
            recommend: validators.clean(get('recommend'), { max: 200, allowNewlines: false }),
            additional: validators.clean(get('additional'), { max: 1000 }),
          },
          config,
        });

        return safeReply(interaction, {
          embeds: [embeds.success({
            config,
            title: 'Thank you',
            description:
              `Your ${stars(rating)} review has been recorded.` +
              (review.approved
                ? ' It is now published in the reviews channel.'
                : ' A member of the team will review it before it is published.'),
            footer: 'Feedback like this is how the studio improves.',
          })],
        }, { ephemeral: true });
      },
    },
  },
};
