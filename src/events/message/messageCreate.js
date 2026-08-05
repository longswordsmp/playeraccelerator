'use strict';

/**
 * The message hot path.
 *
 * Order matters and is chosen for cost: cheap rejections first, AutoMod before
 * any database write, and ticket telemetry only for messages that are actually
 * inside a ticket channel.
 */

const { Events } = require('discord.js');

const configService = require('../../services/configService');
const ticketService = require('../../services/ticketService');
const autoMod = require('../../security/autoMod');
const aiService = require('../../services/aiService');
const { GuildStats, User } = require('../../database/models');
const { logger } = require('../../utils/logger');

const log = logger.child('messages');

/** Batched activity counters, flushed periodically to avoid per-message writes. */
const pendingMessages = new Map();
let flushTimer = null;

/** Flush the batched counters. */
function flush() {
  flushTimer = null;
  for (const [guildId, count] of pendingMessages) {
    GuildStats.bump(guildId, { 'activity.messages': count }).catch(() => null);
  }
  pendingMessages.clear();
}

/** Record a message against a guild's daily counter. */
function countMessage(guildId) {
  pendingMessages.set(guildId, (pendingMessages.get(guildId) ?? 0) + 1);
  if (!flushTimer) {
    flushTimer = setTimeout(flush, 30_000);
    flushTimer.unref?.();
  }
}

module.exports = {
  name: Events.MessageCreate,

  /**
   * @param {import('../../core/Client').StudioClient} client
   * @param {import('discord.js').Message} message
   */
  async execute(client, message) {
    if (!message.guild || message.author.bot || message.system) return;
    if (!message.member) {
      // Partial member — resolve it so permission checks are accurate.
      await message.guild.members.fetch(message.author.id).catch(() => null);
    }

    const config = await configService.get(message.guild);
    countMessage(message.guild.id);

    // ── AutoMod ─────────────────────────────────────────────────────────────
    autoMod.rememberMentions(message);
    const finding = await autoMod.inspect(message, config).catch((err) => {
      log.warn('AutoMod inspection failed', { message: err.message });
      return null;
    });
    // A deleted message has no further telemetry value.
    if (finding && finding.action !== 'none') return;

    // ── Ticket telemetry ────────────────────────────────────────────────────
    const ticketCategories = [config.categories?.tickets, config.categories?.archive].filter(Boolean);
    if (ticketCategories.includes(message.channel.parentId)) {
      await ticketService.trackMessage(message, config).catch((err) => {
        log.debug('Ticket tracking failed', { message: err.message });
      });

      // Automated first-line support. Deliberately not awaited: it waits before
      // answering so a human can get there first, and the message hot path must
      // never block on a model round trip.
      if (aiService.isConfigured()) {
        aiService.consider(message, config).catch((err) => {
          log.debug('AI consideration failed', { message: err.message });
        });
      }
    }

    // ── Lightweight activity tracking ───────────────────────────────────────
    // Sampled: roughly one message in ten is written back, counted as ten, so a
    // busy server never becomes write-bound. Snowflakes exceed Number's safe
    // range, so the sampling uses BigInt arithmetic.
    if (BigInt(message.id) % 10n === 0n) {
      await User.bump(message.guild.id, message.author.id, { 'stats.messagesSent': 10 }).catch(() => null);
    }
  },
};
