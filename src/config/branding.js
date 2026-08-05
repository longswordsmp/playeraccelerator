'use strict';

/**
 * Brand system — the single source of truth for every colour, glyph and piece of
 * public wording the bot renders.
 *
 * Everything here is overridable per-guild through the `Configuration` model
 * (`/config theme ...`); these values are the shipped defaults. Keep the palette
 * dark / indigo / violet with white accents — that is the house style.
 */

/** Core palette. Hex integers so they can be handed straight to EmbedBuilder. */
/**
 * Core palette, sampled directly from the logo and banner artwork in `brand/`
 * so embeds sit against the imagery rather than clashing with it:
 *   #818cf8 → #6366f1 → #a855f7   the mark's gradient
 *   #242840 → #141721             the surface behind it
 */
const COLORS = Object.freeze({
  /** Primary indigo — the midpoint of the logo gradient. */
  primary: 0x6366f1,
  /** Violet accent — the logo gradient's end stop, used for panels. */
  accent: 0xa855f7,
  /** Light indigo — the gradient's start stop, for highlights. */
  highlight: 0x818cf8,
  /** Deep navy — the artwork's surface colour, for large document embeds. */
  surface: 0x242840,
  /** Discord dark background — blends the embed into the client. */
  blend: 0x2b2d31,
  /** White accent — used sparingly for maximum contrast headers. */
  white: 0xf8fafc,

  success: 0x22c55e,
  warning: 0xf59e0b,
  danger: 0xef4444,
  info: 0x38bdf8,
  muted: 0x64748b,

  /** Status colours for the live developer status panel. */
  online: 0x22c55e,
  coding: 0x6366f1,
  streaming: 0xa855f7,
  meeting: 0x0ea5e9,
  busy: 0xf59e0b,
  away: 0x94a3b8,
  offline: 0x475569,

  /** Priority colours for tickets. */
  priorityLow: 0x64748b,
  priorityNormal: 0x6366f1,
  priorityHigh: 0xf59e0b,
  priorityUrgent: 0xef4444,
});

/**
 * Icon set. Deliberately restrained: a small, consistent, professional glyph
 * vocabulary rather than a random emoji soup.
 */
const EMOJIS = Object.freeze({
  brand: '⚡',
  ticket: '🎫',
  order: '📋',
  review: '⭐',
  portfolio: '📁',
  promotion: '📢',
  pricing: '💰',
  status: '📈',
  queue: '📅',
  stats: '📊',
  staff: '🛡️',
  customer: '🛒',
  security: '🔒',
  moderation: '⚠️',
  logs: '📑',
  success: '✅',
  error: '⛔',
  warning: '⚠️',
  info: 'ℹ️',
  loading: '⏳',
  arrow: '›',
  bullet: '•',
  dot: '·',
  clock: '🕒',
  calendar: '📆',
  user: '👤',
  users: '👥',
  lock: '🔒',
  unlock: '🔓',
  trash: '🗑️',
  pencil: '📝',
  bolt: '⚡',
  link: '🔗',
  transcript: '📄',
  star: '⭐',
  starEmpty: '☆',
  claim: '✅',
  close: '🔒',
  reopen: '🔓',
  add: '➕',
  remove: '➖',
  transfer: '🔁',
  note: '🗒️',
  priority: '⚡',
  home: '🏠',
  back: '◀',
  forward: '▶',
});

/**
 * Default brand identity — overridable per guild via `/config brand`.
 *
 * `logoUrl` and `bannerUrl` must be publicly reachable HTTPS URLs; Discord
 * fetches them server-side, so a local file path will not render. The artwork
 * ships in `brand/` — upload it somewhere public (or post it in a Discord
 * channel and copy the CDN link) and set the URLs with `/config brand`.
 */
const BRAND = Object.freeze({
  name: 'Samotworks',
  tagline: 'Software built properly, priced honestly.',
  shortName: 'Samotworks',
  footer: 'Samotworks · Software Development Studio',
  /** Optional absolute URLs — leave empty to omit them from embeds. */
  logoUrl: '',
  bannerUrl: '',
  websiteUrl: 'https://samotportfolio.netlify.app',
  supportEmail: '',
  /** Divider used between embed sections for a consistent rhythm. */
  divider: '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━',
  thinDivider: '─────────────────────────────',
});

/**
 * Star bar renderer used by every review surface.
 * @param {number} rating 1-5
 * @returns {string} e.g. "⭐⭐⭐⭐☆"
 */
function stars(rating) {
  const value = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
  return `${EMOJIS.star.repeat(value)}${EMOJIS.starEmpty.repeat(5 - value)}`;
}

module.exports = { COLORS, EMOJIS, BRAND, stars };
