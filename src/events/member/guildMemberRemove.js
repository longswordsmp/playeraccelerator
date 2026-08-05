'use strict';

/**
 * Member departure: distinguish a kick from a voluntary leave, keep the record,
 * and feed the mass-leave detector.
 */

const { Events } = require('discord.js');

const configService = require('../../services/configService');
const logService = require('../../services/logService');
const antiRaid = require('../../security/antiRaid');
const antiNuke = require('../../security/antiNuke');
const inviteService = require('../../services/inviteService');
const { User, GuildStats } = require('../../database/models');
const { EMOJIS } = require('../../config/branding');
const { timestamp, duration } = require('../../utils/formatters');

module.exports = {
  name: Events.GuildMemberRemove,

  /**
   * @param {import('../../core/Client').StudioClient} client
   * @param {import('discord.js').GuildMember} member
   */
  async execute(client, member) {
    if (!member.guild) return;
    const config = await configService.get(member.guild);

    await User.updateOne(
      { guildId: member.guild.id, userId: member.id },
      { $set: { inGuild: false, leftAt: new Date() } },
    ).catch(() => null);
    await GuildStats.bump(member.guild.id, { 'members.leaves': 1 });

    await antiRaid.onLeave(member, config);
    // Revoke referral credit if they left inside the grace window.
    await inviteService.revokeOnLeave(member, config).catch(() => null);
    // Detects a kick, which is a monitored destructive action.
    await antiNuke.onMemberRemove(member).catch(() => null);

    const roles = member.roles?.cache
      ?.filter((role) => role.id !== member.guild.id)
      ?.map((role) => role.name)
      ?.slice(0, 10) ?? [];

    await logService.record(member.guild, {
      category: 'member',
      event: 'memberLeave',
      title: `${EMOJIS.user} Member Left`,
      summary: `${member.user?.tag ?? member.id} left the server`,
      actorId: member.id,
      actorName: member.user?.tag ?? '',
      thumbnail: member.user?.displayAvatarURL?.({ size: 128 }),
      fields: {
        Joined: member.joinedAt ? `${timestamp(member.joinedAt, 'full')} (${duration(Date.now() - member.joinedTimestamp)} ago)` : 'Unknown',
        'Member count': String(member.guild.memberCount),
        ...(roles.length ? { Roles: roles.join(', ') } : {}),
      },
    }, config);
  },
};
