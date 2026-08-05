'use strict';

/**
 * /help — the command reference, filtered to what the caller can actually use.
 */

const { SlashCommandBuilder } = require('discord.js');

const embeds = require('../../utils/embeds');
const components = require('../../utils/components');
const customId = require('../../utils/customId');
const permissions = require('../../utils/permissions');
const { EMOJIS } = require('../../config/branding');
const { safeReply } = require('../../utils/discord');
const { titleCase, truncate } = require('../../utils/formatters');

/** Presentation order and glyph for each command category. */
const CATEGORIES = [
  { key: 'tickets', label: 'Tickets & Orders', emoji: EMOJIS.ticket },
  { key: 'business', label: 'Business', emoji: EMOJIS.stats },
  { key: 'moderation', label: 'Moderation', emoji: EMOJIS.moderation },
  { key: 'security', label: 'Security', emoji: EMOJIS.security },
  { key: 'admin', label: 'Administration', emoji: EMOJIS.staff },
  { key: 'utility', label: 'Utility', emoji: EMOJIS.info },
];

module.exports = {
  access: 'everyone',
  cooldown: 5,
  requiresSetup: false,

  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show what this bot can do.')
    .setDMPermission(false)
    .addStringOption((option) => option
      .setName('command')
      .setDescription('Get detail on one command.')
      .setAutocomplete(true)),

  /** Suggest commands the caller can actually run. */
  async autocomplete(interaction, { config }) {
    const query = String(interaction.options.getFocused() ?? '').toLowerCase();
    const available = [...interaction.client.commands.values()]
      .filter((command) => permissions.hasLevel(interaction.member, command.access, config))
      .filter((command) => command.data.name.includes(query))
      .slice(0, 25)
      .map((command) => ({ name: `/${command.data.name}`, value: command.data.name }));
    return interaction.respond(available);
  },

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ config: object, member: import('discord.js').GuildMember, client: object }} context
   */
  async execute(interaction, { config, member, client }) {
    const requested = interaction.options.getString('command');

    // ── Detail view ─────────────────────────────────────────────────────────
    if (requested) {
      const command = client.commands.get(requested);
      if (!command) {
        return safeReply(interaction, {
          embeds: [embeds.notice(`\`/${requested}\` is not a command on this server.`, 'warning', config)],
        }, { ephemeral: true });
      }

      const json = command.data.toJSON();
      const subcommands = (json.options ?? []).filter((option) => option.type === 1 || option.type === 2);
      const options = (json.options ?? []).filter((option) => option.type !== 1 && option.type !== 2);

      return safeReply(interaction, {
        embeds: [embeds.info({
          config,
          title: `/${json.name}`,
          description: json.description,
          fields: [
            { name: 'Category', value: titleCase(command.category), inline: true },
            { name: 'Access', value: titleCase(command.access), inline: true },
            { name: 'Cooldown', value: command.cooldown ? `${command.cooldown}s` : 'default', inline: true },
            ...(subcommands.length
              ? [{
                name: 'Subcommands',
                value: truncate(subcommands.map((sub) => `\`${sub.name}\` — ${sub.description}`).join('\n'), 1024),
              }]
              : []),
            ...(options.length
              ? [{
                name: 'Options',
                value: truncate(options.map((option) => `\`${option.name}\`${option.required ? ' *(required)*' : ''} — ${option.description}`).join('\n'), 1024),
              }]
              : []),
            ...(command.requiresSetup ? [{ name: 'Requires', value: 'The server must have been set up with `/setup`.' }] : []),
          ],
        })],
      }, { ephemeral: true });
    }

    // ── Overview ────────────────────────────────────────────────────────────
    const usable = [...client.commands.values()].filter((command) => permissions.hasLevel(member, command.access, config));
    const grouped = CATEGORIES
      .map((category) => ({
        ...category,
        commands: usable.filter((command) => command.category === category.key).sort((a, b) => a.data.name.localeCompare(b.data.name)),
      }))
      .filter((category) => category.commands.length);

    return safeReply(interaction, {
      embeds: [embeds.panel({
        config,
        title: `${EMOJIS.brand} ${config.brand?.name ?? 'Studio'} — Command Reference`,
        description:
          `You can use **${usable.length}** of the **${client.commands.size}** commands on this server.\n` +
          'Run `/help command:<name>` for detail on any one of them.',
        fields: grouped.map((category) => ({
          name: `${category.emoji} ${category.label}`,
          value: truncate(category.commands.map((command) => `\`/${command.data.name}\``).join(' · '), 1024),
        })),
        footer: 'Everything here is also reachable through the panels and buttons.',
      })],
      components: components.rows([
        components.button({ id: customId.build('ticket', 'open'), label: 'Create Ticket', emoji: EMOJIS.ticket, style: 'primary' }),
        components.button({ id: customId.build('portfolio', 'browse'), label: 'View Portfolio', emoji: EMOJIS.portfolio, style: 'secondary' }),
        components.button({ id: customId.build('review', 'start'), label: 'Leave a Review', emoji: EMOJIS.star, style: 'secondary' }),
      ]),
    }, { ephemeral: true });
  },
};
