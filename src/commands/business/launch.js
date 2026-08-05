'use strict';

/**
 * /launch — run the time-boxed opening promotion.
 *
 * Opening the window and publishing the announcement are one action on purpose.
 * A promotion that is announced but not switched on turns the first applicant
 * away; a promotion switched on but never announced does nothing at all.
 */

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');

const launchService = require('../../services/launchService');
const configService = require('../../services/configService');
const logService = require('../../services/logService');
const embeds = require('../../utils/embeds');
const errors = require('../../utils/errors');
const { TICKET_TYPES } = require('../../config/server');
const { EMOJIS } = require('../../config/branding');
const { safeReply, safeSend, safeDefer } = require('../../utils/discord');
const { duration, plural } = require('../../utils/formatters');

/** Services that can sensibly be given away — support and bug reports are free anyway. */
const OFFERABLE = TICKET_TYPES
  .filter((type) => !['support', 'bug-report', 'promotion', 'free-commission', 'other'].includes(type.key))
  .map((type) => ({ name: `${type.emoji} ${type.label}`, value: type.key }));

module.exports = {
  access: 'admin',
  cooldown: 20,
  requiresSetup: true,
  botPermissions: ['SendMessages', 'EmbedLinks', 'AttachFiles'],

  data: new SlashCommandBuilder()
    .setName('launch')
    .setDescription('Run the opening promotion: free commissions for a fixed window.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((sub) => sub
      .setName('start')
      .setDescription('Open the window and publish the announcement.')
      .addIntegerOption((option) => option
        .setName('days')
        .setDescription('How long the offer runs. Default 7.')
        .setMinValue(1)
        .setMaxValue(60))
      .addStringOption((option) => option
        .setName('service')
        .setDescription('What the free work covers. Default: Minecraft plugins.')
        .addChoices(...OFFERABLE))
      .addIntegerOption((option) => option
        .setName('slots')
        .setDescription('Cap the number of free builds. 0 or omitted = uncapped.')
        .setMinValue(0)
        .setMaxValue(500))
      .addChannelOption((option) => option
        .setName('channel')
        .setDescription('Where to announce it. Defaults to the announcements channel.')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
      .addBooleanOption((option) => option
        .setName('everyone')
        .setDescription('Ping @everyone. This is the one announcement that probably warrants it.')))
    .addSubcommand((sub) => sub
      .setName('status')
      .setDescription('Is the promotion running, and how much is left of it?'))
    .addSubcommand((sub) => sub
      .setName('end')
      .setDescription('Close the promotion now and mark the announcement as ended.')),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ config: object, member: import('discord.js').GuildMember }} context
   */
  async execute(interaction, { config, member }) {
    await safeDefer(interaction, { ephemeral: true });

    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;

    if (sub === 'status') {
      const open = launchService.isOpen(config);
      const left = launchService.timeRemaining(config);
      const slots = launchService.remainingSlots(config);

      return safeReply(interaction, {
        embeds: [embeds.info({
          config,
          title: `${EMOJIS.bolt} Launch Promotion`,
          description: open
            ? `**Running.** The referral requirement on free commissions is waived while it is.`
            : '**Not running.** Free commissions require the usual referrals.',
          fields: [
            {
              name: 'Time left',
              value: !open ? '—' : left === null ? 'No end date set' : duration(left),
              inline: true,
            },
            {
              name: 'Slots',
              value: slots === Infinity ? 'Uncapped' : `${plural(slots, 'slot')} of ${config.launch?.maxSlots} left`,
              inline: true,
            },
            {
              name: 'Claimed',
              value: String(config.launch?.claimedSlots ?? 0),
              inline: true,
            },
            {
              name: 'Covers',
              value: launchService.serviceLabels(config).join(', ') || 'Not set',
            },
          ],
        })],
      }, { ephemeral: true });
    }

    if (sub === 'end') {
      if (!config.launch?.enabled) {
        throw new errors.ConflictError('The promotion is not running, so there is nothing to close.');
      }

      // Force the window shut, then let the sweeper do the announcement edit so
      // there is exactly one piece of code that knows how to close one out.
      await configService.update(guild, (cfg) => cfg.setPath('launch.endsAt', new Date(Date.now() - 1000)));
      const stale = await configService.get(guild, { fresh: true });
      await launchService.sweep(guild, stale);

      await logService.record(guild, {
        category: 'business',
        event: 'launch.end',
        title: `${EMOJIS.bolt} Launch Promotion Closed`,
        summary: `Closed early by ${member.user.tag}`,
        actorId: member.id,
        actorName: member.user.tag,
      }, config);

      return safeReply(interaction, {
        embeds: [embeds.success({
          config,
          title: 'Promotion Closed',
          description:
            'The window is shut and the announcement has been rewritten to say so. '
            + 'Free commissions are back behind the referral requirement.',
        })],
      }, { ephemeral: true });
    }

    // start
    const days = interaction.options.getInteger('days') ?? 7;
    const service = interaction.options.getString('service');
    const slots = interaction.options.getInteger('slots');
    const pingEveryone = interaction.options.getBoolean('everyone') ?? false;

    if (pingEveryone && !member.permissions.has(PermissionFlagsBits.MentionEveryone)) {
      throw new errors.PermissionError('You need the **Mention Everyone** permission to notify the whole server.');
    }

    const channel = interaction.options.getChannel('channel')
      ?? configService.channel(guild, config, 'announcements');
    if (!channel) {
      throw new errors.ConfigurationError('No announcements channel is configured. Pass one explicitly or run `/setup`.');
    }

    const updated = await launchService.start(guild, {
      days,
      serviceTypes: service ? [service] : undefined,
      maxSlots: slots,
    });

    const message = await safeSend(channel, {
      content: pingEveryone ? '@everyone' : undefined,
      ...launchService.announcement(updated),
      allowedMentions: pingEveryone ? { parse: ['everyone'] } : { parse: [] },
    });

    if (!message) {
      // The window is open but nobody was told. Roll it back rather than leave
      // the two halves disagreeing.
      await launchService.end(guild);
      throw new errors.PermissionError(
        `I could not post in <#${channel.id}>, so I have closed the window again. `
        + 'Check that I have **Send Messages**, **Embed Links** and **Attach Files** there.',
      );
    }

    await configService.update(guild, (cfg) => {
      cfg.setPath('launch.announcementChannelId', channel.id);
      cfg.setPath('launch.announcementMessageId', message.id);
    });

    await logService.record(guild, {
      category: 'business',
      event: 'launch.start',
      title: `${EMOJIS.bolt} Launch Promotion Opened`,
      summary: `${plural(days, 'day')} of free commissions`,
      actorId: member.id,
      actorName: member.user.tag,
      channelId: channel.id,
      fields: {
        Covers: launchService.serviceLabels(updated).join(', ') || '—',
        Slots: slots ? String(slots) : 'Uncapped',
        Ping: pingEveryone ? '@everyone' : 'None',
      },
    }, config);

    return safeReply(interaction, {
      embeds: [embeds.success({
        config: updated,
        title: 'Launch Promotion Live',
        description:
          `Announced in <#${channel.id}> and running for **${plural(days, 'day')}**.\n\n`
          + 'The referral requirement on free commissions is waived for the duration, so anyone who opens '
          + 'that ticket gets straight through. It closes itself when the window expires.',
        fields: [{ name: 'Jump', value: `[View announcement](${message.url})` }],
      })],
    }, { ephemeral: true });
  },
};
