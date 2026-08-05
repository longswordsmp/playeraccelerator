#!/usr/bin/env node
'use strict';

/**
 * Command registration CLI.
 *
 *   npm run deploy           register to GUILD_ID (instant)
 *   npm run deploy:global    register globally (up to 1 hour to propagate)
 *   npm run undeploy         remove every registered command
 *
 * Runs without connecting to the gateway or the database, so it is safe to use
 * in CI or a deployment hook.
 */

const { validateEnv } = require('../src/config');
const { StudioClient } = require('../src/core/Client');
const commandHandler = require('../src/handlers/commandHandler');
const { logger } = require('../src/utils/logger');

const log = logger.child('deploy');

async function main() {
  const problems = validateEnv({ requireDatabase: false });
  if (problems.length) {
    log.error('Cannot deploy commands — configuration is incomplete:');
    for (const problem of problems) process.stderr.write(`   • ${problem}\n`);
    process.exit(1);
  }

  const global = process.argv.includes('--global');
  const clear = process.argv.includes('--clear');

  // The client is never logged in; it only holds the command registry.
  const client = new StudioClient();
  const { loaded, failed } = commandHandler.load(client);

  if (failed.length) {
    log.error(`${failed.length} command file(s) failed to load:`);
    for (const failure of failed) process.stderr.write(`   • ${failure.file}: ${failure.error}\n`);
    process.exit(1);
  }

  if (!clear && loaded === 0) {
    log.error('No commands were found to register.');
    process.exit(1);
  }

  try {
    await commandHandler.deploy(client, { global, clear });
    if (global && !clear) {
      log.warn('Global commands can take up to an hour to appear. Set GUILD_ID for instant registration during development.');
    }
    process.exit(0);
  } catch (err) {
    log.error(`Registration failed: ${err.message}`);
    if (err.code === 50001) log.error('The application lacks the applications.commands scope in that guild. Re-invite the bot with it.');
    if (err.status === 401) log.error('Discord rejected the token. Check BOT_TOKEN.');
    process.exit(1);
  }
}

main();
