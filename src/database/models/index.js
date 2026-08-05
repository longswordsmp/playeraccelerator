'use strict';

/**
 * Model barrel.
 *
 *   const { Ticket, Order, Review } = require('../database/models');
 *
 * Requiring this module registers every schema with Mongoose, which is what
 * makes `syncIndexes()` at boot able to see all of them.
 */

module.exports = {
  Backup: require('./Backup'),
  Configuration: require('./Configuration'),
  Counter: require('./Counter'),
  GuildStats: require('./GuildStats'),
  Log: require('./Log'),
  Moderation: require('./Moderation'),
  Order: require('./Order'),
  Portfolio: require('./Portfolio'),
  Promotion: require('./Promotion'),
  Review: require('./Review'),
  StaffStats: require('./StaffStats'),
  Ticket: require('./Ticket'),
  User: require('./User'),
};
