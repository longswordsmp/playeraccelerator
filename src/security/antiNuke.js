'use strict';

/**
 * Anti-nuke protection.
 *
 * Watches destructive administrative actions, attributes them through the audit
 * log, and applies rate limits per actor. Crossing a limit strips the actor's
 * dangerous permissions (or kicks/bans them, per configuration) and attempts to
 * restore what was destroyed.
 *
 * ── What Discord makes possible, and what it does not ───────────────────────
 *   • Attribution requires the View Audit Log permission and is eventually
 *     consistent — entries can lag by a second or two, which is why lookups
 *     retry briefly.
 *   • A deleted channel can be recreated with the same name, type, topic,
 *     position and permission overwrites. Its **messages cannot be restored** —
 *     Discord provides no API to write message history. The recreated channel
 *     has a new ID.
 *   • A deleted role can be recreated with the same name, colour and
 *     permissions. **Which members held it cannot be restored**, because the
 *     audit log does not record the membership list.
 *   • The bot cannot act on the guild owner, nor on anyone whose highest role
 *     sits above the bot's own. Those cases are detected and reported instead
 *     of failing silently.
 */

const { AuditLogEvent, PermissionFlagsBits, PermissionsBitField, ChannelType } = require('discord.js');

const { SlidingWindow, registry } = require('../utils/rateLimiter');
const configService = require('../services/configService');
const logService = require('../services/logService');
const moderationService = require('../services/moderationService');
const embeds = require('../utils/embeds');
const permissions = require('../utils/permissions');
const { fetchAuditEntry, attempt, safeSend } = require('../utils/discord');
const { EMOJIS } = require('../config/branding');
const { truncate } = require('../utils/formatters');
const { GuildStats } = require('../database/models');
const { logger } = require('../utils/logger');

const log = logger.child('antinuke');

/** One window per tracked action type, sized to the longest configured window. */
const counters = new Map();

/** Fetch (creating on demand) the counter for an action. */
function counterFor(action, windowSeconds) {
  let counter = counters.get(action);
  if (!counter) {
    counter = registry.register(new SlidingWindow(windowSeconds * 1000));
    counters.set(action, counter);
  }
  counter.windowMs = Math.max(counter.windowMs, windowSeconds * 1000);
  return counter;
}

/** Permissions that make an account dangerous — stripped on a strike. */
const DANGEROUS_PERMISSIONS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.ManageGuildExpressions,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.MentionEveryone,
];

/** Human labels for each monitored action. */
const ACTION_LABELS = {
  channelDelete: 'Channel deletion',
  channelCreate: 'Channel creation',
  roleDelete: 'Role deletion',
  roleCreate: 'Role creation',
  roleUpdate: 'Role modification',
  memberBan: 'Member ban',
  memberKick: 'Member kick',
  webhookCreate: 'Webhook creation',
  webhookDelete: 'Webhook deletion',
  emojiDelete: 'Emoji deletion',
  emojiCreate: 'Emoji creation',
  permissionChange: 'Permission change',
  memberRoleAdd: 'Role assignment',
};

/** Snapshots of deleted objects, kept briefly so restoration is possible. */
const restorePool = new Map();
registry.register({
  prune() {
    const cutoff = Date.now() - 300_000;
    for (const [key, entry] of restorePool) if (entry.at < cutoff) restorePool.delete(key);
  },
});

/**
 * Whether an actor is exempt from anti-nuke.
 * @param {import('discord.js').Guild} guild
 * @param {string} userId
 * @param {object} config
 */
function isExempt(guild, userId, config) {
  if (!userId) return true;
  if (userId === guild.ownerId) return true;
  if (userId === guild.client.user.id) return true;
  if (permissions.isBotOwner(userId)) return true;
  return (config.antiNuke?.whitelist ?? []).includes(userId);
}

/**
 * Record an action and decide whether it crosses the configured limit.
 *
 * @param {import('discord.js').Guild} guild
 * @param {string} action key from the limits configuration
 * @param {string} actorId
 * @param {object} config
 * @returns {{ tripped: boolean, count: number, limit: object }}
 */
function track(guild, action, actorId, config) {
  const limit = config.antiNuke?.limits?.[action] ?? { max: 3, window: 20 };
  const counter = counterFor(action, limit.window);
  const count = counter.hit(`${guild.id}:${actorId}`);
  return { tripped: count >= limit.max, count, limit };
}

/**
 * Respond to a member who tripped a limit.
 *
 * @param {import('discord.js').Guild} guild
 * @param {string} actorId
 * @param {string} action
 * @param {{ count: number, limit: object }} detail
 * @param {object} config
 * @returns {Promise<{ punishment: string, succeeded: boolean, note: string|null }>}
 */
async function strike(guild, actorId, action, detail, config) {
  const punishment = config.antiNuke?.punishment ?? 'strip';
  const member = await guild.members.fetch(actorId).catch(() => null);
  const label = ACTION_LABELS[action] ?? action;
  const reason = `Anti-Nuke: ${detail.count} × ${label} within ${detail.limit.window}s (limit ${detail.limit.max})`;

  let succeeded = false;
  let note = null;

  if (!member) {
    note = 'The actor is no longer in the server — no punishment could be applied.';
  } else if (punishment === 'none') {
    note = 'Punishment is set to `none`; the event was logged only.';
  } else {
    const canAct = permissions.botCanActOn(guild, member);
    if (!canAct.ok) {
      note = `Discord prevented action: ${canAct.reason}`;
    } else if (punishment === 'strip') {
      // Remove every role that grants a dangerous permission.
      const dangerous = member.roles.cache.filter((role) => DANGEROUS_PERMISSIONS.some((permission) => role.permissions.has(permission))
        && role.editable);
      if (dangerous.size) {
        const removed = await attempt(() => member.roles.remove([...dangerous.keys()], truncate(reason, 500)), {
          label: 'strip dangerous roles',
        });
        succeeded = Boolean(removed);
        if (!succeeded) note = 'The dangerous roles could not be removed — check my role position.';
      } else {
        note = 'The actor holds dangerous permissions through a role I cannot edit, or through server ownership.';
      }
    } else {
      const result = await moderationService.punish({
        guild,
        type: punishment,
        target: member.user,
        moderator: { id: guild.client.user.id, tag: 'Anti-Nuke' },
        reason,
        config,
        automated: true,
        source: 'antinuke',
      }).catch((err) => {
        note = `Punishment failed: ${err.message}`;
        return null;
      });
      succeeded = Boolean(result);
    }
  }

  await GuildStats.bump(guild.id, { 'security.nukeAlerts': 1 });

  // Alert staff with everything needed to make a decision.
  const alertChannel = configService.logChannel(guild, config, 'security')
    ?? configService.channel(guild, config, 'staffChat');
  if (alertChannel) {
    const staffRole = config.roles?.leadDeveloper ?? config.roles?.manager;
    await safeSend(alertChannel, {
      content: staffRole ? `<@&${staffRole}>` : undefined,
      embeds: [embeds.error({
        config,
        title: 'Anti-Nuke Triggered',
        description: `<@${actorId}> performed **${detail.count} × ${label}** within **${detail.limit.window} seconds**.`,
        fields: [
          { name: 'Actor', value: `<@${actorId}>\n\`${actorId}\``, inline: true },
          { name: 'Action', value: label, inline: true },
          { name: 'Limit', value: `${detail.limit.max} per ${detail.limit.window}s`, inline: true },
          { name: 'Response', value: succeeded ? `\`${punishment}\` applied` : `\`${punishment}\` — **not applied**`, inline: true },
          ...(note ? [{ name: 'Note', value: note, inline: false }] : []),
        ],
        footer: 'Review the audit log and confirm this was not a legitimate administrative action.',
      })],
    });
  }

  await logService.security(guild, {
    event: `antinuke.${action}`,
    metric: 'nuke',
    title: `${EMOJIS.security} Anti-Nuke Triggered`,
    summary: reason,
    actorId,
    severity: 'critical',
    fields: { Response: punishment, Applied: succeeded ? 'Yes' : 'No', ...(note ? { Note: note } : {}) },
  }, config);

  log.warn(`Anti-nuke strike in ${guild.name}`, { actorId, action, count: detail.count, punishment, succeeded });
  return { punishment, succeeded, note };
}

/**
 * The generic handler every guild event funnels into.
 *
 * @param {import('discord.js').Guild} guild
 * @param {string} action
 * @param {number} auditType AuditLogEvent
 * @param {string|null} targetId
 * @param {{ restore?: () => Promise<unknown>, describe?: string }} [options]
 */
async function handle(guild, action, auditType, targetId, options = {}) {
  const config = await configService.get(guild).catch(() => null);
  if (!config?.antiNuke?.enabled) return null;

  const entry = await fetchAuditEntry(guild, auditType, targetId);
  if (!entry) {
    // Without audit log access the action cannot be attributed. Say so rather
    // than silently doing nothing, because it changes what protection means.
    if (!guild.members.me?.permissions?.has(PermissionFlagsBits.ViewAuditLog)) {
      await logService.security(guild, {
        event: 'antinuke.blind',
        title: `${EMOJIS.warning} Anti-Nuke Cannot Attribute Actions`,
        summary:
          'A destructive action occurred, but I lack the **View Audit Log** permission, so I cannot identify who did it. ' +
          'Grant that permission for anti-nuke to function.',
        severity: 'warn',
      }, config);
    }
    return null;
  }

  const actorId = entry.executor?.id;
  if (isExempt(guild, actorId, config)) return null;

  const detail = track(guild, action, actorId, config);

  // Always log the individual action, even below the threshold.
  await logService.security(guild, {
    event: `antinuke.watch.${action}`,
    title: `${EMOJIS.security} ${ACTION_LABELS[action] ?? action}`,
    summary: `${entry.executor?.tag ?? actorId} — ${detail.count}/${detail.limit.max} within ${detail.limit.window}s`,
    actorId,
    actorName: entry.executor?.tag ?? '',
    targetId: targetId ?? '',
    targetName: options.describe ?? '',
    severity: detail.tripped ? 'critical' : 'info',
  }, config);

  if (!detail.tripped) return null;

  const result = await strike(guild, actorId, action, detail, config);

  // Attempt restoration.
  if (config.antiNuke?.attemptRestore !== false && options.restore) {
    const restored = await options.restore().catch((err) => {
      log.warn('Restoration failed', { message: err.message });
      return null;
    });
    if (restored) {
      await logService.security(guild, {
        event: 'antinuke.restore',
        title: `${EMOJIS.success} Structure Restored`,
        summary: `Recreated: ${options.describe ?? 'deleted object'}. Note: message history and role memberships cannot be restored by any bot.`,
        severity: 'info',
      }, config);
    }
  }

  return result;
}

// ── Event adapters ───────────────────────────────────────────────────────────

/** A channel was deleted. */
async function onChannelDelete(channel) {
  if (!channel.guild) return;

  const snapshot = {
    at: Date.now(),
    name: channel.name,
    type: channel.type,
    parentId: channel.parentId,
    topic: channel.topic ?? undefined,
    nsfw: channel.nsfw ?? false,
    rateLimitPerUser: channel.rateLimitPerUser ?? 0,
    position: channel.rawPosition,
    overwrites: [...channel.permissionOverwrites.cache.values()].map((overwrite) => ({
      id: overwrite.id,
      type: overwrite.type,
      allow: overwrite.allow.bitfield,
      deny: overwrite.deny.bitfield,
    })),
  };
  restorePool.set(channel.id, snapshot);

  return handle(channel.guild, 'channelDelete', AuditLogEvent.ChannelDelete, channel.id, {
    describe: `#${channel.name}`,
    restore: async () => {
      const created = await channel.guild.channels.create({
        name: snapshot.name,
        type: snapshot.type,
        parent: snapshot.parentId ?? undefined,
        topic: snapshot.topic,
        nsfw: snapshot.nsfw,
        rateLimitPerUser: snapshot.rateLimitPerUser || undefined,
        permissionOverwrites: snapshot.overwrites.map((overwrite) => ({
          id: overwrite.id,
          type: overwrite.type,
          allow: new PermissionsBitField(overwrite.allow),
          deny: new PermissionsBitField(overwrite.deny),
        })),
        reason: 'Anti-Nuke automatic restoration',
      });
      // Tell everyone what was and was not recovered.
      if (created.type === ChannelType.GuildText) {
        await safeSend(created, {
          embeds: [embeds.warning({
            title: 'Channel Restored by Anti-Nuke',
            description:
              'This channel was deleted and has been automatically recreated with its original name, ' +
              'topic and permissions.\n\n' +
              '**Message history could not be restored.** Discord provides no API for a bot to write ' +
              'historical messages — that data is permanently gone.',
          })],
        });
      }
      return created;
    },
  });
}

/** A channel was created. */
const onChannelCreate = (channel) => (channel.guild
  ? handle(channel.guild, 'channelCreate', AuditLogEvent.ChannelCreate, channel.id, { describe: `#${channel.name}` })
  : null);

/** A role was deleted. */
async function onRoleDelete(role) {
  const snapshot = {
    at: Date.now(),
    name: role.name,
    color: role.color,
    hoist: role.hoist,
    mentionable: role.mentionable,
    permissions: role.permissions.bitfield,
    position: role.position,
    memberCount: role.members.size,
  };
  restorePool.set(role.id, snapshot);

  return handle(role.guild, 'roleDelete', AuditLogEvent.RoleDelete, role.id, {
    describe: `@${role.name}`,
    restore: async () => {
      const created = await role.guild.roles.create({
        name: snapshot.name,
        color: snapshot.color,
        hoist: snapshot.hoist,
        mentionable: snapshot.mentionable,
        permissions: new PermissionsBitField(snapshot.permissions),
        reason: 'Anti-Nuke automatic restoration',
      });
      // Membership is not recoverable — the audit log does not record it.
      const config = await configService.get(role.guild).catch(() => null);
      if (config && snapshot.memberCount > 0) {
        await logService.security(role.guild, {
          event: 'antinuke.roleRestoreLimitation',
          title: `${EMOJIS.warning} Role Restored — Membership Lost`,
          summary:
            `\`@${snapshot.name}\` was recreated with its original colour and permissions, but the ` +
            `**${snapshot.memberCount} member(s)** who held it must be re-assigned manually. ` +
            'Discord does not record role membership in the audit log, so no bot can recover it.',
          severity: 'warn',
        }, config);
      }
      return created;
    },
  });
}

/** A role was created. */
const onRoleCreate = (role) => handle(role.guild, 'roleCreate', AuditLogEvent.RoleCreate, role.id, { describe: `@${role.name}` });

/** A role was modified — permission escalation is the dangerous case. */
async function onRoleUpdate(oldRole, newRole) {
  const gainedDangerous = DANGEROUS_PERMISSIONS.some(
    (permission) => !oldRole.permissions.has(permission) && newRole.permissions.has(permission),
  );
  const action = gainedDangerous ? 'permissionChange' : 'roleUpdate';
  return handle(newRole.guild, action, AuditLogEvent.RoleUpdate, newRole.id, {
    describe: `@${newRole.name}${gainedDangerous ? ' (gained dangerous permissions)' : ''}`,
  });
}

/** A member was banned. */
const onMemberBan = (ban) => handle(ban.guild, 'memberBan', AuditLogEvent.MemberBanAdd, ban.user.id, { describe: ban.user.tag });

/** A member left — distinguishing a kick requires the audit log. */
async function onMemberRemove(member) {
  const entry = await fetchAuditEntry(member.guild, AuditLogEvent.MemberKick, member.id, { retries: 2, maxAgeMs: 8000 });
  if (!entry) return null; // they left voluntarily
  return handle(member.guild, 'memberKick', AuditLogEvent.MemberKick, member.id, { describe: member.user.tag });
}

/** Webhooks changed — a classic nuke vector because they bypass rate limits. */
const onWebhookUpdate = (channel) => (channel.guild
  ? handle(channel.guild, 'webhookCreate', AuditLogEvent.WebhookCreate, null, { describe: `#${channel.name}` })
  : null);

/** Emoji were removed. */
const onEmojiDelete = (emoji) => handle(emoji.guild, 'emojiDelete', AuditLogEvent.EmojiDelete, emoji.id, { describe: `:${emoji.name}:` });

/** Emoji were added. */
const onEmojiCreate = (emoji) => handle(emoji.guild, 'emojiCreate', AuditLogEvent.EmojiCreate, emoji.id, { describe: `:${emoji.name}:` });

/** A channel's permission overwrites changed. */
const onChannelUpdate = (oldChannel, newChannel) => {
  if (!newChannel.guild) return null;
  const changed = oldChannel.permissionOverwrites?.cache?.size !== newChannel.permissionOverwrites?.cache?.size;
  if (!changed) return null;
  return handle(newChannel.guild, 'permissionChange', AuditLogEvent.ChannelOverwriteUpdate, newChannel.id, {
    describe: `#${newChannel.name}`,
  });
};

/** Mass role assignment — the quiet way to hand out administrator. */
async function onMemberUpdate(oldMember, newMember) {
  const added = newMember.roles.cache.filter((role) => !oldMember.roles.cache.has(role.id));
  if (!added.size) return null;
  const dangerous = added.some((role) => DANGEROUS_PERMISSIONS.some((permission) => role.permissions.has(permission)));
  if (!dangerous) return null;
  return handle(newMember.guild, 'memberRoleAdd', AuditLogEvent.MemberRoleUpdate, newMember.id, {
    describe: `${newMember.user.tag} gained ${added.map((role) => `@${role.name}`).join(', ')}`,
  });
}

/** Current counters for `/security status`. */
function status(guildId) {
  const out = {};
  for (const [action, counter] of counters) {
    let total = 0;
    for (const key of counter.events.keys()) {
      if (key.startsWith(`${guildId}:`)) total += counter.count(key);
    }
    if (total) out[action] = total;
  }
  return out;
}

module.exports = {
  ACTION_LABELS,
  DANGEROUS_PERMISSIONS,
  isExempt,
  track,
  strike,
  handle,
  status,
  onChannelDelete,
  onChannelCreate,
  onChannelUpdate,
  onRoleDelete,
  onRoleCreate,
  onRoleUpdate,
  onMemberBan,
  onMemberRemove,
  onMemberUpdate,
  onWebhookUpdate,
  onEmojiDelete,
  onEmojiCreate,
};
