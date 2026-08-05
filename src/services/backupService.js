'use strict';

/**
 * Server structure snapshots.
 *
 * ── Discord API limitations, stated plainly ─────────────────────────────────
 * A bot can snapshot and rebuild *structure*: roles, categories, channels,
 * topics, slowmode, NSFW flags, and permission overwrites. It CANNOT restore:
 *   • message history or attachments (no API exists to write history),
 *   • which members held which roles at snapshot time (only current state),
 *   • audit log history,
 *   • emoji, sticker or soundboard binaries (these must be re-uploaded),
 *   • server boosts, vanity URLs, or Community/onboarding configuration,
 *   • webhook tokens (webhooks are recreated with new URLs).
 * Restoring recreates channels and roles as *new objects* with new IDs, so any
 * stored ID references are re-wired afterwards.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { ChannelType, PermissionsBitField } = require('discord.js');

const { Backup } = require('../database/models');
const { env } = require('../config/env');
const logService = require('./logService');
const configService = require('./configService');
const { attempt, sleep } = require('../utils/discord');
const errors = require('../utils/errors');
const { EMOJIS } = require('../config/branding');
const { logger } = require('../utils/logger');

const log = logger.child('backups');

const API_DELAY_MS = 400;

/** Serialise a channel's permission overwrites into a portable shape. */
function serialiseOverwrites(channel) {
  return [...channel.permissionOverwrites.cache.values()].map((overwrite) => ({
    id: overwrite.id,
    type: overwrite.type,
    allow: overwrite.allow.bitfield.toString(),
    deny: overwrite.deny.bitfield.toString(),
  }));
}

/**
 * Capture the guild's structure.
 *
 * @param {import('discord.js').Guild} guild
 * @param {{ trigger?: string, createdBy?: string, createdByName?: string, label?: string }} [meta]
 * @returns {Promise<object>} the backup document (without the payload)
 */
async function create(guild, meta = {}) {
  const code = crypto.randomBytes(3).toString('hex').toUpperCase();

  const roles = [...guild.roles.cache.values()]
    .filter((role) => !role.managed && role.id !== guild.roles.everyone.id)
    .sort((a, b) => b.position - a.position)
    .map((role) => ({
      id: role.id,
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      position: role.position,
      permissions: role.permissions.bitfield.toString(),
    }));

  const categories = [...guild.channels.cache.values()]
    .filter((channel) => channel.type === ChannelType.GuildCategory)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((category) => ({
      id: category.id,
      name: category.name,
      position: category.rawPosition,
      overwrites: serialiseOverwrites(category),
    }));

  const channels = [...guild.channels.cache.values()]
    .filter((channel) => channel.type !== ChannelType.GuildCategory)
    .sort((a, b) => a.rawPosition - b.rawPosition)
    .map((channel) => ({
      id: channel.id,
      name: channel.name,
      type: channel.type,
      parentId: channel.parentId,
      position: channel.rawPosition,
      topic: channel.topic ?? '',
      nsfw: channel.nsfw ?? false,
      rateLimitPerUser: channel.rateLimitPerUser ?? 0,
      bitrate: channel.bitrate ?? null,
      userLimit: channel.userLimit ?? null,
      overwrites: serialiseOverwrites(channel),
    }));

  const config = await configService.get(guild);

  const payload = {
    version: 1,
    capturedAt: new Date().toISOString(),
    guild: {
      id: guild.id,
      name: guild.name,
      icon: guild.iconURL({ size: 256 }) ?? '',
      verificationLevel: guild.verificationLevel,
      afkTimeout: guild.afkTimeout,
      systemChannelId: guild.systemChannelId,
    },
    roles,
    categories,
    channels,
    /** The bot's own wiring, so a restore can rebuild the mapping. */
    configuration: {
      roles: config.roles,
      channels: config.channels,
      categories: config.categories,
      logChannels: config.logChannels,
      tickets: config.tickets,
      business: config.business,
      moderation: config.moderation,
      automod: config.automod,
      brand: config.brand,
      theme: config.theme,
    },
  };

  const serialised = JSON.stringify(payload, null, 2);
  const dir = path.join(env.backupDir, guild.id);
  await fs.mkdir(dir, { recursive: true });
  const filePath = path.join(dir, `${code}-${new Date().toISOString().slice(0, 10)}.json`);
  await fs.writeFile(filePath, serialised, 'utf8');

  const document = await Backup.create({
    guildId: guild.id,
    guildName: guild.name,
    code,
    label: meta.label ?? '',
    trigger: meta.trigger ?? 'manual',
    createdBy: meta.createdBy ?? '',
    createdByName: meta.createdByName ?? '',
    summary: {
      roles: roles.length,
      categories: categories.length,
      textChannels: channels.filter((channel) => channel.type === ChannelType.GuildText).length,
      voiceChannels: channels.filter((channel) => channel.type === ChannelType.GuildVoice).length,
      overwrites: [...categories, ...channels].reduce((sum, item) => sum + item.overwrites.length, 0),
    },
    payload,
    filePath,
    sizeBytes: Buffer.byteLength(serialised, 'utf8'),
  });

  await prune(guild.id);
  log.info(`Backup ${code} created for ${guild.name}`, { roles: roles.length, channels: channels.length });

  await logService.record(guild, {
    category: 'system',
    event: 'backup.create',
    title: `${EMOJIS.success} Backup Created`,
    summary: `Snapshot \`${code}\` — ${roles.length} roles, ${channels.length} channels`,
    actorId: meta.createdBy ?? '',
    severity: 'info',
  });

  return document;
}

/** Enforce the retention policy on disk and in the database. */
async function prune(guildId) {
  const config = await configService.get(guildId).catch(() => null);
  const retain = config?.backups?.retain ?? 14;

  const stale = await Backup.find({ guildId }).sort({ createdAt: -1 }).skip(retain).select('_id filePath code');
  for (const backup of stale) {
    if (backup.filePath) await fs.unlink(backup.filePath).catch(() => null);
    // eslint-disable-next-line no-await-in-loop -- small bounded batch
    await Backup.deleteOne({ _id: backup._id });
  }
  return stale.length;
}

/**
 * Restore a snapshot.
 *
 * Structure only — see the module header for what Discord does not allow.
 * Existing channels/roles are left in place; the snapshot is applied additively
 * unless `wipe` is set, which is the caller's explicit decision.
 *
 * @param {import('discord.js').Guild} guild
 * @param {string} code
 * @param {{ actor?: import('discord.js').GuildMember, wipe?: boolean, onProgress?: (message: string) => void }} [options]
 */
async function restore(guild, code, { actor, wipe = false, onProgress = () => {} } = {}) {
  const backup = await Backup.findOne({ guildId: guild.id, code: code.toUpperCase() });
  if (!backup) throw new errors.NotFoundError(`No backup exists with the code \`${code}\`.`);

  const payload = backup.payload;
  if (!payload?.roles) throw new errors.ConflictError('That backup is missing its payload and cannot be restored.');

  // Always snapshot the current state before overwriting it.
  await create(guild, { trigger: 'pre-restore', createdBy: actor?.id, createdByName: actor?.user?.tag, label: `Pre-restore of ${code}` });

  const me = guild.members.me;
  /** Old id -> new id, so overwrites can be re-pointed. */
  const roleMap = new Map([[payload.guild.id, guild.roles.everyone.id]]);
  const created = { roles: 0, categories: 0, channels: 0, skipped: 0 };

  if (wipe) {
    onProgress('Removing current channels…');
    for (const channel of [...guild.channels.cache.values()].sort((a, b) => (a.type === ChannelType.GuildCategory ? 1 : 0) - (b.type === ChannelType.GuildCategory ? 1 : 0))) {
      if (!channel.manageable) continue;
      // eslint-disable-next-line no-await-in-loop
      await attempt(() => channel.delete('Backup restore'), { label: 'delete channel' });
      // eslint-disable-next-line no-await-in-loop
      await sleep(API_DELAY_MS);
    }
  }

  // ── Roles ─────────────────────────────────────────────────────────────────
  onProgress('Restoring roles…');
  for (const role of [...payload.roles].sort((a, b) => b.position - a.position)) {
    const existing = guild.roles.cache.find((candidate) => candidate.name === role.name && !candidate.managed);
    if (existing) {
      roleMap.set(role.id, existing.id);
      created.skipped += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const fresh = await attempt(() => guild.roles.create({
      name: role.name,
      color: role.color,
      hoist: role.hoist,
      mentionable: role.mentionable,
      permissions: new PermissionsBitField(BigInt(role.permissions)),
      reason: `Backup restore ${code}`,
    }), { label: 'restore role' });
    if (fresh) {
      roleMap.set(role.id, fresh.id);
      created.roles += 1;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(API_DELAY_MS);
  }

  /** Translate serialised overwrites onto the new role ids. */
  const mapOverwrites = (overwrites) => overwrites
    .map((overwrite) => {
      const id = roleMap.get(overwrite.id) ?? (overwrite.type === 1 ? overwrite.id : null);
      if (!id) return null;
      return {
        id,
        type: overwrite.type,
        allow: new PermissionsBitField(BigInt(overwrite.allow)),
        deny: new PermissionsBitField(BigInt(overwrite.deny)),
      };
    })
    .filter(Boolean);

  // ── Categories ────────────────────────────────────────────────────────────
  onProgress('Restoring categories…');
  const categoryMap = new Map();
  for (const category of payload.categories) {
    // eslint-disable-next-line no-await-in-loop
    const fresh = await attempt(() => guild.channels.create({
      name: category.name,
      type: ChannelType.GuildCategory,
      permissionOverwrites: mapOverwrites(category.overwrites),
      reason: `Backup restore ${code}`,
    }), { label: 'restore category' });
    if (fresh) {
      categoryMap.set(category.id, fresh.id);
      created.categories += 1;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(API_DELAY_MS);
  }

  // ── Channels ──────────────────────────────────────────────────────────────
  onProgress('Restoring channels…');
  const channelMap = new Map();
  const supported = [ChannelType.GuildText, ChannelType.GuildVoice, ChannelType.GuildAnnouncement, ChannelType.GuildStageVoice, ChannelType.GuildForum];
  for (const channel of payload.channels) {
    if (!supported.includes(channel.type)) {
      created.skipped += 1;
      continue;
    }
    // eslint-disable-next-line no-await-in-loop
    const fresh = await attempt(() => guild.channels.create({
      name: channel.name,
      type: channel.type,
      parent: channel.parentId ? categoryMap.get(channel.parentId) : undefined,
      topic: channel.topic || undefined,
      nsfw: channel.nsfw,
      rateLimitPerUser: channel.rateLimitPerUser || undefined,
      bitrate: channel.type === ChannelType.GuildVoice ? channel.bitrate ?? undefined : undefined,
      userLimit: channel.type === ChannelType.GuildVoice ? channel.userLimit ?? undefined : undefined,
      permissionOverwrites: mapOverwrites(channel.overwrites),
      reason: `Backup restore ${code}`,
    }), { label: 'restore channel' });
    if (fresh) {
      channelMap.set(channel.id, fresh.id);
      created.channels += 1;
    }
    // eslint-disable-next-line no-await-in-loop
    await sleep(API_DELAY_MS);
  }

  // ── Re-wire the bot's configuration onto the new ids ──────────────────────
  onProgress('Re-wiring configuration…');
  const remap = (mapping, lookup) => Object.fromEntries(
    Object.entries(mapping ?? {})
      .map(([key, oldId]) => [key, lookup.get(oldId)])
      .filter(([, value]) => Boolean(value)),
  );

  await configService.update(guild, (cfg) => {
    cfg.setPath('roles', remap(payload.configuration?.roles, roleMap));
    cfg.setPath('categories', remap(payload.configuration?.categories, categoryMap));
    cfg.setPath('channels', remap(payload.configuration?.channels, channelMap));
    cfg.setPath('logChannels', remap(payload.configuration?.logChannels, channelMap));
  });
  configService.invalidate(guild.id);

  backup.restoredAt = new Date();
  backup.restoredBy = actor?.id ?? '';
  await backup.save();

  await logService.record(guild, {
    category: 'system',
    event: 'backup.restore',
    title: `${EMOJIS.warning} Backup Restored`,
    summary: `Snapshot \`${code}\` applied — ${created.roles} roles, ${created.channels} channels recreated`,
    actorId: actor?.id ?? '',
    severity: 'warn',
  });

  log.warn(`Backup ${code} restored for ${guild.name}`, created);
  return { created, backup, unrestorable: UNRESTORABLE };
}

/** What a bot fundamentally cannot bring back — surfaced in the UI. */
const UNRESTORABLE = Object.freeze([
  'Message history and attachments — Discord provides no API to write history.',
  'Which members held which roles at snapshot time.',
  'Emoji, sticker and soundboard files — they must be re-uploaded manually.',
  'Server boosts, the vanity URL, and Community/onboarding configuration.',
  'Webhook tokens — webhooks are recreated with new URLs.',
  'Audit log history.',
]);

/** List snapshots for a guild. */
const list = (guildId, limit = 15) => Backup.list(guildId, limit);

/** Delete a snapshot. */
async function remove(guildId, code) {
  const backup = await Backup.findOne({ guildId, code: code.toUpperCase() });
  if (!backup) throw new errors.NotFoundError(`No backup exists with the code \`${code}\`.`);
  if (backup.filePath) await fs.unlink(backup.filePath).catch(() => null);
  await Backup.deleteOne({ _id: backup._id });
  return backup;
}

module.exports = { create, restore, list, remove, prune, UNRESTORABLE };
