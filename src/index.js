'use strict';

/**
 * Application entry point.
 *
 * Boot order matters and is deliberate:
 *   1. validate the environment  — fail loudly before anything else starts
 *   2. connect to MongoDB        — nothing works without persistence
 *   3. load handlers             — commands, events, components
 *   4. log in to Discord         — the gateway is the last thing to open
 *
 * Shutdown reverses it, draining the log queue and closing the database pool so
 * an in-flight ticket write is never lost on a deploy.
 */

const { env, validateEnv, ensureDirectories } = require('./config');
const { logger, Logger } = require('./utils/logger');
const { StudioClient } = require('./core/Client');
const database = require('./database/connection');
const commandHandler = require('./handlers/commandHandler');
const eventHandler = require('./handlers/eventHandler');
const componentHandler = require('./handlers/componentHandler');
const logService = require('./services/logService');
const scheduler = require('./services/schedulerService');
const { BRAND } = require('./config/branding');

const log = logger.child('boot');

/** Print the startup banner. */
function banner() {
  const lines = [
    '',
    '  ╭──────────────────────────────────────────────────────────╮',
    `  │  ${BRAND.name.padEnd(54)}│`,
    `  │  ${BRAND.tagline.padEnd(54)}│`,
    '  ╰──────────────────────────────────────────────────────────╯',
    '',
  ];
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** @type {StudioClient|null} */
let client = null;
let shuttingDown = false;

/** Boot the application. */
async function start() {
  banner();

  // ── 1. Environment ────────────────────────────────────────────────────────
  const problems = validateEnv();
  if (problems.length) {
    log.error('Configuration is incomplete — the bot cannot start:');
    for (const problem of problems) process.stderr.write(`   • ${problem}\n`);
    process.stderr.write('\n  Copy .env.example to .env and fill in the required values.\n\n');
    process.exit(1);
  }
  ensureDirectories();
  log.info(`Environment: ${env.nodeEnv} · Node ${process.version}`);

  // ── 2. Database ───────────────────────────────────────────────────────────
  await database.connect();

  // ── 3. Handlers ───────────────────────────────────────────────────────────
  client = new StudioClient();
  commandHandler.load(client);
  componentHandler.load(client);
  eventHandler.load(client);

  // ── 4. Gateway ────────────────────────────────────────────────────────────
  log.info('Connecting to Discord…');
  await client.login(env.token).catch((err) => {
    if (err.message?.includes('disallowed intents')) {
      log.error(
        'Discord rejected the privileged intents. Enable "Server Members Intent" and ' +
        '"Message Content Intent" under Bot → Privileged Gateway Intents in the Developer Portal.',
      );
    } else if (err.message?.includes('token')) {
      log.error('Discord rejected the bot token. Check BOT_TOKEN in your .env file.');
    } else {
      log.error(`Login failed: ${err.message}`);
    }
    process.exit(1);
  });

  return client;
}

/**
 * Graceful shutdown.
 * @param {string} signal
 * @param {number} [code]
 */
async function shutdown(signal, code = 0) {
  if (shuttingDown) return;
  shuttingDown = true;
  log.warn(`Received ${signal} — shutting down gracefully…`);

  // Give in-flight work a hard deadline so a hung handle cannot block a deploy.
  const deadline = setTimeout(() => {
    log.error('Graceful shutdown timed out after 15s — forcing exit.');
    process.exit(code || 1);
  }, 15_000);
  deadline.unref?.();

  try {
    scheduler.stop();
    client?.clearTimers();
    await logService.drain();
    if (client) {
      client.removeAllListeners();
      await client.destroy();
      log.info('Discord connection closed.');
    }
    await database.disconnect();
    await Logger.close();
  } catch (err) {
    process.stderr.write(`Shutdown error: ${err.message}\n`);
  }

  clearTimeout(deadline);
  process.exit(code);
}

// ── Process-level safety nets ───────────────────────────────────────────────
// A Discord bot must not die because one promise rejected. Everything is logged
// and, where possible, reported to the bot-log channel.

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  log.error(`Unhandled promise rejection: ${err.message}`, { stack: err.stack });
  logService.error(null, err, { context: 'unhandledRejection' }).catch(() => null);
});

process.on('uncaughtException', (err) => {
  log.error(`Uncaught exception: ${err.message}`, { stack: err.stack });
  logService.error(null, err, { context: 'uncaughtException' }).catch(() => null);
  // An uncaught exception leaves the process in an undefined state — restart it.
  // A process manager (pm2, systemd, Docker restart policy) brings it back.
  shutdown('uncaughtException', 1);
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

// Only auto-start when executed directly, so tests can import this module.
if (require.main === module) {
  start().catch((err) => {
    log.error(`Fatal error during startup: ${err.message}`, { stack: err.stack });
    process.exit(1);
  });
}

module.exports = { start, shutdown };
