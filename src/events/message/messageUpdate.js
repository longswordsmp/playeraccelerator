'use strict';

/**
 * Message edit logging, and re-inspection by AutoMod.
 *
 * Editing a message into a scam link is a real evasion technique, so an edit is
 * treated exactly like a new message by the content filters.
 */

const { Events } = require('discord.js');

const configService = require('../../services/configService');
const logService = require('../../services/logService');
const autoMod = require('../../security/autoMod');
const { EMOJIS } = require('../../config/branding');
const { truncate } = require('../../utils/formatters');
const { messageLink } = require('../../utils/discord');

module.exports = {
  name: Events.MessageUpdate,

  /**
   * @param {import('../../core/Client').StudioClient} client
   * @param {import('discord.js').Message} oldMessage
   * @param {import('discord.js').Message} newMessage
   */
  async execute(client, oldMessage, newMessage) {
    if (!newMessage.guild || newMessage.author?.bot) return;
    // Embed resolution fires an update with identical content — ignore it.
    if (oldMessage.content === newMessage.content) return;

    const config = await configService.get(newMessage.guild);

    // Re-run the filters: an edit is a fresh opportunity to post something bad.
    await autoMod.inspect(newMessage, config).catch(() => null);

    if (!config.logging?.events?.messageUpdate) return;

    await logService.record(newMessage.guild, {
      category: 'message',
      event: 'messageUpdate',
      title: `${EMOJIS.pencil} Message Edited`,
      actorId: newMessage.author?.id ?? '',
      actorName: newMessage.author?.tag ?? '',
      channelId: newMessage.channelId,
      messageId: newMessage.id,
      severity: 'debug',
      fields: {
        Before: truncate(oldMessage.content || '_empty_', 1000),
        After: truncate(newMessage.content || '_empty_', 1000),
        Jump: `[Go to message](${messageLink(newMessage.guild.id, newMessage.channelId, newMessage.id)})`,
      },
    }, config);
  },
};
