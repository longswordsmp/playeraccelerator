'use strict';

/**
 * Gateway ready — the point where the bot becomes operational.
 *
 * Registers commands, warms the configuration cache, verifies permissions in
 * every guild, sets the presence and starts the scheduler.
 */

const { Events, ActivityType } = require('discord.js');

const { env } = require('../../config/env');
const { REQUIRED_BOT_PERMISSIONS } = require('../../config/permissions');
const commandHandler = require('../../handlers/commandHandler');
const configService = require('../../services/configService');
const scheduler = require('../../services/schedulerService');
const permissions = require('../../utils/permissions');
const { logger } = require('../../utils/logger');
const { number } = require('../../utils/formatters');

const log = logger.child('ready');

module.exports = {
  name: Events.ClientReady,
  once: true,

  /** @param {import('../../core/Client').StudioClient} client */
  async execute(client) {
    log.success(`Logged in as ${client.user.tag}`);
    log.info(`Serving ${client.guilds.cache.size} guild(s) · ${number(client.guilds.cache.reduce((sum, guild) => sum + guild.memberCount, 0))} members`);

    // ── Register slash commands ─────────────────────────────────────────────
    if (env.autoDeployCommands) {
      try {
        await commandHandler.deploy(client, { global: !env.guildId });
      } catch (err) {
        log.error(`Command registration failed: ${err.message}`);
        log.error('Run `npm run deploy` manually once the problem is resolved.');
      }
    } else {
      log.info('Automatic command registration is disabled (AUTO_DEPLOY_COMMANDS=false).');
    }

    // ── Warm caches and check each guild ────────────────────────────────────
    for (const guild of client.guilds.cache.values()) {
      try {
        // eslint-disable-next-line no-await-in-loop -- small, one-time, at boot
        const config = await configService.get(guild);

        const { ok, missing } = permissions.botHasPermissions(guild, REQUIRED_BOT_PERMISSIONS);
        if (!ok) {
          log.warn(
            `Missing permissions in "${guild.name}": ${missing.join(', ')}. ` +
            'Some features will not work until they are granted.',
          );
        }

        if (!config.setup?.completed) {
          log.info(`"${guild.name}" has not been set up yet — an administrator should run /setup.`);
        }

        // Fetch members so permission checks and raid detection have data.
        // eslint-disable-next-line no-await-in-loop
        await guild.members.fetch({ time: 30_000 }).catch(() => {
          log.debug(`Member fetch timed out for "${guild.name}" — the cache will fill lazily.`);
        });
      } catch (err) {
        log.warn(`Initialisation failed for "${guild.name}"`, { message: err.message });
      }
    }

    // ── Presence ────────────────────────────────────────────────────────────
    const setPresence = () => {
      const openTickets = client.guilds.cache.size;
      client.user.setPresence({
        status: 'online',
        activities: [{
          name: openTickets === 1 ? 'customer projects' : `${openTickets} studios`,
          type: ActivityType.Watching,
        }],
      });
    };
    setPresence();
    client.addInterval(setPresence, 15 * 60_000);

    // ── Background jobs ─────────────────────────────────────────────────────
    scheduler.start(client);

    log.success('Bot is ready.');
  },
};
