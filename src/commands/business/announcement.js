'use strict';

/**
 * /announcement — professional studio announcements.
 */

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');

const configService = require('../../services/configService');
const logService = require('../../services/logService');
const embeds = require('../../utils/embeds');
const validators = require('../../utils/validators');
const errors = require('../../utils/errors');
const { EMOJIS, COLORS } = require('../../config/branding');
const { safeReply, safeSend, safeDefer } = require('../../utils/discord');

/** Announcement presets — each one sets a tone, colour and glyph. */
const TYPES = {
  general: { label: 'Announcement', emoji: '📢', color: COLORS.primary },
  update: { label: 'Studio Update', emoji: '🔔', color: COLORS.info },
  release: { label: 'Project Release', emoji: '🚀', color: COLORS.success },
  maintenance: { label: 'Maintenance Notice', emoji: '🛠️', color: COLORS.warning },
  portfolio: { label: 'New Portfolio Work', emoji: '📁', color: COLORS.accent },
  stream: { label: 'Going Live', emoji: '🎮', color: 0xa855f7 },
  promotion: { label: 'Promotion Results', emoji: '📣', color: COLORS.accent },
};

module.exports = {
  access: 'manager',
  cooldown: 15,
  requiresSetup: true,
  botPermissions: ['SendMessages', 'EmbedLinks'],

  data: new SlashCommandBuilder()
    .setName('announcement')
    .setDescription('Publish a studio announcement.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addStringOption((option) => option
      .setName('type')
      .setDescription('What kind of announcement.')
      .setRequired(true)
      .addChoices(...Object.entries(TYPES).map(([value, meta]) => ({ name: `${meta.emoji} ${meta.label}`, value }))))
    .addStringOption((option) => option
      .setName('title')
      .setDescription('Headline.')
      .setRequired(true))
    .addStringOption((option) => option
      .setName('message')
      .setDescription('Body text. Use \\n for a line break.')
      .setRequired(true))
    .addChannelOption((option) => option
      .setName('channel')
      .setDescription('Where to post (defaults to the announcements channel).')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement))
    .addRoleOption((option) => option
      .setName('ping')
      .setDescription('Role to notify.'))
    .addBooleanOption((option) => option
      .setName('everyone')
      .setDescription('Notify @everyone (use sparingly).'))
    .addStringOption((option) => option
      .setName('image')
      .setDescription('Image URL.'))
    .addStringOption((option) => option
      .setName('link')
      .setDescription('A link shown as a button.'))
    .addStringOption((option) => option
      .setName('link-label')
      .setDescription('Label for the link button.')),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ config: object, member: import('discord.js').GuildMember }} context
   */
  async execute(interaction, { config, member }) {
    await safeDefer(interaction, { ephemeral: true });

    const type = interaction.options.getString('type');
    const meta = TYPES[type] ?? TYPES.general;

    const channel = interaction.options.getChannel('channel')
      ?? configService.channel(interaction.guild, config, 'announcements');
    if (!channel) {
      throw new errors.ConfigurationError('No announcements channel is configured. Pass one explicitly or run `/setup`.');
    }

    const title = validators.text(interaction.options.getString('title'), 'Title', { max: 200, allowNewlines: false });
    const body = validators.text(interaction.options.getString('message'), 'Message', { max: 3500 }).replace(/\\n/g, '\n');
    const image = interaction.options.getString('image');
    const link = interaction.options.getString('link');

    const pingRole = interaction.options.getRole('ping');
    const pingEveryone = interaction.options.getBoolean('everyone') ?? false;

    // @everyone is a real interruption; require the permission that implies it.
    if (pingEveryone && !member.permissions.has(PermissionFlagsBits.MentionEveryone)) {
      throw new errors.PermissionError('You need the **Mention Everyone** permission to notify the whole server.');
    }

    const mention = pingEveryone ? '@everyone' : pingRole ? `<@&${pingRole.id}>` : undefined;

    const components = require('../../utils/components');
    const message = await safeSend(channel, {
      content: mention,
      embeds: [embeds.panel({
        config,
        color: meta.color,
        title: `${meta.emoji} ${title}`,
        description: body,
        image: image ? validators.url(image, { label: 'Image' }) : undefined,
        footer: `${meta.label} · posted by ${member.user.username}`,
      })],
      components: link
        ? components.rows([components.button({
          url: validators.url(link, { label: 'Link', required: true }),
          label: interaction.options.getString('link-label') ?? 'Open',
          emoji: EMOJIS.link,
        })])
        : [],
      allowedMentions: pingEveryone
        ? { parse: ['everyone'] }
        : pingRole
          ? { roles: [pingRole.id] }
          : { parse: [] },
    });

    if (!message) {
      throw new errors.PermissionError(`I cannot post in <#${channel.id}>. Check my permissions there.`);
    }

    await logService.record(interaction.guild, {
      category: 'business',
      event: 'announcement.publish',
      title: `${meta.emoji} Announcement Published`,
      summary: title,
      actorId: member.id,
      actorName: member.user.tag,
      channelId: channel.id,
      fields: { Type: meta.label, Ping: pingEveryone ? '@everyone' : pingRole?.name ?? 'None' },
    }, config);

    return safeReply(interaction, {
      embeds: [embeds.success({
        config,
        title: 'Announcement Published',
        description: `Posted in <#${channel.id}>.`,
        fields: [{ name: 'Jump', value: `[View announcement](${message.url})` }],
      })],
    }, { ephemeral: true });
  },
};
