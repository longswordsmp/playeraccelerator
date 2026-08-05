'use strict';

/**
 * Gateway event loading.
 *
 * Event modules export `{ name, once?, execute(client, ...args) }` and live in
 * `events/<group>/`. Every listener is wrapped so a throw inside one handler can
 * never become an unhandled rejection that takes the process down.
 */

const fs = require('node:fs');
const path = require('node:path');
const logService = require('../services/logService');
const { logger } = require('../utils/logger');

const log = logger.child('events');

/**
 * Recursively collect event modules.
 * @param {string} dir
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
 * Attach every event listener to the client.
 * @param {import('../core/Client').StudioClient} client
 */
function load(client) {
  const dir = path.join(__dirname, '..', 'events');
  const files = walk(dir);
  let loaded = 0;

  for (const file of files) {
    try {
      delete require.cache[require.resolve(file)];
      const event = require(file);
      if (!event?.name || typeof event.execute !== 'function') {
        log.error(`Event ${path.relative(dir, file)} is missing \`name\` or \`execute\``);
        continue;
      }

      /** Wrapper that isolates handler failures. */
      const listener = async (...args) => {
        try {
          client.metrics.eventsHandled += 1;
          await event.execute(client, ...args);
        } catch (err) {
          client.metrics.errors += 1;
          // Best-effort guild resolution so the error lands in the right log channel.
          const guild = args.find((arg) => arg?.guild)?.guild ?? args.find((arg) => arg?.members && arg?.channels) ?? null;
          await logService.error(guild, err, { context: `event:${event.name}` });
        }
      };

      if (event.once) client.once(event.name, listener);
      else client.on(event.name, listener);
      loaded += 1;
    } catch (err) {
      log.error(`Failed to load event ${path.relative(dir, file)}`, { message: err.message });
    }
  }

  log.success(`Loaded ${loaded} event listeners`);
  return loaded;
}

module.exports = { load, walk };
