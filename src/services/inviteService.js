'use strict';

/**
 * Invite attribution and referral credit.
 *
 * Discord does not tell a bot which invite a member used. The only reliable
 * technique is to keep a snapshot of every invite's use count and, on each
 * join, find the one that went up by one. That is what this service does.
 *
 * ── Where this is genuinely uncertain, and how it is handled ────────────────
 *   • Two people joining in the same instant can make two counters move before
 *     the first join is processed. When exactly one invite moved, attribution
 *     is certain; when several did, the join is left unattributed rather than
 *     credited to a guess.
 *   • The vanity URL and Discord's "server discovery" produce joins with no
 *     invite at all. Those are unattributed by design.
 *   • A member who leaves and rejoins through the same link would otherwise
 *     farm credit, so a given invitee can only ever be credited once, and
 *     leaving inside the grace window revokes the credit.
 */

const { PermissionFlagsBits } = require('discord.js');

const { User } = require('../database/models');
const logService = require('./logService');
const embeds = require('../utils/embeds');
const { attempt, safeSend, safeDm } = require('../utils/discord');
const { EMOJIS } = require('../config/branding');
const { duration } = require('../utils/formatters');
const { logger } = require('../utils/logger');

const log = logger.child('invites');

/**
 * Cached invite use counts, per guild.
 * @type {Map<string, Map<string, number>>} guildId -> (code -> uses)
 */
const cache = new Map();

/**
 * Snapshot every invite in a guild.
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<Map<string, number>|null>}
 */
async function snapshot(guild) {
  if (!guild.members.me?.permissions?.has(PermissionFlagsBits.ManageGuild)) {
    log.debug('Cannot read invites without Manage Guild', { guildId: guild.id });
    return null;
  }

  const invites = await attempt(() => guild.invites.fetch(), { label: 'fetch invites' });
  if (!invites) return null;

  const counts = new Map();
  for (const invite of invites.values()) counts.set(invite.code, invite.uses ?? 0);

  // The vanity URL has its own counter and is fetched separately.
  if (guild.vanityURLCode) {
    const vanity = await attempt(() => guild.fetchVanityData(), { label: 'fetch vanity' });
    if (vanity) counts.set(`vanity:${guild.vanityURLCode}`, vanity.uses ?? 0);
  }

  cache.set(guild.id, counts);
  return counts;
}

/** Prime the cache for every guild at startup. */
async function primeAll(client) {
  let primed = 0;
  for (const guild of client.guilds.cache.values()) {
    // eslint-disable-next-line no-await-in-loop -- once, at boot
    const counts = await snapshot(guild);
    if (counts) primed += 1;
  }
  log.info(`Invite cache primed for ${primed} guild(s)`);
  return primed;
}

/** Refresh the cache after an invite is created or deleted. */
const refresh = (guild) => snapshot(guild);

/**
 * Work out which invite a joining member used.
 *
 * @param {import('discord.js').Guild} guild
 * @returns {Promise<{ code: string, inviterId: string|null, certain: boolean }|null>}
 */
async function attribute(guild) {
  const before = cache.get(guild.id);
  const invites = await attempt(() => guild.invites.fetch(), { label: 'fetch invites' });
  if (!invites) return null;

  const after = new Map();
  for (const invite of invites.values()) after.set(invite.code, invite.uses ?? 0);

  // Find every invite whose use count increased.
  const moved = [];
  for (const [code, uses] of after) {
    const previous = before?.get(code) ?? 0;
    if (uses > previous) moved.push({ code, delta: uses - previous, invite: invites.get(code) });
  }

  // An invite that hit its use limit is deleted rather than incremented, so a
  // code that vanished entirely is also a candidate.
  if (before) {
    for (const [code, previous] of before) {
      if (code.startsWith('vanity:')) continue;
      if (!after.has(code)) moved.push({ code, delta: previous > 0 ? 1 : 0, invite: null, consumed: true });
    }
  }

  cache.set(guild.id, after);

  if (moved.length === 0) return null;
  if (moved.length > 1) {
    // Simultaneous joins — refuse to guess.
    log.debug('Ambiguous invite attribution', { guildId: guild.id, candidates: moved.length });
    return { code: moved[0].code, inviterId: null, certain: false };
  }

  const [hit] = moved;
  return {
    code: hit.code,
    inviterId: hit.invite?.inviter?.id ?? null,
    certain: Boolean(hit.invite?.inviter?.id),
  };
}

/**
 * Credit a referral when a member joins.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {object} config
 * @returns {Promise<{ inviterId: string|null, credited: boolean, reason?: string }>}
 */
async function creditJoin(member, config) {
  if (!config.referrals?.enabled) return { inviterId: null, credited: false, reason: 'disabled' };

  const result = await attribute(member.guild);
  if (!result?.inviterId) {
    return { inviterId: null, credited: false, reason: result ? 'ambiguous' : 'no-invite' };
  }

  const inviterId = result.inviterId;

  // Record how this member arrived, whether or not it earns credit.
  await User.updateOne(
    { guildId: member.guild.id, userId: member.id },
    {
      $set: { 'referrals.invitedBy': inviterId, 'referrals.inviteCode': result.code },
      $setOnInsert: { guildId: member.guild.id, userId: member.id },
    },
    { upsert: true },
  ).catch(() => null);

  // ── Anti-abuse ────────────────────────────────────────────────────────────
  if (inviterId === member.id) return { inviterId, credited: false, reason: 'self-invite' };
  if (member.user.bot) return { inviterId, credited: false, reason: 'bot' };

  const minAge = config.referrals?.minInviteeAccountAgeDays ?? 0;
  const accountAge = Date.now() - member.user.createdTimestamp;
  if (minAge > 0 && accountAge < minAge * 86_400_000) {
    log.debug('Referral rejected: invitee account too new', { inviterId, age: accountAge });
    return { inviterId, credited: false, reason: 'account-too-new' };
  }

  const inviter = await User.findOne({ guildId: member.guild.id, userId: inviterId });
  if (!inviter) return { inviterId, credited: false, reason: 'inviter-unknown' };

  // Never credit the same person twice, even across leave/rejoin cycles.
  if (inviter.referrals.credited.some((entry) => entry.userId === member.id)) {
    return { inviterId, credited: false, reason: 'already-credited' };
  }

  inviter.referrals.credited.push({
    userId: member.id,
    username: member.user.tag ?? member.user.username,
    joinedAt: new Date(),
  });
  inviter.referrals.count = inviter.referrals.credited.filter((entry) => !entry.revoked).length;

  const required = config.referrals?.requiredForFreeCommission ?? 3;
  const justUnlocked = !inviter.referrals.unlockedFreeCommission && inviter.referrals.count >= required;
  if (justUnlocked) {
    inviter.referrals.unlockedFreeCommission = true;
    inviter.referrals.unlockedAt = new Date();
  }
  await inviter.save();

  await logService.record(member.guild, {
    category: 'member',
    event: 'referral.credit',
    title: `${EMOJIS.users} Referral Credited`,
    summary: `${member.user.tag} joined through <@${inviterId}> (${inviter.referrals.count}/${required})`,
    actorId: inviterId,
    targetId: member.id,
    targetName: member.user.tag,
    severity: 'debug',
    fields: { Invite: `\`${result.code}\``, Progress: `${inviter.referrals.count}/${required}` },
  }, config);

  if (justUnlocked) await announceUnlock(member.guild, inviterId, config);

  return { inviterId, credited: true, count: inviter.referrals.count, unlocked: justUnlocked };
}

/**
 * Revoke credit when an invitee leaves inside the grace window.
 * Stops the obvious farm: invite three alts, apply, have them leave.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {object} config
 */
async function revokeOnLeave(member, config) {
  const graceHours = config.referrals?.revokeIfLeaveWithinHours ?? 0;
  if (!config.referrals?.enabled || graceHours <= 0) return false;

  const record = await User.findOne({ guildId: member.guild.id, userId: member.id }).lean();
  const inviterId = record?.referrals?.invitedBy;
  if (!inviterId) return false;

  const inviter = await User.findOne({ guildId: member.guild.id, userId: inviterId });
  if (!inviter) return false;

  const entry = inviter.referrals.credited.find((item) => item.userId === member.id && !item.revoked);
  if (!entry) return false;

  const heldFor = Date.now() - new Date(entry.joinedAt).getTime();
  if (heldFor >= graceHours * 3_600_000) return false;

  entry.revoked = true;
  entry.revokedReason = `Left after ${duration(heldFor)}`;
  inviter.referrals.count = inviter.referrals.credited.filter((item) => !item.revoked).length;

  const required = config.referrals?.requiredForFreeCommission ?? 3;
  if (inviter.referrals.count < required && inviter.referrals.unlockedFreeCommission) {
    // Only re-lock if they have not already spent the unlock.
    if ((inviter.referrals.freeCommissionsUsed ?? 0) === 0) {
      inviter.referrals.unlockedFreeCommission = false;
      inviter.referrals.unlockedAt = null;
    }
  }
  await inviter.save();

  await logService.record(member.guild, {
    category: 'member',
    event: 'referral.revoke',
    title: `${EMOJIS.warning} Referral Revoked`,
    summary: `${member.user?.tag ?? member.id} left ${duration(heldFor)} after joining — credit removed from <@${inviterId}>`,
    actorId: inviterId,
    targetId: member.id,
    severity: 'debug',
  }, config);

  return true;
}

/** Tell a member they have unlocked the free commission programme. */
async function announceUnlock(guild, userId, config) {
  if (config.referrals?.announceUnlock === false) return;

  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) return;

  const channelId = config.channels?.freeCommissions ?? config.channels?.createTicket;
  const embed = embeds.success({
    config,
    title: `${EMOJIS.star} Free Commission Unlocked`,
    description:
      `You have invited **${config.referrals?.requiredForFreeCommission ?? 3}** people who joined and stayed. ` +
      'That unlocks an application to the free portfolio commission programme.',
    fields: [
      { name: 'What you get', value: 'A complete, working build with source code and documentation, at the same standard as paid work.' },
      { name: 'What it is not', value: 'A guarantee. Applications are still reviewed individually — unlocking means you can apply, not that you are accepted.' },
      { name: 'Next step', value: channelId ? `Open a **Free Portfolio Commission** ticket in <#${channelId}>.` : 'Open a **Free Portfolio Commission** ticket.' },
    ],
  });

  await safeDm(member.user, { embeds: [embed] });
  const channel = channelId ? guild.channels.cache.get(channelId) : null;
  await safeSend(channel, { content: `<@${userId}>`, embeds: [embed] });
}

/**
 * A member's referral progress.
 * @param {string} guildId
 * @param {string} userId
 * @param {object} config
 */
async function progress(guildId, userId, config) {
  const record = await User.findOne({ guildId, userId }).lean();
  const required = config.referrals?.requiredForFreeCommission ?? 3;
  const credited = (record?.referrals?.credited ?? []).filter((entry) => !entry.revoked);

  return {
    count: credited.length,
    required,
    remaining: Math.max(0, required - credited.length),
    unlocked: Boolean(record?.referrals?.unlockedFreeCommission),
    used: record?.referrals?.freeCommissionsUsed ?? 0,
    credited,
    revoked: (record?.referrals?.credited ?? []).filter((entry) => entry.revoked),
    invitedBy: record?.referrals?.invitedBy ?? null,
  };
}

/**
 * Whether a member may open a free commission ticket.
 * @returns {Promise<{ allowed: boolean, reason?: string, progress: object }>}
 */
async function canClaimFreeCommission(guildId, userId, config) {
  const state = await progress(guildId, userId, config);
  if (!config.referrals?.enabled) return { allowed: true, progress: state };

  if (!state.unlocked) {
    return {
      allowed: false,
      reason:
        `Free commissions are unlocked by referrals. You need **${state.required}** people to join through your invite ` +
        `and stay — you have **${state.count}**.\n\nUse \`/invites\` to get your link and track progress.`,
      progress: state,
    };
  }
  return { allowed: true, progress: state };
}

/** Record that an unlock has been spent on an application. */
async function consumeUnlock(guildId, userId) {
  await User.updateOne(
    { guildId, userId },
    { $inc: { 'referrals.freeCommissionsUsed': 1 } },
  ).catch(() => null);
}

/** Referral leaderboard. */
function leaderboard(guildId, limit = 10) {
  return User.find({ guildId, 'referrals.count': { $gt: 0 } })
    .sort({ 'referrals.count': -1 })
    .limit(Math.min(25, limit))
    .select('userId username referrals.count referrals.unlockedFreeCommission')
    .lean();
}

module.exports = {
  snapshot,
  primeAll,
  refresh,
  attribute,
  creditJoin,
  revokeOnLeave,
  progress,
  canClaimFreeCommission,
  consumeUnlock,
  leaderboard,
  announceUnlock,
};
