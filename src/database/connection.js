'use strict';

/**
 * MongoDB connection lifecycle.
 *
 * Handles the initial connect with bounded exponential backoff, keeps the
 * process informed about reconnects, and shuts the pool down cleanly so that
 * in-flight writes are never lost on SIGTERM.
 */

const mongoose = require('mongoose');
const { env } = require('../config/env');
const { logger } = require('../utils/logger');

const log = logger.child('database');

/**
 * Fail fast on unknown paths instead of silently dropping data.
 */
mongoose.set('strictQuery', true);

/**
 * Operator-injection defence — and why `sanitizeFilter` is deliberately OFF.
 *
 * Mongoose's global `sanitizeFilter` rewrites *any* nested object containing a
 * `$` key into `{ $eq: <object> }`, and throws outright on `$expr`. It cannot
 * distinguish a hostile value from a query this codebase wrote itself, so
 * enabling it would silently break every legitimate operator — an open-ticket
 * count of `{ status: { $in: [...] } }` becomes `{ status: { $eq: { $in: [...] } } }`
 * and matches nothing. That is a far worse failure than the one it prevents:
 * queries that quietly return empty results instead of erroring.
 *
 * Injection is instead prevented at the boundary, where it is precise:
 *   • Discord coerces every slash-command option to a primitive, so an option
 *     value can never arrive as an object.
 *   • The custom-ID protocol decodes to strings only (see utils/customId).
 *   • `validators.safeQueryValue` rejects objects and `$`-prefixed strings for
 *     anything that reaches a filter position.
 *   • `validators.sanitizeObject` strips `$` keys and dotted paths from any
 *     object before it is persisted.
 *   • `strictQuery` above discards conditions on paths that are not in the
 *     schema, so an unexpected key cannot widen a query.
 *
 * A regression test in tests/models.test.js documents this decision by asserting
 * exactly what the flag would do to real queries.
 */

let connecting = null;
let ready = false;

/** Attach lifecycle listeners exactly once. */
function bindEvents() {
  const connection = mongoose.connection;
  if (connection.listenerCount('connected')) return;

  connection.on('connected', () => {
    ready = true;
    log.success(`Connected to MongoDB (${connection.name})`);
  });
  connection.on('disconnected', () => {
    ready = false;
    log.warn('MongoDB disconnected — the driver will retry automatically.');
  });
  connection.on('reconnected', () => {
    ready = true;
    log.success('MongoDB reconnected.');
  });
  connection.on('error', (err) => {
    log.error('MongoDB connection error', { message: err.message });
  });
}

/**
 * Connect to MongoDB, retrying with exponential backoff.
 * @param {{ retries?: number }} [options]
 * @returns {Promise<typeof mongoose>}
 */
async function connect({ retries = 5 } = {}) {
  if (ready) return mongoose;
  if (connecting) return connecting;

  bindEvents();

  connecting = (async () => {
    let lastError;
    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        log.info(`Connecting to MongoDB (attempt ${attempt}/${retries})…`);
        await mongoose.connect(env.databaseUrl, {
          dbName: env.databaseName,
          serverSelectionTimeoutMS: 10_000,
          socketTimeoutMS: 45_000,
          maxPoolSize: 20,
          minPoolSize: 2,
          retryWrites: true,
          autoIndex: !env.isProduction,
        });
        ready = true;
        // In production, build indexes explicitly once rather than on every model
        // access — it keeps cold starts predictable.
        if (env.isProduction) await syncIndexes();
        return mongoose;
      } catch (err) {
        lastError = err;
        const delay = Math.min(30_000, 2 ** attempt * 1000);
        log.error(`MongoDB connection failed: ${err.message}`);
        if (attempt < retries) {
          log.info(`Retrying in ${Math.round(delay / 1000)}s…`);
          await new Promise((resolve) => setTimeout(resolve, delay));
        }
      }
    }
    throw new Error(`Could not connect to MongoDB after ${retries} attempts: ${lastError?.message}`);
  })();

  try {
    return await connecting;
  } finally {
    connecting = null;
  }
}

/** Build every model's indexes. Safe to call repeatedly. */
async function syncIndexes() {
  const models = Object.values(mongoose.models);
  const results = await Promise.allSettled(models.map((model) => model.createIndexes()));
  const failed = results.filter((result) => result.status === 'rejected');
  if (failed.length) {
    log.warn(`${failed.length} index build(s) failed`, { errors: failed.map((f) => f.reason?.message) });
  } else {
    log.info(`Indexes verified for ${models.length} models.`);
  }
}

/** Close the pool. */
async function disconnect() {
  if (mongoose.connection.readyState === 0) return;
  await mongoose.connection.close(false);
  ready = false;
  log.info('MongoDB connection closed.');
}

/** Connection health snapshot for `/statistics` and the doctor script. */
function health() {
  const states = ['disconnected', 'connected', 'connecting', 'disconnecting'];
  return {
    state: states[mongoose.connection.readyState] ?? 'unknown',
    ready,
    database: mongoose.connection.name ?? null,
    host: mongoose.connection.host ?? null,
    models: Object.keys(mongoose.models).length,
  };
}

/** Whether the database is currently usable. */
const isReady = () => mongoose.connection.readyState === 1;

module.exports = { connect, disconnect, syncIndexes, health, isReady, mongoose };
