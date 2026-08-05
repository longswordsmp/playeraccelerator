'use strict';

/**
 * Error taxonomy.
 *
 * `AppError` and its subclasses carry a user-safe message. Anything else that
 * reaches the interaction boundary is treated as an internal fault: the user
 * sees a generic apology plus a correlation id, and the full stack goes to the
 * logs and the bot-log channel only.
 */

const crypto = require('node:crypto');

/** Base class for every error that is safe to show a user. */
class AppError extends Error {
  /**
   * @param {string} message user-facing message
   * @param {{ code?: string, status?: number, meta?: object, ephemeral?: boolean }} [options]
   */
  constructor(message, { code = 'APP_ERROR', meta = {}, ephemeral = true } = {}) {
    super(message);
    this.name = new.target.name;
    this.code = code;
    this.meta = meta;
    this.ephemeral = ephemeral;
    /** Marks the message as safe to render verbatim. */
    this.userFacing = true;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** The actor is not allowed to do this. */
class PermissionError extends AppError {
  constructor(message = 'You do not have permission to use this.', meta) {
    super(message, { code: 'PERMISSION_DENIED', meta });
  }
}

/** User input failed validation. */
class ValidationError extends AppError {
  constructor(message = 'That input is not valid.', meta) {
    super(message, { code: 'VALIDATION_FAILED', meta });
  }
}

/** The referenced entity does not exist. */
class NotFoundError extends AppError {
  constructor(message = 'That record could not be found.', meta) {
    super(message, { code: 'NOT_FOUND', meta });
  }
}

/** The action is valid but not allowed in the current state. */
class ConflictError extends AppError {
  constructor(message = 'That action cannot be performed right now.', meta) {
    super(message, { code: 'CONFLICT', meta });
  }
}

/** The user is going too fast. */
class RateLimitError extends AppError {
  constructor(message = 'You are doing that too quickly. Please slow down.', meta) {
    super(message, { code: 'RATE_LIMITED', meta });
  }
}

/** A Discord API limitation prevents the requested action. */
class DiscordLimitationError extends AppError {
  constructor(message, meta) {
    super(message, { code: 'DISCORD_LIMITATION', meta });
  }
}

/** Something the bot depends on is not configured yet. */
class ConfigurationError extends AppError {
  constructor(message = 'The bot is not configured for that yet. Run `/setup` first.', meta) {
    super(message, { code: 'NOT_CONFIGURED', meta });
  }
}

/** Short, human-quotable correlation id for support. */
function correlationId() {
  return crypto.randomBytes(4).toString('hex').toUpperCase();
}

/**
 * Decide what a user should see for a given thrown value.
 * @param {unknown} err
 * @returns {{ message: string, internal: boolean, reference: string|null, code: string }}
 */
function describe(err) {
  if (err instanceof AppError) {
    return { message: err.message, internal: false, reference: null, code: err.code };
  }

  // Discord API errors carry useful, non-sensitive hints worth surfacing.
  const discordCode = err?.code;
  const known = {
    50013: 'I am missing the permissions required for that action. Check my role position and channel overwrites.',
    50001: 'I cannot access that channel.',
    50035: 'Discord rejected that request because one of the values was invalid.',
    10008: 'That message no longer exists.',
    10003: 'That channel no longer exists.',
    10011: 'That role no longer exists.',
    10013: 'That user could not be found.',
    30005: 'This server has reached Discord\'s maximum number of roles (250).',
    30013: 'This server has reached Discord\'s maximum number of channels (500).',
    40005: 'That file is too large for Discord to accept.',
    50033: 'That request was invalid because the target no longer exists.',
    50024: 'That action cannot be performed on this channel type.',
  }[discordCode];

  if (known) return { message: known, internal: false, reference: null, code: `DISCORD_${discordCode}` };

  return {
    message: 'An unexpected error occurred. The team has been notified.',
    internal: true,
    reference: correlationId(),
    code: 'INTERNAL_ERROR',
  };
}

module.exports = {
  AppError,
  PermissionError,
  ValidationError,
  NotFoundError,
  ConflictError,
  RateLimitError,
  DiscordLimitationError,
  ConfigurationError,
  describe,
  correlationId,
};
