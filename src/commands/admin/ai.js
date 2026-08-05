'use strict';

/**
 * /ai — control the automated first-line ticket support.
 *
 * Lives outside `/config` because that command is already at Discord's
 * 25-subcommand ceiling, and because the per-ticket controls belong with the
 * people using them rather than buried in an admin menu.
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const aiService = require('../../services/aiService');
const configService = require('../../services/configService');
const businessService = require('../../services/businessService');
const embeds = require('../../utils/embeds');
const errors = require('../../utils/errors');
const permissions = require('../../utils/permissions');
const { Ticket } = require('../../database/models');
const { EMOJIS } = require('../../config/branding');
const { safeReply, safeDefer } = require('../../utils/discord');
const { plural } = require('../../utils/formatters');

module.exports = {
  access: 'support',
  cooldown: 5,
  requiresSetup: false,

  data: new SlashCommandBuilder()
    .setName('ai')
    .setDescription('Automated first-line support for tickets.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages)
    .setDMPermission(false)
    .addSubcommand((sub) => sub
      .setName('status')
      .setDescription('Is automated support on, and what is it configured to do?'))
    .addSubcommand((sub) => sub
      .setName('off')
      .setDescription('Stop automated replies in this ticket. Use when you are handling it yourself.'))
    .addSubcommand((sub) => sub
      .setName('on')
      .setDescription('Allow automated replies in this ticket again.'))
    .addSubcommand((sub) => sub
      .setName('settings')
      .setDescription('Change how automated support behaves server-wide.')
      .addBooleanOption((option) => option
        .setName('enabled')
        .setDescription('Turn automated support on or off for the whole server.'))
      .addBooleanOption((option) => option
        .setName('only-when-closed')
        .setDescription('Only reply outside office hours. Off means it answers whenever you have not.'))
      .addIntegerOption((option) => option
        .setName('delay')
        .setDescription('Seconds to wait before replying, so you can get there first.')
        .setMinValue(0)
        .setMaxValue(3600))
      .addIntegerOption((option) => option
        .setName('max-replies')
        .setDescription('Automated replies allowed per ticket. 0 = unlimited.')
        .setMinValue(0)
        .setMaxValue(50))),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ config: object, member: import('discord.js').GuildMember }} context
   */
  async execute(interaction, { config, member }) {
    const sub = interaction.options.getSubcommand();
    await safeDefer(interaction, { ephemeral: true });

    if (sub === 'status') {
      const configured = aiService.isConfigured();
      const { open } = businessService.availability(config);
      const on = configured && config.ai?.enabled !== false;

      return safeReply(interaction, {
        embeds: [embeds[on ? 'info' : 'warning']({
          config,
          title: `${EMOJIS.bolt} Automated Support`,
          description: !configured
            ? '**Not available.** No `AI_API_KEY` is set, so automated support is inert. '
              + 'Add one to your environment variables and restart to switch it on.'
            : on
              ? '**Active.** Customers get a reply when you have not answered yet.'
              : '**Switched off** for this server.',
          fields: configured
            ? [
              {
                name: 'When it answers',
                value: config.ai?.onlyWhenClosed
                  ? `Outside office hours only — currently **${open ? 'open, so it stays quiet' : 'closed, so it is covering'}**.`
                  : 'Any time you have not replied first.',
                inline: true,
              },
              {
                name: 'Wait before replying',
                value: `${plural(config.ai?.replyDelaySeconds ?? 45, 'second')}`,
                inline: true,
              },
              {
                name: 'Per-ticket limit',
                value: (config.ai?.maxRepliesPerTicket ?? 6) === 0
                  ? 'Unlimited'
                  : `${plural(config.ai.maxRepliesPerTicket, 'reply', 'replies')}`,
                inline: true,
              },
              {
                name: 'What it will never do',
                value:
                  `${EMOJIS.bullet} Quote, estimate or range a price — replies mentioning money are discarded, not sent\n`
                  + `${EMOJIS.bullet} Commit to a deadline or agree to terms\n`
                  + `${EMOJIS.bullet} Claim to be you — every reply is labelled automated\n`
                  + `${EMOJIS.bullet} Speak after a human has replied in the ticket`,
              },
            ]
            : [],
          footer: configured ? 'Use /ai off inside a ticket to silence it there.' : undefined,
        })],
      }, { ephemeral: true });
    }

    if (sub === 'on' || sub === 'off') {
      const ticket = await Ticket.byChannel(interaction.guildId, interaction.channelId);
      if (!ticket) {
        throw new errors.ValidationError('This is not a ticket channel. Run it inside the ticket you want to change.');
      }

      const disabled = sub === 'off';
      await Ticket.updateOne({ _id: ticket._id }, { $set: { aiDisabled: disabled } });

      return safeReply(interaction, {
        embeds: [embeds.success({
          config,
          title: disabled ? 'Automated replies off' : 'Automated replies on',
          description: disabled
            ? 'Nothing automated will post in this ticket. It is yours.'
            : 'Automated support may reply here again when nobody has answered.',
        })],
      }, { ephemeral: true });
    }

    // settings — a server-wide change, so require more than support level.
    permissions.assertLevel(member, 'admin', config, 'change automated support settings');

    const changes = {};
    const enabled = interaction.options.getBoolean('enabled');
    const onlyClosed = interaction.options.getBoolean('only-when-closed');
    const delay = interaction.options.getInteger('delay');
    const maxReplies = interaction.options.getInteger('max-replies');

    if (enabled !== null) changes['ai.enabled'] = enabled;
    if (onlyClosed !== null) changes['ai.onlyWhenClosed'] = onlyClosed;
    if (delay !== null) changes['ai.replyDelaySeconds'] = delay;
    if (maxReplies !== null) changes['ai.maxRepliesPerTicket'] = maxReplies;

    if (!Object.keys(changes).length) {
      throw new errors.ValidationError('No options were provided — nothing was changed.');
    }

    await configService.setPaths(interaction.guild, changes);
    const fresh = await configService.get(interaction.guild, { fresh: true });

    return safeReply(interaction, {
      embeds: [embeds.success({
        config: fresh,
        title: 'Automated Support Updated',
        description: Object.entries(changes)
          .map(([path, value]) => `${EMOJIS.bullet} \`${path.replace('ai.', '')}\` → **${value}**`)
          .join('\n'),
        footer: aiService.isConfigured() ? undefined : 'Note: no AI_API_KEY is set, so this is still inert.',
      })],
    }, { ephemeral: true });
  },
};
