'use strict';

/**
 * Raid detection and response.
 *
 * Watches join velocity, leave velocity, bot joins and account age. When the
 * configured thresholds trip, raid mode engages: slowmode on public channels,
 * optional lockdown, staff alert, and stricter handling of brand-new accounts.
 *
 * Raid mode lifts itself after a quiet period so a moderator does not have to
 * remember to turn it off.
 */

const { ChannelType } = require('discord.js');

const { SlidingWindow, registry } = require('../utils/rateLimiter');
const moderationService = require('../services/moderationService');
const logService = require('../services/logService');
const configService = require('../services/configService');
const embeds = require('../utils/embeds');
const { attempt, safeSend, safeDm } = require('../utils/discord');
const { EMOJIS } = require('../config/branding');
const { duration, timestamp } = require('../utils/formatters');
const { User } = require('../database/models');
const { logger } = require('../utils/logger');

const log = logger.child('antiraid');

/** Join / leave velocity windows, keyed by guild id. */
const joins = registry.register(new SlidingWindow(60_000));
const leaves = registry.register(new SlidingWindow(60_000));
const botJoins = registry.register(new SlidingWindow(60_000));

/** Active raid state per guild. */
const raidState = new Map();

/** Whether a guild is currently in raid mode. */
const isRaiding = (guildId) => {
  const state = raidState.get(guildId);
  return Boolean(state && state.until > Date.now());
};

/**
 * Evaluate a join event.
 *
 * @param {import('discord.js').GuildMember} member
 * @param {object} config
 * @returns {Promise<{ raid: boolean, action: string|null, flagged: boolean }>}
 */
async function onJoin(member, config) {
  const settings = config.antiRaid ?? {};
  const result = { raid: false, action: null, flagged: false };
  if (!settings.enabled) return result;

  const guildId = member.guild.id;
  const window = (settings.joinWindow ?? 10) * 1000;
  joins.windowMs = Math.max(joins.windowMs, window);

  const recentJoins = joins.hit(guildId);
  const recentBots = member.user.bot ? botJoins.hit(guildId) : botJoins.count(guildId);

  // ── Account age heuristic ─────────────────────────────────────────────────
  const minAgeDays = settings.minAccountAgeDays ?? 7;
  const accountAgeMs = Date.now() - member.user.createdTimestamp;
  const isNewAccount = accountAgeMs < minAgeDays * 86_400_000;

  if (isNewAccount) {
    result.flagged = true;
    await User.updateOne(
      { guildId, userId: member.id },
      {
        $set: {
          'moderation.flagged': true,
          'moderation.flagReason': `Account created ${duration(accountAgeMs)} ago (threshold: ${minAgeDays} days)`,
        },
        $setOnInsert: { guildId, userId: member.id },
      },
      { upsert: true },
    );

    if (settings.alertStaff !== false || config.security?.alertOnSuspicious !== false) {
      await logService.security(member.guild, {
        event: 'antiraid.newAccount',
        metric: 'account',
        title: '🔍 New Account Joined',
        summary:
          `${member.user.tag} joined with an account created ${duration(accountAgeMs)} ago. ` +
          'This is a heuristic, not proof of wrongdoing — no action has been taken.',
        actorId: member.id,
        actorName: member.user.tag,
        severity: 'info',
        fields: {
          'Account created': timestamp(member.user.createdAt, 'full'),
          Age: duration(accountAgeMs),
          Threshold: `${minAgeDays} days`,
        },
      }, config);
    }
  }

  // ── Raid triggers ─────────────────────────────────────────────────────────
  const joinTrigger = recentJoins >= (settings.joinThreshold ?? 8);
  const botTrigger = member.user.bot && recentBots >= (settings.botJoinThreshold ?? 3);

  if (joinTrigger || botTrigger) {
    result.raid = true;
    await engage(member.guild, config, {
      trigger: botTrigger ? 'bot-flood' : 'join-flood',
      count: botTrigger ? recentBots : recentJoins,
      window: settings.joinWindow ?? 10,
    });
  }

  // ── Stricter handling of brand-new accounts during an active raid ─────────
  if (isRaiding(guildId) && isNewAccount && !moderationService.isExempt(member, config)) {
    const action = settings.newAccountAction ?? 'kick';
    if (action && action !== 'none') {
      await safeDm(member.user, {
        embeds: [embeds.warning({
          config,
          title: `${member.guild.name} is under raid protection`,
          description:
            'Your account was created very recently, and the server is currently restricting new joins ' +
            'while we deal with an ongoing incident.\n\nPlease try again later — this is not a permanent ban.',
        })],
      });

      await moderationService.punish({
        guild: member.guild,
        type: action,
        target: member.user,
        moderator: { id: member.client.user.id, tag: 'Anti-Raid' },
        reason: `Raid protection: account is ${duration(accountAgeMs)} old, below the ${minAgeDays}-day threshold.`,
        config,
        automated: true,
        source: 'antiraid',
        silent: true,
      }).catch((err) => log.warn('Raid action failed', { message: err.message }));

      result.action = action;
    }
  }

  return result;
}

/** Evaluate a leave event — a mass exodus is also a signal worth logging. */
async function onLeave(member, config) {
  const settings = config.antiRaid ?? {};
  if (!settings.enabled) return false;

  const count = leaves.hit(member.guild.id);
  if (count >= (settings.leaveThreshold ?? 10)) {
    leaves.reset(member.guild.id);
    await logService.security(member.guild, {
      event: 'antiraid.massLeave',
      metric: 'raid',
      title: `${EMOJIS.warning} Mass Leave Detected`,
      summary: `${count} members left within ${settings.joinWindow ?? 10}s. This can indicate a raid ending, a purge, or a bot removal.`,
      severity: 'warn',
    }, config);
    return true;
  }
  return false;
}

/**
 * Engage raid mode.
 *
 * @param {import('discord.js').Guild} guild
 * @param {object} config
 * @param {{ trigger: string, count: number, window: number }} detail
 */
async function engage(guild, config, detail) {
  const settings = config.antiRaid ?? {};
  const durationMinutes = settings.raidDurationMinutes ?? 10;
  const existing = raidState.get(guild.id);

  // Already raiding — extend the window rather than re-running the response.
  if (existing && existing.until > Date.now()) {
    existing.until = Date.now() + durationMinutes * 60_000;
    existing.triggers += 1;
    return existing;
  }

  const state = {
    startedAt: Date.now(),
    until: Date.now() + durationMinutes * 60_000,
    trigger: detail.trigger,
    triggers: 1,
    slowmodeApplied: [],
  };
  raidState.set(guild.id, state);

  log.warn(`Raid mode engaged in ${guild.name}`, detail);

  // 1. Slowmode across public text channels.
  const slowmode = settings.raidSlowmode ?? 15;
  if (slowmode > 0) {
    const publicChannels = [...guild.channels.cache.values()].filter(
      (channel) => channel.type === ChannelType.GuildText
        && channel.manageable
        && channel.permissionsFor(guild.roles.everyone)?.has('ViewChannel'),
    );
    for (const channel of publicChannels.slice(0, 30)) {
      // eslint-disable-next-line no-await-in-loop -- sequential to respect rate limits
      const applied = await attempt(() => channel.setRateLimitPerUser(slowmode, 'Raid protection engaged'), {
        label: 'raid slowmode',
      });
      if (applied) state.slowmodeApplied.push({ id: channel.id, previous: channel.rateLimitPerUser ?? 0 });
    }
  }

  // 2. Optional full lockdown.
  if (settings.autoLockdown) {
    await moderationService.lockdown(
      guild,
      true,
      { id: guild.client.user.id, tag: 'Anti-Raid' },
      config,
      `Automatic lockdown: ${detail.count} joins in ${detail.window}s`,
      true,
    ).catch((err) => log.warn('Raid lockdown failed', { message: err.message }));
  }

  // 3. Alert staff.
  const alertChannel = configService.logChannel(guild, config, 'security')
    ?? configService.channel(guild, config, 'staffChat');
  if (alertChannel) {
    const staffRole = config.roles?.manager ?? config.roles?.leadDeveloper;
    await safeSend(alertChannel, {
      content: settings.alertStaff !== false && staffRole ? `<@&${staffRole}>` : undefined,
      embeds: [embeds.error({
        config,
        title: 'Raid Protection Engaged',
        description:
          `**${detail.count}** ${detail.trigger === 'bot-flood' ? 'bots' : 'members'} joined within **${detail.window}s**.\n\n` +
          'Automatic countermeasures are active.',
        fields: [
          { name: 'Slowmode', value: slowmode > 0 ? `${slowmode}s on ${state.slowmodeApplied.length} channels` : 'Disabled', inline: true },
          { name: 'Lockdown', value: settings.autoLockdown ? 'Enabled' : 'Disabled', inline: true },
          { name: 'New accounts', value: `${settings.newAccountAction ?? 'kick'} (under ${settings.minAccountAgeDays ?? 7} days old)`, inline: true },
          { name: 'Auto-lifts', value: timestamp(new Date(state.until), 'relative'), inline: true },
        ],
        footer: 'Use /security raid off to lift this immediately',
      })],
    });
  }

  await logService.security(guild, {
    event: 'antiraid.engage',
    metric: 'raid',
    title: `${EMOJIS.security} Raid Mode Engaged`,
    summary: `${detail.count} joins in ${detail.window}s (${detail.trigger})`,
    severity: 'critical',
  }, config);

  return state;
}

/**
 * Lift raid mode and restore what it changed.
 * @param {import('discord.js').Guild} guild
 * @param {object} config
 * @param {{ id: string, tag?: string }} [actor]
 */
async function disengage(guild, config, actor = null) {
  const state = raidState.get(guild.id);
  if (!state) return false;
  raidState.delete(guild.id);

  // Restore the previous slowmode value rather than blanket-clearing it.
  for (const entry of state.slowmodeApplied) {
    const channel = guild.channels.cache.get(entry.id);
    if (!channel) continue;
    // eslint-disable-next-line no-await-in-loop -- sequential to respect rate limits
    await attempt(() => channel.setRateLimitPerUser(entry.previous, 'Raid protection lifted'), { label: 'restore slowmode' });
  }

  if (config.lockdown?.active) {
    await moderationService.lockdown(guild, false, actor ?? { id: guild.client.user.id, tag: 'Anti-Raid' }, config, '', true)
      .catch(() => null);
  }

  await logService.security(guild, {
    event: 'antiraid.disengage',
    title: `${EMOJIS.success} Raid Mode Lifted`,
    summary: `Raid mode ended after ${duration(Date.now() - state.startedAt)}${actor ? ` (lifted by <@${actor.id}>)` : ' (automatic)'}`,
    actorId: actor?.id,
    severity: 'info',
  }, config);

  log.info(`Raid mode lifted in ${guild.name}`);
  return true;
}

/**
 * Called by the scheduler: lift expired raid states.
 * @param {import('discord.js').Client} client
 */
async function sweep(client) {
  const now = Date.now();
  let lifted = 0;
  for (const [guildId, state] of raidState) {
    if (state.until > now) continue;
    const guild = client.guilds.cache.get(guildId);
    if (!guild) {
      raidState.delete(guildId);
      continue;
    }
    // eslint-disable-next-line no-await-in-loop -- rare, bounded
    const config = await configService.get(guild).catch(() => null);
    // eslint-disable-next-line no-await-in-loop
    if (config) await disengage(guild, config);
    lifted += 1;
  }
  return lifted;
}

/** Current state for `/security status`. */
function status(guildId) {
  const state = raidState.get(guildId);
  return {
    active: isRaiding(guildId),
    trigger: state?.trigger ?? null,
    since: state?.startedAt ?? null,
    until: state?.until ?? null,
    recentJoins: joins.count(guildId),
    recentLeaves: leaves.count(guildId),
  };
}

module.exports = { onJoin, onLeave, engage, disengage, sweep, isRaiding, status };
