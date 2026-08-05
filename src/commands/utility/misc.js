'use strict';

/**
 * Small utility commands: /ping, /hours, /userinfo, /serverinfo.
 */

const { SlashCommandBuilder } = require('discord.js');

const businessService = require('../../services/businessService');
const database = require('../../database/connection');
const embeds = require('../../utils/embeds');
const components = require('../../utils/components');
const permissions = require('../../utils/permissions');
const { User, Moderation } = require('../../database/models');
const { EMOJIS } = require('../../config/branding');
const { safeReply, safeDefer } = require('../../utils/discord');
const { duration, timestamp, keyValueBlock, number, truncate } = require('../../utils/formatters');

/** Build a command definition. */
function build({ name, description, access = 'everyone', options = [], run, cooldown = 5, defaultPermission }) {
  const data = new SlashCommandBuilder().setName(name).setDescription(description).setDMPermission(false);
  if (defaultPermission) data.setDefaultMemberPermissions(defaultPermission);
  for (const apply of options) apply(data);
  return { access, cooldown, requiresSetup: false, data, execute: run };
}

// ── /ping ────────────────────────────────────────────────────────────────────
const ping = build({
  name: 'ping',
  description: 'Check that the bot and its database are responsive.',
  cooldown: 10,
  async run(interaction, { config, client }) {
    const started = Date.now();
    await safeDefer(interaction, { ephemeral: true });
    const roundTrip = Date.now() - started;

    const dbStarted = Date.now();
    const health = database.health();
    await User.estimatedDocumentCount().catch(() => null);
    const dbLatency = Date.now() - dbStarted;

    const gateway = Math.max(0, Math.round(client.ws.ping));
    const healthy = health.state === 'connected' && gateway < 500;

    return safeReply(interaction, {
      embeds: [embeds[healthy ? 'success' : 'warning']({
        config,
        title: healthy ? 'All systems responsive' : 'Degraded performance',
        fields: [
          { name: 'Gateway', value: `${gateway}ms`, inline: true },
          { name: 'Round trip', value: `${roundTrip}ms`, inline: true },
          { name: 'Database', value: `${health.state} · ${dbLatency}ms`, inline: true },
          { name: 'Uptime', value: duration(client.uptime), inline: true },
        ],
      })],
    }, { ephemeral: true });
  },
});

// ── /hours ───────────────────────────────────────────────────────────────────
const hours = build({
  name: 'hours',
  description: 'View the studio office hours and current availability.',
  async run(interaction, { config, member }) {
    const isStaff = permissions.isStaff(member, config);
    return safeReply(interaction, {
      embeds: [businessService.hoursEmbed(config), businessService.statusEmbed(config)],
      components: isStaff ? components.statusButtons() : [],
    }, { ephemeral: true });
  },
});

// ── /userinfo ────────────────────────────────────────────────────────────────
const userinfo = build({
  name: 'userinfo',
  description: 'Show information about a member.',
  options: [
    (data) => data.addUserOption((option) => option.setName('user').setDescription('Who. Defaults to you.')),
  ],
  async run(interaction, { config, member }) {
    const target = interaction.options.getUser('user') ?? interaction.user;
    const targetMember = await interaction.guild.members.fetch(target.id).catch(() => null);
    const isStaff = permissions.isStaff(member, config);

    const record = await User.findOne({ guildId: interaction.guildId, userId: target.id }).lean();
    const warnings = isStaff
      ? await Moderation.activeWarnings(interaction.guildId, target.id, config.moderation?.warningExpiryDays ?? 0)
      : null;

    const roles = targetMember?.roles?.cache
      ?.filter((role) => role.id !== interaction.guildId)
      ?.sort((a, b) => b.position - a.position)
      ?.map((role) => `<@&${role.id}>`)
      ?.slice(0, 15) ?? [];

    return safeReply(interaction, {
      embeds: [embeds.info({
        config,
        author: { name: target.tag, iconURL: target.displayAvatarURL({ size: 128 }) },
        thumbnail: target.displayAvatarURL({ size: 256 }),
        title: `${EMOJIS.user} Member Information`,
        fields: [
          {
            name: 'Account',
            value: keyValueBlock([
              ['ID', target.id],
              ['Created', new Date(target.createdAt).toISOString().slice(0, 10)],
              ['Age', duration(Date.now() - target.createdTimestamp, { parts: 1 })],
              ['Bot', target.bot ? 'yes' : 'no'],
            ]),
            inline: true,
          },
          {
            name: 'Membership',
            value: keyValueBlock([
              ['Joined', targetMember?.joinedAt ? new Date(targetMember.joinedAt).toISOString().slice(0, 10) : 'not a member'],
              ['Nickname', targetMember?.nickname ?? '—'],
              ['Customer', record?.isCustomer ? (record.isVip ? 'VIP' : 'yes') : 'no'],
              ['Visits', String(record?.joinCount ?? 1)],
            ]),
            inline: true,
          },
          ...(record
            ? [{
              name: 'Engagement',
              value: keyValueBlock([
                ['Tickets', number(record.stats?.totalTickets ?? 0)],
                ['Orders', number(record.stats?.completedOrders ?? 0)],
                ['Reviews', number(record.stats?.reviewsSubmitted ?? 0)],
              ]),
              inline: true,
            }]
            : []),
          ...(roles.length ? [{ name: `Roles (${roles.length})`, value: truncate(roles.join(' '), 1024) }] : []),
          ...(isStaff && warnings !== null
            ? [{
              name: 'Moderation (staff only)',
              value:
                `Active warnings: **${warnings}**` +
                (targetMember?.isCommunicationDisabled?.()
                  ? `\nTimed out until ${timestamp(targetMember.communicationDisabledUntil, 'relative')}`
                  : '') +
                (record?.moderation?.flagged ? `\n${EMOJIS.warning} Flagged: ${truncate(record.moderation.flagReason, 200)}` : ''),
            }]
            : []),
        ],
      })],
    }, { ephemeral: true });
  },
});

// ── /serverinfo ──────────────────────────────────────────────────────────────
const serverinfo = build({
  name: 'serverinfo',
  description: 'Show information about this server.',
  async run(interaction, { config }) {
    const guild = interaction.guild;
    await safeDefer(interaction, { ephemeral: true });

    const channels = guild.channels.cache;
    const { ChannelType } = require('discord.js');

    return safeReply(interaction, {
      embeds: [embeds.info({
        config,
        title: `${EMOJIS.home} ${guild.name}`,
        thumbnail: guild.iconURL({ size: 256 }) ?? undefined,
        image: guild.bannerURL({ size: 1024 }) ?? undefined,
        fields: [
          {
            name: 'Overview',
            value: keyValueBlock([
              ['Members', number(guild.memberCount)],
              ['Created', new Date(guild.createdAt).toISOString().slice(0, 10)],
              ['Owner', `<@${guild.ownerId}>`.slice(0, 30)],
              ['Boosts', String(guild.premiumSubscriptionCount ?? 0)],
            ]),
            inline: true,
          },
          {
            name: 'Structure',
            value: keyValueBlock([
              ['Categories', String(channels.filter((c) => c.type === ChannelType.GuildCategory).size)],
              ['Text', String(channels.filter((c) => c.type === ChannelType.GuildText).size)],
              ['Voice', String(channels.filter((c) => c.type === ChannelType.GuildVoice).size)],
              ['Roles', String(guild.roles.cache.size)],
            ]),
            inline: true,
          },
          {
            name: 'Studio setup',
            value: keyValueBlock([
              ['Configured', config.setup?.completed ? 'yes' : 'no'],
              ['Timezone', config.business?.timezone ?? 'UTC'],
              ['Tickets', config.tickets?.enabled ? 'open' : 'closed'],
              ['Protection', config.automod?.enabled ? 'active' : 'off'],
            ]),
            inline: true,
          },
        ],
        footer: `ID ${guild.id}`,
      })],
    }, { ephemeral: true });
  },
});

module.exports = [ping, hours, userinfo, serverinfo];
