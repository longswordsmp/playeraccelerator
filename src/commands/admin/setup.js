'use strict';

/**
 * /setup — build the entire server from the blueprint.
 *
 * Destructive by design, so it demands: administrator access, a pre-flight
 * check, an explicit confirmation with a plain-English warning, and an
 * automatic backup before anything is deleted.
 */

const { SlashCommandBuilder, PermissionFlagsBits, ComponentType, MessageFlags } = require('discord.js');

const setupService = require('../../services/setupService');
const configService = require('../../services/configService');
const embeds = require('../../utils/embeds');
const components = require('../../utils/components');
const customId = require('../../utils/customId');
const { CATEGORIES, ROLES, VOICE_CHANNELS } = require('../../config/server');
const { EMOJIS, COLORS } = require('../../config/branding');
const { safeReply, safeSend } = require('../../utils/discord');
const { truncate } = require('../../utils/formatters');

const CHANNEL_COUNT = CATEGORIES.reduce((sum, category) => sum + category.channels.length, 0) + VOICE_CHANNELS.length;

module.exports = {
  access: 'admin',
  cooldown: 60,
  botPermissions: ['ManageChannels', 'ManageRoles', 'ManageGuild'],

  data: new SlashCommandBuilder()
    .setName('setup')
    .setDescription('Build or repair the studio server structure.')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .setDMPermission(false)
    .addSubcommand((sub) => sub
      .setName('repair')
      .setDescription('Add anything missing without deleting a thing. Safe on a live server.'))
    .addSubcommand((sub) => sub
      .setName('rebuild')
      .setDescription('DESTRUCTIVE. Delete the existing structure and build it fresh from the blueprint.')
      .addBooleanOption((option) => option
        .setName('wipe')
        .setDescription('Delete existing channels and roles first (default: true).'))
      .addBooleanOption((option) => option
        .setName('delete-roles')
        .setDescription('Also delete unused custom roles (default: true).'))
      .addBooleanOption((option) => option
        .setName('backup')
        .setDescription('Take a structure backup first (default: true, strongly recommended).'))),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ config: object }} context
   */
  async execute(interaction, { config }) {
    const guild = interaction.guild;
    const sub = interaction.options.getSubcommand();

    // ── Repair ──────────────────────────────────────────────────────────────
    // Non-destructive, so it does not need the owner-only gate or the
    // confirmation dialog that guards a rebuild.
    if (sub === 'repair') {
      const blockers = setupService.preflight(guild);
      if (blockers.length) {
        return safeReply(interaction, {
          embeds: [embeds.error({
            config,
            title: 'Repair cannot start',
            description: blockers.map((problem) => `${EMOJIS.bullet} ${problem}`).join('\n\n'),
          })],
        }, { ephemeral: true });
      }

      await safeReply(interaction, {
        embeds: [embeds.info({
          config,
          title: `${EMOJIS.loading} Checking the server…`,
          description: 'Looking for anything the blueprint has that this server does not.',
        })],
      }, { ephemeral: true });

      const progress = new setupService.SetupProgress(interaction, config);
      const result = await setupService.repair(guild, config, progress);
      const updated = await configService.get(guild, { fresh: true });

      // Publish panels only into channels that were just created. An existing
      // channel already has its panel, and publishing again would duplicate it.
      let published = 0;
      if (result.panelTargets.length) {
        await progress.step('Publishing panels for the new channels…', 'pending');
        const panelService = require('../../services/panelService');
        published = await panelService.publishAll(
          guild, updated, result.panelTargets, (message) => progress.warn(message),
        );
      }

      const list = (entries) => (entries.length
        ? entries.slice(0, 20).join(', ') + (entries.length > 20 ? `, and ${entries.length - 20} more` : '')
        : '_none_');

      return interaction.editReply({
        embeds: [embeds.success({
          config: updated,
          title: result.created.length || result.adopted.length ? 'Server Repaired' : 'Nothing missing',
          description: result.created.length || result.adopted.length
            ? `Added **${result.created.length}** and adopted **${result.adopted.length}** existing item`
              + `${result.adopted.length === 1 ? '' : 's'}. `
              + `**${result.existing}** were already correct, and nothing was deleted.`
            : `All **${result.existing}** blueprint roles and channels are already present and wired up.`,
          fields: [
            ...(result.created.length ? [{ name: 'Created', value: truncate(list(result.created), 1024) }] : []),
            ...(result.adopted.length ? [{ name: 'Adopted (already existed, now wired up)', value: truncate(list(result.adopted), 1024) }] : []),
            ...(published ? [{ name: 'Panels', value: `${published} published into the new channels.` }] : []),
            ...(progress.warnings.length
              ? [{ name: 'Warnings', value: truncate([...new Set(progress.warnings)].slice(0, 8).map((w) => `${EMOJIS.bullet} ${w}`).join('\n'), 1024) }]
              : []),
          ],
          footer: 'Nothing was deleted. Existing channels, roles and messages are untouched.',
        })],
        components: [],
      }).catch(() => null);
    }

    // ── Rebuild ─────────────────────────────────────────────────────────────
    // Only the guild owner or a configured bot owner may rebuild a server.
    const permissions = require('../../utils/permissions');
    if (guild.ownerId !== interaction.user.id && !permissions.isBotOwner(interaction.user.id)) {
      return safeReply(interaction, {
        embeds: [embeds.error({
          config,
          title: 'Server owner only',
          description:
            'Because `/setup rebuild` deletes channels and roles, only the **server owner** can run it. ' +
            'If you are only trying to add something that is missing, use `/setup repair` instead — ' +
            'it deletes nothing and anyone with admin can run it.',
        })],
      }, { ephemeral: true });
    }

    // ── Pre-flight ──────────────────────────────────────────────────────────
    const problems = setupService.preflight(guild);
    if (problems.length) {
      return safeReply(interaction, {
        embeds: [embeds.error({
          config,
          title: 'Setup cannot start',
          description: problems.map((problem) => `${EMOJIS.bullet} ${problem}`).join('\n\n'),
          footer: 'Fix these and run /setup again.',
        })],
      }, { ephemeral: true });
    }

    const options = {
      wipe: interaction.options.getBoolean('wipe') ?? true,
      deleteRoles: interaction.options.getBoolean('delete-roles') ?? true,
      backup: interaction.options.getBoolean('backup') ?? true,
    };

    const existingChannels = guild.channels.cache.size;
    const existingRoles = guild.roles.cache.filter((role) => !role.managed && role.id !== guild.id).size;

    // ── Confirmation ────────────────────────────────────────────────────────
    const confirmation = await safeReply(interaction, {
      embeds: [embeds.base({
        config,
        color: COLORS.warning,
        title: `${EMOJIS.warning} Confirm Server Rebuild`,
        description:
          options.wipe
            ? '**This will delete the existing server structure.** Read this carefully before continuing.'
            : 'The blueprint will be added alongside the existing structure.',
        fields: [
          {
            name: 'What will be removed',
            value: options.wipe
              ? `${EMOJIS.bullet} **${existingChannels}** channels and categories\n` +
                (options.deleteRoles ? `${EMOJIS.bullet} **${existingRoles}** custom roles\n` : '') +
                `${EMOJIS.bullet} All message history in those channels — **permanently, with no way to recover it**`
              : 'Nothing — wipe is disabled.',
          },
          {
            name: 'What will be created',
            value:
              `${EMOJIS.bullet} **${CATEGORIES.length}** categories · **${CHANNEL_COUNT}** channels\n` +
              `${EMOJIS.bullet} **${ROLES.length}** roles with a full permission hierarchy\n` +
              `${EMOJIS.bullet} Ticket, review, portfolio, status, queue and statistics panels\n` +
              `${EMOJIS.bullet} Seven logging destinations, wired automatically`,
          },
          {
            name: 'Protected from deletion',
            value:
              `${EMOJIS.bullet} \`@everyone\`, and any role above my own\n` +
              `${EMOJIS.bullet} Bot and integration roles (Discord does not allow deleting them)\n` +
              `${EMOJIS.bullet} Roles that grant Administrator to real members\n` +
              `${EMOJIS.bullet} Community system channels (rules, updates)`,
          },
          ...(options.backup
            ? [{ name: 'Backup', value: `${EMOJIS.success} A structure snapshot will be taken first. It restores channels, roles and permissions — **not messages**.` }]
            : [{ name: 'Backup', value: `${EMOJIS.warning} **Backup disabled.** Nothing will be recoverable.` }]),
        ],
        footer: 'This confirmation expires in 60 seconds.',
      })],
      components: components.confirmation('setup', 'confirm', [], { confirmLabel: 'Rebuild Server', danger: true }),
    }, { ephemeral: true });

    if (!confirmation) return null;

    // ── Await the button ────────────────────────────────────────────────────
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
        embeds: [embeds.notice('Setup cancelled — the confirmation timed out.', 'info', config)],
        components: [],
      }).catch(() => null);
    }

    const parsed = customId.parse(choice.customId);
    if (parsed?.namespace !== 'setup') {
      return choice.update({
        embeds: [embeds.notice('Setup cancelled. Nothing was changed.', 'info', config)],
        components: [],
      }).catch(() => null);
    }

    await choice.update({
      embeds: [embeds.info({ config, title: `${EMOJIS.loading} Starting…`, description: 'Preparing the rebuild.' })],
      components: [],
    }).catch(() => null);

    // ── Run ─────────────────────────────────────────────────────────────────
    const summary = await setupService.run({ interaction, guild, config, options });
    const fresh = await configService.get(guild, { fresh: true });

    // ── Report ──────────────────────────────────────────────────────────────
    const report = embeds.success({
      config: fresh,
      title: 'Server is ready',
      description:
        `Your studio server was rebuilt in **${summary.elapsed} seconds**.\n\n` +
        'Everything is wired up: tickets create channels automatically, reviews publish themselves, ' +
        'and the status, queue and statistics panels refresh on their own.',
      fields: [
        {
          name: 'Created',
          value:
            `${EMOJIS.bullet} ${summary.categories} categories\n` +
            `${EMOJIS.bullet} ${summary.channels} channels\n` +
            `${EMOJIS.bullet} ${summary.roles} roles\n` +
            `${EMOJIS.bullet} ${summary.panels} panels`,
          inline: true,
        },
        {
          name: 'Removed',
          value:
            `${EMOJIS.bullet} ${summary.teardown.deletedChannels} channels\n` +
            `${EMOJIS.bullet} ${summary.teardown.deletedRoles} roles\n` +
            `${EMOJIS.bullet} ${summary.teardown.skippedRoles} roles preserved`,
          inline: true,
        },
        {
          name: 'Next steps',
          value:
            `${EMOJIS.arrow} \`/config business\` — set your timezone and office hours\n` +
            `${EMOJIS.arrow} \`/config brand\` — set your studio name and logo\n` +
            `${EMOJIS.arrow} \`/status\` — set your availability\n` +
            `${EMOJIS.arrow} Assign your team the staff roles that were just created`,
        },
        ...(summary.backup ? [{ name: 'Backup', value: `Snapshot \`${summary.backup.code}\` — restore with \`/backup restore\`.` }] : []),
      ],
      footer: summary.warnings.length ? `${summary.warnings.length} warnings — see below` : 'Setup completed cleanly',
    });

    await interaction.editReply({ embeds: [report], components: [] }).catch(() => null);

    // Warnings are the honest part: what Discord would not let us do.
    if (summary.warnings.length) {
      const unique = [...new Set(summary.warnings)].slice(0, 15);
      await interaction.followUp({
        embeds: [embeds.warning({
          config: fresh,
          title: 'Discord API limitations encountered',
          description:
            'The rebuild finished, but some actions were not possible. These are Discord platform ' +
            'restrictions, not failures of the bot:\n\n' +
            unique.map((warning) => `${EMOJIS.bullet} ${truncate(warning, 200)}`).join('\n'),
          footer: summary.warnings.length > 15 ? `…and ${summary.warnings.length - 15} more (see the bot-logs channel)` : undefined,
        })],
        flags: MessageFlags.Ephemeral,
      }).catch(() => null);
    }

    // Point the owner at the new server, then clean up the leftover channel.
    if (summary.orphanChannel) {
      await safeSend(summary.orphanChannel, {
        embeds: [embeds.info({
          config: fresh,
          title: 'Setup complete',
          description:
            'This channel is left over from before the rebuild and is not part of the new structure. ' +
            'You can delete it whenever you are ready.',
        })],
      });
    }

    return null;
  },
};
