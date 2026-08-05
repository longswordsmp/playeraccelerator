'use strict';

/**
 * Business surfaces: the status quick-switch, the queue position lookup and the
 * portfolio browser.
 */

const businessService = require('../../services/businessService');
const orderService = require('../../services/orderService');
const portfolioService = require('../../services/portfolioService');
const embeds = require('../../utils/embeds');
const componentsUtil = require('../../utils/components');
const customId = require('../../utils/customId');
const errors = require('../../utils/errors');
const { STATUSES, ORDER_STATUSES, TICKET_TYPE_MAP } = require('../../config/server');
const { EMOJIS } = require('../../config/branding');
const { safeReply } = require('../../utils/discord');
const { padId, timestamp, truncate } = require('../../utils/formatters');

module.exports = [
  // ── Developer status ──────────────────────────────────────────────────────
  {
    namespace: 'status',
    access: 'support',
    actions: {
      set: {
        async run(interaction, { config, member, args }) {
          const [status] = args;
          if (!STATUSES[status]) throw new errors.ValidationError('That is not a recognised status.');
          // The quick-switch buttons change availability only — an existing
          // status note is preserved, since clearing it was never asked for.
          await businessService.setStatus(interaction.guild, status, member, config.status?.note ?? '');
          return safeReply(interaction, {
            embeds: [embeds.notice(
              `Status set to ${STATUSES[status].emoji} **${STATUSES[status].label}**. The public panel has been updated.`,
              'success',
              config,
            )],
          }, { ephemeral: true });
        },
      },
    },
  },

  // ── Queue ─────────────────────────────────────────────────────────────────
  {
    namespace: 'queue',
    access: 'everyone',
    actions: {
      mine: {
        async run(interaction, { config }) {
          const positions = await orderService.positionFor(interaction.guildId, interaction.user.id);

          if (!positions.length) {
            return safeReply(interaction, {
              embeds: [embeds.info({
                config,
                title: 'Nothing in the queue',
                description:
                  'You have no active projects right now.\n\n' +
                  'Open a ticket to start one — you will get a fixed-price quote before any work begins.',
              })],
            }, { ephemeral: true });
          }

          return safeReply(interaction, {
            embeds: [embeds.info({
              config,
              title: `${EMOJIS.queue} Your Projects`,
              description: `You have **${positions.length}** active project${positions.length === 1 ? '' : 's'}.`,
              fields: positions.map((entry) => ({
                name: `#${padId(entry.number)} · ${truncate(entry.title, 60)}`,
                value:
                  `${ORDER_STATUSES[entry.status]?.emoji ?? ''} **${ORDER_STATUSES[entry.status]?.label ?? entry.status}** · ` +
                  `Position **#${entry.position}**\n` +
                  (entry.estimatedStart ? `Start: ${timestamp(entry.estimatedStart, 'longDate')}\n` : '') +
                  (entry.estimatedDelivery ? `Delivery: ${timestamp(entry.estimatedDelivery, 'longDate')}` : ''),
              })),
              footer: 'Estimates are projections based on current capacity, not commitments.',
            })],
          }, { ephemeral: true });
        },
      },
    },
  },

  // ── Portfolio ─────────────────────────────────────────────────────────────
  {
    namespace: 'portfolio',
    access: 'everyone',
    actions: {
      browse: {
        async run(interaction, { config }) {
          const categories = await portfolioService.categories(interaction.guildId);
          if (!categories.length) {
            return safeReply(interaction, {
              embeds: [embeds.info({
                config,
                title: 'Portfolio coming soon',
                description: 'No case studies have been published yet. Check back shortly.',
              })],
            }, { ephemeral: true });
          }

          return safeReply(interaction, {
            embeds: [embeds.info({
              config,
              title: `${EMOJIS.portfolio} Browse Our Work`,
              description: 'Pick a category to see what we have delivered.',
            })],
            components: [componentsUtil.row(componentsUtil.select({
              id: customId.build('portfolio', 'category'),
              placeholder: 'Choose a category…',
              options: categories.slice(0, 25).map((entry) => ({
                label: TICKET_TYPE_MAP[entry._id]?.label ?? entry._id,
                value: entry._id,
                description: `${entry.count} project${entry.count === 1 ? '' : 's'}`,
                emoji: TICKET_TYPE_MAP[entry._id]?.emoji,
              })),
            }))],
          }, { ephemeral: true });
        },
      },
    },
  },
];
