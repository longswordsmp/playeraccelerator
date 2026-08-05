'use strict';

/**
 * Model-layer tests that run without a database.
 *
 * Mongoose validates documents, resolves virtuals, runs instance methods and
 * builds queries entirely in memory, so schema mistakes, broken virtuals and
 * malformed filters are all catchable offline. Anything that genuinely needs a
 * live server (index enforcement, aggregation results, TTL expiry) is covered by
 * the manual checklist in the README instead.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_TO_FILE = 'false';
process.env.LOG_LEVEL = 'error';

const models = require('../src/database/models');
const { DEFAULT_CONFIG } = require('../src/config/defaults');

const GUILD = '111111111111111111';
const USER = '222222222222222222';
const STAFF = '333333333333333333';

// ── Schema integrity ─────────────────────────────────────────────────────────

test('every model is registered exactly once', () => {
  const names = Object.keys(models);
  assert.equal(names.length, 13);
  assert.equal(new Set(names).size, names.length);
  for (const [name, model] of Object.entries(models)) {
    assert.equal(typeof model.findOne, 'function', `${name} is a Mongoose model`);
  }
});

test('required fields are enforced', () => {
  const ticket = new models.Ticket({ guildId: GUILD });
  const error = ticket.validateSync();
  assert.ok(error, 'a ticket without number/userId/type is invalid');
  assert.ok(error.errors.number);
  assert.ok(error.errors.userId);
  assert.ok(error.errors.type);
});

test('enums reject unknown values', () => {
  const ticket = new models.Ticket({
    guildId: GUILD, number: 1, userId: USER, type: 'website', priority: 'catastrophic',
  });
  assert.ok(ticket.validateSync()?.errors?.priority, 'priority is constrained');

  const review = new models.Review({ guildId: GUILD, number: 1, userId: USER, rating: 9 });
  assert.ok(review.validateSync()?.errors?.rating, 'rating is capped at 5');

  const moderation = new models.Moderation({
    guildId: GUILD, caseId: 1, type: 'vaporise', userId: USER, moderatorId: STAFF,
  });
  assert.ok(moderation.validateSync()?.errors?.type, 'case type is constrained');
});

test('a fully populated ticket validates cleanly', () => {
  const ticket = new models.Ticket({
    guildId: GUILD,
    number: 42,
    userId: USER,
    username: 'customer#0001',
    type: 'website',
    typeLabel: 'Website Development',
    priority: 'high',
    status: 'claimed',
    channelId: '444444444444444444',
    assignedTo: STAFF,
    form: { 'Project Name': 'Site', Description: 'A site' },
    notes: [{ content: 'internal', authorId: STAFF }],
  });
  assert.equal(ticket.validateSync(), undefined);
});

// ── Virtuals ─────────────────────────────────────────────────────────────────

test('display virtuals zero-pad consistently', () => {
  assert.equal(new models.Ticket({ guildId: GUILD, number: 7, userId: USER, type: 'x' }).display, '#0007');
  assert.equal(new models.Order({ guildId: GUILD, number: 7, userId: USER, title: 't', serviceType: 'x' }).display, '#0007');
  assert.equal(new models.Review({ guildId: GUILD, number: 7, userId: USER, rating: 5 }).display, '#0007');
  assert.equal(new models.Portfolio({ guildId: GUILD, number: 7, title: 't', category: 'x' }).display, '#007');
  assert.equal(new models.Promotion({ guildId: GUILD, number: 7, userId: USER, serverName: 's' }).display, '#007');
});

test('ticket isOpen reflects every status', () => {
  const make = (status) => new models.Ticket({ guildId: GUILD, number: 1, userId: USER, type: 'x', status });
  for (const status of ['open', 'claimed', 'pending']) assert.equal(make(status).isOpen, true, status);
  for (const status of ['closed', 'archived', 'deleted']) assert.equal(make(status).isOpen, false, status);
});

test('review isPublic requires approved, not hidden, not rejected', () => {
  const make = (overrides) => new models.Review({ guildId: GUILD, number: 1, userId: USER, rating: 5, ...overrides });
  assert.equal(make({}).isPublic, true);
  assert.equal(make({ hidden: true }).isPublic, false);
  assert.equal(make({ rejected: true }).isPublic, false);
  assert.equal(make({ approved: false }).isPublic, false);
});

// ── Instance methods ─────────────────────────────────────────────────────────

test('ticket SLA telemetry measures the right intervals', () => {
  const created = new Date('2024-01-01T10:00:00Z');
  const ticket = new models.Ticket({ guildId: GUILD, number: 1, userId: USER, type: 'x', createdAt: created });

  // Customer asks at +1m, staff answers at +5m: first response is 5 minutes.
  ticket.recordCustomerMessage(new Date(created.getTime() + 60_000));
  ticket.recordStaffReply(new Date(created.getTime() + 300_000));
  assert.equal(ticket.firstResponseMinutes, 5);
  assert.equal(ticket.averageResponseMinutes, null, 'the first reply is not a follow-up sample');

  // Customer asks again at +10m, staff answers at +15m: a 5-minute follow-up.
  ticket.recordCustomerMessage(new Date(created.getTime() + 600_000));
  ticket.recordStaffReply(new Date(created.getTime() + 900_000));
  assert.equal(ticket.responseSamples.length, 1);
  assert.equal(ticket.averageResponseMinutes, 5);

  // A slower follow-up moves the average.
  ticket.recordCustomerMessage(new Date(created.getTime() + 1_200_000));
  ticket.recordStaffReply(new Date(created.getTime() + 2_100_000));
  assert.equal(ticket.averageResponseMinutes, 10, '(5 + 15) / 2');
});

test('ticket response samples stay bounded', () => {
  const created = new Date('2024-01-01T10:00:00Z');
  const ticket = new models.Ticket({ guildId: GUILD, number: 1, userId: USER, type: 'x', createdAt: created });
  ticket.recordStaffReply(created);
  for (let i = 1; i <= 80; i += 1) {
    ticket.recordCustomerMessage(new Date(created.getTime() + i * 120_000));
    ticket.recordStaffReply(new Date(created.getTime() + i * 120_000 + 60_000));
  }
  assert.ok(ticket.responseSamples.length <= 50, 'the sample window is capped');
});

test('order transitions set the right timestamps', () => {
  const order = new models.Order({ guildId: GUILD, number: 1, userId: USER, title: 'x', serviceType: 'website' });

  order.transition('in-progress', { id: STAFF, name: 'dev' }, 'started');
  assert.equal(order.status, 'in-progress');
  assert.ok(order.startedAt);
  assert.equal(order.history.at(-1).note, 'started');

  order.startedAt = new Date(Date.now() - 7_200_000);
  order.transition('completed', { id: STAFF, name: 'dev' });
  assert.equal(order.progress, 100);
  assert.equal(order.queuePosition, null, 'a completed order leaves the queue');
  assert.ok(order.completionHours >= 2, 'build time is derived from startedAt');
  assert.ok(order.completedAt);
});

test('order cancellation clears the queue slot', () => {
  const order = new models.Order({ guildId: GUILD, number: 1, userId: USER, title: 'x', serviceType: 'website', queuePosition: 3 });
  order.transition('cancelled', { id: STAFF, name: 'dev' }, 'no longer needed');
  assert.equal(order.queuePosition, null);
  assert.ok(order.cancelledAt);
});

test('order history is bounded', () => {
  const order = new models.Order({ guildId: GUILD, number: 1, userId: USER, title: 'x', serviceType: 'website' });
  for (let i = 0; i < 150; i += 1) order.transition(i % 2 ? 'paused' : 'in-progress', { id: STAFF });
  assert.ok(order.history.length <= 100, 'history does not grow without bound');
});

test('staff statistics compute rolling averages', () => {
  const staff = new models.StaffStats({ guildId: GUILD, userId: STAFF });

  staff.recordFirstResponse(12);
  staff.recordFirstResponse(8);
  assert.equal(staff.responses.averageFirstResponseMinutes, 10);

  staff.recordResolution(100);
  staff.recordResolution(200);
  assert.equal(staff.responses.averageResolutionMinutes, 150);

  staff.recordReview(5);
  staff.recordReview(4);
  assert.equal(staff.reviews.count, 2);
  assert.equal(staff.reviews.average, 4.5);
  assert.equal(staff.reviews.fiveStar, 1);
});

test('staff sample windows stay bounded', () => {
  const staff = new models.StaffStats({ guildId: GUILD, userId: STAFF });
  for (let i = 0; i < 250; i += 1) staff.recordFirstResponse(i);
  assert.ok(staff.responses.firstResponseSamples.length <= 100);
});

test('user markCustomer is idempotent', () => {
  const user = new models.User({ guildId: GUILD, userId: USER });
  user.markCustomer();
  const first = user.customerSince;
  user.markCustomer();
  assert.equal(user.customerSince, first, 'the customer-since date is not overwritten');
});

// ── Configuration document ───────────────────────────────────────────────────

test('a new configuration carries every default section', () => {
  const config = new models.Configuration({ guildId: GUILD });
  for (const section of Object.keys(DEFAULT_CONFIG)) {
    assert.notEqual(config[section], undefined, `${section} is present`);
  }
  assert.equal(config.tickets.enabled, true);
  assert.equal(config.automod.modules.spam.enabled, true);
  assert.equal(config.antiNuke.punishment, 'strip');
});

test('setPath writes nested values and marks the section modified', () => {
  const config = new models.Configuration({ guildId: GUILD });
  config.setPath('tickets.maxOpenPerUser', 9);
  assert.equal(config.tickets.maxOpenPerUser, 9);
  assert.equal(config.getPath('tickets.maxOpenPerUser'), 9);
  assert.ok(config.isModified('tickets'), 'the owning sub-tree is marked modified');
  assert.equal(config.revision, 1);

  config.setPath('automod.modules.spam.threshold', 12);
  assert.equal(config.automod.modules.spam.threshold, 12);
  assert.equal(config.automod.modules.spam.enabled, true, 'siblings survive a deep write');
});

test('getPath returns the fallback for an unknown path', () => {
  const config = new models.Configuration({ guildId: GUILD });
  assert.equal(config.getPath('does.not.exist', 'fallback'), 'fallback');
  assert.equal(config.getPath('tickets.enabled', 'fallback'), true);
});

test('resetSection restores one section and leaves the rest alone', () => {
  const config = new models.Configuration({ guildId: GUILD });
  config.setPath('tickets.maxOpenPerUser', 9);
  config.setPath('business.timezone', 'Europe/Amsterdam');

  assert.equal(config.resetSection('tickets'), true);
  assert.equal(config.tickets.maxOpenPerUser, DEFAULT_CONFIG.tickets.maxOpenPerUser);
  assert.equal(config.business.timezone, 'Europe/Amsterdam', 'other sections are untouched');
  assert.equal(config.resetSection('nonexistent'), false);
});

// ── Query construction ───────────────────────────────────────────────────────
// Mongoose builds and validates filters without a server, so a malformed query
// or a typo'd path is caught here.

test('ticket statics build the filters they claim to', () => {
  assert.deepEqual(models.Ticket.countOpenFor(GUILD, USER).getFilter(), {
    guildId: GUILD,
    userId: USER,
    status: { $in: ['open', 'claimed', 'pending'] },
  });
  assert.deepEqual(models.Ticket.byChannel(GUILD, '999').getFilter(), { guildId: GUILD, channelId: '999' });
});

test('moderation statics scope by guild, user and state', () => {
  const filter = models.Moderation.activeWarnings(GUILD, USER).getFilter();
  assert.equal(filter.guildId, GUILD);
  assert.equal(filter.userId, USER);
  assert.equal(filter.type, 'warn');
  assert.equal(filter.active, true);
  assert.equal(filter.revoked, false);
  assert.equal(filter.createdAt, undefined, 'no expiry window by default');

  const expiring = models.Moderation.activeWarnings(GUILD, USER, 90).getFilter();
  assert.ok(expiring.createdAt.$gte instanceof Date, 'an expiry window adds a date bound');

  const due = models.Moderation.dueForExpiry().getFilter();
  assert.equal(due.active, true);
  assert.ok(due.expiresAt.$lte instanceof Date);
});

test('order queue filters to the active statuses only', () => {
  const filter = models.Order.queue(GUILD).getFilter();
  assert.deepEqual(filter.status, { $in: models.Order.ACTIVE_STATUSES });
  assert.ok(!models.Order.ACTIVE_STATUSES.includes('completed'));
  assert.ok(!models.Order.ACTIVE_STATUSES.includes('cancelled'));
  assert.ok(!models.Order.ACTIVE_STATUSES.includes('pending'), 'unquoted work does not hold a slot');
});

test('portfolio showcase filters and sorts correctly', () => {
  const query = models.Portfolio.showcase(GUILD, { category: 'website' });
  assert.deepEqual(query.getFilter(), { guildId: GUILD, published: true, category: 'website' });
  assert.deepEqual(query.getOptions().sort, { featured: -1, sortOrder: 1, completedAt: -1 });
});

test('promotion pending covers every undecided state', () => {
  const filter = models.Promotion.pending(GUILD).getFilter();
  assert.deepEqual(filter.status, { $in: ['pending', 'reviewing', 'changes-requested'] });
});

test('log recent applies optional filters and caps the limit', () => {
  assert.deepEqual(models.Log.recent(GUILD, { category: 'security' }).getFilter(), { guildId: GUILD, category: 'security' });
  assert.equal(models.Log.recent(GUILD, { limit: 5000 }).getOptions().limit, 100, 'limit is capped');
});

test('the leaderboard rejects an unsafe sort path', () => {
  const safe = models.StaffStats.leaderboard(GUILD, 'reviews.average').getOptions().sort;
  assert.deepEqual(safe, { 'reviews.average': -1 });

  const injected = models.StaffStats.leaderboard(GUILD, 'malicious.$path').getOptions().sort;
  assert.deepEqual(injected, { 'tickets.closed': -1 }, 'an unknown metric falls back to the default');
});

// ── Statistics rollup ────────────────────────────────────────────────────────

test('rollup sums a range and derives averages', () => {
  const totals = models.GuildStats.rollup([
    {
      members: { joins: 5, leaves: 1, newCustomers: 2 },
      tickets: { opened: 10, closed: 8, firstResponseSum: 120, firstResponseCount: 8, resolutionSum: 800, resolutionCount: 8 },
      orders: { created: 4, completed: 3, revenue: 900, completionHoursSum: 30, completionCount: 3 },
      reviews: { received: 3, ratingSum: 14, fiveStar: 2 },
      moderation: { warnings: 2, automodHits: 7 },
      security: { blockedLinks: 4 },
      activity: { messages: 500, commands: 30, errors: 1 },
    },
    {
      members: { joins: 3 },
      tickets: { opened: 6, closed: 6, firstResponseSum: 60, firstResponseCount: 6 },
      orders: { completed: 1, revenue: 100 },
      reviews: { received: 1, ratingSum: 5, fiveStar: 1 },
    },
  ]);

  assert.equal(totals.joins, 8);
  assert.equal(totals.ticketsOpened, 16);
  assert.equal(totals.revenue, 1000);
  assert.equal(totals.averageFirstResponse, Math.round(180 / 14));
  assert.equal(totals.averageResolution, 100);
  assert.equal(totals.averageCompletionHours, 10);
  assert.equal(totals.averageRating, 4.75);
});

test('rollup handles an empty range without dividing by zero', () => {
  const totals = models.GuildStats.rollup([]);
  assert.equal(totals.ticketsOpened, 0);
  assert.equal(totals.averageFirstResponse, null);
  assert.equal(totals.averageRating, null);
  assert.equal(totals.averageCompletionHours, null);
});

test('dayKey produces a stable UTC key', () => {
  assert.equal(models.GuildStats.dayKey(new Date('2024-03-15T23:59:59Z')), '2024-03-15');
  assert.equal(models.GuildStats.dayKey(new Date('2024-03-16T00:00:01Z')), '2024-03-16');
});

// ── Injection defence ────────────────────────────────────────────────────────

test('mongoose global sanitizeFilter stays off, and the reason is provable', () => {
  const mongoose = require('mongoose');
  assert.notEqual(
    mongoose.get('sanitizeFilter'),
    true,
    'sanitizeFilter must stay off — see the comment in database/connection.js',
  );

  /*
   * Why: the helper wraps ANY nested object containing a `$` key in `$eq`,
   * which destroys the operator queries this codebase legitimately writes.
   * These assertions fail loudly if anyone re-enables the flag without
   * understanding the consequence.
   */
  const sanitize = require('mongoose/lib/helpers/query/sanitizeFilter');

  const openTickets = sanitize({ guildId: 'g', status: { $in: ['open', 'claimed', 'pending'] } });
  assert.deepEqual(
    openTickets.status,
    { $eq: { $in: ['open', 'claimed', 'pending'] } },
    'the flag would turn every $in into an equality match against an object, matching nothing',
  );

  const expiring = sanitize({ active: true, expiresAt: { $ne: null, $lte: new Date(0) } });
  assert.ok(expiring.expiresAt.$eq, 'expiring punishments would never be found');

  assert.throws(
    () => sanitize({ $expr: { $gte: [1, 2] } }),
    /not allowed with sanitizeFilter/,
    'the outstanding-reviews query uses $expr and would throw outright',
  );
});

test('a missing component argument cannot collapse a lookup into match-any', () => {
  const validators = require('../src/utils/validators');

  // Mongoose strips undefined out of a filter, so an unguarded
  // `findOne({ _id: undefined, guildId })` silently becomes `findOne({ guildId })`
  // and returns an arbitrary document. Prove both halves of that claim.
  const collapsed = models.Order.findOne({ _id: undefined, guildId: GUILD }).getFilter();
  assert.deepEqual(collapsed, { guildId: GUILD }, 'undefined really is stripped');

  assert.throws(() => validators.objectId(undefined, 'order'), /out of date/);
  assert.throws(() => validators.objectId('', 'order'), /out of date/);
  assert.throws(() => validators.objectId('not-an-object-id', 'order'), /out of date/);
  assert.equal(validators.objectId('507f1f77bcf86cd799439011'), '507f1f77bcf86cd799439011');
  assert.equal(validators.isObjectId('507f1f77bcf86cd799439011'), true);
  assert.equal(validators.isObjectId('nope'), false);
});

test('the query values this codebase produces are always primitives', () => {
  const validators = require('../src/utils/validators');
  const customId = require('../src/utils/customId');

  // A forged custom ID cannot smuggle an object into a filter — the protocol
  // decodes to strings, so the worst case is a CastError, never a match-all.
  const forged = customId.build('ticket', 'close', JSON.stringify({ $ne: null }));
  const parsed = customId.parse(forged);
  assert.equal(typeof parsed.args[0], 'string');

  // And anything routed through safeQueryValue is rejected outright.
  assert.throws(() => validators.safeQueryValue({ $ne: null }), /Invalid/);
  assert.throws(() => validators.safeQueryValue('$where'), /Invalid/);
});

// ── Counter keys ─────────────────────────────────────────────────────────────

test('counters are namespaced per guild and sequence', () => {
  const query = models.Counter.findById(`${GUILD}:ticket`);
  assert.equal(query.getFilter()._id, `${GUILD}:ticket`);
  assert.notEqual(`${GUILD}:ticket`, `${GUILD}:order`, 'sequences do not collide');
});
