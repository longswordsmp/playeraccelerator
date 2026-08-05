'use strict';

/**
 * Channel lifecycle logging + anti-nuke hooks.
 *
 * One module exporting several listeners keeps related handlers together; the
 * event handler supports this by allowing an array export.
 */

const { Events, ChannelType, AuditLogEvent } = require('discord.js');

const configService = require('../../services/configService');
const logService = require('../../services/logService');
const antiNuke = require('../../security/antiNuke');
const { fetchAuditEntry } = require('../../utils/discord');
const { EMOJIS } = require('../../config/branding');
const { titleCase } = require('../../utils/formatters');

/** Readable channel type names. */
const TYPE_NAMES = {
  [ChannelType.GuildText]: 'Text',
  [ChannelType.GuildVoice]: 'Voice',
  [ChannelType.GuildCategory]: 'Category',
  [ChannelType.GuildAnnouncement]: 'Announcement',
  [ChannelType.GuildStageVoice]: 'Stage',
  [ChannelType.GuildForum]: 'Forum',
  [ChannelType.PublicThread]: 'Thread',
  [ChannelType.PrivateThread]: 'Private Thread',
};

module.exports = [
  {
    name: Events.ChannelCreate,
    async execute(client, channel) {
      if (!channel.guild) return;
      await antiNuke.onChannelCreate(channel).catch(() => null);

      const config = await configService.get(channel.guild);
      if (!config.logging?.events?.channelCreate) return;

      const entry = await fetchAuditEntry(channel.guild, AuditLogEvent.ChannelCreate, channel.id);
      await logService.record(channel.guild, {
        category: 'channel',
        event: 'channelCreate',
        title: `${EMOJIS.add} Channel Created`,
        summary: `**${channel.name}** was created`,
        actorId: entry?.executor?.id ?? '',
        actorName: entry?.executor?.tag ?? '',
        channelId: channel.id,
        fields: {
          Type: TYPE_NAMES[channel.type] ?? titleCase(String(channel.type)),
          Category: channel.parent?.name ?? '—',
        },
      }, config);
    },
  },

  {
    name: Events.ChannelDelete,
    async execute(client, channel) {
      if (!channel.guild) return;
      await antiNuke.onChannelDelete(channel).catch(() => null);

      const config = await configService.get(channel.guild);
      if (!config.logging?.events?.channelDelete) return;

      const entry = await fetchAuditEntry(channel.guild, AuditLogEvent.ChannelDelete, channel.id);
      await logService.record(channel.guild, {
        category: 'channel',
        event: 'channelDelete',
        title: `${EMOJIS.trash} Channel Deleted`,
        summary: `**${channel.name}** was deleted`,
        actorId: entry?.executor?.id ?? '',
        actorName: entry?.executor?.tag ?? '',
        severity: 'warn',
        fields: {
          Type: TYPE_NAMES[channel.type] ?? titleCase(String(channel.type)),
          Category: channel.parent?.name ?? '—',
          ID: `\`${channel.id}\``,
        },
      }, config);
    },
  },

  {
    name: Events.ChannelUpdate,
    async execute(client, oldChannel, newChannel) {
      if (!newChannel.guild) return;
      await antiNuke.onChannelUpdate(oldChannel, newChannel).catch(() => null);

      const config = await configService.get(newChannel.guild);
      if (!config.logging?.events?.channelUpdate) return;

      const changes = {};
      if (oldChannel.name !== newChannel.name) changes.Name = `\`${oldChannel.name}\` → \`${newChannel.name}\``;
      if (oldChannel.topic !== newChannel.topic) changes.Topic = `${oldChannel.topic || '_none_'} → ${newChannel.topic || '_none_'}`;
      if (oldChannel.nsfw !== newChannel.nsfw) changes.NSFW = `${oldChannel.nsfw} → ${newChannel.nsfw}`;
      if (oldChannel.rateLimitPerUser !== newChannel.rateLimitPerUser) {
        changes.Slowmode = `${oldChannel.rateLimitPerUser ?? 0}s → ${newChannel.rateLimitPerUser ?? 0}s`;
      }
      if (oldChannel.parentId !== newChannel.parentId) {
        changes.Category = `${oldChannel.parent?.name ?? '—'} → ${newChannel.parent?.name ?? '—'}`;
      }
      const oldOverwrites = oldChannel.permissionOverwrites?.cache?.size ?? 0;
      const newOverwrites = newChannel.permissionOverwrites?.cache?.size ?? 0;
      if (oldOverwrites !== newOverwrites) changes.Permissions = `${oldOverwrites} → ${newOverwrites} overwrites`;

      if (!Object.keys(changes).length) return;

      const entry = await fetchAuditEntry(newChannel.guild, AuditLogEvent.ChannelUpdate, newChannel.id);
      await logService.record(newChannel.guild, {
        category: 'channel',
        event: 'channelUpdate',
        title: `${EMOJIS.pencil} Channel Updated`,
        summary: `**${newChannel.name}** was modified`,
        actorId: entry?.executor?.id ?? '',
        actorName: entry?.executor?.tag ?? '',
        channelId: newChannel.id,
        severity: 'debug',
        fields: changes,
      }, config);
    },
  },
];
