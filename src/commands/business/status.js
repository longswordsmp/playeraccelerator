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
      .addChoices(
        // "Auto" first: it is the mode most studios want, and the one that
        // stops the board going stale when somebody forgets to flip it back.
        { name: '🕒 Auto — follow office hours', value: 'auto' },
        ...Object.entries(STATUSES).map(([value, meta]) => ({ name: `${meta.emoji} ${meta.label}`, value })),
      ))
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

    // What the panel now shows, which is not the same as what was asked for
    // when the schedule is driving it.
    const shown = STATUSES[businessService.effectiveStatus(updated)] ?? STATUSES.offline;

    return safeReply(interaction, {
      embeds: [
        embeds.success({
          config: updated,
          title: 'Status Updated',
          description: status === 'auto'
            ? `Availability now follows your office hours. Right now that is ${shown.emoji} **${shown.label}**.`
            : `Availability is now ${shown.emoji} **${shown.label}**, and stays there until you change it. `
              + 'Use `/status set:Auto` to hand it back to the schedule.',
        }),
        businessService.statusEmbed(updated),
      ],
      components: components.statusButtons(),
    }, { ephemeral: true });
  },
};
