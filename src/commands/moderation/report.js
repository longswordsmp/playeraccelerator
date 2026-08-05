'use strict';

/**
 * /report — member-submitted reports, and /note for staff annotations.
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const configService = require('../../services/configService');
const logService = require('../../services/logService');
const embeds = require('../../utils/embeds');
const componentsUtil = require('../../utils/components');
const customId = require('../../utils/customId');
const validators = require('../../utils/validators');
const errors = require('../../utils/errors');
const { User, Counter, Moderation } = require('../../database/models');
const { EMOJIS, COLORS } = require('../../config/branding');
const { safeReply, safeDefer, safeSend, fetchMember } = require('../../utils/discord');
const { truncate, timestamp } = require('../../utils/formatters');

/** Small builder shared by both commands in this file. */
function build({ name, description, access, options = [], run, defaultPermission, cooldown = 10 }) {
  const data = new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDMPermission(false);
  if (defaultPermission) data.setDefaultMemberPermissions(defaultPermission);
  for (const apply of options) apply(data);
  return { access, cooldown, requiresSetup: false, data, execute: run };
}

// ── /report ──────────────────────────────────────────────────────────────────
const report = build({
  name: 'report',
  description: 'Report a member to the team. Reports are private.',
  access: 'everyone',
  cooldown: 60,
  options: [
    (data) => data.addUserOption((option) => option.setName('user').setDescription('Who you are reporting.').setRequired(true)),
    (data) => data.addStringOption((option) => option.setName('reason').setDescription('What happened.').setRequired(true)),
    (data) => data.addStringOption((option) => option.setName('evidence').setDescription('A message link or screenshot URL.')),
    (data) => data.addStringOption((option) => option.setName('notes').setDescription('Anything else the team should know.')),
  ],
  async run(interaction, { config, member }) {
    const target = interaction.options.getUser('user');

    if (target.id === interaction.user.id) throw new errors.ValidationError('You cannot report yourself.');
    if (target.bot) throw new errors.ValidationError('Bots cannot be reported. Contact the team directly instead.');

    await safeDefer(interaction, { ephemeral: true });

    const reason = validators.text(interaction.options.getString('reason'), 'Reason', { max: 1500, min: 10 });
    const evidence = interaction.options.getString('evidence');
    const notes = validators.clean(interaction.options.getString('notes') ?? '', { max: 1000 });

    const reportChannel = configService.logChannel(interaction.guild, config, 'report')
      ?? configService.logChannel(interaction.guild, config, 'moderation')
      ?? configService.channel(interaction.guild, config, 'staffChat');

    if (!reportChannel) {
      throw new errors.ConfigurationError('No reports channel is configured, so reports cannot be delivered. Ask an administrator to run `/setup`.');
    }

    const targetMember = await fetchMember(interaction.guild, target.id);
    const targetRecord = await User.findOne({ guildId: interaction.guildId, userId: target.id }).lean();

    const staffRole = config.roles?.support ?? config.roles?.manager;
    await safeSend(reportChannel, {
      content: staffRole ? `<@&${staffRole}>` : undefined,
      embeds: [embeds.base({
        config,
        color: COLORS.warning,
        title: `${EMOJIS.moderation} Member Report`,
        description: truncate(reason, 2000),
        thumbnail: target.displayAvatarURL({ size: 128 }),
        fields: [
          { name: 'Reported', value: `<@${target.id}>\n\`${target.id}\``, inline: true },
          { name: 'Reported by', value: `<@${interaction.user.id}>\n\`${interaction.user.id}\``, inline: true },
          { name: 'Channel', value: `<#${interaction.channelId}>`, inline: true },
          ...(evidence ? [{ name: 'Evidence', value: truncate(evidence, 1000) }] : []),
          ...(notes ? [{ name: 'Additional notes', value: truncate(notes, 1000) }] : []),
          {
            name: 'Context',
            value:
              `Joined: ${targetMember?.joinedAt ? timestamp(targetMember.joinedAt, 'relative') : 'not in server'}\n` +
              `Account created: ${timestamp(target.createdAt, 'relative')}\n` +
              `Active warnings: ${targetRecord?.moderation?.activeWarnings ?? 0}`,
          },
        ],
        footer: 'Use /history to see their full record',
      })],
      components: componentsUtil.rows([
        componentsUtil.button({ id: customId.build('report', 'warn', target.id), label: 'Warn', emoji: EMOJIS.warning, style: 'secondary' }),
        componentsUtil.button({ id: customId.build('report', 'timeout', target.id), label: 'Timeout 1h', emoji: '⏳', style: 'secondary' }),
        componentsUtil.button({ id: customId.build('report', 'dismiss', target.id), label: 'Dismiss', emoji: EMOJIS.success, style: 'secondary' }),
      ]),
    });

    await logService.record(interaction.guild, {
      category: 'report',
      event: 'report.submit',
      title: `${EMOJIS.moderation} Report Filed`,
      summary: `${interaction.user.tag} reported ${target.tag}`,
      actorId: interaction.user.id,
      actorName: interaction.user.tag,
      targetId: target.id,
      targetName: target.tag,
      channelId: interaction.channelId,
      severity: 'warn',
      fields: { Reason: truncate(reason, 500) },
    }, config);

    return safeReply(interaction, {
      embeds: [embeds.success({
        config,
        title: 'Report Submitted',
        description:
          'Thank you. The team has been notified and will review this privately.\n\n' +
          'You will not normally receive a follow-up — moderation outcomes are kept confidential.',
      })],
    }, { ephemeral: true });
  },
});

// ── /note ────────────────────────────────────────────────────────────────────
const note = build({
  name: 'note',
  description: 'Attach a private staff note to a member.',
  access: 'support',
  cooldown: 3,
  defaultPermission: PermissionFlagsBits.ManageMessages,
  options: [
    (data) => data.addUserOption((option) => option.setName('user').setDescription('Who the note is about.').setRequired(true)),
    (data) => data.addStringOption((option) => option.setName('content').setDescription('The note.').setRequired(true)),
  ],
  async run(interaction, { config, member }) {
    const target = interaction.options.getUser('user');
    const content = validators.text(interaction.options.getString('content'), 'Note', { max: 1000 });

    const caseId = await Counter.next(interaction.guildId, 'case');
    await Moderation.create({
      guildId: interaction.guildId,
      caseId,
      type: 'note',
      userId: target.id,
      username: target.tag,
      moderatorId: member.id,
      moderatorName: member.user.tag,
      reason: content,
      active: false,
    });

    await User.updateOne(
      { guildId: interaction.guildId, userId: target.id },
      {
        $push: { notes: { content, authorId: member.id, createdAt: new Date() } },
        $setOnInsert: { guildId: interaction.guildId, userId: target.id },
      },
      { upsert: true },
    );

    await logService.record(interaction.guild, {
      category: 'moderation',
      event: 'moderation.note',
      title: `${EMOJIS.note} Staff Note`,
      summary: `Note added about ${target.tag}`,
      actorId: member.id,
      actorName: member.user.tag,
      targetId: target.id,
      targetName: target.tag,
      caseId,
      severity: 'debug',
      fields: { Note: truncate(content, 500) },
    }, config);

    return safeReply(interaction, {
      embeds: [embeds.success({
        config,
        title: 'Note Saved',
        description: `Case \`#${caseId}\` — a private note about <@${target.id}>. Visible with \`/history\`.`,
      })],
    }, { ephemeral: true });
  },
});

module.exports = [report, note];
