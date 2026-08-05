'use strict';

/**
 * /reviewstats and /featuredreview — quick public read-outs of the review data.
 */

const { SlashCommandBuilder } = require('discord.js');

const reviewService = require('../../services/reviewService');
const statisticsService = require('../../services/statisticsService');
const embeds = require('../../utils/embeds');
const components = require('../../utils/components');
const customId = require('../../utils/customId');
const { Review } = require('../../database/models');
const { TICKET_TYPE_MAP } = require('../../config/server');
const { EMOJIS, stars } = require('../../config/branding');
const { safeReply, safeDefer } = require('../../utils/discord');
const { duration, percent, number, keyValueBlock } = require('../../utils/formatters');

/** Build a command definition. */
function build({ name, description, options = [], run, cooldown = 10 }) {
  const data = new SlashCommandBuilder().setName(name).setDescription(description).setDMPermission(false);
  for (const apply of options) apply(data);
  return { access: 'everyone', cooldown, requiresSetup: false, data, execute: run };
}

// ── /reviewstats ─────────────────────────────────────────────────────────────
const reviewstats = build({
  name: 'reviewstats',
  description: 'Customer satisfaction at a glance.',
  async run(interaction, { config }) {
    await safeDefer(interaction, { ephemeral: true });

    const [summary, topServices, overview] = await Promise.all([
      Review.summary(interaction.guildId),
      Review.topServices(interaction.guildId, 3),
      statisticsService.overview(interaction.guildId),
    ]);

    return safeReply(interaction, {
      embeds: [
        reviewService.summaryEmbed(summary, config, { topService: topServices[0] }),
        embeds.info({
          config,
          title: `${EMOJIS.stats} Service Quality`,
          fields: [
            {
              name: 'Experience',
              value: keyValueBlock([
                ['Reviews', number(summary.total)],
                ['Average', summary.total ? `${summary.average.toFixed(2)} / 5` : '—'],
                ['Five star', summary.total ? percent(summary.distribution[5], summary.total) : '—'],
                ['Positive', summary.total ? percent(summary.positive, summary.total) : '—'],
              ]),
              inline: true,
            },
            {
              name: 'Delivery',
              value: keyValueBlock([
                ['First reply', overview.performance.averageFirstResponseMinutes !== null
                  ? duration(overview.performance.averageFirstResponseMinutes * 60_000, { compact: true })
                  : '—'],
                ['Build time', overview.performance.averageCompletionHours !== null
                  ? `${overview.performance.averageCompletionHours}h`
                  : '—'],
                ['Projects', number(overview.orders.completed)],
                ['Repeat rate', `${overview.performance.repeatRate}%`],
              ]),
              inline: true,
            },
            ...(topServices.length
              ? [{
                name: 'By service',
                value: topServices
                  .map((entry) => `${TICKET_TYPE_MAP[entry._id]?.emoji ?? EMOJIS.bullet} **${TICKET_TYPE_MAP[entry._id]?.label ?? entry._id}** — ${stars(Math.round(entry.average))} ${entry.average.toFixed(2)} (${entry.count})`)
                  .join('\n'),
              }]
              : []),
          ],
        }),
      ],
      components: components.rows([
        components.button({ id: customId.build('review', 'start'), label: 'Leave a Review', emoji: EMOJIS.star, style: 'primary' }),
      ]),
    }, { ephemeral: true });
  },
});

// ── /featuredreview ──────────────────────────────────────────────────────────
const featuredreview = build({
  name: 'featuredreview',
  description: 'Read the reviews we are proudest of.',
  cooldown: 5,
  async run(interaction, { config }) {
    await safeDefer(interaction, { ephemeral: true });

    const featured = await Review.find({
      guildId: interaction.guildId,
      featured: true,
      approved: true,
      hidden: false,
      rejected: false,
    })
      .sort({ featuredAt: -1 })
      .limit(5)
      .lean();

    if (!featured.length) {
      return safeReply(interaction, {
        embeds: [embeds.info({
          config,
          title: 'No featured reviews yet',
          description: 'Outstanding reviews are highlighted here as they arrive. Every published review is in the reviews channel.',
        })],
      }, { ephemeral: true });
    }

    return safeReply(interaction, {
      embeds: featured.map((review) => reviewService.reviewEmbed(review, config)),
      components: components.rows([
        components.button({ id: customId.build('ticket', 'open'), label: 'Start a Project', emoji: EMOJIS.ticket, style: 'primary' }),
      ]),
    }, { ephemeral: true });
  },
});

module.exports = [reviewstats, featuredreview];
