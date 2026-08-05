'use strict';

/**
 * Role lifecycle logging + anti-nuke hooks.
 * Permission escalation is called out explicitly because it is the change that
 * actually matters in an incident.
 */

const { Events, AuditLogEvent, PermissionsBitField } = require('discord.js');

const configService = require('../../services/configService');
const logService = require('../../services/logService');
const antiNuke = require('../../security/antiNuke');
const { fetchAuditEntry } = require('../../utils/discord');
const { EMOJIS } = require('../../config/branding');
const { truncate } = require('../../utils/formatters');

/** Render a permission bitfield difference as readable names. */
function permissionDiff(oldPermissions, newPermissions) {
  const before = new PermissionsBitField(oldPermissions).toArray();
  const after = new PermissionsBitField(newPermissions).toArray();
  const added = after.filter((permission) => !before.includes(permission));
  const removed = before.filter((permission) => !after.includes(permission));
  return { added, removed };
}

module.exports = [
  {
    name: Events.GuildRoleCreate,
    async execute(client, role) {
      await antiNuke.onRoleCreate(role).catch(() => null);

      const config = await configService.get(role.guild);
      if (!config.logging?.events?.roleCreate) return;

      const entry = await fetchAuditEntry(role.guild, AuditLogEvent.RoleCreate, role.id);
      await logService.record(role.guild, {
        category: 'role',
        event: 'roleCreate',
        title: `${EMOJIS.add} Role Created`,
        summary: `**${role.name}** was created`,
        actorId: entry?.executor?.id ?? '',
        actorName: entry?.executor?.tag ?? '',
        targetId: role.id,
        targetName: role.name,
        fields: {
          Colour: role.hexColor,
          Hoisted: role.hoist ? 'Yes' : 'No',
          Permissions: truncate(role.permissions.toArray().join(', ') || 'None', 1000),
        },
      }, config);
    },
  },

  {
    name: Events.GuildRoleDelete,
    async execute(client, role) {
      await antiNuke.onRoleDelete(role).catch(() => null);

      const config = await configService.get(role.guild);
      if (!config.logging?.events?.roleDelete) return;

      const entry = await fetchAuditEntry(role.guild, AuditLogEvent.RoleDelete, role.id);
      await logService.record(role.guild, {
        category: 'role',
        event: 'roleDelete',
        title: `${EMOJIS.trash} Role Deleted`,
        summary: `**${role.name}** was deleted`,
        actorId: entry?.executor?.id ?? '',
        actorName: entry?.executor?.tag ?? '',
        targetId: role.id,
        targetName: role.name,
        severity: 'warn',
        fields: {
          'Members affected': String(role.members.size),
          Note: role.members.size ? 'Role membership cannot be restored by any bot — Discord does not record it.' : '—',
        },
      }, config);
    },
  },

  {
    name: Events.GuildRoleUpdate,
    async execute(client, oldRole, newRole) {
      await antiNuke.onRoleUpdate(oldRole, newRole).catch(() => null);

      const config = await configService.get(newRole.guild);
      if (!config.logging?.events?.roleUpdate) return;

      const changes = {};
      if (oldRole.name !== newRole.name) changes.Name = `\`${oldRole.name}\` → \`${newRole.name}\``;
      if (oldRole.hexColor !== newRole.hexColor) changes.Colour = `${oldRole.hexColor} → ${newRole.hexColor}`;
      if (oldRole.hoist !== newRole.hoist) changes.Hoisted = `${oldRole.hoist} → ${newRole.hoist}`;
      if (oldRole.mentionable !== newRole.mentionable) changes.Mentionable = `${oldRole.mentionable} → ${newRole.mentionable}`;

      if (oldRole.permissions.bitfield !== newRole.permissions.bitfield) {
        const { added, removed } = permissionDiff(oldRole.permissions.bitfield, newRole.permissions.bitfield);
        if (added.length) changes['Permissions granted'] = truncate(added.join(', '), 1000);
        if (removed.length) changes['Permissions revoked'] = truncate(removed.join(', '), 1000);
      }

      if (!Object.keys(changes).length) return;

      const entry = await fetchAuditEntry(newRole.guild, AuditLogEvent.RoleUpdate, newRole.id);
      await logService.record(newRole.guild, {
        category: 'role',
        event: 'roleUpdate',
        title: `${EMOJIS.pencil} Role Updated`,
        summary: `**${newRole.name}** was modified`,
        actorId: entry?.executor?.id ?? '',
        actorName: entry?.executor?.tag ?? '',
        targetId: newRole.id,
        targetName: newRole.name,
        severity: changes['Permissions granted'] ? 'warn' : 'debug',
        fields: changes,
      }, config);
    },
  },
];
