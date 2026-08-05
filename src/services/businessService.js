'use strict';

/**
 * Office hours, availability and the live developer status.
 *
 * All time maths is done through `Intl.DateTimeFormat` against the configured
 * IANA timezone, which means DST is handled correctly without a date library.
 */

const { STATUSES } = require('../config/server');
const configService = require('./configService');
const logService = require('./logService');
const embeds = require('../utils/embeds');
const errors = require('../utils/errors');
const { EMOJIS, COLORS } = require('../config/branding');
const { timestamp, duration } = require('../utils/formatters');

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Current wall-clock time in a timezone.
 * @param {string} timezone IANA name
 * @param {Date} [at]
 * @returns {{ day: number, hour: number, minute: number, minutes: number, label: string }}
 */
function localTime(timezone, at = new Date()) {
  let parts;
  try {
    parts = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(at);
  } catch {
    // An invalid timezone must not break the panel — fall back to UTC.
    parts = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(at);
  }

  const get = (type) => parts.find((part) => part.type === type)?.value ?? '';
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  // Intl renders midnight as "24" in some locales; normalise it.
  const hour = Number(get('hour')) % 24;
  const minute = Number(get('minute'));

  return {
    day: weekdayIndex < 0 ? at.getUTCDay() : weekdayIndex,
    hour,
    minute,
    minutes: hour * 60 + minute,
    label: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
  };
}

/** Parse `HH:MM` into minutes past midnight. */
function toMinutes(value) {
  const [hours, minutes] = String(value ?? '').split(':').map(Number);
  return Number.isFinite(hours) && Number.isFinite(minutes) ? hours * 60 + minutes : null;
}

/** Render minutes-past-midnight as a 12-hour label. */
function formatTime(minutes) {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;
  const suffix = hours >= 12 ? 'PM' : 'AM';
  const display = hours % 12 === 0 ? 12 : hours % 12;
  return `${display}:${String(mins).padStart(2, '0')} ${suffix}`;
}

/**
 * Evaluate whether the studio is currently open.
 *
 * @param {object} config
 * @param {Date} [at]
 * @returns {{ open: boolean, timezone: string, now: object, today: object|null, opensIn: number|null, closesIn: number|null, nextOpenDay: string|null }}
 */
function availability(config, at = new Date()) {
  const timezone = config?.business?.timezone ?? 'UTC';
  const hours = config?.business?.hours ?? {};
  const now = localTime(timezone, at);
  const today = hours[now.day] ?? hours[String(now.day)] ?? null;

  let open = false;
  let closesIn = null;
  let opensIn = null;

  if (today?.open && today?.close) {
    const openAt = toMinutes(today.open);
    const closeAt = toMinutes(today.close);
    if (openAt !== null && closeAt !== null) {
      // Support shifts that run past midnight.
      open = closeAt > openAt
        ? now.minutes >= openAt && now.minutes < closeAt
        : now.minutes >= openAt || now.minutes < closeAt;

      if (open) closesIn = (closeAt > now.minutes ? closeAt - now.minutes : 1440 - now.minutes + closeAt) * 60_000;
      else if (now.minutes < openAt) opensIn = (openAt - now.minutes) * 60_000;
    }
  }

  // Find the next opening slot when currently closed.
  let nextOpenDay = null;
  if (!open && opensIn === null) {
    for (let offset = 1; offset <= 7; offset += 1) {
      const day = (now.day + offset) % 7;
      const slot = hours[day] ?? hours[String(day)];
      if (slot?.open) {
        nextOpenDay = `${DAY_NAMES[day]} at ${formatTime(toMinutes(slot.open))}`;
        opensIn = ((offset * 1440) - now.minutes + toMinutes(slot.open)) * 60_000;
        break;
      }
    }
  }

  return { open, timezone, now, today, opensIn, closesIn, nextOpenDay };
}

/**
 * Effective developer status: the manually set status, unless the studio is
 * closed and automatic tracking is enabled.
 * @param {object} config
 */
function effectiveStatus(config) {
  const manual = config?.status?.current ?? 'offline';
  if (config?.status?.autoFromHours === false) return manual;

  const { open } = availability(config);
  // Never override an explicit "busy" signal with "online".
  if (!open && ['online', 'coding'].includes(manual)) return 'away';
  return manual;
}

/**
 * Set the developer status.
 * @param {import('discord.js').Guild} guild
 * @param {string} status
 * @param {import('discord.js').GuildMember} actor
 * @param {string} [note]
 */
async function setStatus(guild, status, actor, note = '') {
  if (!STATUSES[status]) throw new errors.ValidationError('That is not a recognised status.');

  const config = await configService.update(guild, (cfg) => {
    cfg.setPath('status.current', status);
    cfg.setPath('status.note', note.slice(0, 200));
    cfg.setPath('status.updatedAt', new Date());
    cfg.setPath('status.updatedBy', actor.id);
  });

  // Refresh the public panel immediately.
  const panelService = require('./panelService');
  await panelService.refresh(guild, config, 'status').catch(() => null);

  await logService.record(guild, {
    category: 'business',
    event: 'status.change',
    title: `${STATUSES[status].emoji} Status: ${STATUSES[status].label}`,
    summary: note || STATUSES[status].description,
    actorId: actor.id,
  }, config);

  return config;
}

// ── Panels ───────────────────────────────────────────────────────────────────

/** The live developer status panel. */
function statusEmbed(config) {
  const key = effectiveStatus(config);
  const status = STATUSES[key] ?? STATUSES.offline;
  const { open, timezone, nextOpenDay, closesIn, opensIn } = availability(config);

  const fields = [
    { name: 'Availability', value: `${status.emoji} **${status.label}**`, inline: true },
    { name: 'Expected Response', value: status.response, inline: true },
    { name: 'Office', value: open ? '🟢 Open now' : '⚫ Closed', inline: true },
  ];

  if (open && closesIn) fields.push({ name: 'Closes in', value: duration(closesIn), inline: true });
  if (!open && opensIn) fields.push({ name: 'Opens in', value: duration(opensIn), inline: true });
  if (!open && nextOpenDay) fields.push({ name: 'Next open', value: nextOpenDay, inline: true });
  fields.push({ name: 'Timezone', value: `\`${timezone}\``, inline: true });
  if (config?.status?.note) fields.push({ name: 'Note', value: config.status.note, inline: false });

  return embeds.panel({
    config,
    color: status.color,
    title: `${status.emoji} Developer Status`,
    description: status.description,
    fields,
    footer: config?.status?.updatedAt ? 'Updated' : 'Live status',
  });
}

/** The office hours panel. */
function hoursEmbed(config) {
  const { open, timezone, nextOpenDay, closesIn, opensIn, now } = availability(config);
  const hours = config?.business?.hours ?? {};

  const schedule = [1, 2, 3, 4, 5, 6, 0].map((day) => {
    const slot = hours[day] ?? hours[String(day)];
    const isToday = day === now.day;
    const label = DAY_NAMES[day].padEnd(9);
    const value = slot?.open && slot?.close
      ? `${formatTime(toMinutes(slot.open))} – ${formatTime(toMinutes(slot.close))}`
      : 'Closed';
    return `${isToday ? '**›**' : '  '} \`${label}\` ${value}${isToday ? '  ← today' : ''}`;
  }).join('\n');

  const target = config?.business?.responseTargetMinutes ?? 240;

  return embeds.panel({
    config,
    color: open ? COLORS.success : COLORS.muted,
    title: `${EMOJIS.clock} Office Hours`,
    description: open
      ? `**We are open right now.** Local time is \`${now.label}\`.`
      : `**We are currently closed.** Local time is \`${now.label}\`.\n\n${config?.business?.outOfHoursMessage ?? ''}`,
    fields: [
      { name: 'Weekly Schedule', value: schedule },
      { name: 'Timezone', value: `\`${timezone}\``, inline: true },
      { name: 'Response Target', value: duration(target * 60_000), inline: true },
      ...(open && closesIn ? [{ name: 'Closes in', value: duration(closesIn), inline: true }] : []),
      ...(!open && opensIn ? [{ name: 'Reopens', value: `${duration(opensIn)}${nextOpenDay ? ` · ${nextOpenDay}` : ''}`, inline: true }] : []),
    ],
    footer: 'Tickets opened outside office hours are answered on the next business day.',
  });
}

module.exports = {
  localTime,
  availability,
  effectiveStatus,
  setStatus,
  statusEmbed,
  hoursEmbed,
  formatTime,
  toMinutes,
  DAY_NAMES,
};
