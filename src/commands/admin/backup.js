'use strict';

/**
 * /backup — structure snapshots and restoration.
 *
 * The command is explicit about what a snapshot can and cannot bring back;
 * pretending otherwise would be the most dangerous kind of feature.
 */

const { SlashCommandBuilder, PermissionFlagsBits, ComponentType } = require('discord.js');

const backupService = require('../../services/backupService');
const embeds = require('../../utils/embeds');
const components = require('../../utils/components');
const customId = require('../../utils/customId');
const permissions = require('../../utils/permissions');
const errors = require('../../utils/errors');
const { EMOJIS, COLORS } = require('../../config/branding');
const { safeReply, safeDefer } = require('../../utils/discord');
const { timestamp, bytes, table } = require('../../utils/formatters');

module.exports = {
  access: 'admin',
  cooldown: 30,
  botPermissions: ['ManageChannels', 'ManageRoles'],

  data: new SlashCommandBuilder()
    .setName('backup')
    .setDescription('Create, list and restore server structure snapshots.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((sub) => sub
      .setName('create')
      .setDescription('Take a snapshot of the current roles, channels and permissions.')
      .addStringOption((option) => option.setName('label').setDescription('A note to help you identify this snapshot later.')))
    .addSubcommand((sub) => sub
      .setName('list')
      .setDescription('List available snapshots.'))
    .addSubcommand((sub) => sub
      .setName('restore')
      .setDescription('Rebuild the server structure from a snapshot.')
      .addStringOption((option) => option.setName('code').setDescription('Snapshot code, e.g. A1B2C3').setRequired(true))
      .addBooleanOption((option) => option.setName('wipe').setDescription('Delete the current channels first (default: false).')))
    .addSubcommand((sub) => sub
      .setName('delete')
      .setDescription('Delete a snapshot.')
      .addStringOption((option) => option.setName('code').setDescription('Snapshot code.').setRequired(true)))
    .addSubcommand((sub) => sub
      .setName('limitations')
      .setDescription('Explain exactly what a backup can and cannot restore.')),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ config: object }} context
   */
  async execute(interaction, { config }) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;

    if (sub === 'limitations') {
      return safeReply(interaction, {
        embeds: [embeds.info({
          config,
          title: `${EMOJIS.info} What a backup can and cannot do`,
          description:
            'A snapshot captures **structure**, not **content**. That distinction matters, so here it is in full.',
          fields: [
            {
              name: `${EMOJIS.success} Restored`,
              value:
                `${EMOJIS.bullet} Roles: name, colour, hoist, mentionable, permissions\n` +
                `${EMOJIS.bullet} Categories and channels: name, type, topic, slowmode, NSFW flag, order\n` +
                `${EMOJIS.bullet} Permission overwrites on every channel and category\n` +
                `${EMOJIS.bullet} The bot's own configuration, re-pointed at the new IDs`,
            },
            {
              name: `${EMOJIS.error} Not restorable — by any bot`,
              value: backupService.UNRESTORABLE.map((item) => `${EMOJIS.bullet} ${item}`).join('\n'),
            },
            {
              name: 'Why',
              value:
                'Discord provides no API for writing message history, and the audit log does not record ' +
                'role membership. Recreated channels and roles are new objects with new IDs.',
            },
          ],
        })],
      }, { ephemeral: true });
    }

    if (sub === 'create') {
      await safeDefer(interaction, { ephemeral: true });
      const backup = await backupService.create(guild, {
        trigger: 'manual',
        createdBy: interaction.user.id,
        createdByName: interaction.user.tag,
        label: interaction.options.getString('label') ?? '',
      });

      return safeReply(interaction, {
        embeds: [embeds.success({
          config,
          title: 'Backup Created',
          description: `Snapshot \`${backup.code}\` has been saved.`,
          fields: [
            { name: 'Roles', value: String(backup.summary.roles), inline: true },
            { name: 'Categories', value: String(backup.summary.categories), inline: true },
            { name: 'Channels', value: String(backup.summary.textChannels + backup.summary.voiceChannels), inline: true },
            { name: 'Overwrites', value: String(backup.summary.overwrites), inline: true },
            { name: 'Size', value: bytes(backup.sizeBytes), inline: true },
            { name: 'Restore with', value: `\`/backup restore code:${backup.code}\`` },
          ],
          footer: 'Structure only — see /backup limitations',
        })],
      }, { ephemeral: true });
    }

    if (sub === 'list') {
      const backups = await backupService.list(guild.id, 15);
      if (!backups.length) {
        return safeReply(interaction, {
          embeds: [embeds.notice('No backups exist yet. Create one with `/backup create`.', 'info', config)],
        }, { ephemeral: true });
      }

      const rows = backups.map((backup) => [
        backup.code,
        backup.trigger,
        `${backup.summary.roles}r/${backup.summary.textChannels + backup.summary.voiceChannels}c`,
        new Date(backup.createdAt).toISOString().slice(0, 10),
      ]);

      return safeReply(interaction, {
        embeds: [embeds.info({
          config,
          title: `${EMOJIS.logs} Backups`,
          description: table(['Code', 'Trigger', 'Contents', 'Date'], rows),
          fields: backups.slice(0, 5).map((backup) => ({
            name: `\`${backup.code}\`${backup.label ? ` · ${backup.label}` : ''}`,
            value: `${timestamp(backup.createdAt, 'relative')}${backup.createdByName ? ` · by ${backup.createdByName}` : ''}${backup.restoredAt ? ` · restored ${timestamp(backup.restoredAt, 'relative')}` : ''}`,
          })),
          footer: `${backups.length} snapshot(s) retained`,
        })],
      }, { ephemeral: true });
    }

    if (sub === 'delete') {
      const code = interaction.options.getString('code');
      const backup = await backupService.remove(guild.id, code);
      return safeReply(interaction, {
        embeds: [embeds.success({ config, title: 'Backup Deleted', description: `Snapshot \`${backup.code}\` has been removed.` })],
      }, { ephemeral: true });
    }

    // ── restore ─────────────────────────────────────────────────────────────
    if (guild.ownerId !== interaction.user.id && !permissions.isBotOwner(interaction.user.id)) {
      throw new errors.PermissionError('Only the server owner can restore a backup.');
    }

    const code = interaction.options.getString('code').toUpperCase();
    const wipe = interaction.options.getBoolean('wipe') ?? false;

    await safeReply(interaction, {
      embeds: [embeds.base({
        config,
        color: COLORS.warning,
        title: `${EMOJIS.warning} Confirm Restore`,
        description:
          `Snapshot \`${code}\` will be applied to this server.\n\n` +
          (wipe
            ? '**Wipe is enabled.** Every existing channel will be deleted first, along with all of its messages.'
            : 'Wipe is disabled — the snapshot is applied alongside the current structure. Channels and roles with matching names are reused.'),
        fields: [
          { name: 'Restored', value: 'Roles, categories, channels and permission overwrites.' },
          { name: 'Not restored', value: backupService.UNRESTORABLE.slice(0, 3).map((item) => `${EMOJIS.bullet} ${item}`).join('\n') },
          { name: 'Safety', value: 'A pre-restore snapshot of the current state is taken automatically.' },
        ],
        footer: 'This confirmation expires in 60 seconds.',
      })],
      components: components.confirmation('backup', 'restore', [code, String(wipe)], { confirmLabel: 'Restore Now' }),
    }, { ephemeral: true });

    const message = await interaction.fetchReply().catch(() => null);
    if (!message) return null;

    let choice;
    try {
      choice = await message.awaitMessageComponent({
        componentType: ComponentType.Button,
        time: 60_000,
        filter: (component) => component.user.id === interaction.user.id,
      });
    } catch {
      return interaction.editReply({
        embeds: [embeds.notice('Restore cancelled — the confirmation timed out.', 'info', config)],
        components: [],
      }).catch(() => null);
    }

    if (customId.parse(choice.customId)?.namespace !== 'backup') {
      return choice.update({
        embeds: [embeds.notice('Restore cancelled. Nothing was changed.', 'info', config)],
        components: [],
      }).catch(() => null);
    }

    await choice.update({
      embeds: [embeds.info({ config, title: `${EMOJIS.loading} Restoring…`, description: 'Rebuilding roles and channels.' })],
      components: [],
    }).catch(() => null);

    const result = await backupService.restore(guild, code, {
      actor: interaction.member,
      wipe,
      onProgress: (text) => {
        interaction.editReply({
          embeds: [embeds.info({ config, title: `${EMOJIS.loading} Restoring…`, description: text })],
        }).catch(() => null);
      },
    });

    return interaction.editReply({
      embeds: [embeds.success({
        config,
        title: 'Restore Complete',
        description: `Snapshot \`${code}\` has been applied.`,
        fields: [
          { name: 'Roles created', value: String(result.created.roles), inline: true },
          { name: 'Categories created', value: String(result.created.categories), inline: true },
          { name: 'Channels created', value: String(result.created.channels), inline: true },
          { name: 'Reused / skipped', value: String(result.created.skipped), inline: true },
          { name: 'Still missing', value: result.unrestorable.slice(0, 3).map((item) => `${EMOJIS.bullet} ${item}`).join('\n') },
        ],
        footer: 'Run /panel refresh to repopulate the public panels.',
      })],
      components: [],
    }).catch(() => null);
  },
};
