'use strict';

/**
 * Unit tests for the pure logic layers.
 *
 *   npm test
 *
 * Deliberately scoped to code that has no Discord or database dependency:
 * formatters, validators, the custom-ID protocol, the content filters, the
 * rate limiters and the office-hours maths. That is where subtle bugs hide,
 * and it is the part that can be tested without a live gateway.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

process.env.LOG_TO_FILE = 'false';
process.env.LOG_LEVEL = 'error';

const formatters = require('../src/utils/formatters');
const validators = require('../src/utils/validators');
const customId = require('../src/utils/customId');
const filters = require('../src/security/filters');
const { SlidingWindow, CooldownManager, TokenBucket } = require('../src/utils/rateLimiter');
const businessService = require('../src/services/businessService');
const transcriptService = require('../src/services/transcriptService');
const { deepMerge } = require('../src/database/models/Configuration');

// ── Formatters ───────────────────────────────────────────────────────────────

test('duration renders human readable spans', () => {
  assert.equal(formatters.duration(1000), '1 second');
  assert.equal(formatters.duration(90_000), '1 minute, 30 seconds');
  assert.equal(formatters.duration(90_000, { compact: true }), '1m 30s');
  assert.equal(formatters.duration(0), 'less than a second');
});

test('parseDuration understands common shorthands', () => {
  assert.equal(formatters.parseDuration('10m'), 600_000);
  assert.equal(formatters.parseDuration('2h30m'), 9_000_000);
  assert.equal(formatters.parseDuration('7d'), 604_800_000);
  assert.equal(formatters.parseDuration('5'), 300_000, 'a bare number means minutes');
  assert.equal(formatters.parseDuration('nonsense'), null);
  assert.equal(formatters.parseDuration(''), null);
});

test('money and percent format predictably', () => {
  assert.equal(formatters.money(250), '$250', 'whole amounts drop the decimals');
  assert.equal(formatters.money(250.5, '€'), '€250.50', 'fractional amounts get two decimals');
  assert.equal(formatters.money(null), '—');
  assert.equal(formatters.percent(1, 4), '25%');
  assert.equal(formatters.percent(1, 3), '33.3%');
  assert.equal(formatters.percent(1, 0), '0%');
});

test('truncate never exceeds the limit', () => {
  const long = 'a'.repeat(500);
  assert.equal(formatters.truncate(long, 100).length, 100);
  assert.equal(formatters.truncate('short', 100), 'short');
});

test('safeField neutralises mentions', () => {
  const output = formatters.safeField('hello @everyone and <@123456789012345678>');
  assert.ok(!output.includes('@everyone '), 'everyone ping is defused');
  assert.ok(!output.includes('<@123456789012345678>'), 'user mention is defused');
});

test('padId zero-pads consistently', () => {
  assert.equal(formatters.padId(7), '0007');
  assert.equal(formatters.padId(1234), '1234');
  assert.equal(formatters.padId(7, 3), '007');
});

// ── Validators ───────────────────────────────────────────────────────────────

test('clean strips control and zero-width characters', () => {
  // Written as escapes rather than literal bytes: a raw NUL in the source makes
  // git treat this whole file as binary, and every diff of it becomes unreadable.
  const dirty = 'hello\u0000\u200bworld\u202e';
  assert.equal(validators.clean(dirty), 'helloworld');
});

test('text enforces required and minimum length', () => {
  assert.throws(() => validators.text('', 'Field'), /required/);
  assert.throws(() => validators.text('ab', 'Field', { min: 5 }), /at least 5/);
  assert.equal(validators.text('  hello  ', 'Field'), 'hello');
});

test('url rejects non-http and credential-bearing links', () => {
  assert.throws(() => validators.url('javascript:alert(1)', { required: true }), /valid http/);
  assert.throws(() => validators.url('https://user:pass@example.com', { required: true }), /credentials/);
  assert.equal(validators.url('https://example.com/x', { required: true }), 'https://example.com/x');
  assert.equal(validators.url('', {}), '');
});

test('sanitizeObject strips operator keys', () => {
  const input = { $ne: 1, safe: 'yes', 'a.b': 2, nested: { $gt: 5, ok: 1 } };
  assert.deepEqual(validators.sanitizeObject(input), { safe: 'yes', nested: { ok: 1 } });
});

test('safeQueryValue rejects operators and objects', () => {
  assert.throws(() => validators.safeQueryValue({ $ne: null }), /Invalid/);
  assert.throws(() => validators.safeQueryValue('$where'), /Invalid/);
  assert.equal(validators.safeQueryValue('normal'), 'normal');
});

test('compilePattern refuses catastrophic backtracking shapes', () => {
  // Nested quantifiers — the exponential-backtracking family.
  for (const dangerous of ['(a+)+', '(a*)*', '(\\d+|x)*', '(?:ab+)+', 'a+*']) {
    assert.equal(validators.compilePattern(dangerous), null, `${dangerous} must be rejected`);
  }
  // Legitimate patterns still compile, including escaped literal parentheses.
  for (const safe of ['^hello$', '\\bword\\b', '[a-z]{2,5}', '(foo|bar)', '\\(a\\+\\)']) {
    assert.ok(validators.compilePattern(safe) instanceof RegExp, `${safe} must compile`);
  }
  assert.equal(validators.compilePattern('['), null, 'invalid syntax returns null');
  assert.equal(validators.compilePattern('x'.repeat(300)), null, 'over-long patterns are rejected');
});

test('budget extracts a usable estimate', () => {
  assert.deepEqual(validators.budget('around $250'), { raw: 'around $250', amount: 250 });
  assert.deepEqual(validators.budget('150-300 USD'), { raw: '150-300 USD', amount: 225 });
  assert.deepEqual(validators.budget(''), { raw: '', amount: null });
});

test('color parses hex into an integer', () => {
  assert.equal(validators.color('#6366F1'), 0x6366f1);
  assert.throws(() => validators.color('not-a-colour'), /hex/);
});

test('timeOfDay and timezone validate correctly', () => {
  assert.equal(validators.timeOfDay('09:30'), '09:30');
  assert.throws(() => validators.timeOfDay('25:00'), /24-hour/);
  assert.equal(validators.timezone('Europe/Amsterdam'), 'Europe/Amsterdam');
  assert.throws(() => validators.timezone('Nowhere/Fake'), /timezone/);
});

test('channelName produces a Discord-safe slug', () => {
  assert.equal(validators.channelName('My Cool Project!!'), 'my-cool-project');
  assert.throws(() => validators.channelName('!!'), /two usable/);
});

// ── Custom IDs ───────────────────────────────────────────────────────────────

test('custom IDs round-trip through the protocol', () => {
  const id = customId.build('ticket', 'close', 'abc123', 42);
  const parsed = customId.parse(id);
  assert.equal(parsed.namespace, 'ticket');
  assert.equal(parsed.action, 'close');
  assert.deepEqual(parsed.args, ['abc123', '42']);
});

test('custom IDs encode separators safely', () => {
  const id = customId.build('ns', 'action', 'value:with:colons');
  assert.deepEqual(customId.parse(id).args, ['value:with:colons']);
});

test('custom IDs reject over-long payloads and foreign IDs', () => {
  assert.throws(() => customId.build('ns', 'action', 'x'.repeat(120)), /exceeds/);
  assert.equal(customId.parse('someotherbot:thing'), null);
  assert.equal(customId.isOwned('pa:ticket:close'), true);
});

// ── Content filters ──────────────────────────────────────────────────────────

test('normalise defeats common filter evasion', () => {
  assert.equal(filters.collapsed('f.u.c.k'), 'fuck');
  assert.equal(filters.collapsed('f u c k'), 'fuck');
  assert.equal(filters.collapsed('fvck').length, 4);
});

test('banned word matching respects the allow list', () => {
  const words = ['badword'];
  assert.equal(filters.findBannedWords('this is a badword', { words }).matched.length, 1);
  assert.equal(filters.findBannedWords('this is a badword', { words, allowed: ['badword'] }).matched.length, 0);
});

test('caps and symbol ratios are computed correctly', () => {
  assert.equal(filters.capsRatio('HELLO'), 100);
  assert.equal(filters.capsRatio('hello'), 0);
  assert.equal(filters.capsRatio(''), 0);
  assert.ok(filters.symbolRatio('!!!!!!!!!!') > 90);
});

test('URL classification catches the dangerous shapes', () => {
  assert.equal(filters.classifyUrl('https://github.com/a').verdict, 'allowed');
  assert.equal(filters.classifyUrl('https://discord-nitro.gift/claim').verdict, 'malicious');
  assert.equal(filters.classifyUrl('https://example.com/setup.exe').verdict, 'malicious');
  assert.equal(filters.classifyUrl('http://192.168.1.1/x').verdict, 'suspicious');
  assert.equal(filters.classifyUrl('https://evil.com', { blacklist: ['evil.com'] }).verdict, 'blocked');
  assert.equal(filters.classifyUrl('https://other.com', { whitelist: ['ok.com'] }).verdict, 'blocked');
  assert.equal(filters.classifyUrl('https://bit.ly/x', { blockShorteners: true }).verdict, 'suspicious');
});

test('invite detection finds every vanity host', () => {
  assert.deepEqual(filters.findInvites('join discord.gg/abc'), ['abc']);
  assert.deepEqual(filters.findInvites('https://discord.com/invite/xyz'), ['xyz']);
  assert.deepEqual(filters.findInvites('no invites here'), []);
});

test('fake nitro detection needs both the language and an off-platform link', () => {
  assert.equal(filters.isFakeNitro('free nitro https://dlscord-gift.ru/claim'), true);
  assert.equal(filters.isFakeNitro('free nitro, ask me about it'), false);
  assert.equal(filters.isFakeNitro('check https://github.com/x'), false);
});

test('zalgo detection triggers only on dense combining marks', () => {
  assert.equal(filters.isZalgo('h̸̢̛e̵̡l̷l̴ơ̷̡̢'), true);
  assert.equal(filters.isZalgo('café résumé'), false);
});

// ── Rate limiting ────────────────────────────────────────────────────────────

test('sliding window counts within its window', () => {
  const window = new SlidingWindow(1000);
  assert.equal(window.hit('a'), 1);
  assert.equal(window.hit('a'), 2);
  assert.equal(window.hit('b'), 1, 'keys are independent');
  window.reset('a');
  assert.equal(window.count('a'), 0);
});

test('cooldown manager reports remaining time', () => {
  const cooldowns = new CooldownManager();
  assert.equal(cooldowns.check('cmd', 'user', 5), 0, 'first call is allowed');
  assert.ok(cooldowns.check('cmd', 'user', 5) > 0, 'second call is limited');
  cooldowns.clear('cmd', 'user');
  assert.equal(cooldowns.check('cmd', 'user', 5), 0, 'clearing releases it');
  assert.equal(cooldowns.check('cmd', 'user', 0), 0, 'a zero cooldown never limits');
});

test('token bucket allows a burst then throttles', () => {
  const bucket = new TokenBucket(3, 60);
  assert.equal(bucket.consume('u'), true);
  assert.equal(bucket.consume('u'), true);
  assert.equal(bucket.consume('u'), true);
  assert.equal(bucket.consume('u'), false, 'the burst is exhausted');
  assert.equal(bucket.consume('other'), true, 'other users are unaffected');
});

// ── Office hours ─────────────────────────────────────────────────────────────

test('availability reports open and closed correctly', () => {
  const config = {
    business: {
      timezone: 'UTC',
      hours: { 0: null, 1: { open: '09:00', close: '17:00' }, 2: { open: '09:00', close: '17:00' } },
    },
  };

  // Monday 12:00 UTC — open.
  const monday = new Date('2024-01-01T12:00:00Z');
  assert.equal(businessService.availability(config, monday).open, true);

  // Monday 20:00 UTC — closed.
  assert.equal(businessService.availability(config, new Date('2024-01-01T20:00:00Z')).open, false);

  // Sunday — closed all day, and the next opening is found.
  const sunday = businessService.availability(config, new Date('2023-12-31T12:00:00Z'));
  assert.equal(sunday.open, false);
  assert.ok(sunday.nextOpenDay?.startsWith('Monday'));
});

test('availability handles an invalid timezone without throwing', () => {
  const config = { business: { timezone: 'Not/AZone', hours: { 1: { open: '09:00', close: '17:00' } } } };
  assert.doesNotThrow(() => businessService.availability(config, new Date('2024-01-01T12:00:00Z')));
});

test('effectiveStatus falls back to away outside office hours', () => {
  const config = {
    business: { timezone: 'UTC', hours: { 1: { open: '09:00', close: '17:00' } } },
    status: { current: 'online', autoFromHours: true },
  };
  // The maths runs against "now", so assert the two branches directly instead.
  const open = businessService.availability(config, new Date('2024-01-01T12:00:00Z'));
  assert.equal(open.open, true);
  const closed = businessService.availability(config, new Date('2024-01-01T23:00:00Z'));
  assert.equal(closed.open, false);
});

// ── Transcripts ──────────────────────────────────────────────────────────────

test('transcript HTML escapes untrusted content', () => {
  const malicious = '<script>alert("xss")</script>';
  const escaped = transcriptService.escapeHtml(malicious);
  assert.ok(!escaped.includes('<script>'));
  assert.ok(escaped.includes('&lt;script&gt;'));
});

test('transcript markdown rendering keeps injected HTML inert', () => {
  const rendered = transcriptService.renderMarkdown('**bold** <img src=x onerror=alert(1)>');
  assert.ok(rendered.includes('<strong>bold</strong>'));
  assert.ok(!rendered.includes('<img'));
});

test('transcript renders a complete document', () => {
  const html = transcriptService.buildHtml(
    { number: 42, guildId: '1', type: 'website', typeLabel: 'Website', priority: 'normal', username: 'customer', createdAt: new Date(), closedAt: new Date(), assignedName: '', closedByName: '' },
    [],
    { brandName: 'Studio' },
  );
  assert.ok(html.startsWith('<!doctype html>'));
  assert.ok(html.includes('Ticket #0042'));
  assert.ok(html.includes('No messages were exchanged'));
});

// ── Configuration merging ────────────────────────────────────────────────────

test('deepMerge backfills new defaults without losing stored values', () => {
  const defaults = { a: 1, nested: { b: 2, c: 3 }, list: [1, 2] };
  const stored = { a: 9, nested: { b: 8 }, list: [5] };
  const merged = deepMerge(defaults, stored);

  assert.equal(merged.a, 9, 'stored value wins');
  assert.equal(merged.nested.b, 8, 'stored nested value wins');
  assert.equal(merged.nested.c, 3, 'new default is backfilled');
  assert.deepEqual(merged.list, [5], 'arrays are replaced, not merged');
});

test('deepMerge preserves Date values instead of flattening them', () => {
  // Regression: configuration sub-trees hold real dates (setup.completedAt,
  // status.updatedAt, lockdown.startedAt). Recursing into a Date yields `{}`
  // because it has no own enumerable properties, which silently destroyed the
  // value on every boot.
  const when = new Date('2024-01-01T00:00:00Z');
  const merged = deepMerge(
    { completed: false, completedAt: null, version: 1 },
    { completed: true, completedAt: when, version: 2 },
  );

  assert.ok(merged.completedAt instanceof Date, 'the date survives the merge');
  assert.equal(merged.completedAt.getTime(), when.getTime());
  assert.notEqual(merged.completedAt, when, 'and it is a copy, not a shared reference');
});

test('deepMerge distinguishes null, undefined and missing', () => {
  assert.equal(deepMerge({ a: 1 }, null), null, 'an explicit null overwrites');
  assert.deepEqual(deepMerge({ a: 1 }, undefined), { a: 1 }, 'undefined keeps the default');
  assert.deepEqual(deepMerge({ a: { b: 1 } }, {}), { a: { b: 1 } }, 'an empty object keeps defaults');
});

test('deepMerge does not mutate its inputs', () => {
  const defaults = { nested: { a: 1 } };
  const stored = { nested: { b: 2 } };
  const merged = deepMerge(defaults, stored);

  merged.nested.a = 99;
  assert.equal(defaults.nested.a, 1, 'the defaults object is untouched');
  assert.equal(stored.nested.b, 2, 'the stored object is untouched');
});

// ── Component construction ───────────────────────────────────────────────────

test('component builders respect Discord limits', () => {
  const components = require('../src/utils/components');
  const many = Array.from({ length: 12 }, (_, index) => components.button({ id: `pa:x:y:${index}`, label: `B${index}` }));
  const rows = components.rows(many);
  assert.equal(rows.length, 3, 'five buttons per row');
  assert.ok(rows.every((row) => row.components.length <= 5));

  const modal = components.modal({
    id: 'pa:x:y',
    title: 'Test',
    fields: Array.from({ length: 8 }, (_, index) => ({ id: `f${index}`, label: `Field ${index}` })),
  });
  assert.equal(modal.components.length, 5, 'modals are capped at five inputs');
});

test('embed builder enforces Discord field limits', () => {
  const embeds = require('../src/utils/embeds');
  const embed = embeds.base({
    title: 'x'.repeat(400),
    description: 'y'.repeat(5000),
    fields: Array.from({ length: 40 }, (_, index) => ({ name: `n${index}`, value: 'v'.repeat(2000) })),
  });
  const json = embed.toJSON();
  assert.ok(json.title.length <= 256);
  assert.ok(json.description.length <= 4096);
  assert.ok(json.fields.length <= 25);
  assert.ok(json.fields.every((field) => field.value.length <= 1024));
});

// ── Launch promotion window ──────────────────────────────────────────────────

const launchService = require('../src/services/launchService');

/** Minimal configuration shaped like the launch section. */
const launchConfig = (launch) => ({ launch: { serviceTypes: ['minecraft-plugin'], ...launch } });

test('the launch window is only open between its bounds', () => {
  const future = new Date(Date.now() + 86_400_000);
  const past = new Date(Date.now() - 86_400_000);

  assert.equal(launchService.isOpen(launchConfig({ enabled: true, endsAt: future })), true);
  assert.equal(launchService.isOpen(launchConfig({ enabled: true, endsAt: past })), false, 'expired');
  assert.equal(launchService.isOpen(launchConfig({ enabled: false, endsAt: future })), false, 'switched off');
  assert.equal(launchService.isOpen(launchConfig({ enabled: true, endsAt: null })), true, 'no end date');
  assert.equal(launchService.isOpen({}), false, 'no launch section at all');
});

test('an expired window stops waiving the referral gate', () => {
  const open = launchConfig({ enabled: true, endsAt: new Date(Date.now() + 3600_000) });
  const expired = launchConfig({ enabled: true, endsAt: new Date(Date.now() - 1000) });

  assert.equal(launchService.waivesReferralGate(open, 'free-commission'), true);
  assert.equal(launchService.waivesReferralGate(expired, 'free-commission'), false);

  // The waiver must never leak to a type that was not gated in the first place.
  assert.equal(launchService.waivesReferralGate(open, 'minecraft-plugin'), false);
  assert.equal(launchService.waivesReferralGate(open, 'discord-bot'), false);
});

test('slot limits close the waiver once they are exhausted', () => {
  const endsAt = new Date(Date.now() + 3600_000);

  const uncapped = launchConfig({ enabled: true, endsAt, maxSlots: 0, claimedSlots: 99 });
  assert.equal(launchService.remainingSlots(uncapped), Infinity);
  assert.equal(launchService.waivesReferralGate(uncapped, 'free-commission'), true);

  const partly = launchConfig({ enabled: true, endsAt, maxSlots: 5, claimedSlots: 3 });
  assert.equal(launchService.remainingSlots(partly), 2);
  assert.equal(launchService.waivesReferralGate(partly, 'free-commission'), true);

  const full = launchConfig({ enabled: true, endsAt, maxSlots: 5, claimedSlots: 5 });
  assert.equal(launchService.remainingSlots(full), 0);
  assert.equal(launchService.waivesReferralGate(full, 'free-commission'), false);

  // Overshooting the cap must not produce a negative count.
  const overrun = launchConfig({ enabled: true, endsAt, maxSlots: 5, claimedSlots: 9 });
  assert.equal(launchService.remainingSlots(overrun), 0);
});

test('explicitly disabling the waiver keeps the gate closed while the window runs', () => {
  const config = launchConfig({
    enabled: true,
    endsAt: new Date(Date.now() + 3600_000),
    waiveReferralGate: false,
  });
  assert.equal(launchService.isOpen(config), true, 'the window itself is still open');
  assert.equal(launchService.waivesReferralGate(config, 'free-commission'), false);
});

// ── Panel artwork ────────────────────────────────────────────────────────────

const assets = require('../src/utils/assets');

test('every panel has header artwork on disk', () => {
  const { PANELS } = require('../src/services/panelService');
  const missing = Object.keys(PANELS).filter((key) => !assets.hasPanelArt(key));
  assert.deepEqual(missing, [], 'run `node scripts/build-panel-art.js && node scripts/render-brand.js`');
  assert.ok(assets.hasPanelArt('launch'), 'the launch announcement needs art too');
});

test('panel art is attached as an upload, not a URL', () => {
  const embeds = require('../src/utils/embeds');
  const payload = { embeds: [embeds.base({ title: 'Pricing' })] };

  assets.attachPanelArt(payload, 'pricing', {});

  assert.equal(payload.files.length, 1);
  assert.equal(payload.files[0].name, 'pricing.png');
  // The embed must point at the upload, never at a CDN link that can expire.
  assert.equal(payload.embeds[0].toJSON().image.url, 'attachment://pricing.png');
});

test('each call builds a fresh attachment, because uploading consumes it', () => {
  const first = assets.panelArt('rules');
  const second = assets.panelArt('rules');
  assert.notEqual(first.attachment, second.attachment, 'a shared instance would upload an empty file the second time');
});

test('panel art can be switched off, and a missing key is not an error', () => {
  const embeds = require('../src/utils/embeds');

  const disabled = { embeds: [embeds.base({ title: 'x' })] };
  assets.attachPanelArt(disabled, 'pricing', { theme: { panelImages: false } });
  assert.equal(disabled.files, undefined);

  const unknown = { embeds: [embeds.base({ title: 'x' })] };
  assets.attachPanelArt(unknown, 'no-such-panel', {});
  assert.equal(unknown.files, undefined);
  assert.equal(assets.panelArt('no-such-panel'), null);
});

test('/panel offers every panel the bot owns', () => {
  // `verify` and `freeCommission` were added to the registry but not to the
  // command's choice list, which left them publishable only by re-running the
  // whole destructive setup. This keeps the two lists honest.
  const { PANELS } = require('../src/services/panelService');
  const panelCommand = require('../src/commands/admin/panel');

  const offered = new Set(
    panelCommand.data.toJSON().options
      .flatMap((sub) => sub.options ?? [])
      .filter((option) => option.name === 'panel')
      .flatMap((option) => option.choices ?? [])
      .map((choice) => choice.value),
  );

  const missing = Object.keys(PANELS).filter((key) => !offered.has(key));
  assert.deepEqual(missing, [], 'these panels cannot be published from /panel');

  const unknown = [...offered].filter((key) => !PANELS[key]);
  assert.deepEqual(unknown, [], 'these choices point at panels that do not exist');
});

// ── Panel republication ──────────────────────────────────────────────────────

test('purging a panel channel removes only the bot\'s own messages, and counts them correctly', async () => {
  const { Collection } = require('discord.js');
  const panelService = require('../src/services/panelService');

  const message = (id, ageDays, authorId = 'bot') => ({
    id,
    author: { id: authorId },
    deletable: true,
    createdTimestamp: Date.now() - ageDays * 86_400_000,
    async delete() { return this; },
  });

  const channel = (messages) => {
    const bulked = [];
    return {
      id: 'c1',
      name: 'panels',
      guild: { id: 'g1' },
      messages: { fetch: async () => new Collection(messages.map((m) => [m.id, m])) },
      // The real endpoint resolves with an empty collection when the message is
      // no longer cached, which is exactly the case the count must not rely on.
      bulkDelete: async (list) => { bulked.push(...list.map((m) => m.id)); return new Collection(); },
      bulked,
    };
  };

  const mixed = channel([
    message('1', 1), message('2', 2), message('3', 3),
    message('4', 40),                       // too old to bulk delete
    message('5', 1, 'someone-else'),        // not ours
  ]);
  assert.equal(await panelService.purgeOwnMessages(mixed, 'bot'), 4);
  assert.ok(!mixed.bulked.includes('5'), 'another author\'s message must never be touched');
  assert.ok(!mixed.bulked.includes('4'), 'messages past the bulk window go one at a time');

  // One message must not go through bulkDelete: its result is unreliable there.
  const lone = channel([message('9', 1)]);
  assert.equal(await panelService.purgeOwnMessages(lone, 'bot'), 1);
  assert.equal(lone.bulked.length, 0);

  const foreign = channel([message('7', 1, 'someone-else')]);
  assert.equal(await panelService.purgeOwnMessages(foreign, 'bot'), 0);
});

// ── Automatic developer status ───────────────────────────────────────────────

/** Hours that are always open, or always shut, so the mode logic is deterministic. */
const ALWAYS_OPEN = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, { open: '00:00', close: '23:59' }]));
const ALWAYS_SHUT = Object.fromEntries([0, 1, 2, 3, 4, 5, 6].map((d) => [d, null]));

const statusConfig = (hours, status) => ({ business: { timezone: 'UTC', hours }, status });

test('an automatic status follows the office hours in both directions', () => {
  // The bug this pins: the stored default is `offline`, and the old rule only
  // ever downgraded a status. A guild that had never touched /status therefore
  // advertised "offline" at midday, every day, forever.
  assert.equal(businessService.effectiveStatus(statusConfig(ALWAYS_OPEN, { current: 'offline', auto: true })), 'online');
  assert.equal(businessService.effectiveStatus(statusConfig(ALWAYS_SHUT, { current: 'offline', auto: true })), 'away');
  assert.equal(businessService.effectiveStatus(statusConfig(ALWAYS_OPEN, { current: 'busy', auto: true })), 'online');

  // `auto` defaults to on when the key is absent, so an existing document that
  // predates the option still behaves sensibly.
  assert.equal(businessService.effectiveStatus(statusConfig(ALWAYS_OPEN, { current: 'offline' })), 'online');
});

test('a pinned status is respected, except for promising availability after hours', () => {
  const pinned = (current, hours) => businessService.effectiveStatus(statusConfig(hours, { current, auto: false }));

  assert.equal(pinned('busy', ALWAYS_OPEN), 'busy');
  assert.equal(pinned('busy', ALWAYS_SHUT), 'busy', 'busy is honest at any hour');
  assert.equal(pinned('streaming', ALWAYS_SHUT), 'streaming');
  assert.equal(pinned('online', ALWAYS_OPEN), 'online');
  // Advertising "online" when the studio is shut is a promise nobody is there
  // to keep.
  assert.equal(pinned('online', ALWAYS_SHUT), 'away');
  assert.equal(pinned('coding', ALWAYS_SHUT), 'away');
});

test('turning off hour-tracking hands the status back entirely', () => {
  const config = statusConfig(ALWAYS_SHUT, { current: 'online', auto: true, autoFromHours: false });
  assert.equal(businessService.effectiveStatus(config), 'online');
  assert.equal(businessService.isAutoStatus(config), false);
});

test('isAutoStatus reports which mode is driving the panel', () => {
  assert.equal(businessService.isAutoStatus(statusConfig(ALWAYS_OPEN, { auto: true })), true);
  assert.equal(businessService.isAutoStatus(statusConfig(ALWAYS_OPEN, { auto: false })), false);
  assert.equal(businessService.isAutoStatus(statusConfig(ALWAYS_OPEN, {})), true, 'absent means automatic');
});

test('office hours track the wall clock across a daylight-saving change', () => {
  // 12:00-21:00 in America/New_York must stay 12:00-21:00 local on both sides
  // of the switch. A fixed UTC-5 offset would drift by an hour in summer.
  const { DEFAULT_CONFIG } = require('../src/config/defaults');
  const config = { business: DEFAULT_CONFIG.business };
  assert.equal(config.business.timezone, 'America/New_York');

  const at = (iso) => businessService.availability(config, new Date(iso));

  // Winter: EST is UTC-5, so noon local is 17:00Z.
  assert.equal(at('2026-01-14T16:59:00Z').open, false);
  assert.equal(at('2026-01-14T17:00:00Z').open, true);
  assert.equal(at('2026-01-15T01:59:00Z').open, true);
  assert.equal(at('2026-01-15T02:00:00Z').open, false);

  // Summer: EDT is UTC-4, so noon local is 16:00Z — one hour earlier in UTC,
  // same hour on the clock.
  assert.equal(at('2026-07-14T15:59:00Z').open, false);
  assert.equal(at('2026-07-14T16:00:00Z').open, true);
  assert.equal(at('2026-07-15T00:59:00Z').open, true);
  assert.equal(at('2026-07-15T01:00:00Z').open, false);
});

// ── Non-destructive repair ───────────────────────────────────────────────────

test('setup repair contains no destructive call', () => {
  // The whole point of `repair` is that it is safe to run on a live server with
  // thousands of members in it. A `.delete()` slipping into this function later
  // would be catastrophic and completely silent — the command would still look
  // like it worked. Reading the compiled function body is crude, but it is the
  // only way to assert this without a live Discord gateway, and it fails loudly
  // if anyone adds one.
  const setupService = require('../src/services/setupService');
  const source = setupService.repair.toString();

  for (const forbidden of ['.delete(', '.bulkDelete(', 'teardown(', '.setPositions(']) {
    assert.ok(
      !source.includes(forbidden),
      `repair() must never call ${forbidden} — it runs against live servers`,
    );
  }

  // And it must genuinely create things, or it is not doing its job.
  assert.ok(source.includes('channels.create'), 'repair should create missing channels');
  assert.ok(source.includes('roles.create'), 'repair should create missing roles');
});

test('/setup exposes repair as well as rebuild', () => {
  const setup = require('../src/commands/admin/setup');
  const names = setup.data.toJSON().options.map((option) => option.name);

  assert.deepEqual(names, ['repair', 'rebuild']);
  // Repair first: it is the one that is safe to run, and the one people
  // actually need when the blueprint has gained a channel.
  assert.equal(names[0], 'repair');
});

// ── Connection string diagnostics ────────────────────────────────────────────

test('a localhost database URL is recognised so the error can explain itself', () => {
  // Copying a local DATABASE_URL onto a host is the most common deployment
  // mistake, and "ECONNREFUSED 127.0.0.1" names a machine that was never going
  // to have a database on it. This is what turns that into a useful message.
  const { isLocalhostUri } = require('../src/database/connection');

  for (const uri of [
    'mongodb://localhost:27017/studio',
    'mongodb://127.0.0.1:27017/studio',
    'mongodb://user:pw@localhost:27017/studio',
    'mongodb://localhost/studio',
    'mongodb://[::1]:27017/studio',
  ]) {
    assert.equal(isLocalhostUri(uri), true, uri);
  }

  for (const uri of [
    'mongodb://mongo:pw@mongodb.railway.internal:27017/studio',
    'mongodb+srv://user:pw@cluster0.abcde.mongodb.net/studio',
    'mongodb://mongo:27017/studio',
    // A password that merely contains the word must not trigger it.
    'mongodb://user:localhost@realhost:27017/studio',
    '',
  ]) {
    assert.equal(isLocalhostUri(uri), false, uri);
  }
});

test('connection failures name the actual mistake', () => {
  const { diagnose } = require('../src/database/connection');
  const hint = (message, uri) => diagnose(new Error(message), uri) ?? '';

  assert.match(
    hint('connect ECONNREFUSED 127.0.0.1:27017', 'mongodb://localhost:27017/studio'),
    /localhost.*means the container itself/s,
  );

  // MongoDB authenticates against a database, not a server. Hosted providers
  // create the user in `admin`, so appending a database name to an otherwise
  // correct URL breaks auth — with a message that never mentions why.
  assert.match(
    hint('Authentication failed.', 'mongodb://mongo:pw@mongodb.railway.internal:27017/studio'),
    /authSource=admin/,
  );

  // With authSource already set, that advice would be wrong — say something else.
  assert.doesNotMatch(
    hint('Authentication failed.', 'mongodb://mongo:pw@host:27017/studio?authSource=admin'),
    /Append/,
  );
  assert.match(
    hint('Authentication failed.', 'mongodb://mongo:pw@host:27017/studio?authSource=admin'),
    /username or password is wrong/,
  );

  // A refused connection to a real host has no obvious single cause.
  assert.equal(diagnose(new Error('connect ECONNREFUSED 10.0.0.5:27017'), 'mongodb://host:27017/db'), null);
  assert.equal(diagnose(new Error('some unrelated failure'), 'mongodb://host/db'), null);
});

// ── Welcome greeting cleanup ─────────────────────────────────────────────────

test('the welcome sweep spares the panel, pins and anything recent', async () => {
  const { Collection } = require('discord.js');
  const scheduler = require('../src/services/schedulerService');

  const job = scheduler.JOBS.find((entry) => entry.name === 'sweep-welcome-greetings');
  assert.ok(job, 'the sweep job must be registered');

  const deleted = [];
  const message = (id, ageSeconds, options = {}) => ({
    id,
    author: { id: 'bot' },
    createdTimestamp: Date.now() - ageSeconds * 1000,
    pinned: false,
    deletable: true,
    async delete() { deleted.push(id); return this; },
    ...options,
  });

  const messages = [
    message('panel', 9999),                       // the panel itself
    message('pinned', 9999, { pinned: true }),    // deliberately kept
    message('old-greeting', 300),                 // past the TTL
    message('fresh-greeting', 5),                 // still within it
    message('someone-else', 9999, { author: { id: 'human' } }),
  ];

  const guild = {
    id: 'g1',
    client: { user: { id: 'bot' } },
    channels: {
      cache: new Collection([['welcome-channel', {
        id: 'welcome-channel',
        isTextBased: () => true,
        messages: { fetch: async () => new Collection(messages.map((m) => [m.id, m])) },
      }]]),
    },
  };

  const config = {
    setup: { completed: true },
    welcome: { channelMessage: true, deleteAfterSeconds: 60 },
    channels: { welcome: 'welcome-channel' },
    panels: { welcome: { messageId: 'panel' } },
  };

  await job.run(guild, config);
  assert.deepEqual(deleted, ['old-greeting']);
});

test('the welcome sweep refuses to run when it cannot identify the panel', async () => {
  const { Collection } = require('discord.js');
  const scheduler = require('../src/services/schedulerService');
  const job = scheduler.JOBS.find((entry) => entry.name === 'sweep-welcome-greetings');

  let fetched = false;
  const guild = {
    id: 'g1',
    client: { user: { id: 'bot' } },
    channels: {
      cache: new Collection([['welcome-channel', {
        id: 'welcome-channel',
        isTextBased: () => true,
        messages: { fetch: async () => { fetched = true; return new Collection(); } },
      }]]),
    },
  };

  // No stored panel id: the panel and a greeting are indistinguishable, so
  // sweeping would eventually delete the panel. It must not even look.
  await job.run(guild, {
    setup: { completed: true },
    welcome: { deleteAfterSeconds: 60 },
    channels: { welcome: 'welcome-channel' },
    panels: {},
  });
  assert.equal(fetched, false);

  // Likewise when greetings are configured to be permanent.
  await job.run(guild, {
    setup: { completed: true },
    welcome: { deleteAfterSeconds: 0 },
    channels: { welcome: 'welcome-channel' },
    panels: { welcome: { messageId: 'panel' } },
  });
  assert.equal(fetched, false);
});

// ── AutoMod presets and ticket relaxation ────────────────────────────────────

test('the minimal preset moderates slurs and invites and nothing else', () => {
  const presets = require('../src/security/presets');
  const { DEFAULT_CONFIG } = require('../src/config/defaults');

  const { enabled, disabled } = presets.apply('minimal', DEFAULT_CONFIG.automod.modules);

  assert.deepEqual(enabled.sort(), [
    'fakeNitro', 'inviteLinks', 'malwareLinks', 'phishingLinks',
    'scamLinks', 'slurs', 'tokenGrabbers',
  ]);

  // The rules that fire on ordinary conversation must all be off — these are
  // what made the server feel like it deleted everything.
  for (const noisy of [
    'capsAbuse', 'symbolAbuse', 'newlineAbuse', 'emojiSpam', 'repeatedMessages',
    'profanity', 'advertising', 'selfPromotion', 'gifSpam',
  ]) {
    assert.ok(disabled.includes(noisy), `${noisy} should be off in minimal`);
  }
});

test('a preset changes only the enabled flag, never a tuned threshold', () => {
  const presets = require('../src/security/presets');

  const current = {
    slurs: { enabled: false, action: 'ban', threshold: 1, duration: 10080 },
    capsAbuse: { enabled: true, action: 'delete', threshold: 90 },
  };
  const { modules } = presets.apply('minimal', current);

  assert.equal(modules.slurs.enabled, true);
  assert.equal(modules.slurs.action, 'ban', 'a tuned action must survive');
  assert.equal(modules.slurs.duration, 10080);
  assert.equal(modules.capsAbuse.enabled, false);
  assert.equal(modules.capsAbuse.threshold, 90, 'a disabled module keeps its settings');
});

test('scam protection cannot be switched off by any preset', () => {
  const presets = require('../src/security/presets');
  const { DEFAULT_CONFIG } = require('../src/config/defaults');

  for (const level of Object.keys(presets.PRESETS)) {
    const { enabled } = presets.apply(level, DEFAULT_CONFIG.automod.modules);
    for (const critical of presets.ALWAYS_ON) {
      assert.ok(enabled.includes(critical), `${critical} must stay on in ${level}`);
    }
  }
});

test('the shipped defaults are recognisable as the strict preset', () => {
  const presets = require('../src/security/presets');
  const { DEFAULT_CONFIG } = require('../src/config/defaults');

  // If this fails, `strict` has drifted from defaults.js and its description
  // ("everything the shipped defaults enable") has quietly become a lie.
  assert.equal(presets.identify(DEFAULT_CONFIG.automod.modules), 'strict');
  assert.equal(presets.identify({}), null);
});

test('tickets are recognised so AutoMod can stand down inside them', () => {
  const autoMod = require('../src/security/autoMod');
  const config = { categories: { tickets: 'cat-tickets', archive: 'cat-archive' } };

  assert.equal(autoMod.isTicketChannel({ parentId: 'cat-tickets' }, config), true);
  assert.equal(autoMod.isTicketChannel({ parentId: 'cat-archive' }, config), true);
  assert.equal(autoMod.isTicketChannel({ parentId: 'cat-general' }, config), false);
  assert.equal(autoMod.isTicketChannel({ parentId: null }, config), false);
  assert.equal(autoMod.isTicketChannel({ parentId: 'cat-tickets' }, {}), false, 'no categories configured');

  // A Discord invite is the single most likely thing a Minecraft customer
  // sends, so it must not be in the set that still runs inside a ticket.
  assert.equal(autoMod.TICKET_SAFE_MODULES.has('inviteLinks'), false);
  assert.equal(autoMod.TICKET_SAFE_MODULES.has('capsAbuse'), false);
  assert.equal(autoMod.TICKET_SAFE_MODULES.has('phishingLinks'), true);
  assert.equal(autoMod.TICKET_SAFE_MODULES.has('tokenGrabbers'), true);
});

// ── Automated ticket support ─────────────────────────────────────────────────

const aiService = require('../src/services/aiService');

test('a reply that mentions money is caught, whatever shape it takes', () => {
  // This is the guarantee, not the system prompt. A model told not to quote
  // will still occasionally quote; a customer given a number by a machine will
  // hold the studio to it, and would be right to.
  for (const quoted of [
    'That would be about $150.',
    'Around 200 USD for a plugin like that.',
    'It costs 50 to build.',
    'The price is 80 euros.',
    'We charge 40 per hour.',
    'Roughly £120 depending on scope.',
    'That would be 30 bucks.',
    'I can do it for 25 per project.',
    'This one is free of charge.',
    'Plugins are pretty cheap to build.',
    'That is quite expensive, honestly.',
    'I could offer a discount on that.',
    'Our rate is 60.',
  ]) {
    assert.equal(aiService.mentionsMoney(quoted), true, `should have been caught: "${quoted}"`);
  }
});

test('ordinary support answers are not mistaken for quotes', () => {
  for (const safe of [
    'Yes, that is the kind of plugin the studio builds. The developer will confirm the specifics.',
    'The studio is closed right now and reopens Monday at 12:00 PM. Hold tight and you will get a reply then.',
    'Could you say a bit more about how many players your server usually has?',
    'The developer will read your brief and send you a quote.',
    'That sounds like a Discord bot rather than a plugin, but both are in scope.',
    'You can track your project position with /queue.',
    'I have logged this — someone will be with you shortly.',
    'Version 1.20 is supported, yes.',
    'It usually takes 3 messages to pin down a brief.',
  ]) {
    assert.equal(aiService.mentionsMoney(safe), false, `should have been allowed: "${safe}"`);
  }
});

test('the assistant stays quiet unless it is genuinely covering', () => {
  const ticket = { userId: 'customer', status: 'open', aiReplies: 0 };
  const config = { ai: { enabled: true } };
  const from = (id) => ({ author: { id } });

  // Without a key nothing runs at all, so assert the shape of the refusal
  // rather than the outcome, which depends on the environment.
  const verdict = aiService.shouldReply({ message: from('customer'), ticket, config });
  assert.equal(typeof verdict.ok, 'boolean');
  assert.equal(typeof verdict.reason === 'string' || verdict.ok, true);

  // These refusals hold regardless of the key.
  assert.equal(
    aiService.shouldReply({ message: from('staff'), ticket, config }).reason,
    aiService.isConfigured() ? 'not the ticket opener' : 'no API key configured',
  );
  assert.equal(
    aiService.shouldReply({ message: from('customer'), ticket, config: { ai: { enabled: false } } }).ok,
    false,
  );
  assert.equal(
    aiService.shouldReply({ message: from('customer'), ticket: { ...ticket, aiDisabled: true }, config }).ok,
    false,
  );
  assert.equal(
    aiService.shouldReply({ message: from('customer'), ticket: { ...ticket, status: 'closed' }, config }).ok,
    false,
  );
  assert.equal(
    aiService.shouldReply({ message: from('customer'), ticket: { ...ticket, aiReplies: 6 }, config }).ok,
    false,
  );
});

test('a human speaking in the ticket stands the assistant down', () => {
  const { Collection } = require('discord.js');
  const at = Date.now();
  const message = (id, authorId, offset, bot = false) => [id, {
    id, createdTimestamp: at + offset, author: { id: authorId, bot },
  }];

  const withStaff = new Collection([
    message('1', 'customer', 0),
    message('2', 'staff', 100),
  ]);
  assert.equal(aiService.humanRepliedSince(withStaff, at, 'customer', 'bot'), true);

  // The bot's own replies and other bots must not count as a human arriving.
  const withoutStaff = new Collection([
    message('1', 'customer', 0),
    message('2', 'bot', 100),
    message('3', 'otherbot', 150, true),
  ]);
  assert.equal(aiService.humanRepliedSince(withoutStaff, at, 'customer', 'bot'), false);

  // A staff message from *before* the customer asked is not an answer to it.
  const staffEarlier = new Collection([
    message('0', 'staff', -5000),
    message('1', 'customer', 0),
  ]);
  assert.equal(aiService.humanRepliedSince(staffEarlier, at, 'customer', 'bot'), false);
});

test('history becomes a valid alternating conversation', () => {
  const { Collection } = require('discord.js');
  const message = (id, authorId, content, offset) => [id, {
    id, content, createdTimestamp: 1000 + offset, author: { id: authorId }, embeds: [],
  }];

  // Deliberately out of order, and starting with a non-customer turn.
  const history = new Collection([
    message('3', 'customer', 'and it needs a config file', 30),
    message('1', 'bot', 'Ticket opened', 0),
    message('2', 'customer', 'I need a plugin', 10),
    message('4', 'staff', 'on it', 40),
  ]);

  const messages = aiService.toMessages(history, 'customer', 'bot');

  // Must begin with a user turn — the API rejects anything else.
  assert.equal(messages[0].role, 'user');
  // Consecutive same-role messages must be merged, not sent as duplicates.
  for (let i = 1; i < messages.length; i += 1) {
    assert.notEqual(messages[i].role, messages[i - 1].role, 'roles must alternate');
  }
  assert.match(messages[0].content, /I need a plugin/);
  assert.match(messages[0].content, /config file/);
  // A staff turn is marked so the model can tell it from its own earlier reply.
  assert.match(messages[messages.length - 1].content, /\[staff\]/);
});

test('the system prompt is built from the studio\'s own configuration', () => {
  const { DEFAULT_CONFIG } = require('../src/config/defaults');
  const prompt = aiService.buildSystemPrompt({
    ...DEFAULT_CONFIG,
    brand: { name: 'TestStudio' },
  });

  assert.match(prompt, /TestStudio/);
  assert.match(prompt, /NEVER state, estimate, imply or range a price/);
  assert.match(prompt, /NEVER commit to a deadline/);
  assert.match(prompt, /YOU ARE NOT THE DEVELOPER/);
  // Prompt-injection resistance is stated explicitly, since a customer asking
  // it to "ignore previous instructions" is a matter of when, not if.
  assert.match(prompt, /claims to be staff/);
  // Services and FAQ come from config, so it cannot describe a studio that
  // does not exist.
  assert.match(prompt, /Minecraft Plugin Development/);
  assert.match(prompt, /America\/New_York/);
});
