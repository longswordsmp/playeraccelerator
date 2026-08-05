'use strict';

/**
 * Promotion decision and internal-note modals.
 */

const promotionService = require('../../services/promotionService');
const embeds = require('../../utils/embeds');
const validators = require('../../utils/validators');
const errors = require('../../utils/errors');
const { Promotion } = require('../../database/models');
const { safeReply, safeDefer } = require('../../utils/discord');
const { padId } = require('../../utils/formatters');

/** Resolve the application a modal refers to. */
async function resolveApplication(interaction, args) {
  const application = await Promotion.findOne({ _id: validators.objectId(args[0], 'application'), guildId: interaction.guildId });
  if (!application) throw new errors.NotFoundError('That application no longer exists.');
  return application;
}

module.exports = {
  namespace: 'promotion',
  access: 'support',

  actions: {
    decisionSubmit: {
      access: 'support',
      async run(interaction, { config, member, args }) {
        const [, status] = args;
        const application = await resolveApplication(interaction, args);

        // Approving or declining is a manager decision; asking for more
        // information is not.
        if (['approved', 'declined'].includes(status)) {
          require('../../utils/permissions').assertLevel(member, 'manager', config, 'approve or decline promotion applications');
        }

        await safeDefer(interaction, { ephemeral: true });
        const reason = validators.clean(interaction.fields.getTextInputValue('reason'), { max: 900 });

        await promotionService.decide({
          guild: interaction.guild,
          application,
          status,
          actor: member,
          reason,
          config,
        });

        return safeReply(interaction, {
          embeds: [embeds.notice(
            `Application \`#${padId(application.number, 3)}\` marked **${promotionService.STATUS_META[status].label}**. The applicant has been notified.`,
            'success',
            config,
          )],
        }, { ephemeral: true });
      },
    },

    noteSubmit: {
      async run(interaction, { config, member, args }) {
        const application = await resolveApplication(interaction, args);
        const contentText = validators.text(interaction.fields.getTextInputValue('content'), 'Note', { max: 900 });
        await promotionService.addNote(application, contentText, member);
        return safeReply(interaction, {
          embeds: [embeds.notice('Internal note saved.', 'success', config)],
        }, { ephemeral: true });
      },
    },
  },
};
