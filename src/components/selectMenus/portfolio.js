'use strict';

/**
 * Portfolio category browser.
 */

const portfolioService = require('../../services/portfolioService');
const embeds = require('../../utils/embeds');
const { Portfolio } = require('../../database/models');

module.exports = {
  namespace: 'portfolio',
  access: 'everyone',

  actions: {
    category: {
      async run(interaction, { config }) {
        const category = interaction.values[0];
        const entries = await Portfolio.showcase(interaction.guildId, { category, limit: 5 });

        if (!entries.length) {
          return interaction.update({
            embeds: [embeds.info({
              config,
              title: 'Nothing published here yet',
              description: 'No case studies exist in that category. Try another one.',
            })],
            components: [],
          }).catch(() => null);
        }

        return interaction.update({
          embeds: entries.map((entry) => portfolioService.entryEmbed(entry, config)),
          components: [],
        }).catch(() => null);
      },
    },
  },
};
