'use strict';

/**
 * Configuration barrel — import everything config-related from here.
 *
 *   const { env, COLORS, TICKET_TYPES } = require('../config');
 */

const { env, validate, ensureDirectories } = require('./env');
const branding = require('./branding');
const server = require('./server');
const content = require('./content');
const { DEFAULT_CONFIG, ACTIONS } = require('./defaults');
const permissions = require('./permissions');

module.exports = {
  env,
  validateEnv: validate,
  ensureDirectories,
  ...branding,
  ...server,
  content,
  DEFAULT_CONFIG,
  MOD_ACTIONS: ACTIONS,
  ...permissions,
};
