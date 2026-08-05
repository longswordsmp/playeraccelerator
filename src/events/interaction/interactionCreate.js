'use strict';

/**
 * Interaction gateway.
 *
 * Every slash command, button, select menu, modal and autocomplete enters here.
 * A global token-bucket throttle sits in front of the handlers so that a single
 * abusive client cannot exhaust the bot's rate limit budget for everyone else.
 */

const { Events, InteractionType, MessageFlags } = require('discord.js');

const commandHandler = require('../../handlers/commandHandler');
const componentHandler = require('../../handlers/componentHandler');
const embeds = require('../../utils/embeds');
const permissions = require('../../utils/permissions');
const { logger } = require('../../utils/logger');

const log = logger.child('interactions');

module.exports = {
  name: Events.InteractionCreate,

  /**
   * @param {import('../../core/Client').StudioClient} client
   * @param {import('discord.js').Interaction} interaction
   */
  async execute(client, interaction) {
    // Autocomplete has a 3-second budget and must never be throttled.
    if (interaction.type === InteractionType.ApplicationCommandAutocomplete) {
      return commandHandler.autocomplete(interaction);
    }

    // ── Global abuse throttle ───────────────────────────────────────────────
    if (!permissions.isBotOwner(interaction.user.id) && !client.throttle.consume(interaction.user.id)) {
      log.debug('Throttled interaction', { userId: interaction.user.id });
      return interaction.reply({
        embeds: [embeds.notice('You are interacting too quickly. Please wait a moment and try again.', 'warning')],
        flags: MessageFlags.Ephemeral,
      }).catch(() => null);
    }

    if (interaction.isChatInputCommand() || interaction.isContextMenuCommand()) {
      return commandHandler.execute(interaction);
    }
    if (interaction.isButton()) {
      return componentHandler.execute(interaction, 'buttons');
    }
    if (interaction.isAnySelectMenu()) {
      return componentHandler.execute(interaction, 'selectMenus');
    }
    if (interaction.isModalSubmit()) {
      return componentHandler.execute(interaction, 'modals');
    }

    return null;
  },
};
