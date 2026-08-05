'use strict';

/**
 * Member changes: nickname, roles, timeouts and boosts.
 * Also feeds the anti-nuke mass-role-assignment detector.
 */

const { Events, AuditLogEvent } = require('discord.js');

const configService = require('../../services/configService');
const logService = require('../../services/logService');
const antiNuke = require('../../security/antiNuke');
const { fetchAuditEntry } = require('../../utils/discord');
const { User, GuildStats } = require('../../database/models');
const { EMOJIS } = require('../../config/branding');
const { timestamp, truncate } = require('../../utils/formatters');

module.exports = {
  name: Events.GuildMemberUpdate,

  /**
   * @param {import('../../core/Client').StudioClient} client
   * @param {import('discord.js').GuildMember} oldMember
   * @param {import('discord.js').GuildMember} newMember
   */
  async execute(client, oldMember, newMember) {
    await antiNuke.onMemberUpdate(oldMember, newMember).catch(() => null);

    const config = await configService.get(newMember.guild);

    // ── Nickname ────────────────────────────────────────────────────────────
    if (oldMember.nickname !== newMember.nickname && config.logging?.events?.nicknameChange) {
      const entry = await fetchAuditEntry(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id, { retries: 2 });
      await logService.record(newMember.guild, {
        category: 'member',
        event: 'nicknameChange',
        title: `${EMOJIS.pencil} Nickname Changed`,
        summary: `${newMember.user.tag} changed nickname`,
        actorId: entry?.executor?.id ?? newMember.id,
        actorName: entry?.executor?.tag ?? newMember.user.tag,
        targetId: newMember.id,
        targetName: newMember.user.tag,
        severity: 'debug',
        fields: {
          Before: oldMember.nickname ?? '_none_',
          After: newMember.nickname ?? '_none_',
        },
      }, config);
      await User.updateOne(
        { guildId: newMember.guild.id, userId: newMember.id },
        { $set: { displayName: newMember.displayName } },
      ).catch(() => null);
    }

    // ── Roles ───────────────────────────────────────────────────────────────
    const added = newMember.roles.cache.filter((role) => !oldMember.roles.cache.has(role.id));
    const removed = oldMember.roles.cache.filter((role) => !newMember.roles.cache.has(role.id));

    if ((added.size || removed.size) && config.logging?.events?.roleChange) {
      const entry = await fetchAuditEntry(newMember.guild, AuditLogEvent.MemberRoleUpdate, newMember.id, { retries: 2 });
      await logService.record(newMember.guild, {
        category: 'member',
        event: 'roleChange',
        title: `${EMOJIS.users} Member Roles Changed`,
        summary: `${newMember.user.tag}'s roles were updated`,
        actorId: entry?.executor?.id ?? '',
        actorName: entry?.executor?.tag ?? '',
        targetId: newMember.id,
        targetName: newMember.user.tag,
        fields: {
          ...(added.size ? { Added: truncate(added.map((role) => `<@&${role.id}>`).join(' '), 1000) } : {}),
          ...(removed.size ? { Removed: truncate(removed.map((role) => `<@&${role.id}>`).join(' '), 1000) } : {}),
        },
      }, config);

      // Keep the denormalised staff flag accurate for dashboards.
      const permissionsUtil = require('../../utils/permissions');
      await User.updateOne(
        { guildId: newMember.guild.id, userId: newMember.id },
        { $set: { isStaff: permissionsUtil.isStaff(newMember, config) } },
      ).catch(() => null);
    }

    // ── Timeout ─────────────────────────────────────────────────────────────
    const oldTimeout = oldMember.communicationDisabledUntilTimestamp ?? 0;
    const newTimeout = newMember.communicationDisabledUntilTimestamp ?? 0;
    if (oldTimeout !== newTimeout) {
      const applied = newTimeout > Date.now();
      const entry = await fetchAuditEntry(newMember.guild, AuditLogEvent.MemberUpdate, newMember.id, { retries: 2 });
      await logService.record(newMember.guild, {
        category: 'moderation',
        event: 'memberTimeout',
        title: applied ? '⏳ Member Timed Out' : `${EMOJIS.success} Timeout Removed`,
        summary: `${newMember.user.tag} ${applied ? 'was timed out' : 'is no longer timed out'}`,
        actorId: entry?.executor?.id ?? '',
        actorName: entry?.executor?.tag ?? '',
        targetId: newMember.id,
        targetName: newMember.user.tag,
        severity: applied ? 'warn' : 'info',
        fields: applied ? { Until: timestamp(newTimeout, 'full'), Reason: truncate(entry?.reason ?? 'No reason recorded', 500) } : {},
      }, config);
    }

    // ── Boost ───────────────────────────────────────────────────────────────
    if (!oldMember.premiumSince && newMember.premiumSince && config.logging?.events?.memberBoost) {
      await GuildStats.bump(newMember.guild.id, {});
      await logService.record(newMember.guild, {
        category: 'member',
        event: 'memberBoost',
        title: '💎 Server Boosted',
        summary: `${newMember.user.tag} boosted the server`,
        actorId: newMember.id,
        actorName: newMember.user.tag,
        fields: { 'Total boosts': String(newMember.guild.premiumSubscriptionCount ?? 0) },
      }, config);
    }
  },
};
