'use strict';

/**
 * Apply the studio's operating settings to every guild in the database.
 *
 * Why this exists rather than "just change the defaults": defaults only fill in
 * options a guild has never had. `Configuration.resolve` deep-merges the stored
 * document *over* the shipped defaults, so anything already written — including
 * a timezone that was written as `UTC` the first time `/setup` ran — keeps
 * winning forever. Editing `defaults.js` fixes new installs and does nothing at
 * all for an existing one.
 *
 * Safe to run repeatedly. It reports what it changed and leaves everything else
 * alone.
 *
 *   npm run configure
 *   npm run configure -- --timezone=Europe/London --open=10:00 --close=18:00
 *   npm run configure -- --dry-run
 *
 * Options:
 *   --timezone=<IANA>   default America/New_York
 *   --open=HH:MM        default 12:00
 *   --close=HH:MM       default 21:00
 *   --days=0,1,2…       which weekdays are open (0 = Sunday). Default all seven.
 *   --dry-run           print the changes without writing them
 */

const { validateEnv } = require('../src/config');
const database = require('../src/database/connection');
const { Configuration } = require('../src/database/models');
const businessService = require('../src/services/businessService');
const validators = require('../src/utils/validators');

const COLOURS = {
  reset: '[0m', dim: '[2m', bold: '[1m',
  green: '[32m', yellow: '[33m', red: '[31m', cyan: '[36m',
};

const write = (text) => process.stdout.write(text);
const ok = (text, detail = '') => write(`  ${COLOURS.green}✓${COLOURS.reset} ${text}${detail ? ` ${COLOURS.dim}${detail}${COLOURS.reset}` : ''}\n`);
const note = (text) => write(`  ${COLOURS.dim}·${COLOURS.reset} ${COLOURS.dim}${text}${COLOURS.reset}\n`);
const bad = (text, detail = '') => write(`  ${COLOURS.red}✗${COLOURS.reset} ${text}${detail ? `\n     ${COLOURS.dim}${detail}${COLOURS.reset}` : ''}\n`);

/** Read `--name=value` from argv. */
function flag(name, fallback = null) {
  const match = process.argv.find((argument) => argument.startsWith(`--${name}=`));
  return match ? match.slice(name.length + 3) : fallback;
}

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

async function main() {
  write(`\n  ${COLOURS.bold}SamotWorks — apply configuration${COLOURS.reset}\n\n`);

  const dryRun = process.argv.includes('--dry-run');

  // Validate the inputs before touching the database, so a typo cannot leave
  // half the guilds updated and half not.
  let timezone;
  let open;
  let close;
  try {
    timezone = validators.timezone(flag('timezone', 'America/New_York'));
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

  write(`  ${COLOURS.cyan}Applying${COLOURS.reset}\n`);
  note(`Timezone      ${timezone}`);
  note(`Office hours  ${businessService.formatTime(businessService.toMinutes(open))} – `
    + `${businessService.formatTime(businessService.toMinutes(close))}`);
  note(`Open days     ${days.map((day) => DAY_NAMES[day].slice(0, 3)).join(', ')}`);
  note('Status        follows the schedule automatically');
  if (dryRun) note('DRY RUN — nothing will be written');
  write('\n');

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
    write(`  ${COLOURS.yellow}!${COLOURS.reset} No guilds are configured yet.\n`);
    note('Run /setup in Discord first — these settings are then applied from the shipped defaults,');
    note('and this script is only needed if you change them later.');
    await database.disconnect().catch(() => null);
    return;
  }

  let changedGuilds = 0;

  for (const config of configurations) {
    const before = {
      timezone: config.business?.timezone,
      hours: JSON.stringify(config.business?.hours ?? {}),
      auto: config.status?.auto,
      autoFromHours: config.status?.autoFromHours,
    };

    config.setPath('business.timezone', timezone);
    config.setPath('business.hours', hours);
    config.setPath(
      'business.outOfHoursMessage',
      `We are currently outside office hours (${open}–${close} ${timezone.split('/').pop().replace(/_/g, ' ')}). `
      + 'Your ticket is logged and will be answered when we reopen.',
    );
    config.setPath('status.autoFromHours', true);
    config.setPath('status.auto', true);

    const after = {
      timezone: config.business.timezone,
      hours: JSON.stringify(config.business.hours),
      auto: config.status.auto,
      autoFromHours: config.status.autoFromHours,
    };

    const changed = Object.keys(before).filter((key) => before[key] !== after[key]);
    const label = config.guildName || config.guildId;

    if (!changed.length) {
      ok(label, 'already correct');
      continue;
    }

    if (!dryRun) {
      // eslint-disable-next-line no-await-in-loop -- a handful of guilds at most
      await config.save();
    }
    changedGuilds += 1;

    ok(label, `${dryRun ? 'would update' : 'updated'}: ${changed.join(', ')}`);
    if (before.timezone !== after.timezone) note(`  timezone  ${before.timezone ?? 'unset'} → ${after.timezone}`);
  }

  // Show what the studio status resolves to right now, which is the whole point
  // of the exercise and the fastest way to see it worked.
  const sample = configurations[0];
  const { open: isOpen, now } = businessService.availability(sample);
  const status = businessService.effectiveStatus(sample);

  write('\n');
  write(`  ${COLOURS.cyan}Right now${COLOURS.reset}\n`);
  note(`Local time    ${now.label} ${timezone}`);
  note(`Office        ${isOpen ? 'open' : 'closed'}`);
  note(`Status shows  ${status}`);

  write('\n');
  if (dryRun) {
    write(`  ${COLOURS.yellow}Dry run — nothing was written.${COLOURS.reset}\n\n`);
  } else if (changedGuilds) {
    write(`  ${COLOURS.green}${changedGuilds} guild${changedGuilds === 1 ? '' : 's'} updated.${COLOURS.reset} `
      + `${COLOURS.dim}Restart the bot, or wait for the next panel refresh.${COLOURS.reset}\n\n`);
  } else {
    write(`  ${COLOURS.green}Everything was already correct.${COLOURS.reset}\n\n`);
  }

  await database.disconnect().catch(() => null);
}

main().catch(async (err) => {
  bad('Failed', err.stack);
  process.exitCode = 1;
  await database.disconnect().catch(() => null);
});
