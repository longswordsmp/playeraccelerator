'use strict';

/**
 * Extended Discord client.
 *
 * Owns the registries that the handlers populate (commands, components, events)
 * plus the shared runtime state — cooldowns, throttles and process metrics —
 * so no module needs a global singleton of its own.
 */

const { Client, GatewayIntentBits, Partials, Collection, Options } = require('discord.js');
const { CooldownManager, TokenBucket, registry } = require('../utils/rateLimiter');
const { logger } = require('../utils/logger');

/**
 * Intents.
 *
 * `GuildMembers` and `MessageContent` are privileged and MUST be enabled in the
 * Developer Portal (Bot → Privileged Gateway Intents). Without MessageContent
 * the AutoMod content filters cannot see message text; without GuildMembers the
 * join automation and raid detection cannot function. The boot sequence checks
 * for these and explains the failure rather than crashing cryptically.
 */
const INTENTS = [
  GatewayIntentBits.Guilds,
  GatewayIntentBits.GuildMembers,
  GatewayIntentBits.GuildModeration,
  GatewayIntentBits.GuildExpressions,
  GatewayIntentBits.GuildIntegrations,
  GatewayIntentBits.GuildWebhooks,
  GatewayIntentBits.GuildInvites,
  GatewayIntentBits.GuildVoiceStates,
  GatewayIntentBits.GuildMessages,
  GatewayIntentBits.GuildMessageReactions,
  GatewayIntentBits.MessageContent,
  GatewayIntentBits.DirectMessages,
].filter((intent) => intent !== undefined);

class StudioClient extends Client {
  constructor() {
    super({
      intents: INTENTS,
      partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.GuildMember, Partials.User],
      allowedMentions: { parse: ['users', 'roles'], repliedUser: false },
      /**
       * Cache tuning. Members and roles must stay resident for permission
       * checks; message and reaction caches are bounded because the transcript
       * generator fetches history on demand instead of relying on cache.
       */
      makeCache: Options.cacheWithLimits({
        ...Options.DefaultMakeCacheSettings,
        MessageManager: 200,
        ReactionManager: 0,
        GuildMemberManager: { maxSize: 5000, keepOverLimit: (member) => member.id === member.client.user.id },
        UserManager: { maxSize: 5000, keepOverLimit: (user) => user.id === user.client.user.id },
        PresenceManager: 0,
        ThreadManager: 100,
      }),
      sweepers: {
        ...Options.DefaultSweeperSettings,
        messages: { interval: 600, lifetime: 1800 },
        users: { interval: 3600, filter: () => (user) => user.bot && user.id !== user.client.user.id },
        threads: { interval: 3600, lifetime: 14_400 },
      },
      failIfNotExists: false,
    });

    /** @type {Collection<string, object>} slash command name -> definition */
    this.commands = new Collection();
    /** @type {Collection<string, object>} context menu name -> definition */
    this.contextMenus = new Collection();
    /** @type {Collection<string, object>} namespace -> button handler */
    this.buttons = new Collection();
    /** @type {Collection<string, object>} namespace -> select menu handler */
    this.selectMenus = new Collection();
    /** @type {Collection<string, object>} namespace -> modal handler */
    this.modals = new Collection();

    /** Per-user, per-command cooldowns. */
    this.cooldowns = registry.register(new CooldownManager());
    /** Global interaction throttle — the first line of defence against abuse. */
    this.throttle = registry.register(new TokenBucket(20, 40));

    /** Runtime metrics surfaced by `/statistics system`. */
    this.metrics = {
      startedAt: Date.now(),
      commandsExecuted: 0,
      componentsHandled: 0,
      errors: 0,
      eventsHandled: 0,
    };

    /** Populated by the scheduler service so shutdown can clear timers. */
    this.timers = new Set();

    this.log = logger.child('client');
  }

  /** Process uptime in milliseconds. */
  get uptime() {
    return Date.now() - this.metrics.startedAt;
  }

  /**
   * Register an interval that is automatically cleared on shutdown.
   * @param {() => void} fn
   * @param {number} ms
   */
  addInterval(fn, ms) {
    const timer = setInterval(fn, ms);
    timer.unref?.();
    this.timers.add(timer);
    return timer;
  }

  /** Clear every registered timer. */
  clearTimers() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers.clear();
  }
}

module.exports = { StudioClient, INTENTS };
