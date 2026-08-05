'use strict';

/**
 * Gateway health.
 *
 * The library recovers from most of these on its own; logging them turns an
 * invisible reconnect into something an operator can actually correlate with a
 * report of "the bot was slow at 3am".
 */

const { Events } = require('discord.js');
const { logger } = require('../../utils/logger');
const logService = require('../../services/logService');

const log = logger.child('gateway');

module.exports = [
  {
    name: Events.Error,
    async execute(client, error) {
      log.error(`Gateway error: ${error.message}`, { stack: error.stack });
      await logService.error(null, error, { context: 'gateway' });
    },
  },
  {
    name: Events.Warn,
    execute(client, message) {
      log.warn(`Gateway warning: ${message}`);
    },
  },
  {
    name: Events.ShardDisconnect,
    execute(client, event, shardId) {
      log.warn(`Shard ${shardId} disconnected (code ${event?.code}) — the library will reconnect.`);
    },
  },
  {
    name: Events.ShardReconnecting,
    execute(client, shardId) {
      log.info(`Shard ${shardId} reconnecting…`);
    },
  },
  {
    name: Events.ShardResume,
    execute(client, shardId, replayed) {
      log.success(`Shard ${shardId} resumed (${replayed} events replayed).`);
    },
  },
  {
    name: Events.ShardError,
    async execute(client, error, shardId) {
      log.error(`Shard ${shardId} error: ${error.message}`);
    },
  },
  {
    name: Events.Invalidated,
    execute() {
      log.error('Session invalidated by Discord — the process will exit so the supervisor can restart it.');
      process.exit(1);
    },
  },
];
