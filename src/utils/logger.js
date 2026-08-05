'use strict';

/**
 * Structured logger.
 *
 * Dependency-free by design: writes coloured, aligned lines to stdout and
 * newline-delimited JSON to daily rotating files. Every subsystem creates a
 * scoped child (`logger.child('tickets')`) so log lines are attributable.
 *
 * Levels: error < warn < info < debug < trace
 */

const fs = require('node:fs');
const path = require('node:path');
const { env } = require('../config/env');

const LEVELS = { error: 0, warn: 1, info: 2, debug: 3, trace: 4 };

const COLOR = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
  gray: '\x1b[90m',
  green: '\x1b[32m',
};

const LEVEL_STYLE = {
  error: { color: COLOR.red, label: 'ERROR' },
  warn: { color: COLOR.yellow, label: 'WARN ' },
  info: { color: COLOR.cyan, label: 'INFO ' },
  debug: { color: COLOR.magenta, label: 'DEBUG' },
  trace: { color: COLOR.gray, label: 'TRACE' },
};

/** Keys that must never reach a log sink. */
const REDACT_KEYS = [
  'token', 'bot_token', 'authorization', 'password', 'secret', 'apikey', 'api_key',
  'databaseurl', 'database_url', 'connectionstring', 'clientsecret', 'client_secret',
];

/** Values that look like credentials get masked wherever they appear. */
const SECRET_VALUES = [env.token, env.databaseUrl].filter((v) => v && v.length > 8);

/**
 * Recursively strip secrets out of a metadata object.
 * @param {unknown} value
 * @param {number} depth
 */
function redact(value, depth = 0) {
  if (depth > 6) return '[Truncated]';
  if (value === null || value === undefined) return value;

  if (typeof value === 'string') {
    let out = value;
    for (const secret of SECRET_VALUES) {
      if (out.includes(secret)) out = out.split(secret).join('[REDACTED]');
    }
    return out;
  }
  if (typeof value !== 'object') return value;
  if (value instanceof Error) {
    return { name: value.name, message: redact(value.message, depth + 1), stack: redact(value.stack, depth + 1) };
  }
  if (Array.isArray(value)) return value.slice(0, 50).map((v) => redact(v, depth + 1));

  const out = {};
  for (const [key, val] of Object.entries(value)) {
    out[key] = REDACT_KEYS.includes(key.toLowerCase()) ? '[REDACTED]' : redact(val, depth + 1);
  }
  return out;
}

/** Safe JSON stringify that survives circular references. */
function safeStringify(obj) {
  const seen = new WeakSet();
  try {
    return JSON.stringify(obj, (key, value) => {
      if (typeof value === 'object' && value !== null) {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      if (typeof value === 'bigint') return value.toString();
      return value;
    });
  } catch {
    return '{"error":"unserializable log payload"}';
  }
}

class Logger {
  /**
   * @param {string} scope
   * @param {{ level?: string, toFile?: boolean, dir?: string }} [options]
   */
  constructor(scope = 'core', options = {}) {
    this.scope = scope;
    this.level = options.level ?? env.logLevel;
    this.toFile = options.toFile ?? env.logToFile;
    this.dir = options.dir ?? env.logDir;
    /** @type {Map<string, fs.WriteStream>} */
    this.streams = Logger._streams;
  }

  /** Shared stream cache so children never open duplicate handles. */
  static _streams = new Map();

  /** Create a scoped child logger that shares this logger's configuration. */
  child(scope) {
    return new Logger(`${this.scope}:${scope}`, { level: this.level, toFile: this.toFile, dir: this.dir });
  }

  /** @param {string} level */
  enabled(level) {
    return (LEVELS[level] ?? 2) <= (LEVELS[this.level] ?? 2);
  }

  /** Resolve (and lazily open) today's log stream for a given channel. */
  _stream(name) {
    const day = new Date().toISOString().slice(0, 10);
    const key = `${name}-${day}`;
    let stream = this.streams.get(key);
    if (!stream) {
      try {
        fs.mkdirSync(this.dir, { recursive: true });
        stream = fs.createWriteStream(path.join(this.dir, `${key}.log`), { flags: 'a' });
        stream.on('error', () => this.streams.delete(key));
        this.streams.set(key, stream);
        // Close yesterday's handles so the process does not leak descriptors.
        for (const [existingKey, existingStream] of this.streams) {
          if (!existingKey.endsWith(day)) {
            existingStream.end();
            this.streams.delete(existingKey);
          }
        }
      } catch {
        return null;
      }
    }
    return stream;
  }

  /**
   * @param {keyof LEVELS} level
   * @param {string} message
   * @param {object} [meta]
   */
  log(level, message, meta = {}) {
    if (!this.enabled(level)) return;

    const timestamp = new Date();
    const clean = redact(meta);
    const style = LEVEL_STYLE[level] ?? LEVEL_STYLE.info;

    const time = timestamp.toISOString().replace('T', ' ').slice(0, 19);
    const metaKeys = clean && typeof clean === 'object' ? Object.keys(clean) : [];
    const suffix = metaKeys.length ? ` ${COLOR.dim}${safeStringify(clean)}${COLOR.reset}` : '';

    const line =
      `${COLOR.gray}${time}${COLOR.reset} ` +
      `${style.color}${COLOR.bold}${style.label}${COLOR.reset} ` +
      `${COLOR.dim}[${this.scope}]${COLOR.reset} ` +
      `${redact(String(message))}${suffix}`;

    if (level === 'error') process.stderr.write(`${line}\n`);
    else process.stdout.write(`${line}\n`);

    if (!this.toFile) return;
    const payload = safeStringify({
      ts: timestamp.toISOString(),
      level,
      scope: this.scope,
      message: redact(String(message)),
      ...(metaKeys.length ? { meta: clean } : {}),
    });

    this._stream('app')?.write(`${payload}\n`);
    if (level === 'error') this._stream('error')?.write(`${payload}\n`);
  }

  error(message, meta) { this.log('error', message, meta); }
  warn(message, meta) { this.log('warn', message, meta); }
  info(message, meta) { this.log('info', message, meta); }
  debug(message, meta) { this.log('debug', message, meta); }
  trace(message, meta) { this.log('trace', message, meta); }

  /** Prominent success line — used for lifecycle milestones. */
  success(message, meta) {
    if (!this.enabled('info')) return;
    process.stdout.write(
      `${COLOR.gray}${new Date().toISOString().replace('T', ' ').slice(0, 19)}${COLOR.reset} ` +
      `${COLOR.green}${COLOR.bold}OK   ${COLOR.reset} ${COLOR.dim}[${this.scope}]${COLOR.reset} ${message}\n`,
    );
    if (this.toFile) {
      this._stream('app')?.write(`${safeStringify({ ts: new Date().toISOString(), level: 'info', scope: this.scope, message, ...(meta ? { meta: redact(meta) } : {}) })}\n`);
    }
  }

  /** Flush and close every open file handle (used during shutdown). */
  static async close() {
    const closing = [...Logger._streams.values()].map(
      (stream) => new Promise((resolve) => stream.end(resolve)),
    );
    Logger._streams.clear();
    await Promise.allSettled(closing);
  }
}

const logger = new Logger('bot');

module.exports = { logger, Logger, redact };
