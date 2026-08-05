'use strict';

/**
 * Slash command loading, registration and execution.
 *
 * Command modules export:
 *   {
 *     data:        SlashCommandBuilder,
 *     access:      'everyone' | 'customer' | 'support' | … (default 'everyone'),
 *     cooldown:    seconds (default from guild config),
 *     guildOnly:   boolean (default true),
 *     requiresSetup: boolean (default false),
 *     botPermissions: ['ManageChannels', …],
 *     autocomplete?: async (interaction, context) => void,
 *     execute:     async (interaction, context) => void,
 *   }
 *
 * `context` gives every command the same pre-resolved dependencies:
 *   { client, config, member, guild, t /* helpers *\/ }
 */

const fs = require('node:fs');
const path = require('node:path');
const { REST, Routes, MessageFlags } = require('discord.js');

const { env } = require('../config/env');
const configService = require('../services/configService');
const logService = require('../services/logService');
const embeds = require('../utils/embeds');
const errors = require('../utils/errors');
const permissions = require('../utils/permissions');
const { safeReply, attempt } = require('../utils/discord');
const { duration } = require('../utils/formatters');
const { logger } = require('../utils/logger');
const { GuildStats, StaffStats } = require('../database/models');

const log = logger.child('commands');

/**
 * Recursively collect `.js` files under a directory.
 * @param {string} dir
 * @returns {string[]}
 */
function walk(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else if (entry.isFile() && entry.name.endsWith('.js') && !entry.name.startsWith('_')) out.push(full);
  }
  return out;
}

/**
 * Load every command module into the client registry.
 * @param {import('../core/Client').StudioClient} client
 * @returns {{ loaded: number, failed: Array<{file: string, error: string}> }}
 */
function load(client) {
  const dir = path.join(__dirname, '..', 'commands');
  const files = walk(dir);
  const failed = [];
  let loaded = 0;

  for (const file of files) {
    try {
      // Clear the require cache so a hot reload picks up edits.
      delete require.cache[require.resolve(file)];
      const exported = require(file);
      // A module may export one command or an array of related commands.
      const commands = Array.isArray(exported) ? exported : [exported];
      const category = path.basename(path.dirname(file));

      for (const command of commands) {
        if (!command?.data?.name || typeof command.execute !== 'function') {
          failed.push({ file: path.relative(dir, file), error: 'missing `data` or `execute`' });
          continue;
        }

        const definition = {
          category,
          access: command.access ?? 'everyone',
          cooldown: command.cooldown ?? null,
          guildOnly: command.guildOnly !== false,
          requiresSetup: command.requiresSetup === true,
          botPermissions: command.botPermissions ?? [],
          ...command,
        };

        if (command.data.type && command.data.type !== 1) client.contextMenus.set(command.data.name, definition);
        else client.commands.set(command.data.name, definition);
        loaded += 1;
      }
    } catch (err) {
      failed.push({ file: path.relative(dir, file), error: err.message });
      log.error(`Failed to load command ${path.relative(dir, file)}`, { message: err.message });
    }
  }

  log.success(`Loaded ${loaded} commands${failed.length ? ` (${failed.length} failed)` : ''}`);
  return { loaded, failed };
}

/**
 * Publish the command set to Discord.
 *
 * Guild registration is instant and is used when `GUILD_ID` is present; global
 * registration can take up to an hour to propagate, which is why it is opt-in.
 *
 * @param {import('../core/Client').StudioClient} client
 * @param {{ global?: boolean, clear?: boolean }} [options]
 */
async function deploy(client, { global = false, clear = false } = {}) {
  const rest = new REST({ version: '10' }).setToken(env.token);
  const body = clear
    ? []
    : [...client.commands.values(), ...client.contextMenus.values()].map((command) => command.data.toJSON());

  const useGuild = !global && env.guildId;
  const route = useGuild
    ? Routes.applicationGuildCommands(env.clientId, env.guildId)
    : Routes.applicationCommands(env.clientId);

  const result = await rest.put(route, { body });
  const scope = useGuild ? `guild ${env.guildId}` : 'globally';
  if (clear) log.success(`Cleared all application commands ${scope}.`);
  else log.success(`Registered ${result.length} commands ${scope}.`);
  return result;
}

/**
 * Build the shared execution context handed to every command.
 * @param {import('discord.js').Interaction} interaction
 */
async function buildContext(interaction) {
  const config = interaction.guild ? await configService.get(interaction.guild) : null;
  return {
    client: interaction.client,
    guild: interaction.guild,
    member: interaction.member,
    user: interaction.user,
    config,
    /** Convenience: build an embed already themed for this guild. */
    embed: (options) => embeds.base({ ...options, config }),
  };
}

/**
 * Run every gate a command must pass before its body executes.
 * Throws an `AppError` subclass on failure — the caller renders it.
 *
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 * @param {object} command
 * @param {object} context
 */
async function authorize(interaction, command, context) {
  if (command.guildOnly && !interaction.guild) {
    throw new errors.AppError('This command can only be used inside a server.');
  }

  if (command.requiresSetup && !configService.isConfigured(context.config)) {
    throw new errors.ConfigurationError(
      'This server has not been set up yet. An administrator needs to run `/setup` first.',
    );
  }

  // Access level.
  if (command.access && command.access !== 'everyone') {
    permissions.assertLevel(context.member, command.access, context.config, `use \`/${command.data.name}\``);
  }

  // Owner-only commands additionally require an environment-configured owner.
  if (command.ownerOnly && !permissions.isBotOwner(interaction.user.id)) {
    throw new errors.PermissionError('This command is restricted to the bot owner.');
  }

  // The bot's own Discord permissions.
  if (command.botPermissions?.length && interaction.guild) {
    const { ok, missing } = permissions.botHasPermissions(interaction.guild, command.botPermissions);
    if (!ok) {
      throw new errors.PermissionError(
        `I am missing the permissions required for this command: ${permissions.humanizePermissions(missing)}.`,
      );
    }
  }

  // Cooldown.
  const seconds = command.cooldown ?? context.config?.security?.defaultCooldown ?? 3;
  if (seconds > 0 && !permissions.isBotOwner(interaction.user.id)) {
    const remaining = interaction.client.cooldowns.check(command.data.name, interaction.user.id, seconds);
    if (remaining > 0) {
      throw new errors.RateLimitError(`Please wait **${duration(remaining, { compact: true })}** before using \`/${command.data.name}\` again.`);
    }
  }
}

/**
 * Execute a slash command with full authorisation, error handling and logging.
 * @param {import('discord.js').ChatInputCommandInteraction} interaction
 */
async function execute(interaction) {
  const command = interaction.client.commands.get(interaction.commandName)
    ?? interaction.client.contextMenus.get(interaction.commandName);

  if (!command) {
    return safeReply(interaction, {
      embeds: [embeds.notice('That command is no longer available. It may have been removed or renamed.', 'warning')],
    }, { ephemeral: true });
  }

  const startedAt = Date.now();
  let context;

  try {
    context = await buildContext(interaction);
    await authorize(interaction, command, context);
  } catch (err) {
    // Failed gates release the cooldown so a rejected attempt is not punished.
    interaction.client.cooldowns.clear(command.data.name, interaction.user.id);
    const described = errors.describe(err);
    if (described.internal) {
      interaction.client.metrics.errors += 1;
      await logService.error(interaction.guild, err, {
        context: `authorize /${interaction.commandName}`,
        reference: described.reference,
        userId: interaction.user.id,
      });
    }
    return safeReply(interaction, {
      embeds: [embeds.notice(described.message, described.internal ? 'error' : 'warning', context?.config)],
    }, { ephemeral: true });
  }

  try {
    await command.execute(interaction, context);
    interaction.client.metrics.commandsExecuted += 1;

    if (interaction.guild) {
      await GuildStats.bump(interaction.guild.id, { 'activity.commands': 1 });
      // Track staff command usage for the performance dashboard.
      if (permissions.isStaff(interaction.member, context.config)) {
        await StaffStats.bump(interaction.guild.id, { 'activity.commandsUsed': 1 }, interaction.user.username);
      }
      if (context.config?.logging?.events?.commandUsage) {
        await logService.record(interaction.guild, {
          category: 'command',
          event: 'command.used',
          title: `Command · /${interaction.commandName}`,
          actorId: interaction.user.id,
          actorName: interaction.user.tag,
          channelId: interaction.channelId,
          severity: 'debug',
          fields: {
            Command: `\`${formatInvocation(interaction)}\``,
            Duration: `${Date.now() - startedAt}ms`,
          },
        }, context.config);
      }
    }
  } catch (err) {
    interaction.client.metrics.errors += 1;
    const described = errors.describe(err);

    if (described.internal) {
      await logService.error(interaction.guild, err, {
        context: `/${interaction.commandName}`,
        reference: described.reference,
        userId: interaction.user.id,
      });
    } else {
      log.debug(`/${interaction.commandName} rejected: ${described.message}`);
    }

    const embed = described.internal
      ? embeds.error({
        config: context?.config,
        title: 'Something went wrong',
        description: `${described.message}\n\nReference: \`${described.reference}\``,
      })
      : embeds.notice(described.message, 'warning', context?.config);

    await safeReply(interaction, { embeds: [embed] }, { ephemeral: true, followUp: interaction.replied });
  }
}

/**
 * Handle an autocomplete request.
 * @param {import('discord.js').AutocompleteInteraction} interaction
 */
async function autocomplete(interaction) {
  const command = interaction.client.commands.get(interaction.commandName);
  if (!command?.autocomplete) return attempt(() => interaction.respond([]), { label: 'empty autocomplete' });

  try {
    const context = await buildContext(interaction);
    await command.autocomplete(interaction, context);
  } catch (err) {
    log.debug(`Autocomplete failed for /${interaction.commandName}`, { message: err.message });
    await attempt(() => interaction.respond([]), { label: 'autocomplete fallback' });
  }
}

/** Reconstruct the full invocation string for the audit log. */
function formatInvocation(interaction) {
  const parts = [`/${interaction.commandName}`];
  const group = interaction.options.getSubcommandGroup(false);
  const sub = interaction.options.getSubcommand(false);
  if (group) parts.push(group);
  if (sub) parts.push(sub);
  for (const option of interaction.options.data) {
    for (const nested of option.options ?? [option]) {
      if (nested.value !== undefined && nested.type !== 1 && nested.type !== 2) {
        parts.push(`${nested.name}:${String(nested.value).slice(0, 40)}`);
      }
    }
  }
  return parts.join(' ').slice(0, 300);
}

module.exports = { load, deploy, execute, autocomplete, buildContext, walk, MessageFlags };
