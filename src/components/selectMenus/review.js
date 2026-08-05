'use strict';

/**
 * Review select menu — choose which completed ticket to review, then show the
 * star buttons for it.
 */

const embeds = require('../../utils/embeds');
const components = require('../../utils/components');
const errors = require('../../utils/errors');
const validators = require('../../utils/validators');
const { Ticket } = require('../../database/models');
const { EMOJIS } = require('../../config/branding');
const { padId } = require('../../utils/formatters');

module.exports = {
  namespace: 'review',
  access: 'everyone',

  actions: {
    pick: {
      async run(interaction, { config }) {
        const ticketId = interaction.values[0];
        const ticket = await Ticket.findOne({ _id: validators.objectId(ticketId, 'ticket'), guildId: interaction.guildId });
        if (!ticket) throw new errors.NotFoundError('That ticket no longer exists.');
        if (ticket.userId !== interaction.user.id) {
          throw new errors.PermissionError('Only the customer who opened this ticket can review it.');
        }
        if (ticket.review?.submitted) {
          throw new errors.ConflictError('You have already reviewed this ticket. Thank you!');
        }

        return interaction.update({
          embeds: [embeds.info({
            config,
            title: `${EMOJIS.star} How would you rate this engagement?`,
            description:
              `**Ticket #${padId(ticket.number)}** · ${ticket.typeLabel || ticket.type}\n\n` +
              'Pick a rating, then tell us a little about the experience. ' +
              'Your review is published publicly and is never edited.',
          })],
          components: components.reviewStars(ticket._id.toString()),
        }).catch(() => null);
      },
    },
  },
};
