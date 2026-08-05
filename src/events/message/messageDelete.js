'use strict';

/**
 * Message deletion logging, plus ghost-ping detection.
 * Audit log attribution distinguishes a self-delete from a moderator delete.
 */

const { Events, AuditLogEvent } = require('discord.js');

const configService = require('../../services/configService');
const logService = require('../../services/logService');
const autoMod = require('../../security/autoMod');
const { fetchAuditEntry } = require('../../utils/discord');
const { EMOJIS } = require('../../config/branding');
const { truncate, bytes } = require('../../utils/formatters');

module.exports = {
  name: Events.MessageDelete,

  /**
   * @param {import('../../core/Client').StudioClient} client
   * @param {import('discord.js').Message} message
   */
  async execute(client, message) {
    if (!message.guild) return;
    const config = await configService.get(message.guild);

    await autoMod.checkGhostPing(message, config).catch(() => null);

    if (!config.logging?.events?.messageDelete) return;
    // A partial message carries no content worth logging.
    if (message.partial && !message.content) return;
    if (message.author?.bot && !message.embeds?.length) return;

    const entry = await fetchAuditEntry(message.guild, AuditLogEvent.MessageDelete, message.author?.id, {
      retries: 2,
      maxAgeMs: 5000,
    });
    const deletedBy = entry?.executor && entry.executor.id !== message.author?.id ? entry.executor : null;

    const attachments = [...(message.attachments?.values() ?? [])];

    await logService.record(message.guild, {
      category: 'message',
      event: 'messageDelete',
      title: `${EMOJIS.trash} Message Deleted`,
      summary: message.content ? truncate(message.content, 1800) : '_No text content_',
      actorId: message.author?.id ?? '',
      actorName: message.author?.tag ?? 'Unknown',
      channelId: message.channelId,
      messageId: message.id,
      severity: 'debug',
      fields: {
        ...(deletedBy ? { 'Deleted by': `<@${deletedBy.id}>` } : {}),
        ...(attachments.length
          ? { Attachments: attachments.map((a) => `[${a.name}](${a.url}) · ${bytes(a.size)}`).join('\n') }
          : {}),
        ...(message.embeds?.length ? { Embeds: String(message.embeds.length) } : {}),
      },
    }, config);
  },
};
