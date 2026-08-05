'use strict';

/**
 * Background job scheduler.
 *
 * A single tick loop drives every periodic task, which keeps timer count and
 * memory bounded no matter how many guilds the bot serves. Each job declares
 * its own interval; the loop runs the ones that are due, isolates failures, and
 * never lets a slow job block the next tick.
 */

const configService = require('./configService');
const panelService = require('./panelService');
const ticketService = require('./ticketService');
const moderationService = require('./moderationService');
const reportService = require('./reportService');
const backupService = require('./backupService');
const orderService = require('./orderService');
const antiRaid = require('../security/antiRaid');
const { GuildStats } = require('../database/models');
const { logger } = require('../utils/logger');

const log = logger.child('scheduler');

/** How often the loop wakes up. */
const TICK_MS = 60_000;

/** @type {NodeJS.Timeout|null} */
let timer = null;
/** Last run timestamp per job. */
const lastRun = new Map();
/** Prevents overlapping ticks if one runs long. */
let running = false;

/**
 * Job registry.
 * `every` is in minutes. `perGuild` jobs receive `(guild, config)`.
 */
const JOBS = [
  {
    name: 'expire-punishments',
    every: 1,
    perGuild: false,
    run: async (client) => {
      const lifted = await moderationService.processExpirations(client);
      if (lifted) log.debug(`Lifted ${lifted} expired punishment(s)`);
    },
  },
  {
    name: 'raid-sweep',
    every: 1,
    perGuild: false,
    run: async (client) => antiRaid.sweep(client),
  },
  {
    name: 'refresh-panels',
    every: 10,
    perGuild: true,
    run: async (guild, config) => {
      if (!config.setup?.completed) return;
      await panelService.refreshDynamic(guild, config);
    },
  },
  {
    name: 'ticket-sweep',
    every: 30,
    perGuild: true,
    run: async (guild, config) => {
      if (!config.setup?.completed) return;
      await ticketService.sweepInactive(guild, config);
      await ticketService.sweepArchived(guild);
    },
  },
  {
    name: 'queue-estimates',
    every: 60,
    perGuild: true,
    run: async (guild, config) => {
      if (!config.setup?.completed) return;
      await orderService.recalculateEstimates(guild.id, config);
    },
  },
  {
    name: 'member-count',
    every: 60,
    perGuild: true,
    run: async (guild) => {
      await GuildStats.bump(guild.id, {}, new Date());
      await GuildStats.updateOne(
        { guildId: guild.id, date: GuildStats.dayKey() },
        { $set: { 'members.total': guild.memberCount } },
        { upsert: true },
      ).catch(() => null);
    },
  },
  {
    name: 'daily-report',
    every: 60,
    perGuild: true,
    /** Only fires in the configured UTC hour, once per day. */
    guard: (config) => {
      const hour = config.reports?.hourUtc ?? 8;
      return new Date().getUTCHours() === hour;
    },
    once: 'day',
    run: async (guild) => reportService.postDaily(guild),
  },
  {
    name: 'weekly-report',
    every: 60,
    perGuild: true,
    guard: (config) => {
      const hour = config.reports?.hourUtc ?? 8;
      // Monday morning, so the week just ended is the subject.
      return new Date().getUTCDay() === 1 && new Date().getUTCHours() === hour;
    },
    once: 'day',
    run: async (guild) => reportService.postWeekly(guild),
  },
  {
    name: 'scheduled-backup',
    every: 60,
    perGuild: true,
    run: async (guild, config) => {
      const intervalHours = config.backups?.intervalHours ?? 0;
      if (!config.backups?.enabled || intervalHours <= 0) return;
      const key = `backup:${guild.id}`;
      const last = lastRun.get(key) ?? 0;
      if (Date.now() - last < intervalHours * 3_600_000) return;
      lastRun.set(key, Date.now());
      await backupService.create(guild, { trigger: 'scheduled', label: 'Scheduled snapshot' });
    },
  },
];

/** Track "once per day" jobs so a 60-minute cadence cannot double-fire. */
const dailyMarks = new Map();

/**
 * Should this job run now?
 * @param {object} job
 * @param {string} scope guild id or 'global'
 */
function isDue(job, scope) {
  const key = `${job.name}:${scope}`;
  const last = lastRun.get(key) ?? 0;
  if (Date.now() - last < job.every * 60_000) return false;

  if (job.once === 'day') {
    const today = new Date().toISOString().slice(0, 10);
    if (dailyMarks.get(key) === today) return false;
  }
  return true;
}

/** Mark a job as having run. */
function markRun(job, scope) {
  const key = `${job.name}:${scope}`;
  lastRun.set(key, Date.now());
  if (job.once === 'day') dailyMarks.set(key, new Date().toISOString().slice(0, 10));
}

/**
 * One tick of the loop.
 * @param {import('../core/Client').StudioClient} client
 */
async function tick(client) {
  if (running) return;
  running = true;

  try {
    for (const job of JOBS) {
      if (job.perGuild) {
        for (const guild of client.guilds.cache.values()) {
          if (!isDue(job, guild.id)) continue;
          try {
            // eslint-disable-next-line no-await-in-loop -- sequential by design
            const config = await configService.get(guild);
            // eslint-disable-next-line no-await-in-loop
            if (job.guard && !(await job.guard(config, guild))) continue;
            // eslint-disable-next-line no-await-in-loop
            await job.run(guild, config);
            markRun(job, guild.id);
          } catch (err) {
            log.warn(`Job ${job.name} failed for ${guild.name}`, { message: err.message });
            markRun(job, guild.id);
          }
        }
      } else {
        if (!isDue(job, 'global')) continue;
        try {
          // eslint-disable-next-line no-await-in-loop
          await job.run(client);
        } catch (err) {
          log.warn(`Job ${job.name} failed`, { message: err.message });
        }
        markRun(job, 'global');
      }
    }
  } finally {
    running = false;
  }
}

/**
 * Start the scheduler.
 * @param {import('../core/Client').StudioClient} client
 */
function start(client) {
  if (timer) return timer;
  // A short delay lets the guild cache populate before the first tick.
  setTimeout(() => tick(client).catch((err) => log.error('Initial tick failed', { message: err.message })), 15_000).unref?.();
  timer = setInterval(() => {
    tick(client).catch((err) => log.error('Scheduler tick failed', { message: err.message }));
  }, TICK_MS);
  timer.unref?.();
  log.success(`Scheduler started with ${JOBS.length} jobs`);
  return timer;
}

/** Stop the scheduler. */
function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  lastRun.clear();
  dailyMarks.clear();
}

/** Job status for diagnostics. */
const status = () => JOBS.map((job) => ({
  name: job.name,
  every: `${job.every}m`,
  scope: job.perGuild ? 'per-guild' : 'global',
  lastRun: lastRun.get(`${job.name}:global`) ?? null,
}));

module.exports = { start, stop, tick, status, JOBS };
