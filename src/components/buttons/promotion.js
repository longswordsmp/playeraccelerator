'use strict';

/**
 * Promotion application review controls (staff only).
 */

const embeds = require('../../utils/embeds');
const componentsUtil = require('../../utils/components');
const customId = require('../../utils/customId');
const errors = require('../../utils/errors');
const { Promotion } = require('../../database/models');
const { EMOJIS } = require('../../config/branding');
const { safeReply } = require('../../utils/discord');
const { padId } = require('../../utils/formatters');
const content = require('../../config/content');

/** Resolve the application a control refers to. */
async function resolveApplication(interaction, args) {
  const application = await Promotion.findOne({ _id: args[0], guildId: interaction.guildId });
  if (!application) throw new errors.NotFoundError('That application no longer exists.');
  return application;
}

/** Build the decision modal for approve / decline / changes. */
function decisionModal(application, status) {
  const titles = {
    approved: 'Approve Application',
    declined: 'Decline Application',
    'changes-requested': 'Request More Information',
  };
  const placeholders = {
    approved: 'What is being offered, and when. This is sent to the applicant.',
    declined: 'A short, honest reason. This is sent to the applicant.',
    'changes-requested': 'What do you need to know before deciding?',
  };

  return componentsUtil.modal({
    id: customId.build('promotion', 'decisionSubmit', application._id.toString(), status),
    title: `${titles[status]} · #${padId(application.number, 3)}`,
    fields: [{
      id: 'reason',
      label: 'Message to the applicant',
      style: 'paragraph',
      required: status !== 'approved',
      placeholder: placeholders[status],
      max: 900,
    }],
  });
}

module.exports = {
  namespace: 'promotion',
  access: 'everyone',

  actions: {
    // ── Customer entry point ──────────────────────────────────────────────
    start: {
      async run(interaction, { config }) {
        if (config.promotion?.enabled === false) {
          throw new errors.ConflictError('The promotion partnership programme is not accepting applications right now.');
        }

        const doc = content.PROMOTION;
        return safeReply(interaction, {
          embeds: [embeds.panel({
            config,
            title: `${EMOJIS.promotion} ${doc.title}`,
            description: doc.intro.replace('100+ concurrent viewers', config.promotion?.audienceSize ?? '100+ concurrent viewers'),
            fields: doc.sections,
            footer: doc.footer,
          })],
          components: componentsUtil.rows([
            componentsUtil.button({
              id: customId.build('ticket', 'quickOpen', 'promotion'),
              label: 'Apply Now',
              emoji: EMOJIS.promotion,
              style: 'primary',
            }),
          ]),
        }, { ephemeral: true });
      },
    },

    // ── Staff decisions ───────────────────────────────────────────────────
    approve: {
      access: 'manager',
      async run(interaction, { args }) {
        const application = await resolveApplication(interaction, args);
        return interaction.showModal(decisionModal(application, 'approved'));
      },
    },

    decline: {
      access: 'manager',
      async run(interaction, { args }) {
        const application = await resolveApplication(interaction, args);
        return interaction.showModal(decisionModal(application, 'declined'));
      },
    },

    changes: {
      access: 'support',
      async run(interaction, { args }) {
        const application = await resolveApplication(interaction, args);
        return interaction.showModal(decisionModal(application, 'changes-requested'));
      },
    },

    note: {
      access: 'support',
      async run(interaction, { args }) {
        const application = await resolveApplication(interaction, args);
        return interaction.showModal(componentsUtil.modal({
          id: customId.build('promotion', 'noteSubmit', application._id.toString()),
          title: `Internal Note · #${padId(application.number, 3)}`,
          fields: [{
            id: 'content',
            label: 'Note (never shown to the applicant)',
            style: 'paragraph',
            placeholder: 'Your read on this server, concerns, follow-ups.',
            max: 900,
          }],
        }));
      },
    },
  },
};
