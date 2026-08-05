'use strict';

/**
 * Access-control vocabulary.
 *
 * Commands and component handlers declare an `access` level; the permission
 * utility resolves it against the guild configuration and the member's roles.
 * Levels are hierarchical — a higher level satisfies every lower requirement.
 */

const ACCESS_LEVELS = Object.freeze({
  /** Anyone in the guild. */
  everyone: 0,
  /** Members with the customer or VIP role. */
  customer: 10,
  /** Support team and above. */
  support: 20,
  /** Developers and above. */
  developer: 30,
  /** Managers and above. */
  manager: 40,
  /** Lead developers and above (server administrators). */
  admin: 50,
  /** Guild owner and configured bot owners only. */
  owner: 60,
});

/** Which configured role keys satisfy which access level. */
const LEVEL_ROLE_KEYS = Object.freeze({
  customer: ['customer', 'vip', 'support', 'developer', 'manager', 'leadDeveloper', 'owner'],
  support: ['support', 'developer', 'manager', 'leadDeveloper', 'owner'],
  developer: ['developer', 'manager', 'leadDeveloper', 'owner'],
  manager: ['manager', 'leadDeveloper', 'owner'],
  admin: ['leadDeveloper', 'owner'],
  owner: ['owner'],
});

/** Discord permissions that always satisfy a given level as a fallback. */
const LEVEL_DISCORD_PERMISSIONS = Object.freeze({
  support: ['ManageMessages'],
  developer: ['ManageMessages'],
  manager: ['ManageGuild', 'KickMembers'],
  admin: ['Administrator'],
  owner: [],
});

/**
 * Permissions the bot needs for the full feature set. Surfaced by `/setup` and
 * the README so an operator can verify the invite before running anything.
 */
const REQUIRED_BOT_PERMISSIONS = Object.freeze([
  'ViewChannel',
  'ManageChannels',
  'ManageRoles',
  'ManageGuild',
  'ManageMessages',
  'ManageNicknames',
  'ManageWebhooks',
  'ReadMessageHistory',
  'SendMessages',
  'SendMessagesInThreads',
  'EmbedLinks',
  'AttachFiles',
  'AddReactions',
  'UseExternalEmojis',
  'MentionEveryone',
  'ModerateMembers',
  'KickMembers',
  'BanMembers',
  'ViewAuditLog',
  'Connect',
  'MoveMembers',
]);

module.exports = { ACCESS_LEVELS, LEVEL_ROLE_KEYS, LEVEL_DISCORD_PERMISSIONS, REQUIRED_BOT_PERMISSIONS };
