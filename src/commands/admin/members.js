'use strict';

/**
 * /members — bulk role operations across the existing membership.
 *
 * The verification gate only fires on join, which means everybody who was
 * already in the server when it was switched on holds no role and sees nothing.
 * This is the backfill for that, and the undo for it.
 */

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const logService = require('../../services/logService');
const embeds = require('../../utils/embeds');
const errors = require('../../utils/errors');
const { User } = require('../../database/models');
const { EMOJIS } = require('../../config/branding');
const { safeReply, safeDefer, attempt } = require('../../utils/discord');
const { number, plural } = require('../../utils/formatters');
const { logger } = require('../../utils/logger');

const log = logger.child('members');

/** Edit the progress reply no more often than this, to stay clear of rate limits. */
const PROGRESS_EVERY = 25;

/**
 * Refuse to hand out a role that would escalate privilege in bulk.
 * Granting Administrator to every member is never what someone meant.
 */
const DANGEROUS = [
  PermissionFlagsBits.Administrator,
  PermissionFlagsBits.ManageGuild,
  PermissionFlagsBits.ManageRoles,
  PermissionFlagsBits.ManageChannels,
  PermissionFlagsBits.ManageWebhooks,
  PermissionFlagsBits.BanMembers,
  PermissionFlagsBits.KickMembers,
  PermissionFlagsBits.MentionEveryone,
];

/**
 * Validate that the bot can actually assign this role, and that assigning it in
 * bulk is sane.
 * @param {import('discord.js').Role} role
 */
function assertAssignable(role) {
  if (role.managed) {
    throw new errors.ValidationError(
      `**${role.name}** is managed by an integration or a bot. Discord does not allow anyone to assign it manually.`,
    );
  }
  if (role.id === role.guild.id) {
    throw new errors.ValidationError('`@everyone` is already held by everyone — there is nothing to grant.');
  }
  if (!role.editable) {
    throw new errors.DiscordLimitationError(
      `I cannot assign **${role.name}** — it sits at or above my highest role. `
      + 'Move my role above it in Server Settings → Roles and try again.',
    );
  }

  const dangerous = DANGEROUS.filter((flag) => role.permissions.has(flag));
  if (dangerous.length) {
    throw new errors.PermissionError(
      `**${role.name}** carries moderator-level permissions. I will not hand that to the whole server in one command. `
      + 'Assign it by hand, or strip the permissions from the role first.',
    );
  }
}

module.exports = {
  access: 'admin',
  cooldown: 60,
  requiresSetup: false,
  botPermissions: ['ManageRoles'],

  data: new SlashCommandBuilder()
    .setName('members')
    .setDescription('Bulk role operations across everyone already in the server.')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
    .setDMPermission(false)
    .addSubcommand((sub) => sub
      .setName('grant-all')
      .setDescription('Give a role to every member who does not already have it.')
      .addRoleOption((option) => option
        .setName('role')
        .setDescription('The role to grant. Defaults to the configured Verified role.'))
      .addBooleanOption((option) => option
        .setName('include-bots')
        .setDescription('Also give it to bots. Off by default.')))
    .addSubcommand((sub) => sub
      .setName('remove-all')
      .setDescription('Take a role away from everyone who has it. The undo for grant-all.')
      .addRoleOption((option) => option
        .setName('role')
        .setDescription('The role to remove.')
        .setRequired(true)))
    .addSubcommand((sub) => sub
      .setName('count')
      .setDescription('How many members hold a role, without changing anything.')
      .addRoleOption((option) => option
        .setName('role')
        .setDescription('The role to count.')
        .setRequired(true))),

  /**
   * @param {import('discord.js').ChatInputCommandInteraction} interaction
   * @param {{ config: object, member: import('discord.js').GuildMember }} context
   */
  async execute(interaction, { config, member }) {
    await safeDefer(interaction, { ephemeral: true });

    const sub = interaction.options.getSubcommand();
    const guild = interaction.guild;

    // A role option is optional on grant-all, where the Verified role is the
    // obvious default — it is the whole reason this command exists.
    const chosen = interaction.options.getRole('role');
    const fallbackId = config.verify?.roleId || config.roles?.verified;
    const role = chosen ?? (fallbackId ? guild.roles.cache.get(fallbackId) : null);

    if (!role) {
      throw new errors.ConfigurationError(
        'No role given, and no Verified role is configured. Pass a `role`, or run `/setup` first.',
      );
    }

    // The full member list is required for all three subcommands, and the cache
    // is not trustworthy for this — a guild only caches members it has seen.
    const members = await attempt(() => guild.members.fetch(), { label: 'fetch members' });
    if (!members) {
      throw new errors.DiscordLimitationError(
        'I could not fetch the member list. Check that **Server Members Intent** is enabled for the bot '
        + 'in the Discord Developer Portal → Bot → Privileged Gateway Intents.',
      );
    }

    if (sub === 'count') {
      const holders = members.filter((entry) => entry.roles.cache.has(role.id));
      const humans = holders.filter((entry) => !entry.user.bot).size;

      return safeReply(interaction, {
        embeds: [embeds.info({
          config,
          title: `${EMOJIS.users} ${role.name}`,
          description:
            `**${number(holders.size)}** of **${number(members.size)}** members hold this role.\n`
            + `${EMOJIS.bullet} ${number(humans)} people\n`
            + `${EMOJIS.bullet} ${number(holders.size - humans)} bots\n`
            + `${EMOJIS.bullet} ${number(members.size - holders.size)} without it`,
        })],
      }, { ephemeral: true });
    }

    const granting = sub === 'grant-all';
    if (granting) assertAssignable(role);
    else if (!role.editable) {
      throw new errors.DiscordLimitationError(
        `I cannot remove **${role.name}** — it sits at or above my highest role.`,
      );
    }

    const includeBots = interaction.options.getBoolean('include-bots') ?? false;

    const targets = [...members.values()].filter((entry) => {
      if (!includeBots && entry.user.bot) return false;
      const has = entry.roles.cache.has(role.id);
      return granting ? !has : has;
    });

    if (!targets.length) {
      return safeReply(interaction, {
        embeds: [embeds.info({
          config,
          title: 'Nothing to do',
          description: granting
            ? `Everyone already has **${role.name}**.`
            : `Nobody has **${role.name}**.`,
        })],
      }, { ephemeral: true });
    }

    const reason = `Bulk ${granting ? 'grant' : 'removal'} by ${member.user.tag}`;
    let done = 0;
    const failed = [];

    for (const target of targets) {
      const action = granting
        ? () => target.roles.add(role, reason)
        : () => target.roles.remove(role, reason);

      // eslint-disable-next-line no-await-in-loop -- one call per member; discord.js
      // queues these against the shared rate limit bucket, and firing them all at
      // once only buys a longer queue plus a worse failure mode.
      const ok = await attempt(action, { label: `${granting ? 'grant' : 'remove'} ${role.name}` });

      if (ok) done += 1;
      else failed.push(target.user.tag);

      if (done % PROGRESS_EVERY === 0) {
        // eslint-disable-next-line no-await-in-loop
        await attempt(() => interaction.editReply({
          embeds: [embeds.info({
            config,
            title: `${EMOJIS.loading} Working…`,
            description: `**${number(done)} / ${number(targets.length)}** members updated.`,
          })],
        }), { label: 'progress update' });
      }
    }

    // Keep the database in step when the role we just handed out is the one
    // verification grants, so the verify button does not offer it again and the
    // referral surfaces read correctly.
    let recorded = 0;
    if (granting && role.id === fallbackId) {
      const now = new Date();
      const operations = targets.map((target) => ({
        updateOne: {
          filter: { guildId: guild.id, userId: target.id },
          update: {
            $set: { verified: true, verifiedAt: now },
            $setOnInsert: { guildId: guild.id, userId: target.id, firstJoinedAt: target.joinedAt ?? now },
          },
          upsert: true,
        },
      }));

      const written = await User.bulkWrite(operations, { ordered: false }).catch((err) => {
        log.warn('Could not record bulk verification', { message: err.message });
        return null;
      });
      recorded = (written?.upsertedCount ?? 0) + (written?.modifiedCount ?? 0);
    }

    await logService.record(guild, {
      category: 'member',
      event: granting ? 'member.bulkGrant' : 'member.bulkRemove',
      title: `${EMOJIS.users} Bulk Role ${granting ? 'Grant' : 'Removal'}`,
      summary: `${role.name} ${granting ? 'granted to' : 'removed from'} ${plural(done, 'member')}`,
      actorId: member.id,
      actorName: member.user.tag,
      severity: 'info',
      fields: {
        Role: role.name,
        Updated: String(done),
        Failed: String(failed.length),
        Bots: includeBots ? 'included' : 'excluded',
      },
    }, config);

    log.info(`Bulk role ${granting ? 'grant' : 'removal'}`, {
      guildId: guild.id, role: role.id, done, failed: failed.length,
    });

    return safeReply(interaction, {
      embeds: [embeds.success({
        config,
        title: granting ? 'Role Granted' : 'Role Removed',
        description:
          `**${role.name}** ${granting ? 'given to' : 'taken from'} **${number(done)}** `
          + `of ${number(targets.length)} member${targets.length === 1 ? '' : 's'}.`,
        fields: [
          ...(recorded ? [{ name: 'Marked verified', value: `${number(recorded)} member records updated.` }] : []),
          ...(failed.length
            ? [{
              name: `Could not update ${plural(failed.length, 'member')}`,
              value:
                `${failed.slice(0, 10).map((tag) => `${EMOJIS.bullet} ${tag}`).join('\n')}`
                + `${failed.length > 10 ? `\n_…and ${failed.length - 10} more_` : ''}`
                + '\n\nUsually this means their highest role sits above mine.',
            }]
            : []),
        ],
      })],
    }, { ephemeral: true });
  },
};
