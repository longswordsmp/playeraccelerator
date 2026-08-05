'use strict';

/**
 * Environment loader & validator.
 *
 * Loads `.env` once, coerces values into their proper types and fails fast with
 * a readable error when a required secret is missing. Nothing else in the
 * codebase should ever read `process.env` directly — import this module instead.
 */

const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.resolve(__dirname, '..', '..');

require('dotenv').config({ path: path.join(ROOT, '.env') });

/** Parse a boolean-ish environment value. */
function bool(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on', 'enabled'].includes(String(value).trim().toLowerCase());
}

/** Parse a comma separated list into a de-duplicated array of trimmed strings. */
function list(value) {
  if (!value) return [];
  return [...new Set(String(value).split(',').map((v) => v.trim()).filter(Boolean))];
}

/** Resolve a possibly-relative path against the project root. */
function resolvePath(value, fallback) {
  const target = value && String(value).trim() ? String(value).trim() : fallback;
  return path.isAbsolute(target) ? target : path.join(ROOT, target);
}

const env = Object.freeze({
  root: ROOT,

  // Discord
  token: process.env.BOT_TOKEN?.trim() || '',
  clientId: process.env.CLIENT_ID?.trim() || '',
  guildId: process.env.GUILD_ID?.trim() || '',
  owners: list(process.env.OWNER_ID),

  // Database
  databaseUrl: process.env.DATABASE_URL?.trim() || '',
  databaseName: process.env.DATABASE_NAME?.trim() || undefined,

  // Runtime
  nodeEnv: (process.env.NODE_ENV || 'production').trim(),
  get isProduction() {
    return this.nodeEnv === 'production';
  },
  logLevel: (process.env.LOG_LEVEL || 'info').trim().toLowerCase(),
  logToFile: bool(process.env.LOG_TO_FILE, true),
  autoDeployCommands: bool(process.env.AUTO_DEPLOY_COMMANDS, true),

  // Paths
  transcriptDir: resolvePath(process.env.TRANSCRIPT_DIR, 'transcripts'),
  backupDir: resolvePath(process.env.BACKUP_DIR, 'backups'),
  logDir: resolvePath(process.env.LOG_DIR, 'logs'),
  transcriptBaseUrl: (process.env.TRANSCRIPT_BASE_URL || '').replace(/\/+$/, ''),

  // Optional integrations
  imageModeration: {
    url: process.env.IMAGE_MODERATION_API_URL?.trim() || '',
    key: process.env.IMAGE_MODERATION_API_KEY?.trim() || '',
    get enabled() {
      return Boolean(this.url);
    },
  },
  urlReputation: {
    url: process.env.URL_REPUTATION_API_URL?.trim() || '',
    key: process.env.URL_REPUTATION_API_KEY?.trim() || '',
    get enabled() {
      return Boolean(this.url);
    },
  },
});

/**
 * Validate that every hard requirement is present.
 * @param {{ requireDiscord?: boolean, requireDatabase?: boolean }} [options]
 * @returns {string[]} list of human readable problems (empty when healthy)
 */
function validate({ requireDiscord = true, requireDatabase = true } = {}) {
  const problems = [];

  if (requireDiscord) {
    if (!env.token) problems.push('BOT_TOKEN is missing — create a bot at discord.com/developers and copy its token.');
    if (!env.clientId) problems.push('CLIENT_ID is missing — copy the Application ID from the Developer Portal.');
    if (env.clientId && !/^\d{17,20}$/.test(env.clientId)) problems.push('CLIENT_ID must be a numeric Discord snowflake.');
    if (env.guildId && !/^\d{17,20}$/.test(env.guildId)) problems.push('GUILD_ID must be a numeric Discord snowflake (or empty for global commands).');
    for (const owner of env.owners) {
      if (!/^\d{17,20}$/.test(owner)) problems.push(`OWNER_ID contains an invalid snowflake: "${owner}".`);
    }
    if (env.owners.length === 0) problems.push('OWNER_ID is missing — at least one owner is required for privileged commands.');
  }

  if (requireDatabase && !env.databaseUrl) {
    problems.push('DATABASE_URL is missing — point it at a MongoDB instance.');
  }
  if (requireDatabase && env.databaseUrl && !/^mongodb(\+srv)?:\/\//.test(env.databaseUrl)) {
    problems.push('DATABASE_URL must start with mongodb:// or mongodb+srv://');
  }

  return problems;
}

/** Ensure runtime directories exist before anything tries to write into them. */
function ensureDirectories() {
  for (const dir of [env.transcriptDir, env.backupDir, env.logDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

module.exports = { env, validate, ensureDirectories, bool, list };
