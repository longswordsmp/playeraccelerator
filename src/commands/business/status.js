'use strict';

/**
 * /status — set or view the live developer availability.
 */

const { SlashCommandBuilder } = require('discord.js');

const businessService = require('../../services/businessService');
const embeds = require('../../utils/embeds');
const components = require('../../utils/components');
const validators = require('../../utils/validators');
const permissions = require('../../utils/permissions');
const { STATUSES } = require('../../config/server');
const { safeReply } = require('../../utils/discord');

module.exports = {
  access: 'everyone',
  cooldown: 5,
  requiresSetup: false,

  data: new SlashCommandBuilder()
    .setName('status')
    .setDescription('View or change the studio availability status.')
    .setDMPermission(false)
    .addStringOption((option) => option
      .setName('set')
      .setDescription('Set the status (staff only).')
      .addChoices(...Object.entries(STATUSES).map(([value, meta]) => ({ name: `${meta.emoji} ${meta.label}`, value }))))
    .addStringOption((option) => option
      .setName('note')
      .setDescription('A short note shown on the status panel.')),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ config: object, member: import('discord.js').GuildMember }} context
   */
  async execute(interaction, { config, member }) {
    const target = interaction.options.getString('set');
    const note = interaction.options.getString('note');

    if (!target && note === null) {
      // Read-only view for everyone.
      return safeReply(interaction, {
        embeds: [businessService.statusEmbed(config), businessService.hoursEmbed(config)],
        components: permissions.isStaff(member, config) ? components.statusButtons() : [],
      }, { ephemeral: true });
    }

    permissions.assertLevel(member, 'support', config, 'change the studio status');

    const status = target ?? config.status?.current ?? 'offline';
    const cleanNote = note !== null ? validators.clean(note, { max: 200, allowNewlines: false }) : (config.status?.note ?? '');
    const updated = await businessService.setStatus(interaction.guild, status, member, cleanNote);

    return safeReply(interaction, {
      embeds: [
        embeds.success({
          config: updated,
          title: 'Status Updated',
          description: `Availability is now ${STATUSES[status].emoji} **${STATUSES[status].label}**.`,
        }),
        businessService.statusEmbed(updated),
      ],
      components: components.statusButtons(),
    }, { ephemeral: true });
  },
};
