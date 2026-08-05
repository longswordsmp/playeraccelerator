'use strict';

/**
 * Bulk deletion logging — a purge, or the aftermath of a raid cleanup.
 */

const { Events } = require('discord.js');

const configService = require('../../services/configService');
const logService = require('../../services/logService');
const { EMOJIS } = require('../../config/branding');
const { truncate } = require('../../utils/formatters');
const { GuildStats } = require('../../database/models');

module.exports = {
  name: Events.MessageBulkDelete,

  /**
   * @param {import('../../core/Client').StudioClient} client
   * @param {import('discord.js').Collection<string, import('discord.js').Message>} messages
   * @param {import('discord.js').GuildTextBasedChannel} channel
   */
  async execute(client, messages, channel) {
    if (!channel?.guild) return;
    const config = await configService.get(channel.guild);
    if (!config.logging?.events?.messageBulkDelete) return;

    await GuildStats.bump(channel.guild.id, { 'moderation.messagesDeleted': messages.size });

    // Summarise by author rather than dumping every message.
    const byAuthor = new Map();
    for (const message of messages.values()) {
      const key = message.author?.tag ?? 'Unknown';
      byAuthor.set(key, (byAuthor.get(key) ?? 0) + 1);
    }
    const breakdown = [...byAuthor.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([author, count]) => `${author}: ${count}`)
      .join('\n');

    await logService.record(channel.guild, {
      category: 'message',
      event: 'messageBulkDelete',
      title: `${EMOJIS.trash} Bulk Delete`,
      summary: `${messages.size} messages were deleted in <#${channel.id}>`,
      channelId: channel.id,
      severity: 'warn',
      fields: { Authors: truncate(breakdown || '—', 1024) },
    }, config);
  },
};
