'use strict';

/**
 * Input validation and sanitisation.
 *
 * Everything a user can type reaches the database through one of these
 * functions. They strip control characters, cap length, reject NoSQL operator
 * injection and normalise Unicode so lookalike attacks fail.
 */

const { ValidationError } = require('./errors');

/** Discord snowflakes are 17-20 digit numeric strings. */
const SNOWFLAKE = /^\d{17,20}$/;
const URL_PATTERN = /^https?:\/\/[^\s<>"'`]+$/i;
const HOSTNAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/**
 * Remove control characters, zero-width joiners abused for spoofing, and
 * collapse absurd whitespace runs. Applied to every free-text field.
 * @param {unknown} value
 * @param {{ max?: number, allowNewlines?: boolean }} [options]
 */
function clean(value, { max = 2000, allowNewlines = true } = {}) {
  let text = String(value ?? '');
  // Strip C0/C1 control characters except tab/newline/carriage return.
  text = text.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '');
  // Strip zero-width and bidirectional override characters.
  text = text.replace(/[\u200B-\u200F\u202A-\u202E\u2060-\u2064\uFEFF]/g, '');
  if (!allowNewlines) text = text.replace(/[\r\n]+/g, ' ');
  else text = text.replace(/\n{4,}/g, '\n\n\n');
  text = text.replace(/[ \t]{4,}/g, '   ').trim();
  return text.slice(0, max);
}

/**
 * Validate and clean a required free-text field.
 * @param {unknown} value
 * @param {string} label used in the error message
 * @param {{ min?: number, max?: number, required?: boolean, allowNewlines?: boolean }} [options]
 */
function text(value, label, { min = 1, max = 1000, required = true, allowNewlines = true } = {}) {
  const result = clean(value, { max, allowNewlines });
  if (!result) {
    if (required) throw new ValidationError(`**${label}** is required.`);
    return '';
  }
  if (result.length < min) throw new ValidationError(`**${label}** must be at least ${min} characters.`);
  return result;
}

/**
 * Validate a Discord snowflake.
 * @param {unknown} value
 * @param {string} [label]
 */
function snowflake(value, label = 'ID') {
  const id = String(value ?? '').trim();
  if (!SNOWFLAKE.test(id)) throw new ValidationError(`**${label}** must be a valid Discord ID.`);
  return id;
}

/** Non-throwing snowflake check. */
const isSnowflake = (value) => SNOWFLAKE.test(String(value ?? '').trim());

/** MongoDB ObjectIds are 24 hexadecimal characters. */
const OBJECT_ID = /^[0-9a-f]{24}$/i;

/**
 * Validate a MongoDB ObjectId taken from a component's custom ID.
 *
 * This guard matters more than it looks: Mongoose strips `undefined` values out
 * of a filter, so `findOne({ _id: undefined, guildId })` silently becomes
 * `findOne({ guildId })` and returns an arbitrary document. A component from an
 * older panel version, or one whose argument was dropped, must fail closed.
 *
 * @param {unknown} value
 * @param {string} [label]
 * @returns {string}
 */
function objectId(value, label = 'record') {
  const id = String(value ?? '').trim();
  if (!OBJECT_ID.test(id)) {
    throw new ValidationError(`This control is out of date and no longer points at a valid ${label}. Please refresh the panel.`);
  }
  return id;
}

/** Non-throwing ObjectId check. */
const isObjectId = (value) => OBJECT_ID.test(String(value ?? '').trim());

/**
 * Validate a URL, restricted to http(s) and free of embedded credentials.
 * @param {unknown} value
 * @param {{ required?: boolean, label?: string }} [options]
 */
function url(value, { required = false, label = 'URL' } = {}) {
  const raw = clean(value, { max: 500, allowNewlines: false });
  if (!raw) {
    if (required) throw new ValidationError(`**${label}** is required.`);
    return '';
  }
  if (!URL_PATTERN.test(raw)) throw new ValidationError(`**${label}** must be a valid http(s) link.`);
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw new ValidationError(`**${label}** is not a valid link.`);
  }
  if (parsed.username || parsed.password) throw new ValidationError(`**${label}** must not contain credentials.`);
  return parsed.toString();
}

/**
 * Extract every http(s) link from arbitrary text (used by the link filter and
 * by "reference links" form fields).
 * @param {string} value
 * @returns {string[]}
 */
function extractUrls(value) {
  const matches = String(value ?? '').match(/https?:\/\/[^\s<>"'`)\]]+/gi) ?? [];
  return [...new Set(matches.map((match) => match.replace(/[.,;!?]+$/, '')))];
}

/**
 * Validate a number within bounds.
 * @param {unknown} value
 * @param {string} label
 * @param {{ min?: number, max?: number, integer?: boolean, required?: boolean, fallback?: number|null }} [options]
 */
function num(value, label, { min = -Infinity, max = Infinity, integer = false, required = true, fallback = null } = {}) {
  if (value === null || value === undefined || value === '') {
    if (required) throw new ValidationError(`**${label}** is required.`);
    return fallback;
  }
  const parsed = Number(String(value).replace(/[^0-9.\-]/g, ''));
  if (!Number.isFinite(parsed)) throw new ValidationError(`**${label}** must be a number.`);
  if (integer && !Number.isInteger(parsed)) throw new ValidationError(`**${label}** must be a whole number.`);
  if (parsed < min || parsed > max) throw new ValidationError(`**${label}** must be between ${min} and ${max}.`);
  return parsed;
}

/**
 * Parse a loosely-typed budget string ("around $250", "150-300 USD") into a
 * numeric estimate plus the original text, which is preserved for the quote.
 * @param {unknown} value
 */
function budget(value) {
  const raw = clean(value, { max: 100, allowNewlines: false });
  if (!raw) return { raw: '', amount: null };
  const numbers = raw.match(/\d+(?:[.,]\d+)?/g);
  if (!numbers) return { raw, amount: null };
  const parsed = numbers.map((n) => Number(n.replace(/,/g, ''))).filter(Number.isFinite);
  if (!parsed.length) return { raw, amount: null };
  // For a range, take the midpoint so queue value estimates stay honest.
  const amount = parsed.length > 1 ? (Math.min(...parsed) + Math.max(...parsed)) / 2 : parsed[0];
  return { raw, amount: Math.round(amount * 100) / 100 };
}

/**
 * Reject values that would be interpreted as MongoDB query operators.
 * Applied to anything that is used as a query key or value.
 * @param {unknown} value
 */
function safeQueryValue(value) {
  if (value && typeof value === 'object') {
    throw new ValidationError('Invalid query value.');
  }
  const text = String(value ?? '');
  if (text.startsWith('$') || text.includes('\0')) throw new ValidationError('Invalid query value.');
  return text;
}

/**
 * Strip `$` prefixed keys and dots out of an object before it is persisted or
 * used as a filter. Defence-in-depth against operator injection.
 * @param {object} input
 * @param {number} [depth]
 */
function sanitizeObject(input, depth = 0) {
  if (depth > 5 || input === null || typeof input !== 'object') return input;
  if (Array.isArray(input)) return input.map((item) => sanitizeObject(item, depth + 1));
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    if (key.startsWith('$') || key.includes('.')) continue;
    out[key] = sanitizeObject(value, depth + 1);
  }
  return out;
}

/**
 * Escape a string for safe use inside a RegExp.
 * @param {string} value
 */
function escapeRegex(value) {
  return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a user-supplied pattern defensively.
 * Rejects patterns that are obviously catastrophic-backtracking prone.
 * @param {string} pattern
 * @param {string} [flags]
 * @returns {RegExp|null}
 */
function compilePattern(pattern, flags = 'i') {
  const source = String(pattern ?? '').trim();
  if (!source || source.length > 200) return null;

  /*
   * Reject the classic catastrophic-backtracking shapes before compiling.
   * The dangerous form is a quantified group whose body is itself quantified —
   * `(a+)+`, `(a*)*`, `(\d+|x)*`, `(?:ab+)+` — because the engine can split the
   * same input across the inner and outer quantifiers exponentially many ways.
   *
   * `[^()\\]|\\.` matches a group body without nesting or escape confusion, so
   * `\(` and `\+` inside a pattern are not mistaken for structure.
   */
  const QUANTIFIED_GROUP_BODY = /\((?:\?[:=!<]*)?(?:[^()\\]|\\.)*[*+}](?:[^()\\]|\\.)*\)\s*[*+{]/;
  // Two adjacent quantifiers, e.g. `a+*` or `)+ *`.
  const STACKED_QUANTIFIERS = /[*+}]\s*[*+]/;

  if (QUANTIFIED_GROUP_BODY.test(source) || STACKED_QUANTIFIERS.test(source)) return null;

  try {
    return new RegExp(source, flags);
  } catch {
    return null;
  }
}

/**
 * Validate a hostname / domain entry for the link filter.
 * @param {string} value
 */
function domain(value) {
  const raw = clean(value, { max: 255, allowNewlines: false }).toLowerCase().replace(/^\*?\.?/, '').replace(/\/.*$/, '');
  if (!HOSTNAME.test(raw)) throw new ValidationError(`\`${raw || value}\` is not a valid domain.`);
  return raw;
}

/**
 * Validate a hex colour and return it as an integer.
 * @param {string} value
 */
function color(value) {
  const raw = String(value ?? '').trim().replace(/^#/, '');
  if (!/^[0-9a-f]{6}$/i.test(raw)) throw new ValidationError('Colour must be a 6-digit hex value, e.g. `#6366F1`.');
  return parseInt(raw, 16);
}

/**
 * Validate an `HH:MM` time-of-day string.
 * @param {string} value
 */
function timeOfDay(value) {
  const raw = String(value ?? '').trim();
  if (!/^([01]\d|2[0-3]):([0-5]\d)$/.test(raw)) throw new ValidationError('Time must be in 24-hour `HH:MM` format.');
  return raw;
}

/**
 * Validate an IANA timezone using the runtime's own database.
 * @param {string} value
 */
function timezone(value) {
  const raw = String(value ?? '').trim();
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: raw });
    return raw;
  } catch {
    throw new ValidationError('That is not a recognised timezone. Use an IANA name such as `Europe/Amsterdam`.');
  }
}

/**
 * Validate a channel name fragment for ticket renames.
 * @param {string} value
 */
function channelName(value) {
  const raw = clean(value, { max: 90, allowNewlines: false })
    .toLowerCase()
    .replace(/[^a-z0-9¡-￿\s_-]/gi, '')
    .replace(/\s+/g, '-')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  if (raw.length < 2) throw new ValidationError('Channel names need at least two usable characters.');
  return raw.slice(0, 90);
}

/**
 * Validate a Minecraft-style server address (`host` or `host:port`).
 * @param {string} value
 */
function serverAddress(value) {
  const raw = clean(value, { max: 120, allowNewlines: false }).toLowerCase();
  if (!raw) throw new ValidationError('**Server IP** is required.');
  const [host, port] = raw.split(':');
  const isIp = /^\d{1,3}(\.\d{1,3}){3}$/.test(host);
  if (!isIp && !HOSTNAME.test(host)) throw new ValidationError('**Server IP** must be a valid address or domain.');
  if (port !== undefined && !/^\d{1,5}$/.test(port)) throw new ValidationError('**Server IP** has an invalid port.');
  return raw;
}

module.exports = {
  clean,
  text,
  snowflake,
  isSnowflake,
  objectId,
  isObjectId,
  url,
  extractUrls,
  num,
  budget,
  safeQueryValue,
  sanitizeObject,
  escapeRegex,
  compilePattern,
  domain,
  color,
  timeOfDay,
  timezone,
  channelName,
  serverAddress,
  SNOWFLAKE,
};
