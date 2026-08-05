'use strict';

/**
 * /panel — publish or refresh the public panels the bot owns.
 */

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');

const panelService = require('../../services/panelService');
const configService = require('../../services/configService');
const embeds = require('../../utils/embeds');
const { EMOJIS } = require('../../config/branding');
const { safeReply, safeDefer } = require('../../utils/discord');

const PANEL_CHOICES = [
  { name: 'Welcome', value: 'welcome' },
  { name: 'Verification', value: 'verify' },
  { name: 'Free Service', value: 'freeCommission' },
  { name: 'Rules', value: 'rules' },
  { name: 'FAQ', value: 'faq' },
  { name: 'Terms of Service', value: 'tos' },
  { name: 'Pricing', value: 'pricing' },
  { name: 'Portfolio', value: 'portfolio' },
  { name: 'Reviews', value: 'reviews' },
  { name: 'Ticket Launcher', value: 'ticket' },
  { name: 'Developer Status', value: 'status' },
  { name: 'Office Hours', value: 'hours' },
  { name: 'Statistics', value: 'statistics' },
  { name: 'Project Queue', value: 'queue' },
  { name: 'Staff Performance', value: 'performance' },
];

module.exports = {
  access: 'admin',
  cooldown: 10,
  requiresSetup: true,
  botPermissions: ['SendMessages', 'EmbedLinks', 'ManageMessages', 'AttachFiles'],

  data: new SlashCommandBuilder()
    .setName('panel')
    .setDescription('Publish or refresh a public panel.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((sub) => sub
      .setName('publish')
      .setDescription('Publish a panel, or move it to a different channel.')
      .addStringOption((option) => option
        .setName('panel')
        .setDescription('Which panel.')
        .setRequired(true)
        .addChoices(...PANEL_CHOICES))
      .addChannelOption((option) => option
        .setName('channel')
        .setDescription('Where to publish it (defaults to the configured channel).')
        .addChannelTypes(ChannelType.GuildText)))
    .addSubcommand((sub) => sub
      .setName('refresh')
      .setDescription('Refresh a panel in place.')
      .addStringOption((option) => option
        .setName('panel')
        .setDescription('Which panel. Omit to refresh every live panel.')
        .addChoices(...PANEL_CHOICES)))
    .addSubcommand((sub) => sub
      .setName('republish')
      .setDescription('Delete my old posts in every panel channel and publish the whole set again.')
      .addBooleanOption((option) => option
        .setName('confirm')
        .setDescription('Required. This deletes my previous messages in those channels.')
        .setRequired(true)))
    .addSubcommand((sub) => sub
      .setName('list')
      .setDescription('Show which panels are published and where.')),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ config: object }} context
   */
  async execute(interaction, { config }) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;
    await safeDefer(interaction, { ephemeral: true });

    if (sub === 'list') {
      const rows = Object.entries(panelService.PANELS).map(([key, definition]) => {
        const stored = config.panels?.[key];
        const target = stored?.channelId ?? config.channels?.[definition.channel];
        return `${stored?.messageId ? EMOJIS.success : EMOJIS.warning} \`${key.padEnd(12)}\` ${target ? `<#${target}>` : '_no channel configured_'}`;
      });

      return safeReply(interaction, {
        embeds: [embeds.info({
          config,
          title: `${EMOJIS.logs} Panels`,
          description: rows.join('\n'),
          footer: 'Publish a missing panel with /panel publish',
        })],
      }, { ephemeral: true });
    }

    if (sub === 'republish') {
      if (!interaction.options.getBoolean('confirm')) {
        return safeReply(interaction, {
          embeds: [embeds.warning({
            config,
            title: 'Nothing done',
            description:
              'Republishing deletes my own previous messages in every panel channel and posts the '
              + 'whole set again. Run it with `confirm: True` when you are ready.',
          })],
        }, { ephemeral: true });
      }

      const fresh = await configService.get(interaction.guild, { fresh: true });
      const result = await panelService.republishAll(interaction.guild, fresh);

      return safeReply(interaction, {
        embeds: [embeds.success({
          config: fresh,
          title: 'Panels Republished',
          description:
            `Removed **${result.deleted}** of my old message${result.deleted === 1 ? '' : 's'} and posted `
            + `**${result.published}** panel${result.published === 1 ? '' : 's'} fresh, with the current branding.`,
          fields: result.skipped.length
            ? [{
              name: 'Skipped',
              value:
                `${result.skipped.map((key) => `\`${key}\``).join(', ')}\n`
                + '_No channel is configured for these, or I cannot post there._',
            }]
            : [],
        })],
      }, { ephemeral: true });
    }

    if (sub === 'publish') {
      const key = interaction.options.getString('panel');
      const channel = interaction.options.getChannel('channel');

      const message = await panelService.publish(guild, config, key, channel?.id);
      if (!message) {
        return safeReply(interaction, {
          embeds: [embeds.error({
            config,
            title: 'Panel not published',
            description:
              'No destination channel is configured for this panel, or I cannot post there.\n\n' +
              'Pass a `channel` explicitly, or check that I have **View Channel**, **Send Messages** and **Embed Links** there.',
          })],
        }, { ephemeral: true });
      }

      return safeReply(interaction, {
        embeds: [embeds.success({
          config,
          title: 'Panel Published',
          description: `The **${key}** panel is now live in <#${message.channelId}>.`,
          fields: [{ name: 'Jump', value: `[Open panel](${message.url})` }],
        })],
      }, { ephemeral: true });
    }

    // refresh
    const key = interaction.options.getString('panel');
    if (key) {
      const message = await panelService.refresh(guild, config, key);
      return safeReply(interaction, {
        embeds: [message
          ? embeds.success({ config, title: 'Panel Refreshed', description: `The **${key}** panel has been updated.` })
          : embeds.warning({ config, title: 'Nothing to refresh', description: `The **${key}** panel has not been published yet. Use \`/panel publish\` first.` })],
      }, { ephemeral: true });
    }

    const fresh = await configService.get(guild, { fresh: true });
    const count = await panelService.refreshDynamic(guild, fresh);
    return safeReply(interaction, {
      embeds: [embeds.success({
        config: fresh,
        title: 'Panels Refreshed',
        description: `${count} live panel${count === 1 ? '' : 's'} updated with current data.`,
      })],
    }, { ephemeral: true });
  },
};
