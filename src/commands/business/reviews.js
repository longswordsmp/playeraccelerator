'use strict';

/**
 * /reviews — the public review browser and satisfaction summary.
 */

const { SlashCommandBuilder } = require('discord.js');

const reviewService = require('../../services/reviewService');
const embeds = require('../../utils/embeds');
const components = require('../../utils/components');
const customId = require('../../utils/customId');
const { Review } = require('../../database/models');
const { TICKET_TYPE_MAP, TICKET_TYPES } = require('../../config/server');
const { EMOJIS } = require('../../config/branding');
const { safeReply, safeDefer } = require('../../utils/discord');

module.exports = {
  access: 'everyone',
  cooldown: 5,
  requiresSetup: false,

  data: new SlashCommandBuilder()
    .setName('reviews')
    .setDescription('Read verified customer reviews.')
    .setDMPermission(false)
    .addStringOption((option) => option
      .setName('service')
      .setDescription('Only show reviews for one service.')
      .addChoices(...TICKET_TYPES.slice(0, 25).map((type) => ({ name: type.label, value: type.key }))))
    .addIntegerOption((option) => option
      .setName('rating')
      .setDescription('Only show reviews with this rating.')
      .setMinValue(1)
      .setMaxValue(5))
    .addBooleanOption((option) => option
      .setName('featured')
      .setDescription('Only show featured reviews.')),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ config: object }} context
   */
  async execute(interaction, { config }) {
    await safeDefer(interaction, { ephemeral: true });

    const query = { guildId: interaction.guildId, approved: true, hidden: false, rejected: false };
    const service = interaction.options.getString('service');
    const rating = interaction.options.getInteger('rating');
    const featured = interaction.options.getBoolean('featured');
    if (service) query.serviceType = service;
    if (rating) query.rating = rating;
    if (featured) query.featured = true;

    const [reviews, summary] = await Promise.all([
      Review.find(query).sort({ featured: -1, createdAt: -1 }).limit(4).lean(),
      Review.summary(interaction.guildId, { serviceType: service ?? undefined }),
    ]);

    if (!reviews.length) {
      return safeReply(interaction, {
        embeds: [embeds.info({
          config,
          title: 'No reviews here yet',
          description: service
            ? `No published reviews for **${TICKET_TYPE_MAP[service]?.label ?? service}** yet.`
            : 'No reviews have been published yet. Yours could be the first.',
        })],
        components: components.rows([
          components.button({ id: customId.build('review', 'start'), label: 'Leave a Review', emoji: EMOJIS.star, style: 'primary' }),
        ]),
      }, { ephemeral: true });
    }

    return safeReply(interaction, {
      embeds: [
        reviewService.summaryEmbed(summary, config),
        ...reviews.map((review) => reviewService.reviewEmbed(review, config)),
      ],
      components: components.rows([
        components.button({ id: customId.build('review', 'start'), label: 'Leave a Review', emoji: EMOJIS.star, style: 'primary' }),
        components.button({ id: customId.build('review', 'featured'), label: 'Featured', emoji: '🏆', style: 'secondary' }),
      ]),
    }, { ephemeral: true });
  },
};
