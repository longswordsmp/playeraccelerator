'use strict';

/**
 * Channel-level moderation: purge, slowmode, lock and unlock.
 */

const { SlashCommandBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');

const moderationService = require('../../services/moderationService');
const logService = require('../../services/logService');
const embeds = require('../../utils/embeds');
const validators = require('../../utils/validators');
const errors = require('../../utils/errors');
const { Counter, Moderation, GuildStats, StaffStats } = require('../../database/models');
const { EMOJIS } = require('../../config/branding');
const { safeReply, safeDefer, safeSend, fetchMessages, attempt } = require('../../utils/discord');
const { duration, parseDuration, truncate, number } = require('../../utils/formatters');

/** Build a standard command definition. */
function build({ name, description, access, options = [], run, defaultPermission, cooldown = 3, botPermissions = [] }) {
  const data = new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(defaultPermission)
    .setDMPermission(false);
  for (const apply of options) apply(data);
  return { access, cooldown, botPermissions, requiresSetup: false, data, execute: run };
}

// ── /purge ───────────────────────────────────────────────────────────────────
const purge = build({
  name: 'purge',
  description: 'Bulk-delete recent messages in this channel.',
  access: 'support',
  defaultPermission: PermissionFlagsBits.ManageMessages,
  botPermissions: ['ManageMessages', 'ReadMessageHistory'],
  cooldown: 5,
  options: [
    (data) => data.addIntegerOption((option) => option
      .setName('count')
      .setDescription('How many messages to scan (1-500).')
      .setRequired(true)
      .setMinValue(1)
      .setMaxValue(500)),
    (data) => data.addUserOption((option) => option.setName('user').setDescription('Only delete this member\'s messages.')),
    (data) => data.addStringOption((option) => option
      .setName('filter')
      .setDescription('Only delete messages matching a filter.')
      .addChoices(
        { name: 'Bots', value: 'bots' },
        { name: 'Humans', value: 'humans' },
        { name: 'With attachments', value: 'attachments' },
        { name: 'With links', value: 'links' },
        { name: 'With embeds', value: 'embeds' },
      )),
    (data) => data.addStringOption((option) => option.setName('contains').setDescription('Only delete messages containing this text.')),
    (data) => data.addStringOption((option) => option.setName('reason').setDescription('Why.')),
  ],
  async run(interaction, { config, member }) {
    await safeDefer(interaction, { ephemeral: true });

    const count = interaction.options.getInteger('count');
    const user = interaction.options.getUser('user');
    const filter = interaction.options.getString('filter');
    const contains = interaction.options.getString('contains');
    const reason = validators.clean(interaction.options.getString('reason') ?? 'No reason provided', { max: 500 });

    const channel = interaction.channel;
    if (!channel?.isTextBased?.() || channel.type === ChannelType.DM) {
      throw new errors.ValidationError('Messages can only be purged in a server text channel.');
    }

    const messages = await fetchMessages(channel, count);

    // Discord will not bulk-delete anything older than 14 days.
    const cutoff = Date.now() - 13.9 * 86_400_000;
    const candidates = messages.filter((message) => {
      if (message.createdTimestamp < cutoff) return false;
      if (message.pinned) return false;
      if (user && message.author.id !== user.id) return false;
      if (filter === 'bots' && !message.author.bot) return false;
      if (filter === 'humans' && message.author.bot) return false;
      if (filter === 'attachments' && message.attachments.size === 0) return false;
      if (filter === 'links' && !/https?:\/\//i.test(message.content ?? '')) return false;
      if (filter === 'embeds' && message.embeds.length === 0) return false;
      if (contains && !String(message.content ?? '').toLowerCase().includes(contains.toLowerCase())) return false;
      return true;
    });

    if (!candidates.length) {
      return safeReply(interaction, {
        embeds: [embeds.warning({
          config,
          title: 'Nothing to delete',
          description:
            'No messages matched. Note that Discord does not allow bulk-deleting messages older than **14 days**, ' +
            'and pinned messages are always skipped.',
        })],
      }, { ephemeral: true });
    }

    const deleted = await channel.bulkDelete(candidates, true).catch(() => null);
    const removed = deleted?.size ?? 0;
    const skipped = messages.length - removed;

    // Record it as a case so the audit trail is complete.
    const caseId = await Counter.next(interaction.guildId, 'case');
    await Moderation.create({
      guildId: interaction.guildId,
      caseId,
      type: 'purge',
      userId: user?.id ?? interaction.channelId,
      username: user?.tag ?? `#${channel.name}`,
      moderatorId: member.id,
      moderatorName: member.user.tag,
      reason,
      context: { channelId: channel.id, content: `${removed} messages` },
      active: false,
    });

    await Promise.all([
      GuildStats.bump(interaction.guildId, { 'moderation.messagesDeleted': removed }),
      StaffStats.bump(interaction.guildId, member.id, { 'moderation.messagesPurged': removed }, member.user.tag),
      logService.record(interaction.guild, {
        category: 'moderation',
        event: 'moderation.purge',
        title: `${EMOJIS.trash} Messages Purged`,
        summary: `${removed} messages deleted in <#${channel.id}>`,
        actorId: member.id,
        actorName: member.user.tag,
        channelId: channel.id,
        caseId,
        severity: 'warn',
        fields: {
          Reason: truncate(reason, 500),
          ...(user ? { Target: `<@${user.id}>` } : {}),
          ...(filter ? { Filter: filter } : {}),
          ...(contains ? { Contains: truncate(contains, 100) } : {}),
        },
      }, config),
    ]);

    return safeReply(interaction, {
      embeds: [embeds.success({
        config,
        title: 'Messages Purged',
        description: `Deleted **${number(removed)}** message${removed === 1 ? '' : 's'} in <#${channel.id}>.`,
        fields: [
          { name: 'Scanned', value: String(messages.length), inline: true },
          { name: 'Skipped', value: String(skipped), inline: true },
          { name: 'Case', value: `\`#${caseId}\``, inline: true },
          ...(skipped > 0
            ? [{ name: 'Why some were skipped', value: 'Pinned messages, messages older than 14 days, or messages that did not match the filter.' }]
            : []),
        ],
      })],
    }, { ephemeral: true });
  },
});

// ── /slowmode ────────────────────────────────────────────────────────────────
const slowmode = build({
  name: 'slowmode',
  description: 'Set the slowmode delay for a channel.',
  access: 'support',
  defaultPermission: PermissionFlagsBits.ManageChannels,
  botPermissions: ['ManageChannels'],
  options: [
    (data) => data.addStringOption((option) => option
      .setName('duration')
      .setDescription('e.g. 10s, 5m, or "off". Maximum 6 hours.')
      .setRequired(true)),
    (data) => data.addChannelOption((option) => option
      .setName('channel')
      .setDescription('Which channel (defaults to this one).')
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildForum)),
    (data) => data.addStringOption((option) => option.setName('reason').setDescription('Why.')),
  ],
  async run(interaction, { config, member }) {
    const channel = interaction.options.getChannel('channel') ?? interaction.channel;
    const input = interaction.options.getString('duration');
    const reason = validators.clean(interaction.options.getString('reason') ?? 'No reason provided', { max: 400 });

    const seconds = ['off', 'none', '0'].includes(input.toLowerCase())
      ? 0
      : Math.round((parseDuration(input) ?? 0) / 1000);

    if (seconds === null || Number.isNaN(seconds)) {
      throw new errors.ValidationError('That duration could not be understood. Try `10s`, `5m` or `off`.');
    }
    if (seconds > 21_600) {
      throw new errors.DiscordLimitationError('Discord caps slowmode at **6 hours**.');
    }

    await channel.setRateLimitPerUser(seconds, `${reason} — by ${member.user.tag}`);

    await logService.record(interaction.guild, {
      category: 'moderation',
      event: 'moderation.slowmode',
      title: '🐌 Slowmode Changed',
      summary: seconds ? `Slowmode set to ${duration(seconds * 1000)} in <#${channel.id}>` : `Slowmode disabled in <#${channel.id}>`,
      actorId: member.id,
      actorName: member.user.tag,
      channelId: channel.id,
      fields: { Reason: truncate(reason, 500) },
    }, config);

    return safeReply(interaction, {
      embeds: [embeds.success({
        config,
        title: seconds ? 'Slowmode Enabled' : 'Slowmode Disabled',
        description: seconds
          ? `Members must now wait **${duration(seconds * 1000)}** between messages in <#${channel.id}>.`
          : `Slowmode has been turned off in <#${channel.id}>.`,
      })],
    }, { ephemeral: true });
  },
});

// ── /lock ────────────────────────────────────────────────────────────────────
const lock = build({
  name: 'lock',
  description: 'Prevent members from sending messages in a channel.',
  access: 'support',
  defaultPermission: PermissionFlagsBits.ManageChannels,
  botPermissions: ['ManageRoles', 'ManageChannels'],
  options: [
    (data) => data.addChannelOption((option) => option
      .setName('channel')
      .setDescription('Which channel (defaults to this one).')
      .addChannelTypes(ChannelType.GuildText)),
    (data) => data.addStringOption((option) => option.setName('reason').setDescription('Shown to members in the channel.')),
    (data) => data.addBooleanOption((option) => option.setName('category').setDescription('Lock every channel in this category.')),
  ],
  async run(interaction, { config, member }) {
    await safeDefer(interaction, { ephemeral: true });

    const channel = interaction.options.getChannel('channel') ?? interaction.channel;
    const reason = validators.clean(interaction.options.getString('reason') ?? '', { max: 500 });
    const wholeCategory = interaction.options.getBoolean('category') ?? false;

    const targets = wholeCategory && channel.parent
      ? [...channel.parent.children.cache.values()].filter((child) => child.type === ChannelType.GuildText && child.manageable)
      : [channel];

    let locked = 0;
    for (const target of targets) {
      // eslint-disable-next-line no-await-in-loop -- sequential to respect rate limits
      const result = await attempt(
        () => moderationService.setChannelLock(target, true, reason || `Locked by ${member.user.tag}`),
        { label: 'lock channel' },
      );
      if (result) {
        locked += 1;
        // eslint-disable-next-line no-await-in-loop
        await safeSend(target, {
          embeds: [embeds.warning({
            config,
            title: `${EMOJIS.lock} Channel Locked`,
            description: reason
              ? `This channel is temporarily read-only.\n\n**Reason:** ${truncate(reason, 500)}`
              : 'This channel is temporarily read-only. It will reopen shortly.',
            footer: 'Existing tickets are unaffected.',
          })],
        });
      }
    }

    await logService.record(interaction.guild, {
      category: 'moderation',
      event: 'moderation.lock',
      title: `${EMOJIS.lock} Channel Locked`,
      summary: `${locked} channel(s) locked`,
      actorId: member.id,
      actorName: member.user.tag,
      channelId: channel.id,
      severity: 'warn',
      fields: { Reason: truncate(reason || 'No reason provided', 500) },
    }, config);

    return safeReply(interaction, {
      embeds: [embeds.success({
        config,
        title: 'Locked',
        description: `**${locked}** channel${locked === 1 ? '' : 's'} locked.`,
      })],
    }, { ephemeral: true });
  },
});

// ── /unlock ──────────────────────────────────────────────────────────────────
const unlock = build({
  name: 'unlock',
  description: 'Restore messaging in a locked channel.',
  access: 'support',
  defaultPermission: PermissionFlagsBits.ManageChannels,
  botPermissions: ['ManageRoles', 'ManageChannels'],
  options: [
    (data) => data.addChannelOption((option) => option
      .setName('channel')
      .setDescription('Which channel (defaults to this one).')
      .addChannelTypes(ChannelType.GuildText)),
    (data) => data.addBooleanOption((option) => option.setName('category').setDescription('Unlock every channel in this category.')),
  ],
  async run(interaction, { config, member }) {
    await safeDefer(interaction, { ephemeral: true });

    const channel = interaction.options.getChannel('channel') ?? interaction.channel;
    const wholeCategory = interaction.options.getBoolean('category') ?? false;

    const targets = wholeCategory && channel.parent
      ? [...channel.parent.children.cache.values()].filter((child) => child.type === ChannelType.GuildText && child.manageable)
      : [channel];

    let unlocked = 0;
    for (const target of targets) {
      // eslint-disable-next-line no-await-in-loop -- sequential to respect rate limits
      const result = await attempt(
        () => moderationService.setChannelLock(target, false, `Unlocked by ${member.user.tag}`),
        { label: 'unlock channel' },
      );
      if (result) {
        unlocked += 1;
        // eslint-disable-next-line no-await-in-loop
        await safeSend(target, {
          embeds: [embeds.success({ config, title: `${EMOJIS.unlock} Channel Unlocked`, description: 'Normal messaging has resumed.' })],
        });
      }
    }

    await logService.record(interaction.guild, {
      category: 'moderation',
      event: 'moderation.unlock',
      title: `${EMOJIS.unlock} Channel Unlocked`,
      summary: `${unlocked} channel(s) unlocked`,
      actorId: member.id,
      actorName: member.user.tag,
      channelId: channel.id,
    }, config);

    return safeReply(interaction, {
      embeds: [embeds.success({
        config,
        title: 'Unlocked',
        description: `**${unlocked}** channel${unlocked === 1 ? '' : 's'} unlocked.`,
      })],
    }, { ephemeral: true });
  },
});

// ── /nickname ────────────────────────────────────────────────────────────────
const nickname = build({
  name: 'nickname',
  description: 'Change or clear a member\'s nickname.',
  access: 'support',
  defaultPermission: PermissionFlagsBits.ManageNicknames,
  botPermissions: ['ManageNicknames'],
  options: [
    (data) => data.addUserOption((option) => option.setName('user').setDescription('Whose nickname.').setRequired(true)),
    (data) => data.addStringOption((option) => option.setName('nickname').setDescription('New nickname. Omit to clear it.')),
    (data) => data.addStringOption((option) => option.setName('reason').setDescription('Why.')),
  ],
  async run(interaction, { config, member }) {
    const target = await interaction.guild.members.fetch(interaction.options.getUser('user').id).catch(() => null);
    if (!target) throw new errors.NotFoundError('That member is not in this server.');

    const check = require('../../utils/permissions').botCanActOn(interaction.guild, target);
    if (!check.ok) throw new errors.DiscordLimitationError(check.reason);

    const raw = interaction.options.getString('nickname');
    const nick = raw ? validators.text(raw, 'Nickname', { max: 32, allowNewlines: false }) : null;
    const reason = validators.clean(interaction.options.getString('reason') ?? '', { max: 400 });

    await target.setNickname(nick, `${reason || 'No reason provided'} — by ${member.user.tag}`);

    return safeReply(interaction, {
      embeds: [embeds.success({
        config,
        title: nick ? 'Nickname Set' : 'Nickname Cleared',
        description: nick ? `<@${target.id}> is now **${nick}**.` : `<@${target.id}>'s nickname has been cleared.`,
      })],
    }, { ephemeral: true });
  },
});

// ── /role ────────────────────────────────────────────────────────────────────
const role = build({
  name: 'role',
  description: 'Add or remove a role from a member.',
  access: 'manager',
  defaultPermission: PermissionFlagsBits.ManageRoles,
  botPermissions: ['ManageRoles'],
  options: [
    (data) => data.addUserOption((option) => option.setName('user').setDescription('Who.').setRequired(true)),
    (data) => data.addRoleOption((option) => option.setName('role').setDescription('Which role.').setRequired(true)),
    (data) => data.addStringOption((option) => option
      .setName('action')
      .setDescription('Add or remove (default: toggle).')
      .addChoices({ name: 'Add', value: 'add' }, { name: 'Remove', value: 'remove' })),
    (data) => data.addStringOption((option) => option.setName('reason').setDescription('Why.')),
  ],
  async run(interaction, { config, member }) {
    const target = await interaction.guild.members.fetch(interaction.options.getUser('user').id).catch(() => null);
    if (!target) throw new errors.NotFoundError('That member is not in this server.');

    const targetRole = interaction.options.getRole('role');
    if (!targetRole.editable) {
      throw new errors.DiscordLimitationError(
        `I cannot manage **${targetRole.name}** — it sits at or above my highest role, or it is managed by an integration.`,
      );
    }
    // A moderator must not be able to grant a role above their own.
    if (member.id !== interaction.guild.ownerId && member.roles.highest.comparePositionTo(targetRole) <= 0) {
      throw new errors.PermissionError(`**${targetRole.name}** is at or above your highest role.`);
    }

    const has = target.roles.cache.has(targetRole.id);
    const action = interaction.options.getString('action') ?? (has ? 'remove' : 'add');
    const reason = validators.clean(interaction.options.getString('reason') ?? '', { max: 400 });
    const audit = `${reason || 'No reason provided'} — by ${member.user.tag}`;

    if (action === 'add' && has) throw new errors.ConflictError('That member already has this role.');
    if (action === 'remove' && !has) throw new errors.ConflictError('That member does not have this role.');

    if (action === 'add') await target.roles.add(targetRole, audit);
    else await target.roles.remove(targetRole, audit);

    await logService.record(interaction.guild, {
      category: 'moderation',
      event: 'moderation.role',
      title: `${EMOJIS.users} Role ${action === 'add' ? 'Granted' : 'Removed'}`,
      summary: `${targetRole.name} ${action === 'add' ? 'granted to' : 'removed from'} ${target.user.tag}`,
      actorId: member.id,
      actorName: member.user.tag,
      targetId: target.id,
      targetName: target.user.tag,
      fields: { Role: `<@&${targetRole.id}>`, Reason: truncate(reason || 'No reason provided', 500) },
    }, config);

    return safeReply(interaction, {
      embeds: [embeds.success({
        config,
        title: action === 'add' ? 'Role Granted' : 'Role Removed',
        description: `<@&${targetRole.id}> has been ${action === 'add' ? 'granted to' : 'removed from'} <@${target.id}>.`,
      })],
    }, { ephemeral: true });
  },
});

module.exports = [purge, slowmode, lock, unlock, nickname, role];
