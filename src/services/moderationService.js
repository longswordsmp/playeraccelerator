'use strict';

/**
 * Moderation engine.
 *
 * Every punishment — manual or automated — funnels through `punish()` so that
 * case numbering, hierarchy checks, DM notification, logging, statistics and
 * warning escalation all behave identically no matter what triggered them.
 */

const { PermissionFlagsBits } = require('discord.js');

const { Moderation, User, Counter, StaffStats, GuildStats } = require('../database/models');
const configService = require('./configService');
const logService = require('./logService');
const statisticsService = require('./statisticsService');
const embeds = require('../utils/embeds');
const errors = require('../utils/errors');
const permissions = require('../utils/permissions');
const { EMOJIS, COLORS } = require('../config/branding');
const { safeDm, fetchMember, attempt, safeSend } = require('../utils/discord');
const { duration, timestamp, truncate, safeField } = require('../utils/formatters');
const { logger } = require('../utils/logger');

const log = logger.child('moderation');

/** Discord caps a timeout at 28 days. */
const MAX_TIMEOUT_MS = 28 * 86_400_000;

/** Human labels for each action. */
const ACTION_LABELS = {
  warn: { label: 'Warning', emoji: '⚠️', color: COLORS.warning, past: 'warned' },
  unwarn: { label: 'Warning Removed', emoji: '✅', color: COLORS.success, past: 'had a warning removed' },
  mute: { label: 'Muted', emoji: '🔇', color: COLORS.warning, past: 'muted' },
  unmute: { label: 'Unmuted', emoji: '🔊', color: COLORS.success, past: 'unmuted' },
  timeout: { label: 'Timed Out', emoji: '⏳', color: COLORS.warning, past: 'timed out' },
  untimeout: { label: 'Timeout Removed', emoji: '✅', color: COLORS.success, past: 'released from timeout' },
  kick: { label: 'Kicked', emoji: '👢', color: COLORS.danger, past: 'kicked' },
  ban: { label: 'Banned', emoji: '🔨', color: COLORS.danger, past: 'banned' },
  unban: { label: 'Unbanned', emoji: '✅', color: COLORS.success, past: 'unbanned' },
  softban: { label: 'Soft-banned', emoji: '🧹', color: COLORS.danger, past: 'soft-banned' },
  note: { label: 'Note', emoji: '🗒️', color: COLORS.muted, past: 'noted' },
  purge: { label: 'Messages Purged', emoji: '🧹', color: COLORS.muted, past: 'purged' },
  automod: { label: 'AutoMod', emoji: '🤖', color: COLORS.warning, past: 'flagged' },
  lockdown: { label: 'Lockdown', emoji: '🔒', color: COLORS.danger, past: 'locked down' },
  antinuke: { label: 'Anti-Nuke', emoji: '🛡️', color: COLORS.danger, past: 'blocked' },
  antiraid: { label: 'Anti-Raid', emoji: '🛡️', color: COLORS.danger, past: 'blocked' },
};

/** Statistics field each action increments. */
const STAT_KEYS = {
  warn: { guild: 'moderation.warnings', staff: 'moderation.warningsIssued', user: 'moderation.totalWarnings' },
  timeout: { guild: 'moderation.timeouts', staff: 'moderation.timeoutsIssued', user: 'moderation.timeouts' },
  mute: { guild: 'moderation.timeouts', staff: 'moderation.timeoutsIssued', user: 'moderation.timeouts' },
  kick: { guild: 'moderation.kicks', staff: 'moderation.kicksIssued', user: 'moderation.kicks' },
  ban: { guild: 'moderation.bans', staff: 'moderation.bansIssued', user: 'moderation.bans' },
  softban: { guild: 'moderation.kicks', staff: 'moderation.kicksIssued', user: 'moderation.kicks' },
};

/**
 * Whether a member is exempt from automated moderation.
 * @param {import('discord.js').GuildMember|null} member
 * @param {object} config
 */
function isExempt(member, config) {
  if (!member) return false;
  if (member.user?.bot) return true;
  if (permissions.isBotOwner(member.id)) return true;
  if (member.id === member.guild.ownerId) return true;

  const moderation = config?.moderation ?? {};
  if ((moderation.whitelistedUsers ?? []).includes(member.id)) return true;
  if ((moderation.ignoredRoles ?? []).some((roleId) => member.roles.cache.has(roleId))) return true;
  if (moderation.exemptStaff !== false && permissions.isStaff(member, config)) return true;
  return false;
}

/** Whether a channel is excluded from automated moderation. */
function isChannelExempt(channelId, config) {
  return (config?.moderation?.ignoredChannels ?? []).includes(channelId);
}

/**
 * Apply a moderation action.
 *
 * @param {object} params
 * @param {import('discord.js').Guild} params.guild
 * @param {string} params.type action type
 * @param {import('discord.js').User|{id: string, tag?: string}} params.target
 * @param {{ id: string, tag?: string, bot?: boolean }} params.moderator
 * @param {string} [params.reason]
 * @param {number} [params.duration] milliseconds, for timed actions
 * @param {object} [params.config]
 * @param {boolean} [params.automated]
 * @param {string} [params.source] automod module or security system
 * @param {object} [params.context] channel/message/content snapshot
 * @param {string[]} [params.evidence]
 * @param {boolean} [params.silent] skip the DM notification
 * @param {number} [params.deleteMessageSeconds] for bans
 * @returns {Promise<{ case: object, applied: boolean, note: string|null }>}
 */
async function punish({
  guild,
  type,
  target,
  moderator,
  reason = 'No reason provided',
  duration: durationMs = null,
  config = null,
  automated = false,
  source = '',
  context = {},
  evidence = [],
  silent = false,
  deleteMessageSeconds = 0,
}) {
  const cfg = config ?? (await configService.get(guild));
  const targetId = target.id;
  const targetTag = target.tag ?? target.username ?? targetId;
  const member = await fetchMember(guild, targetId);

  // ── Hierarchy checks ──────────────────────────────────────────────────────
  if (['kick', 'ban', 'softban', 'timeout', 'mute'].includes(type) && member) {
    const check = permissions.botCanActOn(guild, member);
    if (!check.ok) throw new errors.DiscordLimitationError(check.reason);
  }

  const caseId = await Counter.next(guild.id, 'case');
  const now = new Date();
  const expiresAt = durationMs ? new Date(now.getTime() + durationMs) : null;

  // ── Notify before acting, otherwise a kick/ban makes the DM impossible ────
  let note = null;
  if (!silent && cfg.moderation?.dmOnPunish !== false && member && type !== 'note') {
    const meta = ACTION_LABELS[type] ?? ACTION_LABELS.warn;
    const delivered = await safeDm(member.user, {
      embeds: [embeds.base({
        config: cfg,
        color: meta.color,
        title: `${meta.emoji} ${meta.label} — ${guild.name}`,
        description: `You have been **${meta.past}** in **${guild.name}**.`,
        fields: [
          { name: 'Reason', value: safeField(reason, 1024) },
          ...(durationMs ? [{ name: 'Duration', value: duration(durationMs), inline: true }] : []),
          ...(expiresAt ? [{ name: 'Expires', value: timestamp(expiresAt, 'relative'), inline: true }] : []),
          { name: 'Case', value: `\`#${caseId}\``, inline: true },
        ],
        footer: automated ? `Automated action · ${source}` : 'If you believe this is a mistake, open a support ticket.',
      })],
    });
    if (!delivered) note = 'The member has direct messages disabled — they were not notified.';
  }

  // ── Apply the action ──────────────────────────────────────────────────────
  let applied = true;
  const auditReason = truncate(`${automated ? `[${source || 'AutoMod'}] ` : ''}${reason} (case #${caseId})`, 500);

  try {
    switch (type) {
      case 'timeout':
      case 'mute': {
        if (!member) throw new errors.NotFoundError('That member is not in the server.');
        const ms = Math.min(durationMs ?? 600_000, MAX_TIMEOUT_MS);
        await member.timeout(ms, auditReason);
        break;
      }
      case 'untimeout':
      case 'unmute': {
        if (!member) throw new errors.NotFoundError('That member is not in the server.');
        await member.timeout(null, auditReason);
        break;
      }
      case 'kick': {
        if (!member) throw new errors.NotFoundError('That member is not in the server.');
        await member.kick(auditReason);
        break;
      }
      case 'ban': {
        await guild.members.ban(targetId, { reason: auditReason, deleteMessageSeconds: Math.min(deleteMessageSeconds, 604_800) });
        break;
      }
      case 'softban': {
        await guild.members.ban(targetId, { reason: auditReason, deleteMessageSeconds: 86_400 });
        await guild.members.unban(targetId, `Softban cleanup (case #${caseId})`);
        break;
      }
      case 'unban': {
        await guild.members.unban(targetId, auditReason);
        break;
      }
      case 'warn':
      case 'note':
      case 'automod':
      case 'purge':
      case 'unwarn':
        // Record-only actions.
        break;
      default:
        applied = false;
    }
  } catch (err) {
    // A failed Discord call must not leave an orphan case record.
    if (err instanceof errors.AppError) throw err;
    log.warn(`Moderation action ${type} failed`, { code: err.code, message: err.message });
    throw err;
  }

  // ── Persist the case ──────────────────────────────────────────────────────
  const record = await Moderation.create({
    guildId: guild.id,
    caseId,
    type,
    userId: targetId,
    username: targetTag,
    moderatorId: moderator.id,
    moderatorName: moderator.tag ?? 'System',
    automated,
    source,
    reason: truncate(reason, 1000),
    evidence,
    context: {
      channelId: context.channelId ?? '',
      messageId: context.messageId ?? '',
      content: truncate(context.content ?? '', 1000),
    },
    duration: durationMs,
    expiresAt,
    active: !['unwarn', 'unban', 'untimeout', 'unmute', 'note'].includes(type),
  });

  // ── Statistics ────────────────────────────────────────────────────────────
  const keys = STAT_KEYS[type];
  await Promise.all([
    keys ? GuildStats.bump(guild.id, { [keys.guild]: 1 }) : null,
    keys && !automated ? StaffStats.bump(guild.id, moderator.id, { [keys.staff]: 1 }, moderator.tag) : null,
    keys ? User.bump(guild.id, targetId, { [keys.user]: 1 }) : null,
    User.updateOne({ guildId: guild.id, userId: targetId }, { $set: { 'moderation.lastActionAt': now } }, { upsert: true }),
    automated ? GuildStats.bump(guild.id, { 'moderation.automodHits': 1 }) : null,
  ].filter(Boolean));

  if (type === 'warn') await syncWarningCount(guild.id, targetId, cfg);

  // ── Log ───────────────────────────────────────────────────────────────────
  const meta = ACTION_LABELS[type] ?? ACTION_LABELS.warn;
  await logService.record(guild, {
    category: 'moderation',
    event: `moderation.${type}`,
    title: `${meta.emoji} ${meta.label}`,
    summary: `${targetTag} was ${meta.past}`,
    actorId: moderator.id,
    actorName: moderator.tag ?? 'System',
    targetId,
    targetName: targetTag,
    channelId: context.channelId ?? '',
    caseId,
    severity: ['ban', 'kick', 'softban'].includes(type) ? 'warn' : 'info',
    fields: {
      Reason: truncate(reason, 500),
      ...(durationMs ? { Duration: duration(durationMs) } : {}),
      ...(automated ? { Source: source || 'AutoMod' } : {}),
      ...(context.content ? { Content: truncate(context.content, 300) } : {}),
    },
  }, cfg);

  statisticsService.invalidate(guild.id);
  log.info(`Case #${caseId}: ${type} ${targetTag}`, { guildId: guild.id, automated, source });

  // ── Escalation ────────────────────────────────────────────────────────────
  if (type === 'warn') {
    await escalate({ guild, target, config: cfg, caseId }).catch((err) => {
      log.warn('Escalation failed', { message: err.message });
    });
  }

  return { case: record, applied, note };
}

/** Recompute the denormalised active-warning count for a member. */
async function syncWarningCount(guildId, userId, config) {
  const expiryDays = config?.moderation?.warningExpiryDays ?? 0;
  const active = await Moderation.activeWarnings(guildId, userId, expiryDays);
  await User.updateOne(
    { guildId, userId },
    { $set: { 'moderation.activeWarnings': active }, $setOnInsert: { guildId, userId } },
    { upsert: true },
  );
  return active;
}

/**
 * Apply the configured escalation ladder once a warning threshold is reached.
 * @param {object} params
 */
async function escalate({ guild, target, config, caseId }) {
  const ladder = config?.moderation?.escalation ?? [];
  if (!ladder.length) return null;

  const active = await syncWarningCount(guild.id, target.id, config);
  // Take the highest rung the member has reached, not merely the first match.
  const rung = [...ladder].filter((entry) => active >= entry.at).sort((a, b) => b.at - a.at)[0];
  if (!rung || active !== rung.at) return null; // fire exactly once per threshold

  const durationMs = rung.duration ? rung.duration * 60_000 : null;
  const result = await punish({
    guild,
    type: rung.action,
    target,
    moderator: { id: guild.client.user.id, tag: `${config?.brand?.name ?? 'System'} (auto)` },
    reason: `Automatic escalation: ${active} active warnings.`,
    duration: durationMs,
    config,
    automated: true,
    source: 'warning-escalation',
  }).catch((err) => {
    log.warn(`Escalation action ${rung.action} failed`, { message: err.message });
    return null;
  });

  if (result) {
    await Moderation.updateOne({ _id: result.case._id }, { $set: { escalatedFrom: caseId } });
  }
  return result;
}

/**
 * Remove a warning by case number.
 * @param {import('discord.js').Guild} guild
 * @param {number} caseId
 * @param {{ id: string, tag?: string }} moderator
 * @param {string} reason
 * @param {object} config
 */
async function revoke(guild, caseId, moderator, reason, config) {
  const record = await Moderation.findOne({ guildId: guild.id, caseId });
  if (!record) throw new errors.NotFoundError(`Case \`#${caseId}\` does not exist.`);
  if (record.revoked) throw new errors.ConflictError(`Case \`#${caseId}\` has already been revoked.`);

  record.revoked = true;
  record.active = false;
  record.revokedBy = moderator.id;
  record.revokedAt = new Date();
  record.revokeReason = truncate(reason, 500);
  await record.save();

  if (record.type === 'warn') await syncWarningCount(guild.id, record.userId, config);

  await logService.record(guild, {
    category: 'moderation',
    event: 'moderation.revoke',
    title: `${EMOJIS.success} Case Revoked`,
    summary: `Case #${caseId} (${record.type}) revoked`,
    actorId: moderator.id,
    targetId: record.userId,
    fields: { Reason: truncate(reason, 500) },
  }, config);

  return record;
}

/**
 * Lift punishments whose duration has elapsed.
 * Discord lifts timeouts itself; this exists so the database stops counting
 * them as active and bans with a duration are actually undone.
 *
 * @param {import('discord.js').Client} client
 */
async function processExpirations(client) {
  const due = await Moderation.dueForExpiry();
  let lifted = 0;

  for (const record of due) {
    const guild = client.guilds.cache.get(record.guildId);
    record.active = false;

    if (guild && record.type === 'ban') {
      // eslint-disable-next-line no-await-in-loop -- bounded batch
      await attempt(() => guild.members.unban(record.userId, `Temporary ban expired (case #${record.caseId})`), {
        label: 'lift temporary ban',
      });
      // eslint-disable-next-line no-await-in-loop
      await logService.record(guild, {
        category: 'moderation',
        event: 'moderation.expire',
        title: `${EMOJIS.success} Temporary Ban Expired`,
        summary: `Case #${record.caseId} — <@${record.userId}> unbanned automatically`,
        targetId: record.userId,
      });
    }

    // eslint-disable-next-line no-await-in-loop
    await record.save();
    if (guild && record.type === 'warn') {
      // eslint-disable-next-line no-await-in-loop
      const config = await configService.get(guild).catch(() => null);
      // eslint-disable-next-line no-await-in-loop
      if (config) await syncWarningCount(guild.id, record.userId, config);
    }
    lifted += 1;
  }

  return lifted;
}

/**
 * A member's moderation history, formatted for `/history`.
 * @param {string} guildId
 * @param {string} userId
 */
async function history(guildId, userId, limit = 20) {
  const [cases, activeWarnings] = await Promise.all([
    Moderation.historyFor(guildId, userId, limit),
    Moderation.activeWarnings(guildId, userId),
  ]);
  const counts = cases.reduce((acc, record) => {
    acc[record.type] = (acc[record.type] ?? 0) + 1;
    return acc;
  }, {});
  return { cases, activeWarnings, counts, total: cases.length };
}

// ── Channel controls ─────────────────────────────────────────────────────────

/**
 * Lock or unlock a channel for @everyone.
 * @param {import('discord.js').GuildChannel} channel
 * @param {boolean} locked
 * @param {string} reason
 */
async function setChannelLock(channel, locked, reason) {
  const everyone = channel.guild.roles.everyone;
  await channel.permissionOverwrites.edit(everyone, {
    SendMessages: locked ? false : null,
    AddReactions: locked ? false : null,
    CreatePublicThreads: locked ? false : null,
    CreatePrivateThreads: locked ? false : null,
    SendMessagesInThreads: locked ? false : null,
  }, { reason: truncate(reason, 400) });
  return channel;
}

/**
 * Server-wide lockdown.
 *
 * @param {import('discord.js').Guild} guild
 * @param {boolean} enable
 * @param {{ id: string, tag?: string }} actor
 * @param {object} config
 * @param {string} [reason]
 * @param {boolean} [announce]
 */
async function lockdown(guild, enable, actor, config, reason = '', announce = true) {
  const { ChannelType } = require('discord.js');
  const targets = [...guild.channels.cache.values()].filter(
    (channel) => channel.type === ChannelType.GuildText && channel.manageable,
  );

  const previouslyLocked = config.lockdown?.lockedChannels ?? [];
  const affected = [];

  for (const channel of targets) {
    // On unlock, only restore what the lockdown itself changed.
    if (!enable && previouslyLocked.length && !previouslyLocked.includes(channel.id)) continue;
    // Never lock staff channels — the team needs to coordinate the response.
    if (enable && !channel.permissionsFor(guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel)) continue;

    // eslint-disable-next-line no-await-in-loop -- sequential to respect rate limits
    const result = await attempt(() => setChannelLock(channel, enable, reason || 'Server lockdown'), { label: 'lockdown channel' });
    if (result) affected.push(channel.id);
  }

  await configService.update(guild, (cfg) => {
    cfg.setPath('lockdown', {
      active: enable,
      reason: truncate(reason, 500),
      startedAt: enable ? new Date() : null,
      startedBy: enable ? actor.id : null,
      lockedChannels: enable ? affected : [],
    });
  });

  if (announce) {
    const announcementChannel = configService.channel(guild, config, 'announcements')
      ?? configService.channel(guild, config, 'general');
    await safeSend(announcementChannel, {
      embeds: [enable
        ? embeds.warning({
          config,
          title: 'Server Temporarily Restricted',
          description:
            'Messaging has been paused across public channels while our team addresses a security concern.\n\n' +
            'Existing tickets are unaffected — your project channel still works normally.',
          fields: reason ? [{ name: 'Reason', value: safeField(reason, 1024) }] : [],
          footer: 'Thank you for your patience.',
        })
        : embeds.success({
          config,
          title: 'Server Restored',
          description: 'Normal messaging has resumed. Thank you for your patience.',
        })],
    });
  }

  await logService.security(guild, {
    event: enable ? 'lockdown.enable' : 'lockdown.disable',
    title: `${enable ? '🔒' : '🔓'} Server ${enable ? 'Locked Down' : 'Unlocked'}`,
    summary: `${affected.length} channels affected${reason ? ` — ${truncate(reason, 200)}` : ''}`,
    actorId: actor.id,
    severity: enable ? 'critical' : 'info',
  }, config);

  return affected.length;
}

module.exports = {
  ACTION_LABELS,
  MAX_TIMEOUT_MS,
  isExempt,
  isChannelExempt,
  punish,
  escalate,
  revoke,
  syncWarningCount,
  processExpirations,
  history,
  setChannelLock,
  lockdown,
};
