'use strict';

/**
 * /security and /lockdown — the protection control surface.
 */

const { SlashCommandBuilder, PermissionFlagsBits, ComponentType } = require('discord.js');

const configService = require('../../services/configService');
const moderationService = require('../../services/moderationService');
const antiRaid = require('../../security/antiRaid');
const antiNuke = require('../../security/antiNuke');
const autoMod = require('../../security/autoMod');
const embeds = require('../../utils/embeds');
const components = require('../../utils/components');
const customId = require('../../utils/customId');
const validators = require('../../utils/validators');
const errors = require('../../utils/errors');
const permissions = require('../../utils/permissions');
const { REQUIRED_BOT_PERMISSIONS } = require('../../config/permissions');
const { GuildStats } = require('../../database/models');
const { EMOJIS, COLORS } = require('../../config/branding');
const { safeReply, safeDefer } = require('../../utils/discord');
const { keyValueBlock, timestamp, truncate, number, table } = require('../../utils/formatters');

/** Build a command definition. */
function build({ name, description, access, options = [], run, cooldown = 5 }) {
  const data = new SlashCommandBuilder()
    .setName(name)
    .setDescription(description)
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false);
  for (const apply of options) apply(data);
  return { access, cooldown, requiresSetup: false, data, execute: run };
}

// ── /security ────────────────────────────────────────────────────────────────
const security = build({
  name: 'security',
  description: 'Inspect and control the protection systems.',
  access: 'manager',
  options: [
    (data) => data.addSubcommand((sub) => sub
      .setName('status')
      .setDescription('Show the state of every protection system.')),
    (data) => data.addSubcommand((sub) => sub
      .setName('modules')
      .setDescription('List every AutoMod module and its configuration.')),
    (data) => data.addSubcommand((sub) => sub
      .setName('toggle')
      .setDescription('Turn a protection system on or off.')
      .addStringOption((option) => option
        .setName('system')
        .setDescription('Which system.')
        .setRequired(true)
        .addChoices(
          { name: 'AutoMod', value: 'automod' },
          { name: 'Link filter', value: 'links' },
          { name: 'Anti-raid', value: 'antiRaid' },
          { name: 'Anti-nuke', value: 'antiNuke' },
          { name: 'Logging', value: 'logging' },
          { name: 'Moderation', value: 'moderation' },
        ))
      .addBooleanOption((option) => option.setName('enabled').setDescription('On or off.').setRequired(true))),
    (data) => data.addSubcommand((sub) => sub
      .setName('raid')
      .setDescription('Manually engage or lift raid mode.')
      .addStringOption((option) => option
        .setName('mode')
        .setDescription('Engage or lift.')
        .setRequired(true)
        .addChoices({ name: 'Engage raid mode', value: 'on' }, { name: 'Lift raid mode', value: 'off' }))),
    (data) => data.addSubcommand((sub) => sub
      .setName('permissions')
      .setDescription('Check that I have every permission the protection systems need.')),
    (data) => data.addSubcommand((sub) => sub
      .setName('incidents')
      .setDescription('Recent security incidents.')
      .addIntegerOption((option) => option.setName('days').setDescription('Window in days (default 7).').setMinValue(1).setMaxValue(90))),
  ],

  async run(interaction, { config, member }) {
    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;

    switch (sub) {
      case 'status': {
        const raid = antiRaid.status(guild.id);
        const nuke = antiNuke.status(guild.id);
        const enabledModules = Object.values(config.automod?.modules ?? {}).filter((module) => module?.enabled).length;
        const totalModules = Object.keys(config.automod?.modules ?? {}).length;

        return safeReply(interaction, {
          embeds: [embeds.base({
            config,
            color: raid.active || config.lockdown?.active ? COLORS.danger : COLORS.success,
            title: `${EMOJIS.security} Security Status`,
            description: raid.active
              ? `${EMOJIS.warning} **Raid mode is active** — engaged ${timestamp(raid.since, 'relative')}, lifting ${timestamp(raid.until, 'relative')}.`
              : config.lockdown?.active
                ? `${EMOJIS.lock} **The server is locked down.** Lift it with \`/lockdown off\`.`
                : `${EMOJIS.success} All systems normal.`,
            fields: [
              {
                name: 'Systems',
                value: keyValueBlock([
                  ['AutoMod', config.automod?.enabled ? `On (${enabledModules}/${totalModules})` : 'Off'],
                  ['Link filter', config.links?.enabled ? 'On' : 'Off'],
                  ['Anti-raid', config.antiRaid?.enabled ? 'On' : 'Off'],
                  ['Anti-nuke', config.antiNuke?.enabled ? `On (${config.antiNuke.punishment})` : 'Off'],
                  ['Logging', config.logging?.enabled ? 'On' : 'Off'],
                ]),
                inline: true,
              },
              {
                name: 'Live counters',
                value: keyValueBlock([
                  ['Recent joins', String(raid.recentJoins)],
                  ['Recent leaves', String(raid.recentLeaves)],
                  ['Raid mode', raid.active ? 'ACTIVE' : 'inactive'],
                  ['Lockdown', config.lockdown?.active ? 'ACTIVE' : 'inactive'],
                ]),
                inline: true,
              },
              {
                name: 'Raid thresholds',
                value: keyValueBlock([
                  ['Joins', `${config.antiRaid?.joinThreshold ?? 8} / ${config.antiRaid?.joinWindow ?? 10}s`],
                  ['Min age', `${config.antiRaid?.minAccountAgeDays ?? 7} days`],
                  ['Action', config.antiRaid?.newAccountAction ?? 'kick'],
                  ['Auto-lockdown', config.antiRaid?.autoLockdown ? 'yes' : 'no'],
                ]),
                inline: true,
              },
              ...(Object.keys(nuke).length
                ? [{ name: 'Anti-nuke activity (live windows)', value: keyValueBlock(Object.entries(nuke).map(([action, count]) => [action, String(count)])) }]
                : []),
              {
                name: 'Exemptions',
                value:
                  `Staff exempt: **${config.moderation?.exemptStaff !== false ? 'yes' : 'no'}** · ` +
                  `Ignored roles: **${(config.moderation?.ignoredRoles ?? []).length}** · ` +
                  `Ignored channels: **${(config.moderation?.ignoredChannels ?? []).length}** · ` +
                  `Anti-nuke whitelist: **${(config.antiNuke?.whitelist ?? []).length}**`,
              },
            ],
            footer: 'Configure with /config automod, /config antiraid, /config antinuke',
          })],
        }, { ephemeral: true });
      }

      case 'modules': {
        const modules = config.automod?.modules ?? {};
        const rows = autoMod.MODULE_LIST
          .filter((module) => modules[module.key])
          .map((module) => {
            const settings = modules[module.key];
            return [
              truncate(module.label, 22),
              settings.enabled ? 'on' : 'off',
              settings.action ?? '—',
              String(settings.threshold ?? '—'),
            ];
          });

        return safeReply(interaction, {
          embeds: [embeds.info({
            config,
            title: `${EMOJIS.moderation} AutoMod Modules`,
            description: table(['Module', 'State', 'Action', 'Threshold'], rows),
            fields: [
              { name: 'Custom words', value: String((config.automod?.customWords ?? []).length), inline: true },
              { name: 'Custom patterns', value: String((config.automod?.customPatterns ?? []).length), inline: true },
              { name: 'Allow list', value: String((config.automod?.allowedWords ?? []).length), inline: true },
            ],
            footer: 'Change one with /config automod module:<name>',
          })],
        }, { ephemeral: true });
      }

      case 'toggle': {
        const system = interaction.options.getString('system');
        const enabled = interaction.options.getBoolean('enabled');
        await configService.setPaths(guild, { [`${system}.enabled`]: enabled });

        return safeReply(interaction, {
          embeds: [embeds[enabled ? 'success' : 'warning']({
            config,
            title: `${system} ${enabled ? 'Enabled' : 'Disabled'}`,
            description: enabled
              ? `**${system}** is now active.`
              : `**${system}** is now disabled. The server is less protected until it is turned back on.`,
          })],
        }, { ephemeral: true });
      }

      case 'raid': {
        const mode = interaction.options.getString('mode');
        await safeDefer(interaction, { ephemeral: true });

        if (mode === 'on') {
          await antiRaid.engage(guild, config, { trigger: 'manual', count: 0, window: config.antiRaid?.joinWindow ?? 10 });
          return safeReply(interaction, {
            embeds: [embeds.warning({
              config,
              title: 'Raid Mode Engaged',
              description:
                'Slowmode has been applied to public channels and new accounts are being screened.\n\n' +
                `It lifts automatically after **${config.antiRaid?.raidDurationMinutes ?? 10} minutes** of quiet, or immediately with \`/security raid mode:off\`.`,
            })],
          }, { ephemeral: true });
        }

        const lifted = await antiRaid.disengage(guild, config, { id: member.id, tag: member.user.tag });
        return safeReply(interaction, {
          embeds: [lifted
            ? embeds.success({ config, title: 'Raid Mode Lifted', description: 'Slowmode has been restored and screening has stopped.' })
            : embeds.notice('Raid mode was not active.', 'info', config)],
        }, { ephemeral: true });
      }

      case 'permissions': {
        const { ok, missing } = permissions.botHasPermissions(guild, REQUIRED_BOT_PERMISSIONS);
        const me = guild.members.me;
        const position = me.roles.highest.position;
        const above = guild.roles.cache.filter((role) => role.position > position && !role.managed).size;

        return safeReply(interaction, {
          embeds: [embeds[ok && above === 0 ? 'success' : 'warning']({
            config,
            title: `${EMOJIS.security} Permission Audit`,
            description: ok
              ? 'I hold every permission the protection systems require.'
              : 'Some permissions are missing. The features listed below will not work until they are granted.',
            fields: [
              ...(missing.length
                ? [{
                  name: 'Missing permissions',
                  value: permissions.humanizePermissions(missing),
                }]
                : []),
              {
                name: 'Role position',
                value: above === 0
                  ? `${EMOJIS.success} My role is above every non-managed role. I can moderate anyone below the owner.`
                  : `${EMOJIS.warning} **${above}** role(s) sit above mine. I cannot moderate their members, delete those roles, or reorder them — Discord forbids it.`,
              },
              {
                name: 'What each permission unlocks',
                value:
                  `${EMOJIS.bullet} **View Audit Log** — anti-nuke attribution; without it, destructive actions cannot be traced to a user\n` +
                  `${EMOJIS.bullet} **Manage Roles / Channels** — anti-nuke restoration, lockdown, ticket permissions\n` +
                  `${EMOJIS.bullet} **Moderate Members** — timeouts\n` +
                  `${EMOJIS.bullet} **Ban / Kick Members** — escalation and raid response\n` +
                  `${EMOJIS.bullet} **Manage Messages** — AutoMod deletions and \`/purge\``,
              },
            ],
          })],
        }, { ephemeral: true });
      }

      case 'incidents': {
        await safeDefer(interaction, { ephemeral: true });
        const days = interaction.options.getInteger('days') ?? 7;
        const { Log } = require('../../database/models');

        const [entries, stats] = await Promise.all([
          Log.find({
            guildId: guild.id,
            category: 'security',
            createdAt: { $gte: new Date(Date.now() - days * 86_400_000) },
          }).sort({ createdAt: -1 }).limit(15).lean(),
          GuildStats.range(guild.id, days),
        ]);

        const totals = GuildStats.rollup(stats);

        return safeReply(interaction, {
          embeds: [embeds.info({
            config,
            title: `${EMOJIS.security} Security Incidents · last ${days} days`,
            description: entries.length
              ? entries.slice(0, 10).map((entry) => (
                `${EMOJIS.bullet} **${entry.event}** — ${truncate(entry.summary, 120)} · ${timestamp(entry.createdAt, 'relative')}`
              )).join('\n')
              : 'No security incidents recorded in this window.',
            fields: [
              {
                name: 'Totals',
                value: keyValueBlock([
                  ['AutoMod hits', number(totals.automodHits)],
                  ['Blocked links', number(totals.blockedLinks)],
                  ['Raid alerts', number(totals.raidAlerts)],
                  ['Anti-nuke alerts', number(totals.nukeAlerts)],
                ]),
                inline: true,
              },
              {
                name: 'Enforcement',
                value: keyValueBlock([
                  ['Warnings', number(totals.warnings)],
                  ['Timeouts', number(totals.timeouts)],
                  ['Kicks', number(totals.kicks)],
                  ['Bans', number(totals.bans)],
                ]),
                inline: true,
              },
            ],
          })],
        }, { ephemeral: true });
      }

      default:
        throw new errors.ValidationError('Unknown subcommand.');
    }
  },
});

// ── /lockdown ────────────────────────────────────────────────────────────────
const lockdown = build({
  name: 'lockdown',
  description: 'Lock or unlock every public channel at once.',
  access: 'admin',
  cooldown: 15,
  options: [
    (data) => data.addStringOption((option) => option
      .setName('mode')
      .setDescription('Enable or disable the lockdown.')
      .setRequired(true)
      .addChoices(
        { name: 'Enable lockdown', value: 'on' },
        { name: 'Disable lockdown', value: 'off' },
        { name: 'Emergency (lockdown + raid mode)', value: 'emergency' },
      )),
    (data) => data.addStringOption((option) => option.setName('reason').setDescription('Shown publicly in the announcement.')),
    (data) => data.addBooleanOption((option) => option.setName('announce').setDescription('Post a public notice (default: true).')),
  ],

  async run(interaction, { config, member }) {
    const mode = interaction.options.getString('mode');
    const reason = validators.clean(interaction.options.getString('reason') ?? '', { max: 500 });
    const announce = interaction.options.getBoolean('announce') ?? true;
    const guild = interaction.guild;

    if (mode === 'off') {
      await safeDefer(interaction, { ephemeral: true });
      if (!config.lockdown?.active) {
        return safeReply(interaction, {
          embeds: [embeds.notice('The server is not currently locked down.', 'info', config)],
        }, { ephemeral: true });
      }
      const restored = await moderationService.lockdown(guild, false, member, config, '', announce);
      await antiRaid.disengage(guild, config, { id: member.id, tag: member.user.tag }).catch(() => null);

      return safeReply(interaction, {
        embeds: [embeds.success({
          config,
          title: 'Lockdown Lifted',
          description: `**${restored}** channel${restored === 1 ? '' : 's'} restored. Normal messaging has resumed.`,
        })],
      }, { ephemeral: true });
    }

    // Locking the whole server is disruptive — confirm it.
    await safeReply(interaction, {
      embeds: [embeds.warning({
        config,
        title: mode === 'emergency' ? 'Confirm Emergency Lockdown' : 'Confirm Lockdown',
        description:
          'Every public text channel will become read-only for `@everyone`.\n\n' +
          '**Ticket channels are unaffected** — customers can keep talking to you.' +
          (mode === 'emergency' ? '\n\nRaid mode will also engage: slowmode everywhere, and new accounts screened.' : ''),
        fields: reason ? [{ name: 'Public reason', value: truncate(reason, 1024) }] : [],
        footer: 'This confirmation expires in 30 seconds.',
      })],
      components: components.confirmation('confirm', 'lockdown', [], { confirmLabel: mode === 'emergency' ? 'Emergency Lockdown' : 'Lock Server' }),
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
        embeds: [embeds.notice('Lockdown cancelled — the confirmation timed out.', 'info', config)],
        components: [],
      }).catch(() => null);
    }

    if (customId.parse(choice.customId)?.namespace !== 'confirm') {
      return choice.update({
        embeds: [embeds.notice('Lockdown cancelled.', 'info', config)],
        components: [],
      }).catch(() => null);
    }

    await choice.update({
      embeds: [embeds.info({ config, title: `${EMOJIS.loading} Locking channels…`, description: 'This can take a moment on a large server.' })],
      components: [],
    }).catch(() => null);

    const affected = await moderationService.lockdown(guild, true, member, config, reason, announce);
    if (mode === 'emergency') {
      const fresh = await configService.get(guild, { fresh: true });
      await antiRaid.engage(guild, fresh, { trigger: 'manual-emergency', count: 0, window: fresh.antiRaid?.joinWindow ?? 10 });
    }

    return interaction.editReply({
      embeds: [embeds.warning({
        config,
        title: mode === 'emergency' ? 'Emergency Lockdown Active' : 'Lockdown Active',
        description: `**${affected}** channel${affected === 1 ? '' : 's'} locked.`,
        fields: [
          { name: 'Unaffected', value: 'Ticket channels and staff channels remain fully usable.' },
          { name: 'To lift', value: '`/lockdown mode:off`' },
        ],
      })],
      components: [],
    }).catch(() => null);
  },
});

module.exports = [security, lockdown];
