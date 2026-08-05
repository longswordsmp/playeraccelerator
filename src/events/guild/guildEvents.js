'use strict';

/**
 * Remaining guild-level audit streams: bans, invites, webhooks, emoji, guild
 * settings, plus the bot joining or leaving a server.
 */

const { Events, AuditLogEvent } = require('discord.js');

const configService = require('../../services/configService');
const logService = require('../../services/logService');
const antiNuke = require('../../security/antiNuke');
const { fetchAuditEntry, safeSend } = require('../../utils/discord');
const embeds = require('../../utils/embeds');
const { REQUIRED_BOT_PERMISSIONS } = require('../../config/permissions');
const permissions = require('../../utils/permissions');
const { EMOJIS } = require('../../config/branding');
const { timestamp, truncate } = require('../../utils/formatters');
const { logger } = require('../../utils/logger');

const log = logger.child('guild');

module.exports = [
  // ── Bans ──────────────────────────────────────────────────────────────────
  {
    name: Events.GuildBanAdd,
    async execute(client, ban) {
      await antiNuke.onMemberBan(ban).catch(() => null);

      const config = await configService.get(ban.guild);
      const entry = await fetchAuditEntry(ban.guild, AuditLogEvent.MemberBanAdd, ban.user.id);
      await logService.record(ban.guild, {
        category: 'moderation',
        event: 'guildBanAdd',
        title: `${EMOJIS.moderation} Member Banned`,
        summary: `${ban.user.tag} was banned`,
        actorId: entry?.executor?.id ?? '',
        actorName: entry?.executor?.tag ?? '',
        targetId: ban.user.id,
        targetName: ban.user.tag,
        severity: 'warn',
        fields: { Reason: truncate(entry?.reason ?? ban.reason ?? 'No reason provided', 1000) },
      }, config);
    },
  },

  {
    name: Events.GuildBanRemove,
    async execute(client, ban) {
      const config = await configService.get(ban.guild);
      const entry = await fetchAuditEntry(ban.guild, AuditLogEvent.MemberBanRemove, ban.user.id);
      await logService.record(ban.guild, {
        category: 'moderation',
        event: 'guildBanRemove',
        title: `${EMOJIS.success} Member Unbanned`,
        summary: `${ban.user.tag} was unbanned`,
        actorId: entry?.executor?.id ?? '',
        actorName: entry?.executor?.tag ?? '',
        targetId: ban.user.id,
        targetName: ban.user.tag,
      }, config);
    },
  },

  // ── Invites ───────────────────────────────────────────────────────────────
  {
    name: Events.InviteCreate,
    async execute(client, invite) {
      if (!invite.guild) return;
      const config = await configService.get(invite.guild);
      if (!config.logging?.events?.inviteCreate) return;

      await logService.record(invite.guild, {
        category: 'invite',
        event: 'inviteCreate',
        title: `${EMOJIS.link} Invite Created`,
        summary: `\`${invite.code}\` for <#${invite.channelId}>`,
        actorId: invite.inviterId ?? '',
        actorName: invite.inviter?.tag ?? '',
        channelId: invite.channelId,
        fields: {
          Expires: invite.expiresAt ? timestamp(invite.expiresAt, 'relative') : 'Never',
          'Max uses': invite.maxUses ? String(invite.maxUses) : 'Unlimited',
          Temporary: invite.temporary ? 'Yes' : 'No',
        },
      }, config);
    },
  },

  {
    name: Events.InviteDelete,
    async execute(client, invite) {
      if (!invite.guild) return;
      const config = await configService.get(invite.guild);
      if (!config.logging?.events?.inviteDelete) return;

      await logService.record(invite.guild, {
        category: 'invite',
        event: 'inviteDelete',
        title: `${EMOJIS.link} Invite Deleted`,
        summary: `\`${invite.code}\` was removed`,
        channelId: invite.channelId,
        severity: 'debug',
      }, config);
    },
  },

  // ── Webhooks ──────────────────────────────────────────────────────────────
  {
    name: Events.WebhooksUpdate,
    async execute(client, channel) {
      await antiNuke.onWebhookUpdate(channel).catch(() => null);

      const config = await configService.get(channel.guild);
      if (!config.logging?.events?.webhookUpdate) return;

      const entry = await fetchAuditEntry(channel.guild, AuditLogEvent.WebhookCreate, null, { retries: 2 });
      await logService.record(channel.guild, {
        category: 'webhook',
        event: 'webhookUpdate',
        title: `${EMOJIS.link} Webhooks Changed`,
        summary: `Webhook configuration changed in <#${channel.id}>`,
        actorId: entry?.executor?.id ?? '',
        actorName: entry?.executor?.tag ?? '',
        channelId: channel.id,
        severity: 'warn',
      }, config);
    },
  },

  // ── Emoji ─────────────────────────────────────────────────────────────────
  {
    name: Events.GuildEmojiCreate,
    async execute(client, emoji) {
      await antiNuke.onEmojiCreate(emoji).catch(() => null);
      const config = await configService.get(emoji.guild);
      if (!config.logging?.events?.emojiUpdate) return;
      await logService.record(emoji.guild, {
        category: 'guild',
        event: 'emojiUpdate',
        title: `${EMOJIS.add} Emoji Added`,
        summary: `\`:${emoji.name}:\` was added`,
        thumbnail: emoji.imageURL?.({ size: 64 }),
        severity: 'debug',
      }, config);
    },
  },

  {
    name: Events.GuildEmojiDelete,
    async execute(client, emoji) {
      await antiNuke.onEmojiDelete(emoji).catch(() => null);
      const config = await configService.get(emoji.guild);
      if (!config.logging?.events?.emojiUpdate) return;
      await logService.record(emoji.guild, {
        category: 'guild',
        event: 'emojiUpdate',
        title: `${EMOJIS.trash} Emoji Removed`,
        summary: `\`:${emoji.name}:\` was deleted`,
        severity: 'warn',
      }, config);
    },
  },

  // ── Guild settings ────────────────────────────────────────────────────────
  {
    name: Events.GuildUpdate,
    async execute(client, oldGuild, newGuild) {
      const config = await configService.get(newGuild);
      if (!config.logging?.events?.guildUpdate) return;

      const changes = {};
      if (oldGuild.name !== newGuild.name) changes.Name = `\`${oldGuild.name}\` → \`${newGuild.name}\``;
      if (oldGuild.ownerId !== newGuild.ownerId) changes.Owner = `<@${oldGuild.ownerId}> → <@${newGuild.ownerId}>`;
      if (oldGuild.verificationLevel !== newGuild.verificationLevel) {
        changes['Verification level'] = `${oldGuild.verificationLevel} → ${newGuild.verificationLevel}`;
      }
      if (oldGuild.iconURL() !== newGuild.iconURL()) changes.Icon = 'Server icon changed';
      if (!Object.keys(changes).length) return;

      const entry = await fetchAuditEntry(newGuild, AuditLogEvent.GuildUpdate, newGuild.id);
      await logService.record(newGuild, {
        category: 'guild',
        event: 'guildUpdate',
        title: `${EMOJIS.pencil} Server Settings Changed`,
        actorId: entry?.executor?.id ?? '',
        actorName: entry?.executor?.tag ?? '',
        severity: changes.Owner ? 'critical' : 'info',
        fields: changes,
      }, config);
    },
  },

  // ── The bot joining a new server ──────────────────────────────────────────
  {
    name: Events.GuildCreate,
    async execute(client, guild) {
      log.success(`Joined a new guild: ${guild.name} (${guild.memberCount} members)`);
      const config = await configService.get(guild);

      const { ok, missing } = permissions.botHasPermissions(guild, REQUIRED_BOT_PERMISSIONS);

      // Greet whoever can actually act on the setup instructions.
      const target = guild.systemChannel
        ?? guild.channels.cache.find((channel) => channel.isTextBased?.()
          && channel.permissionsFor(guild.members.me)?.has('SendMessages'));

      await safeSend(target, {
        embeds: [embeds.panel({
          config,
          title: `${EMOJIS.brand} Thanks for adding ${config.brand?.name ?? 'the bot'}`,
          description:
            'This bot turns a Discord server into a complete client workspace: tickets, orders, ' +
            'reviews, a portfolio, business analytics, moderation and security.\n\n' +
            '**Get started:** run `/setup` as an administrator. It rebuilds the server from scratch, ' +
            'so run it on a fresh server — or take a backup first with `/backup create`.',
          fields: [
            {
              name: 'Before you run /setup',
              value:
                `${EMOJIS.bullet} Move my role near the top of **Server Settings → Roles**\n` +
                `${EMOJIS.bullet} Make sure I have Administrator, or the permissions listed below\n` +
                `${EMOJIS.bullet} Understand that \`/setup\` **deletes existing channels and roles**`,
            },
            ...(ok
              ? [{ name: 'Permissions', value: `${EMOJIS.success} All required permissions are granted.` }]
              : [{ name: 'Missing Permissions', value: `${EMOJIS.warning} ${permissions.humanizePermissions(missing)}` }]),
          ],
          footer: 'Run /help for a full command reference.',
        })],
      });
    },
  },

  {
    name: Events.GuildDelete,
    async execute(client, guild) {
      log.warn(`Removed from guild: ${guild.name ?? guild.id}`);
    },
  },
];
