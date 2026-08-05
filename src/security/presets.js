'use strict';

/**
 * AutoMod presets.
 *
 * The shipped defaults turn on nearly thirty modules, which is right for a
 * large public community and wrong for almost everyone else: caps, symbols,
 * newlines, emoji counts, repeated messages, profanity and self-promotion all
 * fire on ordinary conversation. On a customer-facing server that reads as "the
 * bot deletes everything", and the cost is real — people stop talking.
 *
 * A preset is a named answer to "how much moderation does this server actually
 * want", applied in one command instead of twenty-eight.
 */

const { DEFAULT_CONFIG } = require('../config/defaults');

/**
 * Modules that stay on at every level.
 *
 * These do not police how somebody writes; they stop a third party stealing
 * from your members. There is no server that wants a token grabber in it.
 */
const ALWAYS_ON = Object.freeze([
  'scamLinks', 'phishingLinks', 'malwareLinks', 'tokenGrabbers', 'fakeNitro',
]);

/**
 * Every module the shipped defaults switch on.
 *
 * Derived rather than listed, so `strict` cannot drift from `defaults.js`. It
 * is not "all modules": `offensiveLanguage` and `nsfwImages` ship off, the
 * first because it is a tone judgement and the second because it needs an
 * external moderation API.
 */
const SHIPPED_ON = Object.freeze(
  Object.entries(DEFAULT_CONFIG.automod.modules)
    .filter(([, settings]) => settings.enabled)
    .map(([key]) => key),
);

const PRESETS = Object.freeze({
  minimal: {
    label: 'Minimal',
    summary: 'Slurs and Discord invites only, plus scam protection. Nothing else is touched.',
    detail:
      'Ordinary conversation is never moderated — no caps, emoji, repeats, profanity or link rules. '
      + 'Best for a small server where the members are customers rather than strangers.',
    modules: [...ALWAYS_ON, 'slurs', 'inviteLinks'],
  },

  balanced: {
    label: 'Balanced',
    summary: 'Minimal, plus raid-shaped spam: message floods, mention spam and mass DMs.',
    detail:
      'Adds the rules that catch someone attacking the server rather than someone talking in it. '
      + 'Still allows caps, emoji, repeated messages and swearing.',
    modules: [
      ...ALWAYS_ON, 'slurs', 'inviteLinks',
      'spam', 'flood', 'mentionSpam', 'massDm', 'everyonePing', 'herePing', 'zalgo',
    ],
  },

  strict: {
    label: 'Strict',
    summary: 'Everything the shipped defaults enable. Suited to a large public community.',
    detail:
      'Includes tone policing — caps, symbols, newlines, emoji counts, repeated messages, '
      + 'profanity, advertising and self-promotion. Expect false positives in normal conversation.',
    modules: SHIPPED_ON,
  },
});

/**
 * Produce the `automod.modules` tree for a preset, preserving each module's
 * existing action, threshold and duration.
 *
 * Only the `enabled` flag changes: someone who has tuned `slurs` to a 7-day
 * timeout should not silently get the shipped 24 hours back because they
 * switched preset.
 *
 * @param {string} name preset key
 * @param {object} current the guild's existing `automod.modules`
 * @returns {{ modules: object, enabled: string[], disabled: string[] }}
 */
function apply(name, current = {}) {
  const preset = PRESETS[name];
  if (!preset) throw new Error(`Unknown preset: ${name}`);

  const wanted = new Set(preset.modules);
  const modules = {};
  const enabled = [];
  const disabled = [];

  for (const [key, settings] of Object.entries(current)) {
    const on = wanted.has(key);
    modules[key] = { ...settings, enabled: on };
    (on ? enabled : disabled).push(key);
  }

  return { modules, enabled, disabled };
}

/** Which preset, if any, the current configuration matches exactly. */
function identify(current = {}) {
  const on = new Set(Object.entries(current).filter(([, s]) => s?.enabled).map(([key]) => key));

  for (const [name, preset] of Object.entries(PRESETS)) {
    const wanted = new Set(preset.modules);
    if (wanted.size !== on.size) continue;
    if ([...wanted].every((key) => on.has(key))) return name;
  }
  return null;
}

module.exports = { PRESETS, ALWAYS_ON, apply, identify };
