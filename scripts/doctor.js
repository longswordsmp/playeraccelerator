#!/usr/bin/env node
'use strict';

/**
 * Pre-flight diagnostics.
 *
 *   npm run doctor
 *
 * Checks the environment, the database, the Discord token and the bot's
 * permissions, and prints an invite URL with exactly the permissions this
 * project needs. Run it before the first start and whenever something breaks.
 */

const { REST, Routes, PermissionsBitField, PermissionFlagsBits } = require('discord.js');

const { env, validateEnv, ensureDirectories } = require('../src/config');
const { REQUIRED_BOT_PERMISSIONS } = require('../src/config/permissions');
const database = require('../src/database/connection');
const { StudioClient } = require('../src/core/Client');
const commandHandler = require('../src/handlers/commandHandler');
const componentHandler = require('../src/handlers/componentHandler');
const eventHandler = require('../src/handlers/eventHandler');

const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';
const DIM = '\x1b[2m';
const RESET = '\x1b[0m';

let failures = 0;
let warnings = 0;

const pass = (message, detail) => process.stdout.write(`  ${GREEN}✓${RESET} ${message}${detail ? ` ${DIM}${detail}${RESET}` : ''}\n`);
const warn = (message, detail) => {
  warnings += 1;
  process.stdout.write(`  ${YELLOW}!${RESET} ${message}${detail ? `\n     ${DIM}${detail}${RESET}` : ''}\n`);
};
const fail = (message, detail) => {
  failures += 1;
  process.stdout.write(`  ${RED}✗${RESET} ${message}${detail ? `\n     ${DIM}${detail}${RESET}` : ''}\n`);
};
const section = (title) => process.stdout.write(`\n${title}\n`);

async function main() {
  process.stdout.write('\n  Player Accelerator — diagnostics\n');

  // ── Environment ───────────────────────────────────────────────────────────
  section('Environment');
  const problems = validateEnv();
  if (problems.length) {
    for (const problem of problems) fail(problem);
  } else {
    pass('Configuration is complete');
  }
  pass(`Node ${process.version}`, process.version < 'v20' ? '(v20+ recommended)' : '');
  if (Number(process.version.slice(1).split('.')[0]) < 20) {
    warn('Node 20 or newer is recommended', 'Older versions lack the fetch and test-runner APIs this project uses.');
  }

  try {
    ensureDirectories();
    pass('Runtime directories are writable', `${env.transcriptDir}, ${env.backupDir}, ${env.logDir}`);
  } catch (err) {
    fail('Runtime directories are not writable', err.message);
  }

  // ── Code ──────────────────────────────────────────────────────────────────
  section('Code');
  const client = new StudioClient();
  const commands = commandHandler.load(client);
  const components = componentHandler.load(client);
  const events = eventHandler.load(client);

  if (commands.failed.length) {
    for (const failure of commands.failed) fail(`Command failed to load: ${failure.file}`, failure.error);
  } else {
    pass(`${commands.loaded} commands loaded`);
  }
  pass(`${components} component handlers loaded`);
  pass(`${events} event listeners loaded`);

  // Serialising every command is exactly what deployment does.
  let serialiseFailures = 0;
  for (const command of client.commands.values()) {
    try {
      command.data.toJSON();
    } catch (err) {
      serialiseFailures += 1;
      fail(`/${command.data.name} does not serialise`, err.message);
    }
  }
  if (!serialiseFailures) pass('Every command serialises for the Discord API');

  // ── Database ──────────────────────────────────────────────────────────────
  section('Database');
  try {
    await database.connect({ retries: 1 });
    const health = database.health();
    pass(`Connected to MongoDB`, `${health.host} · database "${health.database}" · ${health.models} models`);
    await database.syncIndexes();
    pass('Indexes verified');
  } catch (err) {
    fail('Could not connect to MongoDB', err.message);
  }

  // ── Discord ───────────────────────────────────────────────────────────────
  section('Discord');
  if (!env.token) {
    fail('No bot token configured — skipping Discord checks');
  } else {
    const rest = new REST({ version: '10' }).setToken(env.token);
    try {
      const application = await rest.get(Routes.currentApplication());
      pass(`Token is valid`, `application "${application.name}" (${application.id})`);

      if (application.id !== env.clientId) {
        fail('CLIENT_ID does not match the token\'s application', `token belongs to ${application.id}, CLIENT_ID is ${env.clientId}`);
      } else {
        pass('CLIENT_ID matches the token');
      }

      const flags = application.flags ?? 0;
      // GatewayMessageContent = 1 << 18 (limited) / 1 << 19 (enabled)
      // GatewayGuildMembers   = 1 << 14 (limited) / 1 << 15 (enabled)
      const hasMessageContent = Boolean(flags & (1 << 18)) || Boolean(flags & (1 << 19));
      const hasGuildMembers = Boolean(flags & (1 << 14)) || Boolean(flags & (1 << 15));

      if (hasMessageContent) pass('Message Content intent is enabled');
      else fail('Message Content intent is NOT enabled', 'Enable it under Bot → Privileged Gateway Intents. AutoMod content filters cannot work without it.');

      if (hasGuildMembers) pass('Server Members intent is enabled');
      else fail('Server Members intent is NOT enabled', 'Enable it under Bot → Privileged Gateway Intents. Join automation and raid detection need it.');

      if (env.guildId) {
        try {
          const registered = await rest.get(Routes.applicationGuildCommands(env.clientId, env.guildId));
          pass(`${registered.length} commands registered in guild ${env.guildId}`);
          if (registered.length !== commands.loaded) {
            warn(`Registered command count (${registered.length}) differs from loaded (${commands.loaded})`, 'Run `npm run deploy` to synchronise.');
          }
        } catch {
          warn(`Could not read guild ${env.guildId}`, 'The bot may not be in that server, or it lacks the applications.commands scope.');
        }
      } else {
        warn('GUILD_ID is not set', 'Commands will be registered globally, which can take up to an hour to propagate.');
      }
    } catch (err) {
      fail('Discord rejected the token', err.message);
    }
  }

  // ── Invite ────────────────────────────────────────────────────────────────
  section('Invite URL');
  const bits = new PermissionsBitField(
    REQUIRED_BOT_PERMISSIONS.map((permission) => PermissionFlagsBits[permission]).filter(Boolean),
  );
  if (env.clientId) {
    process.stdout.write(
      `  ${DIM}Invite the bot with exactly the permissions it needs:${RESET}\n` +
      `  https://discord.com/oauth2/authorize?client_id=${env.clientId}&permissions=${bits.bitfield}&scope=bot%20applications.commands\n`,
    );
  } else {
    warn('CLIENT_ID is not set, so an invite URL cannot be generated');
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  section('Summary');
  if (failures === 0 && warnings === 0) {
    process.stdout.write(`  ${GREEN}Everything checks out. Start the bot with \`npm start\`.${RESET}\n\n`);
  } else {
    process.stdout.write(`  ${failures ? RED : YELLOW}${failures} failure(s), ${warnings} warning(s).${RESET}\n\n`);
  }

  await database.disconnect().catch(() => null);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  process.stderr.write(`\nDiagnostics crashed: ${err.stack}\n`);
  process.exit(1);
});
