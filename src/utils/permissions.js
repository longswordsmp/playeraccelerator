'use strict';

/**
 * Authorisation.
 *
 * The single gate every command, button, select menu and modal passes through.
 * Nothing anywhere else is allowed to decide "can this person do this" — button
 * presses are authorised exactly as strictly as slash commands, because a
 * custom ID is trivially forgeable by anyone who can read the client payload.
 */

const { PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const { env } = require('../config/env');
const { ACCESS_LEVELS, LEVEL_ROLE_KEYS, LEVEL_DISCORD_PERMISSIONS } = require('../config/permissions');
const { STAFF_ROLE_KEYS } = require('../config/server');
const { PermissionError } = require('./errors');

/** Configured bot owners from the environment. */
const isBotOwner = (userId) => env.owners.includes(String(userId));

/**
 * Resolve every role id that satisfies a named access level for a guild.
 * @param {object} config guild configuration document
 * @param {keyof ACCESS_LEVELS} level
 * @returns {string[]} role ids
 */
function roleIdsForLevel(config, level) {
  const keys = LEVEL_ROLE_KEYS[level] ?? [];
  const roles = config?.roles ?? {};
  return keys.map((key) => roles[key]).filter(Boolean);
}

/** Every configured staff role id. */
function staffRoleIds(config) {
  const roles = config?.roles ?? {};
  return STAFF_ROLE_KEYS.map((key) => roles[key]).filter(Boolean);
}

/**
 * Does this member hold at least the requested access level?
 * @param {import('discord.js').GuildMember|null} member
 * @param {keyof ACCESS_LEVELS} level
 * @param {object} config
 * @returns {boolean}
 */
function hasLevel(member, level, config) {
  if (!member) return false;
  if (isBotOwner(member.id)) return true;
  if (member.guild?.ownerId === member.id) return true;
  if (level === 'everyone') return true;

  // Configured role grant.
  const allowed = roleIdsForLevel(config, level);
  if (allowed.some((roleId) => member.roles.cache.has(roleId))) return true;

  // Native Discord permission fallback — keeps the bot usable before /setup and
  // in servers that manage staff through their own role structure.
  const fallback = LEVEL_DISCORD_PERMISSIONS[level] ?? [];
  if (fallback.length && fallback.some((permission) => member.permissions.has(PermissionFlagsBits[permission]))) return true;

  // Administrators satisfy every level below owner.
  if (level !== 'owner' && member.permissions.has(PermissionFlagsBits.Administrator)) return true;

  return false;
}

/** Convenience predicates used across services. */
const isStaff = (member, config) => hasLevel(member, 'support', config);
const isAdmin = (member, config) => hasLevel(member, 'admin', config);
const isManager = (member, config) => hasLevel(member, 'manager', config);

/**
 * Throw a user-facing PermissionError unless the member holds the level.
 * @param {import('discord.js').GuildMember|null} member
 * @param {keyof ACCESS_LEVELS} level
 * @param {object} config
 * @param {string} [action] used to phrase the error
 */
function assertLevel(member, level, config, action = 'use this') {
  if (hasLevel(member, level, config)) return true;
  const labels = {
    customer: 'customers',
    support: 'the support team',
    developer: 'developers',
    manager: 'managers',
    admin: 'administrators',
    owner: 'the server owner',
  };
  throw new PermissionError(`Only ${labels[level] ?? 'authorised staff'} can ${action}.`);
}

/**
 * Compare role positions so the bot never attempts a hierarchy-violating action
 * (which Discord rejects with a 50013 and which would otherwise look like a bug).
 *
 * @param {import('discord.js').GuildMember} actor
 * @param {import('discord.js').GuildMember} target
 * @returns {{ ok: boolean, reason?: string }}
 */
function canActOn(actor, target) {
  if (!actor || !target) return { ok: false, reason: 'Target could not be resolved.' };
  if (actor.id === target.id) return { ok: false, reason: 'You cannot perform this action on yourself.' };
  if (target.id === target.guild.ownerId) return { ok: false, reason: 'The server owner cannot be moderated.' };
  if (isBotOwner(target.id)) return { ok: false, reason: 'That user is protected as a bot owner.' };

  if (actor.id !== actor.guild.ownerId && actor.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    return { ok: false, reason: 'That member has a role equal to or higher than yours.' };
  }
  return { ok: true };
}

/**
 * Can the bot itself act on this member?
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').GuildMember} target
 * @returns {{ ok: boolean, reason?: string }}
 */
function botCanActOn(guild, target) {
  const me = guild.members.me;
  if (!me) return { ok: false, reason: 'I could not resolve my own membership in this server.' };
  if (target.id === guild.ownerId) return { ok: false, reason: 'Discord does not allow moderating the server owner.' };
  if (me.roles.highest.comparePositionTo(target.roles.highest) <= 0) {
    return { ok: false, reason: 'That member\'s highest role is above mine. Move my role higher in Server Settings → Roles.' };
  }
  return { ok: true };
}

/**
 * Verify the bot holds the Discord permissions a feature needs.
 * @param {import('discord.js').Guild} guild
 * @param {Array<keyof typeof PermissionFlagsBits>} required
 * @returns {{ ok: boolean, missing: string[] }}
 */
function botHasPermissions(guild, required) {
  const me = guild.members.me;
  if (!me) return { ok: false, missing: required };
  const missing = required.filter((permission) => !me.permissions.has(PermissionFlagsBits[permission]));
  return { ok: missing.length === 0, missing };
}

/**
 * Verify the bot's permissions inside a specific channel (overwrites included).
 * @param {import('discord.js').GuildChannel} channel
 * @param {Array<keyof typeof PermissionFlagsBits>} required
 */
function botHasChannelPermissions(channel, required) {
  const me = channel.guild?.members?.me;
  if (!me) return { ok: false, missing: required };
  const permissions = channel.permissionsFor(me);
  if (!permissions) return { ok: false, missing: required };
  const missing = required.filter((permission) => !permissions.has(PermissionFlagsBits[permission]));
  return { ok: missing.length === 0, missing };
}

/** Turn permission keys into readable names for error messages. */
function humanizePermissions(permissions) {
  return permissions
    .map((permission) => String(permission).replace(/([a-z])([A-Z])/g, '$1 $2'))
    .map((permission) => `\`${permission}\``)
    .join(', ');
}

/** Convert a list of permission names into a bitfield for invite links. */
function permissionBits(names) {
  return new PermissionsBitField(names.map((name) => PermissionFlagsBits[name]).filter(Boolean)).bitfield.toString();
}

module.exports = {
  ACCESS_LEVELS,
  isBotOwner,
  hasLevel,
  isStaff,
  isAdmin,
  isManager,
  assertLevel,
  canActOn,
  botCanActOn,
  botHasPermissions,
  botHasChannelPermissions,
  humanizePermissions,
  permissionBits,
  roleIdsForLevel,
  staffRoleIds,
};
