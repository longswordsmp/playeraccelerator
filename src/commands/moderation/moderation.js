'use strict';

/**
 * Moderation commands.
 *
 * All of them are thin wrappers around `moderationService.punish`, which owns
 * hierarchy checks, DM notification, case numbering, logging, statistics and
 * escalation. Each command is exported separately so `/warn`, `/ban` and the
 * rest appear as top-level commands rather than buried under a group.
 */

const { SlashCommandBuilder, PermissionFlagsBits, ComponentType } = require('discord.js');

const moderationService = require('../../services/moderationService');
const embeds = require('../../utils/embeds');
const components = require('../../utils/components');
const customId = require('../../utils/customId');
const validators = require('../../utils/validators');
const errors = require('../../utils/errors');
const permissions = require('../../utils/permissions');
const { Moderation } = require('../../database/models');
const { EMOJIS } = require('../../config/branding');
const { safeReply, safeDefer, fetchMember } = require('../../utils/discord');
const { duration, parseDuration, timestamp, truncate, table } = require('../../utils/formatters');

/**
 * Shared pre-flight for any command that acts on a member.
 * @returns {Promise<{ target: import('discord.js').User, member: import('discord.js').GuildMember|null }>}
 */
async function resolveTarget(interaction, actor, config, { requireMember = true } = {}) {
  const user = interaction.options.getUser('user');
  const target = await fetchMember(interaction.guild, user.id);

  if (requireMember && !target) {
    throw new errors.NotFoundError('That member is not in this server.');
  }

  if (target) {
    const actorCheck = permissions.canActOn(actor, target);
    if (!actorCheck.ok) throw new errors.PermissionError(actorCheck.reason);

    const botCheck = permissions.botCanActOn(interaction.guild, target);
    if (!botCheck.ok) throw new errors.DiscordLimitationError(botCheck.reason);
  }

  return { target: user, member: target };
}

/** Render the standard confirmation embed for a completed action. */
function result(config, type, user, extra = {}) {
  const meta = moderationService.ACTION_LABELS[type];
  return embeds.base({
    config,
    color: meta.color,
    title: `${meta.emoji} ${meta.label}`,
    description: `**${user.tag}** has been ${meta.past}.`,
    fields: [
      { name: 'User', value: `<@${user.id}>\n\`${user.id}\``, inline: true },
      ...(extra.caseId ? [{ name: 'Case', value: `\`#${extra.caseId}\``, inline: true }] : []),
      ...(extra.duration ? [{ name: 'Duration', value: duration(extra.duration), inline: true }] : []),
      { name: 'Reason', value: truncate(extra.reason ?? 'No reason provided', 1024) },
      ...(extra.note ? [{ name: 'Note', value: extra.note }] : []),
    ],
  });
}

/** Build a standard moderation command definition. */
function build({ name, description, access, options = [], run, defaultPermission = PermissionFlagsBits.ModerateMembers, cooldown = 3 }) {
  const data = new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(defaultPermission)
    .setDMPermission(false);
  for (const apply of options) apply(data);

  return { access, cooldown, requiresSetup: false, data, execute: run };
}

// ── /warn ────────────────────────────────────────────────────────────────────
const warn = build({
  name: 'warn',
  description: 'Warn a member. Warnings escalate automatically.',
  access: 'support',
  options: [
    (data) => data.addUserOption((option) => option.setName('user').setDescription('Who to warn.').setRequired(true)),
    (data) => data.addStringOption((option) => option.setName('reason').setDescription('Why.').setRequired(true)),
    (data) => data.addStringOption((option) => option.setName('evidence').setDescription('Message link or screenshot URL.')),
  ],
  async run(interaction, { config, member }) {
    const { target } = await resolveTarget(interaction, member, config);
    const reason = validators.text(interaction.options.getString('reason'), 'Reason', { max: 1000 });
    const evidence = interaction.options.getString('evidence');

    const { case: record, note } = await moderationService.punish({
      guild: interaction.guild,
      type: 'warn',
      target,
      moderator: { id: member.id, tag: member.user.tag },
      reason,
      config,
      evidence: evidence ? [validators.url(evidence, { label: 'Evidence' })] : [],
    });

    const active = await Moderation.activeWarnings(interaction.guildId, target.id, config.moderation?.warningExpiryDays ?? 0);
    return safeReply(interaction, {
      embeds: [result(config, 'warn', target, {
        caseId: record.caseId,
        reason,
        note: `${active} active warning${active === 1 ? '' : 's'}.${note ? ` ${note}` : ''}`,
      })],
    }, { ephemeral: true });
  },
});

// ── /unwarn ──────────────────────────────────────────────────────────────────
const unwarn = build({
  name: 'unwarn',
  description: 'Revoke a warning or any other case by its number.',
  access: 'manager',
  options: [
    (data) => data.addIntegerOption((option) => option.setName('case').setDescription('Case number.').setRequired(true).setMinValue(1)),
    (data) => data.addStringOption((option) => option.setName('reason').setDescription('Why it is being revoked.')),
  ],
  async run(interaction, { config, member }) {
    const caseId = interaction.options.getInteger('case');
    const reason = validators.clean(interaction.options.getString('reason') ?? 'No reason provided', { max: 500 });
    const record = await moderationService.revoke(interaction.guild, caseId, member, reason, config);

    return safeReply(interaction, {
      embeds: [embeds.success({
        config,
        title: 'Case Revoked',
        description: `Case \`#${caseId}\` (${record.type}) against <@${record.userId}> has been revoked.`,
        fields: [{ name: 'Reason', value: truncate(reason, 1024) }],
      })],
    }, { ephemeral: true });
  },
});

// ── /warnings ────────────────────────────────────────────────────────────────
const warnings = build({
  name: 'warnings',
  description: 'Show a member\'s active warnings.',
  access: 'support',
  options: [
    (data) => data.addUserOption((option) => option.setName('user').setDescription('Whose warnings.').setRequired(true)),
  ],
  async run(interaction, { config }) {
    const user = interaction.options.getUser('user');
    const expiryDays = config.moderation?.warningExpiryDays ?? 0;

    const query = { guildId: interaction.guildId, userId: user.id, type: 'warn', revoked: false };
    if (expiryDays > 0) query.createdAt = { $gte: new Date(Date.now() - expiryDays * 86_400_000) };
    const records = await Moderation.find(query).sort({ createdAt: -1 }).limit(15).lean();

    if (!records.length) {
      return safeReply(interaction, {
        embeds: [embeds.success({ config, title: 'Clean Record', description: `**${user.tag}** has no active warnings.` })],
      }, { ephemeral: true });
    }

    const ladder = config.moderation?.escalation ?? [];
    const next = ladder.find((rung) => rung.at > records.length);

    return safeReply(interaction, {
      embeds: [embeds.warning({
        config,
        title: `Warnings · ${user.tag}`,
        description: `**${records.length}** active warning${records.length === 1 ? '' : 's'}${expiryDays > 0 ? ` (warnings expire after ${expiryDays} days)` : ''}.`,
        thumbnail: user.displayAvatarURL({ size: 128 }),
        fields: [
          ...records.slice(0, 10).map((record) => ({
            name: `Case #${record.caseId} · ${new Date(record.createdAt).toISOString().slice(0, 10)}`,
            value: `${truncate(record.reason, 200)}\n${record.automated ? `_Automated (${record.source})_` : `_By <@${record.moderatorId}>_`}`,
          })),
          ...(next ? [{ name: 'Next escalation', value: `At **${next.at}** warnings: \`${next.action}\`${next.duration ? ` for ${duration(next.duration * 60_000)}` : ''}` }] : []),
        ],
      })],
    }, { ephemeral: true });
  },
});

// ── /timeout ─────────────────────────────────────────────────────────────────
const timeout = build({
  name: 'timeout',
  description: 'Temporarily prevent a member from speaking.',
  access: 'support',
  options: [
    (data) => data.addUserOption((option) => option.setName('user').setDescription('Who to time out.').setRequired(true)),
    (data) => data.addStringOption((option) => option.setName('duration').setDescription('e.g. 10m, 2h, 1d (max 28 days).').setRequired(true)),
    (data) => data.addStringOption((option) => option.setName('reason').setDescription('Why.')),
  ],
  async run(interaction, { config, member }) {
    const { target } = await resolveTarget(interaction, member, config);
    const ms = parseDuration(interaction.options.getString('duration'));
    if (!ms) throw new errors.ValidationError('That duration could not be understood. Try `10m`, `2h` or `1d`.');
    if (ms > moderationService.MAX_TIMEOUT_MS) {
      throw new errors.DiscordLimitationError('Discord caps timeouts at **28 days**. Use `/ban` for anything longer.');
    }

    const reason = validators.clean(interaction.options.getString('reason') ?? 'No reason provided', { max: 1000 });
    const { case: record, note } = await moderationService.punish({
      guild: interaction.guild,
      type: 'timeout',
      target,
      moderator: { id: member.id, tag: member.user.tag },
      reason,
      duration: ms,
      config,
    });

    return safeReply(interaction, {
      embeds: [result(config, 'timeout', target, { caseId: record.caseId, reason, duration: ms, note })],
    }, { ephemeral: true });
  },
});

// ── /untimeout ───────────────────────────────────────────────────────────────
const untimeout = build({
  name: 'untimeout',
  description: 'Lift a member\'s timeout early.',
  access: 'support',
  options: [
    (data) => data.addUserOption((option) => option.setName('user').setDescription('Who to release.').setRequired(true)),
    (data) => data.addStringOption((option) => option.setName('reason').setDescription('Why.')),
  ],
  async run(interaction, { config, member }) {
    const { target, member: targetMember } = await resolveTarget(interaction, member, config);
    if (!targetMember.isCommunicationDisabled()) {
      throw new errors.ConflictError('That member is not currently timed out.');
    }

    const reason = validators.clean(interaction.options.getString('reason') ?? 'Timeout lifted', { max: 500 });
    const { case: record } = await moderationService.punish({
      guild: interaction.guild,
      type: 'untimeout',
      target,
      moderator: { id: member.id, tag: member.user.tag },
      reason,
      config,
    });

    return safeReply(interaction, {
      embeds: [result(config, 'untimeout', target, { caseId: record.caseId, reason })],
    }, { ephemeral: true });
  },
});

// ── /mute, /unmute — aliases that use Discord's timeout under the hood ───────
const mute = build({
  name: 'mute',
  description: 'Mute a member (an alias for /timeout).',
  access: 'support',
  options: [
    (data) => data.addUserOption((option) => option.setName('user').setDescription('Who to mute.').setRequired(true)),
    (data) => data.addStringOption((option) => option.setName('duration').setDescription('e.g. 30m, 4h (default 1 hour, max 28 days).')),
    (data) => data.addStringOption((option) => option.setName('reason').setDescription('Why.')),
  ],
  async run(interaction, { config, member }) {
    const { target } = await resolveTarget(interaction, member, config);
    const ms = parseDuration(interaction.options.getString('duration') ?? '1h') ?? 3_600_000;
    if (ms > moderationService.MAX_TIMEOUT_MS) {
      throw new errors.DiscordLimitationError('Discord caps mutes at **28 days**.');
    }
    const reason = validators.clean(interaction.options.getString('reason') ?? 'No reason provided', { max: 1000 });

    const { case: record, note } = await moderationService.punish({
      guild: interaction.guild,
      type: 'mute',
      target,
      moderator: { id: member.id, tag: member.user.tag },
      reason,
      duration: ms,
      config,
    });

    return safeReply(interaction, {
      embeds: [result(config, 'mute', target, { caseId: record.caseId, reason, duration: ms, note })],
    }, { ephemeral: true });
  },
});

const unmute = build({
  name: 'unmute',
  description: 'Unmute a member.',
  access: 'support',
  options: [
    (data) => data.addUserOption((option) => option.setName('user').setDescription('Who to unmute.').setRequired(true)),
    (data) => data.addStringOption((option) => option.setName('reason').setDescription('Why.')),
  ],
  async run(interaction, { config, member }) {
    const { target } = await resolveTarget(interaction, member, config);
    const reason = validators.clean(interaction.options.getString('reason') ?? 'Mute lifted', { max: 500 });
    const { case: record } = await moderationService.punish({
      guild: interaction.guild,
      type: 'unmute',
      target,
      moderator: { id: member.id, tag: member.user.tag },
      reason,
      config,
    });
    return safeReply(interaction, {
      embeds: [result(config, 'unmute', target, { caseId: record.caseId, reason })],
    }, { ephemeral: true });
  },
});

// ── /kick ────────────────────────────────────────────────────────────────────
const kick = build({
  name: 'kick',
  description: 'Remove a member from the server.',
  access: 'manager',
  defaultPermission: PermissionFlagsBits.KickMembers,
  options: [
    (data) => data.addUserOption((option) => option.setName('user').setDescription('Who to kick.').setRequired(true)),
    (data) => data.addStringOption((option) => option.setName('reason').setDescription('Why.').setRequired(true)),
  ],
  async run(interaction, { config, member }) {
    const { target } = await resolveTarget(interaction, member, config);
    const reason = validators.text(interaction.options.getString('reason'), 'Reason', { max: 1000 });

    const { case: record, note } = await moderationService.punish({
      guild: interaction.guild,
      type: 'kick',
      target,
      moderator: { id: member.id, tag: member.user.tag },
      reason,
      config,
    });

    return safeReply(interaction, {
      embeds: [result(config, 'kick', target, { caseId: record.caseId, reason, note })],
    }, { ephemeral: true });
  },
});

// ── /ban ─────────────────────────────────────────────────────────────────────
const ban = build({
  name: 'ban',
  description: 'Ban a user, permanently or for a set duration.',
  access: 'manager',
  defaultPermission: PermissionFlagsBits.BanMembers,
  cooldown: 5,
  options: [
    (data) => data.addUserOption((option) => option.setName('user').setDescription('Who to ban.').setRequired(true)),
    (data) => data.addStringOption((option) => option.setName('reason').setDescription('Why.').setRequired(true)),
    (data) => data.addStringOption((option) => option.setName('duration').setDescription('Temporary ban, e.g. 7d. Omit for permanent.')),
    (data) => data.addIntegerOption((option) => option
      .setName('delete-days')
      .setDescription('Delete this many days of their recent messages (0-7).')
      .setMinValue(0)
      .setMaxValue(7)),
  ],
  async run(interaction, { config, member }) {
    // A ban may target someone who has already left, so the member is optional.
    const { target } = await resolveTarget(interaction, member, config, { requireMember: false });
    const reason = validators.text(interaction.options.getString('reason'), 'Reason', { max: 1000 });
    const durationInput = interaction.options.getString('duration');
    const ms = durationInput ? parseDuration(durationInput) : null;
    if (durationInput && !ms) throw new errors.ValidationError('That duration could not be understood. Try `7d` or `30d`.');
    const deleteDays = interaction.options.getInteger('delete-days') ?? 0;

    const existing = await interaction.guild.bans.fetch(target.id).catch(() => null);
    if (existing) throw new errors.ConflictError('That user is already banned.');

    // Confirmation, because a ban is not trivially reversible.
    if (config.moderation?.confirmDestructive !== false) {
      await safeReply(interaction, {
        embeds: [embeds.warning({
          config,
          title: 'Confirm Ban',
          description: `**${target.tag}** will be banned${ms ? ` for **${duration(ms)}**` : ' **permanently**'}.`,
          fields: [
            { name: 'Reason', value: truncate(reason, 1024) },
            ...(deleteDays ? [{ name: 'Message deletion', value: `The last **${deleteDays} day(s)** of their messages will be removed.` }] : []),
          ],
        })],
        components: components.confirmation('confirm', 'ban', [], { confirmLabel: 'Ban User' }),
      }, { ephemeral: true });

      const reply = await interaction.fetchReply().catch(() => null);
      if (!reply) return null;

      let choice;
      try {
        choice = await reply.awaitMessageComponent({
          componentType: ComponentType.Button,
          time: 30_000,
          filter: (component) => component.user.id === interaction.user.id,
        });
      } catch {
        return interaction.editReply({
          embeds: [embeds.notice('Ban cancelled — the confirmation timed out.', 'info', config)],
          components: [],
        }).catch(() => null);
      }

      if (customId.parse(choice.customId)?.namespace !== 'confirm') {
        return choice.update({
          embeds: [embeds.notice('Ban cancelled.', 'info', config)],
          components: [],
        }).catch(() => null);
      }
      await choice.deferUpdate().catch(() => null);
    } else {
      await safeDefer(interaction, { ephemeral: true });
    }

    const { case: record, note } = await moderationService.punish({
      guild: interaction.guild,
      type: 'ban',
      target,
      moderator: { id: member.id, tag: member.user.tag },
      reason,
      duration: ms,
      config,
      deleteMessageSeconds: deleteDays * 86_400,
    });

    return interaction.editReply({
      embeds: [result(config, 'ban', target, { caseId: record.caseId, reason, duration: ms, note })],
      components: [],
    }).catch(() => null);
  },
});

// ── /unban ───────────────────────────────────────────────────────────────────
const unban = build({
  name: 'unban',
  description: 'Lift a ban.',
  access: 'manager',
  defaultPermission: PermissionFlagsBits.BanMembers,
  options: [
    (data) => data.addStringOption((option) => option.setName('user-id').setDescription('The banned user\'s ID.').setRequired(true)),
    (data) => data.addStringOption((option) => option.setName('reason').setDescription('Why.')),
  ],
  async run(interaction, { config, member }) {
    const userId = validators.snowflake(interaction.options.getString('user-id'), 'User ID');
    const existing = await interaction.guild.bans.fetch(userId).catch(() => null);
    if (!existing) throw new errors.NotFoundError('That user is not banned in this server.');

    const reason = validators.clean(interaction.options.getString('reason') ?? 'Ban lifted', { max: 500 });
    const { case: record } = await moderationService.punish({
      guild: interaction.guild,
      type: 'unban',
      target: existing.user,
      moderator: { id: member.id, tag: member.user.tag },
      reason,
      config,
      silent: true,
    });

    return safeReply(interaction, {
      embeds: [result(config, 'unban', existing.user, { caseId: record.caseId, reason })],
    }, { ephemeral: true });
  },
});

// ── /softban ─────────────────────────────────────────────────────────────────
const softban = build({
  name: 'softban',
  description: 'Ban and immediately unban, to clear a member\'s recent messages.',
  access: 'manager',
  defaultPermission: PermissionFlagsBits.BanMembers,
  options: [
    (data) => data.addUserOption((option) => option.setName('user').setDescription('Who to soft-ban.').setRequired(true)),
    (data) => data.addStringOption((option) => option.setName('reason').setDescription('Why.').setRequired(true)),
  ],
  async run(interaction, { config, member }) {
    const { target } = await resolveTarget(interaction, member, config);
    const reason = validators.text(interaction.options.getString('reason'), 'Reason', { max: 1000 });

    const { case: record, note } = await moderationService.punish({
      guild: interaction.guild,
      type: 'softban',
      target,
      moderator: { id: member.id, tag: member.user.tag },
      reason,
      config,
    });

    return safeReply(interaction, {
      embeds: [result(config, 'softban', target, {
        caseId: record.caseId,
        reason,
        note: `${note ? `${note} ` : ''}Their last 24 hours of messages were removed. They can rejoin immediately.`,
      })],
    }, { ephemeral: true });
  },
});

// ── /history ─────────────────────────────────────────────────────────────────
const history = build({
  name: 'history',
  description: 'Show a member\'s full moderation history.',
  access: 'support',
  options: [
    (data) => data.addUserOption((option) => option.setName('user').setDescription('Whose history.').setRequired(true)),
  ],
  async run(interaction, { config }) {
    const user = interaction.options.getUser('user');
    await safeDefer(interaction, { ephemeral: true });
    const { cases, activeWarnings, counts } = await moderationService.history(interaction.guildId, user.id, 25);

    if (!cases.length) {
      return safeReply(interaction, {
        embeds: [embeds.success({ config, title: 'Clean Record', description: `**${user.tag}** has no moderation history in this server.` })],
      }, { ephemeral: true });
    }

    const rows = cases.slice(0, 15).map((record) => [
      `#${record.caseId}`,
      record.type,
      new Date(record.createdAt).toISOString().slice(0, 10),
      record.revoked ? 'revoked' : record.active ? 'active' : 'expired',
    ]);

    return safeReply(interaction, {
      embeds: [embeds.info({
        config,
        title: `${EMOJIS.logs} Moderation History · ${user.tag}`,
        description: table(['Case', 'Type', 'Date', 'State'], rows),
        thumbnail: user.displayAvatarURL({ size: 128 }),
        fields: [
          { name: 'Active warnings', value: String(activeWarnings), inline: true },
          { name: 'Total cases', value: String(cases.length), inline: true },
          { name: 'Breakdown', value: Object.entries(counts).map(([type, count]) => `${type}: ${count}`).join(', ') || '—', inline: true },
          ...cases.slice(0, 5).map((record) => ({
            name: `Case #${record.caseId} · ${record.type}${record.revoked ? ' (revoked)' : ''}`,
            value:
              `${truncate(record.reason, 250)}\n` +
              `${record.automated ? `_Automated · ${record.source}_` : `_By <@${record.moderatorId}>_`} · ${timestamp(record.createdAt, 'relative')}`,
          })),
        ],
        footer: `${cases.length} case(s) on record`,
      })],
    }, { ephemeral: true });
  },
});

module.exports = [warn, unwarn, warnings, timeout, untimeout, mute, unmute, kick, ban, unban, softban, history];
