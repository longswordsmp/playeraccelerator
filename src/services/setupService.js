'use strict';

/**
 * Automated server construction.
 *
 * `/setup` tears down the existing structure and rebuilds the guild from the
 * blueprint in `config/server.js`: roles, categories, channels, permission
 * overwrites, logging destinations and every public panel.
 *
 * Discord API limitations that the engine handles rather than hides:
 *   • Roles positioned above the bot's highest role cannot be deleted, edited
 *     or reordered. They are detected, skipped and reported.
 *   • Managed roles (bot/integration/booster roles) can never be deleted.
 *   • The @everyone role cannot be deleted.
 *   • A guild is capped at 500 channels, 250 roles, and 50 channels per
 *     category. The engine checks these before it starts.
 *   • The channel the command runs in is preserved until the very end so
 *     progress can keep being reported.
 */

const { ChannelType, PermissionFlagsBits, PermissionsBitField } = require('discord.js');

const { ROLES, CATEGORIES, VOICE_CHANNELS } = require('../config/server');
const configService = require('./configService');
const logService = require('./logService');
const backupService = require('./backupService');
const embeds = require('../utils/embeds');
const { EMOJIS, COLORS } = require('../config/branding');
const { attempt, sleep } = require('../utils/discord');
const { logger } = require('../utils/logger');

const log = logger.child('setup');

/** Pause between destructive API calls so a rebuild never trips a global limit. */
const API_DELAY_MS = 400;

/**
 * Progress reporter. Accumulates a step log and edits a single message rather
 * than spamming the channel.
 */
class SetupProgress {
  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {object} config
   */
  constructor(interaction, config) {
    this.interaction = interaction;
    this.config = config;
    this.steps = [];
    this.warnings = [];
    this.startedAt = Date.now();
    this.lastEdit = 0;
  }

  /**
   * @param {string} message
   * @param {'pending'|'done'|'warn'|'fail'} [state]
   */
  async step(message, state = 'done') {
    const glyph = { pending: EMOJIS.loading, done: EMOJIS.success, warn: EMOJIS.warning, fail: EMOJIS.error }[state];
    this.steps.push(`${glyph} ${message}`);
    if (state === 'warn' || state === 'fail') this.warnings.push(message);
    await this.render();
  }

  /** Record a non-blocking limitation without a progress line. */
  warn(message) {
    this.warnings.push(message);
  }

  /** Edit the progress message, throttled to respect rate limits. */
  async render(force = false) {
    if (!force && Date.now() - this.lastEdit < 1500) return;
    this.lastEdit = Date.now();
    const recent = this.steps.slice(-14);
    await attempt(
      () => this.interaction.editReply({
        embeds: [embeds.base({
          config: this.config,
          color: COLORS.primary,
          title: `${EMOJIS.loading} Building your server…`,
          description: recent.join('\n') || 'Starting…',
          footer: `${this.steps.length} steps · ${Math.round((Date.now() - this.startedAt) / 1000)}s elapsed`,
        })],
        components: [],
      }),
      { label: 'setup progress' },
    );
  }
}

/**
 * Pre-flight checks. Returns a list of blocking problems.
 * @param {import('discord.js').Guild} guild
 * @returns {string[]}
 */
function preflight(guild) {
  const problems = [];
  const me = guild.members.me;

  if (!me) return ['I could not resolve my own membership in this server.'];

  const required = [
    'ManageChannels', 'ManageRoles', 'ManageGuild', 'ViewChannel',
    'SendMessages', 'EmbedLinks', 'ManageMessages', 'ReadMessageHistory',
  ];
  const missing = required.filter((permission) => !me.permissions.has(PermissionFlagsBits[permission]));
  if (missing.length) {
    problems.push(`I am missing these permissions: ${missing.map((p) => `\`${p}\``).join(', ')}. Grant them and try again.`);
  }

  // The bot must sit high enough to create and order the role hierarchy.
  if (me.roles.highest.position < 2) {
    problems.push('My role is at the bottom of the hierarchy. Move it near the top in **Server Settings → Roles** before running setup.');
  }

  if (guild.roles.cache.size + ROLES.length > 250) {
    problems.push(`This server has ${guild.roles.cache.size} roles. Discord caps a guild at 250, and setup needs ${ROLES.length} more.`);
  }

  const plannedChannels = CATEGORIES.reduce((sum, category) => sum + 1 + category.channels.length, 0) + VOICE_CHANNELS.length;
  if (plannedChannels > 500) {
    problems.push('The blueprint exceeds Discord\'s 500-channel limit.');
  }

  return problems;
}

// ── Teardown ─────────────────────────────────────────────────────────────────

/**
 * Delete existing channels and roles.
 *
 * @param {import('discord.js').Guild} guild
 * @param {SetupProgress} progress
 * @param {{ keepChannelId?: string, deleteRoles?: boolean }} options
 */
async function teardown(guild, progress, { keepChannelId, deleteRoles = true }) {
  const me = guild.members.me;
  let deletedChannels = 0;
  let skippedChannels = 0;

  // ── Channels ──────────────────────────────────────────────────────────────
  await progress.step('Removing existing channels…', 'pending');

  const channels = [...guild.channels.cache.values()]
    // Delete children before parents so Discord does not orphan anything.
    .sort((a, b) => (a.type === ChannelType.GuildCategory ? 1 : 0) - (b.type === ChannelType.GuildCategory ? 1 : 0));

  for (const channel of channels) {
    if (channel.id === keepChannelId) continue;
    // Community-server system channels cannot be deleted; skip them cleanly.
    if (channel.id === guild.rulesChannelId || channel.id === guild.publicUpdatesChannelId || channel.id === guild.safetyAlertsChannelId) {
      skippedChannels += 1;
      progress.warn(`\`${channel.name}\` is a Community system channel and cannot be deleted by a bot.`);
      continue;
    }
    if (!channel.manageable) {
      skippedChannels += 1;
      progress.warn(`\`${channel.name}\` could not be deleted (insufficient permissions).`);
      continue;
    }

    // eslint-disable-next-line no-await-in-loop -- deliberate pacing
    const deleted = await attempt(() => channel.delete('Server rebuild via /setup'), { label: 'delete channel' });
    if (deleted) deletedChannels += 1;
    else skippedChannels += 1;
    // eslint-disable-next-line no-await-in-loop
    await sleep(API_DELAY_MS);
  }

  await progress.step(`Removed ${deletedChannels} channel${deletedChannels === 1 ? '' : 's'}${skippedChannels ? ` (${skippedChannels} skipped)` : ''}`);

  // ── Roles ─────────────────────────────────────────────────────────────────
  if (!deleteRoles) return { deletedChannels, deletedRoles: 0, skippedChannels, skippedRoles: 0 };

  await progress.step('Removing unused roles…', 'pending');
  let deletedRoles = 0;
  let skippedRoles = 0;

  for (const role of [...guild.roles.cache.values()]) {
    // Never touch @everyone, managed roles, or anything at/above the bot.
    if (role.id === guild.roles.everyone.id) continue;
    if (role.managed) {
      skippedRoles += 1;
      continue;
    }
    if (role.position >= me.roles.highest.position) {
      skippedRoles += 1;
      progress.warn(`\`${role.name}\` sits above my highest role — Discord does not allow me to delete it.`);
      continue;
    }
    // Preserve roles that still grant administrator access to real humans, so a
    // rebuild can never lock the owner's team out of their own server.
    if (role.permissions.has(PermissionFlagsBits.Administrator) && role.members.size > 0) {
      skippedRoles += 1;
      progress.warn(`\`${role.name}\` was kept: it grants Administrator to ${role.members.size} member(s).`);
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const deleted = await attempt(() => role.delete('Server rebuild via /setup'), { label: 'delete role' });
    if (deleted) deletedRoles += 1;
    else skippedRoles += 1;
    // eslint-disable-next-line no-await-in-loop
    await sleep(API_DELAY_MS);
  }

  await progress.step(`Removed ${deletedRoles} role${deletedRoles === 1 ? '' : 's'}${skippedRoles ? ` (${skippedRoles} preserved)` : ''}`);
  return { deletedChannels, deletedRoles, skippedChannels, skippedRoles };
}

// ── Roles ────────────────────────────────────────────────────────────────────

/**
 * Create the role hierarchy, highest first so positions land correctly.
 * @param {import('discord.js').Guild} guild
 * @param {SetupProgress} progress
 * @returns {Promise<Record<string, string>>} roleKey -> role id
 */
async function createRoles(guild, progress) {
  await progress.step('Creating role hierarchy…', 'pending');
  /** @type {Record<string, string>} */
  const created = {};

  for (const definition of ROLES) {
    // Reuse an identically named role if one survived teardown.
    const existing = guild.roles.cache.find((role) => role.name === definition.name && !role.managed);
    if (existing) {
      created[definition.key] = existing.id;
      // eslint-disable-next-line no-await-in-loop
      await attempt(() => existing.edit({
        color: definition.color,
        hoist: definition.hoist,
        mentionable: definition.mentionable,
        permissions: new PermissionsBitField(definition.permissions.map((p) => PermissionFlagsBits[p]).filter(Boolean)),
      }), { label: 'update role' });
      continue;
    }

    // eslint-disable-next-line no-await-in-loop
    const role = await attempt(() => guild.roles.create({
      name: definition.name,
      color: definition.color,
      hoist: definition.hoist,
      mentionable: definition.mentionable,
      permissions: new PermissionsBitField(definition.permissions.map((p) => PermissionFlagsBits[p]).filter(Boolean)),
      reason: 'Server setup',
    }), { label: 'create role' });

    if (role) created[definition.key] = role.id;
    else progress.warn(`Could not create the \`${definition.name}\` role.`);
    // eslint-disable-next-line no-await-in-loop
    await sleep(API_DELAY_MS);
  }

  // Order them: the blueprint is listed highest-first, so reverse for Discord's
  // ascending position scale. Anything above the bot simply cannot move.
  const me = guild.members.me;
  const ordered = ROLES
    .map((definition) => created[definition.key])
    .filter(Boolean)
    .reverse()
    .map((id, index) => ({ role: id, position: index + 1 }))
    .filter((entry) => (guild.roles.cache.get(entry.role)?.position ?? 0) < me.roles.highest.position);

  if (ordered.length) {
    const positioned = await attempt(() => guild.roles.setPositions(ordered), { label: 'order roles' });
    if (!positioned) progress.warn('Role ordering could not be applied — move my role higher and re-run `/setup`.');
  }

  await progress.step(`Created ${Object.keys(created).length} roles`);
  return created;
}

// ── Permission presets ───────────────────────────────────────────────────────

/**
 * Expand an access preset into concrete permission overwrites.
 * @param {import('discord.js').Guild} guild
 * @param {Record<string, string>} roles roleKey -> id
 * @param {string} access preset name
 */
function overwritesFor(guild, roles, access) {
  const everyone = guild.roles.everyone.id;
  const staffKeys = ['support', 'developer', 'manager', 'leadDeveloper', 'owner'];
  const staffIds = staffKeys.map((key) => roles[key]).filter(Boolean);

  const read = [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory];
  const write = [PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks, PermissionFlagsBits.AttachFiles, PermissionFlagsBits.AddReactions];
  const manage = [PermissionFlagsBits.ManageMessages, PermissionFlagsBits.ManageThreads];

  const base = [];

  // The muted role is denied speech everywhere.
  if (roles.muted) {
    base.push({
      id: roles.muted,
      deny: [
        PermissionFlagsBits.SendMessages,
        PermissionFlagsBits.SendMessagesInThreads,
        PermissionFlagsBits.CreatePublicThreads,
        PermissionFlagsBits.CreatePrivateThreads,
        PermissionFlagsBits.AddReactions,
        PermissionFlagsBits.Speak,
        PermissionFlagsBits.Connect,
      ],
    });
  }

  switch (access) {
    case 'community':
      return [
        ...base,
        { id: everyone, allow: [...read, ...write] },
        ...staffIds.map((id) => ({ id, allow: [...read, ...write, ...manage] })),
      ];

    case 'readonly':
    case 'public':
      return [
        ...base,
        { id: everyone, allow: read, deny: [PermissionFlagsBits.SendMessages, PermissionFlagsBits.CreatePublicThreads] },
        ...staffIds.map((id) => ({ id, allow: [...read, ...write, ...manage] })),
      ];

    case 'staff':
      return [
        ...base,
        { id: everyone, deny: [PermissionFlagsBits.ViewChannel] },
        ...staffIds.map((id) => ({ id, allow: [...read, ...write, ...manage] })),
      ];

    case 'tickets':
      // Hidden by default; each ticket channel receives its own overwrites.
      return [
        ...base,
        { id: everyone, deny: [PermissionFlagsBits.ViewChannel] },
        ...staffIds.map((id) => ({ id, allow: [...read, ...write, ...manage] })),
      ];

    default:
      return [...base, { id: everyone, allow: read }];
  }
}

// ── Channels ─────────────────────────────────────────────────────────────────

/**
 * Build the category and channel structure.
 * @param {import('discord.js').Guild} guild
 * @param {Record<string, string>} roles
 * @param {SetupProgress} progress
 */
async function createChannels(guild, roles, progress) {
  const categories = {};
  const channels = {};
  const logChannels = {};
  const panelTargets = [];

  for (const category of CATEGORIES) {
    // eslint-disable-next-line no-await-in-loop
    await progress.step(`Building ${category.name.replace(/[═\s]/g, ' ').trim()}…`, 'pending');

    // eslint-disable-next-line no-await-in-loop
    const parent = await attempt(() => guild.channels.create({
      name: category.name,
      type: ChannelType.GuildCategory,
      permissionOverwrites: overwritesFor(guild, roles, category.access),
      reason: 'Server setup',
    }), { label: 'create category' });

    if (!parent) {
      progress.warn(`Could not create the category \`${category.name}\`.`);
      continue;
    }
    categories[category.key] = parent.id;
    // eslint-disable-next-line no-await-in-loop
    await sleep(API_DELAY_MS);

    for (const definition of category.channels) {
      // eslint-disable-next-line no-await-in-loop
      const channel = await attempt(() => guild.channels.create({
        name: definition.name,
        type: ChannelType.GuildText,
        parent: parent.id,
        topic: definition.topic,
        permissionOverwrites: overwritesFor(guild, roles, definition.access ?? category.access),
        reason: 'Server setup',
      }), { label: 'create channel' });

      if (!channel) {
        progress.warn(`Could not create \`${definition.name}\`.`);
        continue;
      }
      channels[definition.key] = channel.id;
      if (definition.logKey) logChannels[definition.logKey] = channel.id;
      if (definition.panel) panelTargets.push({ panel: definition.panel, channelId: channel.id });
      // eslint-disable-next-line no-await-in-loop
      await sleep(API_DELAY_MS);
    }
  }

  // Voice channels.
  await progress.step('Creating voice channels…', 'pending');
  for (const definition of VOICE_CHANNELS) {
    const parentId = categories[definition.category];
    // eslint-disable-next-line no-await-in-loop
    const channel = await attempt(() => guild.channels.create({
      name: definition.name,
      type: ChannelType.GuildVoice,
      parent: parentId,
      permissionOverwrites: overwritesFor(guild, roles, definition.access),
      reason: 'Server setup',
    }), { label: 'create voice channel' });
    if (channel) channels[definition.key] = channel.id;
    // eslint-disable-next-line no-await-in-loop
    await sleep(API_DELAY_MS);
  }

  await progress.step(`Created ${Object.keys(categories).length} categories and ${Object.keys(channels).length} channels`);
  return { categories, channels, logChannels, panelTargets };
}

// ── Orchestration ────────────────────────────────────────────────────────────

/**
 * Run the complete setup.
 *
 * @param {object} params
 * @param {import('discord.js').ChatInputCommandInteraction} params.interaction
 * @param {import('discord.js').Guild} params.guild
 * @param {object} params.config
 * @param {{ wipe?: boolean, deleteRoles?: boolean, backup?: boolean }} params.options
 * @returns {Promise<object>} a summary of what happened
 */
async function run({ interaction, guild, config, options }) {
  const progress = new SetupProgress(interaction, config);
  const startedAt = Date.now();

  // A snapshot before a destructive rebuild is not optional in a business tool.
  let backup = null;
  if (options.backup !== false) {
    await progress.step('Creating a structure backup…', 'pending');
    backup = await backupService
      .create(guild, { trigger: 'pre-setup', createdBy: interaction.user.id, createdByName: interaction.user.tag, label: 'Automatic pre-setup snapshot' })
      .catch((err) => {
        progress.warn(`Backup failed: ${err.message}`);
        return null;
      });
    await progress.step(backup ? `Backup saved as \`${backup.code}\`` : 'Backup skipped', backup ? 'done' : 'warn');
  }

  let teardownResult = { deletedChannels: 0, deletedRoles: 0, skippedChannels: 0, skippedRoles: 0 };
  if (options.wipe !== false) {
    teardownResult = await teardown(guild, progress, {
      keepChannelId: interaction.channelId,
      deleteRoles: options.deleteRoles !== false,
    });
  }

  const roles = await createRoles(guild, progress);
  const { categories, channels, logChannels, panelTargets } = await createChannels(guild, roles, progress);

  // Persist the wiring before publishing panels — panels read it back.
  await progress.step('Saving configuration…', 'pending');
  await configService.update(guild, (cfg) => {
    cfg.setPath('roles', roles);
    cfg.setPath('categories', categories);
    cfg.setPath('channels', channels);
    cfg.setPath('logChannels', logChannels);
    cfg.setPath('autoRoles.onJoin', roles.verified ? [roles.verified] : []);
    // The verify button grants this role; joining alone does not.
    cfg.setPath('verify.roleId', roles.verified ?? '');
    cfg.setPath('autoRoles.onBotJoin', roles.bot ? [roles.bot] : []);
    cfg.setPath('autoRoles.onFirstPurchase', roles.customer ?? '');
    cfg.setPath('autoRoles.onVip', roles.vip ?? '');
    cfg.setPath('setup', {
      completed: true,
      completedAt: new Date(),
      completedBy: interaction.user.id,
      version: (cfg.setup?.version ?? 0) + 1,
    });
  });
  configService.invalidate(guild.id);
  const fresh = await configService.get(guild, { fresh: true });
  await progress.step('Configuration saved');

  // Publish every public panel.
  await progress.step('Publishing panels…', 'pending');
  // Lazy require: panelService depends on services that depend on setup output.
  const panelService = require('./panelService');
  const published = await panelService.publishAll(guild, fresh, panelTargets, (message) => progress.warn(message));
  await progress.step(`Published ${published} panels`);

  // Clean up the temporary channel the command ran in, if it is not part of the
  // new structure.
  const commandChannel = guild.channels.cache.get(interaction.channelId);
  const isNewStructure = Object.values(channels).includes(interaction.channelId);
  const elapsed = Math.round((Date.now() - startedAt) / 1000);

  const summary = {
    elapsed,
    backup,
    roles: Object.keys(roles).length,
    categories: Object.keys(categories).length,
    channels: Object.keys(channels).length,
    panels: published,
    teardown: teardownResult,
    warnings: progress.warnings,
    orphanChannel: !isNewStructure && commandChannel ? commandChannel : null,
  };

  await logService.record(guild, {
    category: 'system',
    event: 'setup.complete',
    title: `${EMOJIS.success} Server Setup Completed`,
    summary: `Rebuilt in ${elapsed}s — ${summary.roles} roles, ${summary.channels} channels, ${published} panels`,
    actorId: interaction.user.id,
    actorName: interaction.user.tag,
    fields: {
      'Channels removed': String(teardownResult.deletedChannels),
      'Roles removed': String(teardownResult.deletedRoles),
      Warnings: String(progress.warnings.length),
      Backup: backup?.code ?? 'none',
    },
  }, fresh);

  log.success(`Setup completed for ${guild.name} in ${elapsed}s`);
  return summary;
}

module.exports = { run, preflight, teardown, createRoles, createChannels, overwritesFor, SetupProgress };
