'use strict';

/**
 * Account-level changes: username, display name and avatar.
 *
 * Discord API note: `userUpdate` only fires for users the bot shares a guild
 * with AND has cached. Avatar changes in particular are best-effort — the
 * gateway does not guarantee delivery for every member of a large server.
 */

const { Events } = require('discord.js');

const configService = require('../../services/configService');
const logService = require('../../services/logService');
const { User } = require('../../database/models');
const { EMOJIS } = require('../../config/branding');

module.exports = {
  name: Events.UserUpdate,

  /**
   * @param {import('../../core/Client').StudioClient} client
   * @param {import('discord.js').User} oldUser
   * @param {import('discord.js').User} newUser
   */
  async execute(client, oldUser, newUser) {
    const changes = {};
    if (oldUser.username !== newUser.username) changes.Username = `\`${oldUser.username}\` → \`${newUser.username}\``;
    if (oldUser.globalName !== newUser.globalName) changes['Display name'] = `${oldUser.globalName ?? '_none_'} → ${newUser.globalName ?? '_none_'}`;
    if (oldUser.avatar !== newUser.avatar) changes.Avatar = 'Profile picture changed';
    if (!Object.keys(changes).length) return;

    // Log into every guild the bot shares with this user.
    for (const guild of client.guilds.cache.values()) {
      if (!guild.members.cache.has(newUser.id)) continue;

      // eslint-disable-next-line no-await-in-loop -- rare event, small guild set
      const config = await configService.get(guild);
      // eslint-disable-next-line no-await-in-loop
      await User.updateOne(
        { guildId: guild.id, userId: newUser.id },
        { $set: { username: newUser.username, displayName: newUser.globalName ?? newUser.username, avatar: newUser.displayAvatarURL({ size: 128 }) } },
      ).catch(() => null);

      if (!config.logging?.events?.userUpdate) continue;

      // eslint-disable-next-line no-await-in-loop
      await logService.record(guild, {
        category: 'member',
        event: 'userUpdate',
        title: `${EMOJIS.user} Profile Updated`,
        summary: `${newUser.tag} updated their account`,
        actorId: newUser.id,
        actorName: newUser.tag,
        thumbnail: changes.Avatar ? newUser.displayAvatarURL({ size: 128 }) : undefined,
        severity: 'debug',
        fields: changes,
      }, config);
    }
  },
};
