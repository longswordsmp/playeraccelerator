'use strict';

/**
 * Bring every guild's configuration to the shipped studio profile.
 *
 * Why this exists rather than "just change the defaults": defaults only fill in
 * options a guild has never had. `Configuration.resolve` deep-merges the stored
 * document *over* the shipped defaults, so anything already written — a
 * timezone saved as `UTC` by the first `/setup`, a brand name from before a
 * rename — keeps winning forever. Editing `defaults.js` fixes new installs and
 * does nothing at all for an existing one. This is the other half.
 *
 * What it will never touch, because losing it means the bot no longer knows
 * what it built: `roles`, `channels`, `categories`, `logChannels`, `panels`,
 * `setup`. A running `launch` promotion is preserved too — resetting it
 * mid-window would silently close an offer that has been publicly announced.
 *
 * Safe to run repeatedly. Reports every section it changes, and `--dry-run`
 * shows the whole plan without writing a byte.
 *
 *   npm run configure
 *   npm run configure -- --dry-run
 *   npm run configure -- --schedule-only
 *   npm run configure -- --timezone=Europe/London --open=10:00 --close=18:00
 *   npm run configure -- --days=1,2,3,4,5
 *
 * Options:
 *   --timezone=<IANA>   default America/New_York
 *   --open=HH:MM        default 12:00
 *   --close=HH:MM       default 21:00
 *   --days=0,1,2…       open weekdays, 0 = Sunday. Default all seven.
 *   --schedule-only     only the timezone, hours and status mode
 *   --dry-run           print the plan, write nothing
 */

const { validateEnv } = require('../src/config');
const database = require('../src/database/connection');
const Configuration = require('../src/database/models/Configuration');
const { DEFAULT_CONFIG } = require('../src/config/defaults');
const configService = require('../src/services/configService');
const businessService = require('../src/services/businessService');
const validators = require('../src/utils/validators');

const { applyProfile, PRESERVED } = configService;

const C = {
  reset: '[0m', dim: '[2m', bold: '[1m',
  green: '[32m', yellow: '[33m', red: '[31m', cyan: '[36m',
};

const write = (text) => process.stdout.write(text);
const ok = (text, detail = '') => write(`  ${C.green}✓${C.reset} ${text}${detail ? ` ${C.dim}${detail}${C.reset}` : ''}\n`);
const note = (text) => write(`  ${C.dim}·${C.reset} ${C.dim}${text}${C.reset}\n`);
const warn = (text) => write(`  ${C.yellow}!${C.reset} ${text}\n`);
const bad = (text, detail = '') => write(`  ${C.red}✗${C.reset} ${text}${detail ? `\n     ${C.dim}${detail}${C.reset}` : ''}\n`);
const heading = (text) => write(`\n  ${C.cyan}${text}${C.reset}\n`);

/** Read `--name=value` from argv. */
function flag(name, fallback = null) {
  const match = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Human summary of what a section is for, shown when it changes. */
const SECTION_LABELS = {
  brand: 'studio name, server name, tagline, description',
  theme: 'embed palette, panel artwork',
  tickets: 'ticket limits, transcripts, auto-close',
  business: 'timezone, office hours, currency, VIP thresholds',
  status: 'availability mode',
  queue: 'capacity and delivery estimates',
  reviews: 'moderation and publishing rules',
  portfolio: 'showcase settings',
  promotion: 'partnership programme',
  announcements: 'announcement defaults',
  autoRoles: 'roles granted on join and on purchase',
  verify: 'verification gate',
  referrals: 'free-commission referral requirement',
  welcome: 'welcome message',
  moderation: 'warn thresholds and escalation',
  automod: 'AutoMod modules',
  links: 'link filtering',
  antiRaid: 'raid detection',
  antiNuke: 'nuke protection',
  logging: 'what gets logged where',
  security: 'security posture',
  lockdown: 'lockdown state',
  backups: 'scheduled snapshots',
  reports: 'daily and weekly business reports',
};

async function main() {
  write(`\n  ${C.bold}SamotWorks — apply configuration${C.reset}\n`);

  const dryRun = process.argv.includes('--dry-run');
  const scheduleOnly = process.argv.includes('--schedule-only');

  // Validate every input before touching the database, so a typo cannot leave
  // one guild updated and the next one not.
  let timezone;
  let open;
  let close;
  try {
    timezone = validators.timezone(flag('timezone', DEFAULT_CONFIG.business.timezone));
    open = validators.timeOfDay(flag('open', '12:00'));
    close = validators.timeOfDay(flag('close', '21:00'));
  } catch (err) {
    bad('Invalid option', err.message);
    process.exitCode = 1;
    return;
  }

  const days = (flag('days') ?? '0,1,2,3,4,5,6')
    .split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 6);

  if (!days.length) {
    bad('No valid days given', 'Use --days=1,2,3,4,5 for weekdays, where 0 is Sunday.');
    process.exitCode = 1;
    return;
  }

  const hours = {};
  for (let day = 0; day <= 6; day += 1) hours[day] = days.includes(day) ? { open, close } : null;

  const label = (time) => businessService.formatTime(businessService.toMinutes(time));
  const outOfHoursMessage =
    `We are currently outside office hours (${label(open)} – ${label(close)}, `
    + `${days.length === 7 ? 'daily' : 'on our open days'}). `
    + 'Your ticket is logged and will be answered when we reopen.';

  heading('Plan');
  note(`Timezone       ${timezone}`);
  note(`Office hours   ${label(open)} – ${label(close)}`);
  note(`Open days      ${days.length === 7 ? 'every day' : days.map((day) => DAY_NAMES[day].slice(0, 3)).join(', ')}`);
  note('Status         follows the schedule automatically');
  note(scheduleOnly
    ? 'Sections       schedule only'
    : 'Sections       every setting reset to the shipped defaults');
  note(`Preserved      ${PRESERVED.join(', ')}`);
  if (dryRun) warn('DRY RUN — nothing will be written');

  const problems = validateEnv();
  if (problems.some((problem) => problem.includes('DATABASE_URL'))) {
    bad('DATABASE_URL is not set', 'Add it to your .env file first.');
    process.exitCode = 1;
    return;
  }

  try {
    await database.connect({ retries: 1 });
  } catch (err) {
    bad('Could not connect to MongoDB', err.message);
    process.exitCode = 1;
    return;
  }

  const configurations = await Configuration.find({});

  if (!configurations.length) {
    heading('Guilds');
    warn('No guilds are configured yet.');
    note('Run /setup in Discord first. A brand new guild is written straight from the shipped');
    note('defaults, which already carry everything above — this script is for guilds that have');
    note('drifted from them.');
    write('\n');
    await database.disconnect().catch(() => null);
    return;
  }

  heading('Guilds');
  let changedGuilds = 0;

  for (const config of configurations) {
    const name = config.guildName || config.guildId;
    const { changed } = applyProfile(config, {
      timezone, hours, outOfHoursMessage, scheduleOnly,
    });
    const verifiedRole = config.roles?.verified;

    if (!changed.length) {
      ok(name, 'already correct');
      continue;
    }

    if (!dryRun) {
      // eslint-disable-next-line no-await-in-loop -- a handful of guilds at most
      await config.save();
    }
    changedGuilds += 1;

    ok(name, `${dryRun ? 'would update' : 'updated'} ${changed.length} section${changed.length === 1 ? '' : 's'}`);
    for (const section of changed) {
      note(`  ${section.padEnd(14)} ${SECTION_LABELS[section] ?? ''}`);
    }
    if (!verifiedRole) {
      note('  verify.roleId is empty — run /setup so the verification gate has a role to grant');
    }
  }

  // Show what the schedule resolves to right now. This is the fastest way to
  // see it worked, and catches a timezone that is technically valid but not the
  // one that was meant.
  const sample = configurations[0];
  const availability = businessService.availability(sample);
  const status = businessService.effectiveStatus(sample);

  heading('Right now');
  note(`Local time     ${availability.now.label} ${timezone}`);
  note(`Office         ${availability.open ? 'open' : 'closed'}`);
  note(`Status shows   ${status}`);
  if (!availability.open && availability.nextOpenDay) note(`Next open      ${availability.nextOpenDay}`);

  heading('Result');
  if (dryRun) {
    warn('Dry run — nothing was written. Re-run without --dry-run to apply.');
  } else if (changedGuilds) {
    ok(`${changedGuilds} guild${changedGuilds === 1 ? '' : 's'} updated`);
    note('Restart the bot so it picks up the new configuration, then run');
    note('/panel republish confirm:True in Discord to repost the panels with it.');
  } else {
    ok('Everything was already correct');
  }
  write('\n');

  await database.disconnect().catch(() => null);
}

// Only run when invoked directly, so the tests can import `applyProfile`
// without opening a database connection.
if (require.main === module) {
  main().catch(async (err) => {
    bad('Failed', err.stack);
    process.exitCode = 1;
    await database.disconnect().catch(() => null);
  });
}

