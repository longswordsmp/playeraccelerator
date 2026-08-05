'use strict';

/**
 * Presentation helpers.
 *
 * Every user-visible string that needs shaping — timestamps, durations, money,
 * tables, truncation, progress bars — is produced here so the whole product
 * speaks with one voice.
 */

const { EMOJIS } = require('../config/branding');

/** Discord timestamp styles. */
const TIME_STYLES = { short: 't', long: 'T', date: 'd', longDate: 'D', full: 'f', fullLong: 'F', relative: 'R' };

/**
 * Render a Discord dynamic timestamp.
 * @param {Date|number|string|null|undefined} value
 * @param {keyof TIME_STYLES} [style]
 */
function timestamp(value, style = 'full') {
  if (!value) return '—';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return `<t:${Math.floor(date.getTime() / 1000)}:${TIME_STYLES[style] ?? 'f'}>`;
}

/** `<t:…:F> (<t:…:R>)` — the format used across every audit surface. */
function fullTimestamp(value) {
  if (!value) return '—';
  return `${timestamp(value, 'full')} · ${timestamp(value, 'relative')}`;
}

/**
 * Human readable duration from milliseconds.
 * @param {number} ms
 * @param {{ compact?: boolean, parts?: number }} [options]
 */
function duration(ms, { compact = false, parts = 2 } = {}) {
  const value = Math.abs(Math.round(Number(ms) || 0));
  if (value < 1000) return compact ? '0s' : 'less than a second';

  const units = [
    { label: compact ? 'd' : 'day', ms: 86_400_000 },
    { label: compact ? 'h' : 'hour', ms: 3_600_000 },
    { label: compact ? 'm' : 'minute', ms: 60_000 },
    { label: compact ? 's' : 'second', ms: 1000 },
  ];

  const out = [];
  let remainder = value;
  for (const unit of units) {
    const amount = Math.floor(remainder / unit.ms);
    if (amount > 0) {
      remainder -= amount * unit.ms;
      out.push(compact ? `${amount}${unit.label}` : `${amount} ${unit.label}${amount === 1 ? '' : 's'}`);
    }
    if (out.length >= parts) break;
  }
  return out.length ? out.join(compact ? ' ' : ', ') : compact ? '0s' : '0 seconds';
}

/**
 * Parse a human duration string ("10m", "2h30m", "7d") into milliseconds.
 * @param {string} input
 * @returns {number|null} milliseconds, or null when unparsable
 */
function parseDuration(input) {
  if (input === null || input === undefined) return null;
  const text = String(input).trim().toLowerCase();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text) * 60_000; // bare numbers are minutes

  const pattern = /(\d+(?:\.\d+)?)\s*(ms|s|sec|secs|seconds?|m|min|mins|minutes?|h|hr|hrs|hours?|d|days?|w|weeks?)/g;
  const multipliers = {
    ms: 1, s: 1000, sec: 1000, secs: 1000, second: 1000, seconds: 1000,
    m: 60_000, min: 60_000, mins: 60_000, minute: 60_000, minutes: 60_000,
    h: 3_600_000, hr: 3_600_000, hrs: 3_600_000, hour: 3_600_000, hours: 3_600_000,
    d: 86_400_000, day: 86_400_000, days: 86_400_000,
    w: 604_800_000, week: 604_800_000, weeks: 604_800_000,
  };

  let total = 0;
  let matched = false;
  for (const match of text.matchAll(pattern)) {
    const multiplier = multipliers[match[2]];
    if (!multiplier) continue;
    total += Number(match[1]) * multiplier;
    matched = true;
  }
  return matched && total > 0 ? Math.round(total) : null;
}

/**
 * Format currency for display.
 * @param {number|null|undefined} amount
 * @param {string} [symbol]
 */
function money(amount, symbol = '$') {
  if (amount === null || amount === undefined || Number.isNaN(Number(amount))) return '—';
  const value = Number(amount);
  return `${symbol}${value.toLocaleString('en-US', { minimumFractionDigits: value % 1 === 0 ? 0 : 2, maximumFractionDigits: 2 })}`;
}

/** Thousands separated integer. */
function number(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed.toLocaleString('en-US') : '0';
}

/** Percentage with a single decimal when needed. */
function percent(value, total) {
  const denominator = Number(total);
  if (!denominator) return '0%';
  const ratio = (Number(value) / denominator) * 100;
  return `${ratio % 1 === 0 ? ratio.toFixed(0) : ratio.toFixed(1)}%`;
}

/**
 * Truncate to a maximum length with an ellipsis, never mid-escape.
 * @param {string} text
 * @param {number} max
 */
function truncate(text, max = 1024) {
  const value = String(text ?? '');
  if (value.length <= max) return value;
  return `${value.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Escape Discord markdown so user input cannot break embed layout.
 * @param {string} text
 */
function escapeMarkdown(text) {
  return String(text ?? '').replace(/([\\*_~`|>])/g, '\\$1');
}

/**
 * Neutralise mentions in untrusted text (keeps it readable, removes the ping).
 * @param {string} text
 */
function sanitizeMentions(text) {
  return String(text ?? '')
    .replace(/@(everyone|here)/gi, '@​$1')
    .replace(/<@[!&]?(\d+)>/g, '@​$1');
}

/** Combine escaping + mention neutralisation + truncation for embed fields. */
function safeField(text, max = 1024) {
  const value = sanitizeMentions(String(text ?? '').trim());
  return truncate(value || '—', max);
}

/** Render a horizontal progress bar. */
function progressBar(value, total, size = 12) {
  const ratio = total > 0 ? Math.max(0, Math.min(1, Number(value) / Number(total))) : 0;
  const filled = Math.round(ratio * size);
  return `\`${'█'.repeat(filled)}${'░'.repeat(Math.max(0, size - filled))}\` ${percent(value, total)}`;
}

/**
 * Render an aligned key/value block inside a code fence — used by dashboards.
 * @param {Array<[string, string|number]>} rows
 */
function keyValueBlock(rows) {
  if (!rows.length) return '```\nNo data\n```';
  const width = Math.max(...rows.map(([key]) => String(key).length));
  const body = rows.map(([key, value]) => `${String(key).padEnd(width)} : ${value}`).join('\n');
  return `\`\`\`\n${truncate(body, 1000)}\n\`\`\``;
}

/**
 * Render a simple fixed-width table inside a code fence.
 * @param {string[]} headers
 * @param {Array<Array<string|number>>} rows
 */
function table(headers, rows) {
  if (!rows.length) return '```\nNo entries\n```';
  const all = [headers, ...rows].map((row) => row.map((cell) => String(cell ?? '')));
  const widths = headers.map((_, index) => Math.min(24, Math.max(...all.map((row) => (row[index] ?? '').length))));
  const render = (row) => row.map((cell, index) => truncate(cell, widths[index]).padEnd(widths[index])).join('  ');
  const separator = widths.map((width) => '─'.repeat(width)).join('  ');
  const body = [render(all[0]), separator, ...all.slice(1).map(render)].join('\n');
  return `\`\`\`\n${truncate(body, 1800)}\n\`\`\``;
}

/** A bulleted list with the house bullet glyph. */
function bullets(items) {
  const list = items.filter(Boolean);
  if (!list.length) return '—';
  return list.map((item) => `${EMOJIS.bullet} ${item}`).join('\n');
}

/** `1st`, `2nd`, `3rd`, … */
function ordinal(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return String(value);
  const suffix = ['th', 'st', 'nd', 'rd'][(n % 100 - 20) % 10] || ['th', 'st', 'nd', 'rd'][n % 100] || 'th';
  return `${n}${suffix}`;
}

/** Zero-padded ticket / order display id. */
function padId(value, size = 4) {
  return String(value ?? 0).padStart(size, '0');
}

/** Medal glyph for leaderboard positions. */
function medal(position) {
  return ['🥇', '🥈', '🥉'][position] ?? `\`#${position + 1}\``;
}

/** Convert bytes to a readable size. */
function bytes(value) {
  const units = ['B', 'KB', 'MB', 'GB'];
  let size = Number(value) || 0;
  let unit = 0;
  while (size >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${size.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`;
}

/** Turn a slug into Title Case ("free-commission" -> "Free Commission"). */
function titleCase(value) {
  return String(value ?? '')
    .replace(/[-_]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

/** Pluralise a noun against a count. */
function plural(count, singular, pluralForm) {
  const n = Number(count) || 0;
  return `${number(n)} ${n === 1 ? singular : pluralForm ?? `${singular}s`}`;
}

module.exports = {
  timestamp,
  fullTimestamp,
  duration,
  parseDuration,
  money,
  number,
  percent,
  truncate,
  escapeMarkdown,
  sanitizeMentions,
  safeField,
  progressBar,
  keyValueBlock,
  table,
  bullets,
  ordinal,
  padId,
  medal,
  bytes,
  titleCase,
  plural,
};
