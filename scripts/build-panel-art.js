'use strict';

/**
 * Panel artwork generator.
 *
 * Writes one SVG per public panel into `brand/panels/`, all cut from the same
 * template so the set reads as a family: same surface, same grid, same gradient,
 * same left-weighted composition. Only the wording and the glyph change.
 *
 * The glyphs are hand-written vector paths on a 96×96 grid rather than emoji or
 * an icon font, because the renderer here has neither Segoe UI Emoji nor any
 * icon font installed — anything font-dependent would come out as tofu.
 *
 *   node scripts/build-panel-art.js          # write the SVGs
 *   node scripts/render-brand.js             # rasterise them to PNG
 */

const fs = require('node:fs');
const path = require('node:path');

const OUT = path.join(__dirname, '..', 'brand', 'panels');

/** Typeface stack. Liberation Sans is Arial-metric and present on most Linux
 *  render hosts; the rest are fallbacks for macOS and Windows. */
const FONT = 'Liberation Sans, Segoe UI, Inter, Helvetica Neue, Arial, sans-serif';

// ── Glyphs ───────────────────────────────────────────────────────────────────
// Each entry is a list of shapes drawn inside a 96×96 box. `d` paths are stroked
// with the brand gradient; `circle` entries are stroked the same way unless
// `fill` says otherwise.

const GLYPHS = {
  welcome: [
    { d: 'M10 46 L48 12 L86 46' },
    { d: 'M22 40 V84 H74 V40' },
    { d: 'M39 84 V60 H57 V84' },
  ],
  verify: [
    { d: 'M48 8 L84 23 V50 C84 71 68 83 48 89 C28 83 12 71 12 50 V23 Z' },
    { d: 'M33 47 L44 58 L65 36' },
  ],
  freeCommission: [
    { d: 'M16 42 H80 V84 H16 Z' },
    { d: 'M10 26 H86 V42 H10 Z' },
    { d: 'M48 26 V84' },
    { d: 'M48 26 C42 8 22 10 24 21 C25 26 38 27 48 26 Z' },
    { d: 'M48 26 C54 8 74 10 72 21 C71 26 58 27 48 26 Z' },
  ],
  rules: [
    { d: 'M22 8 H60 L80 28 V88 H22 Z' },
    { d: 'M60 8 V28 H80' },
    { d: 'M35 46 H67' },
    { d: 'M35 60 H67' },
    { d: 'M35 74 H55' },
  ],
  faq: [
    { d: 'M10 18 H86 V64 H50 L32 82 V64 H10 Z' },
    { d: 'M36 34 C36 25 42 20 49 20 C57 20 63 25 63 33 C63 42 50 43 50 52' },
    { circle: [50, 62, 4], fill: true },
  ],
  tos: [
    { d: 'M18 6 H58 L78 26 V70 H18 Z' },
    { d: 'M58 6 V26 H78' },
    { d: 'M31 40 H63' },
    { d: 'M31 54 H55' },
    { circle: [62, 72, 15] },
    { d: 'M53 84 L50 96 L62 90 L74 96 L71 84' },
  ],
  pricing: [
    { d: 'M52 8 H88 V44 L46 86 L10 50 Z' },
    { circle: [72, 24, 8] },
  ],
  portfolio: [
    { d: 'M10 30 H86 V84 H10 Z' },
    { d: 'M35 30 V18 H61 V30' },
    { d: 'M10 54 H86' },
    { d: 'M43 50 H53 V60 H43 Z' },
  ],
  reviews: [
    { d: 'M48 8 L61 36 L91 40 L69 61 L75 91 L48 76 L21 91 L27 61 L5 40 L35 36 Z' },
  ],
  ticket: [
    {
      d: 'M14 28 H82 A4 4 0 0 1 86 32 V40 A8 8 0 0 0 86 56 V64 A4 4 0 0 1 82 68 '
        + 'H14 A4 4 0 0 1 10 64 V56 A8 8 0 0 0 10 40 V32 A4 4 0 0 1 14 28 Z',
    },
    // Perforation, drawn as discrete segments rather than a dash array so the
    // gaps land in the same place at every raster size.
    { d: 'M62 33 V41' },
    { d: 'M62 44 V52' },
    { d: 'M62 55 V63' },
  ],
  status: [
    { d: 'M6 52 H26 L37 20 L52 76 L63 42 L71 56 H90' },
  ],
  hours: [
    { circle: [48, 48, 39] },
    { d: 'M48 22 V49 L67 60' },
  ],
  statistics: [
    { d: 'M12 88 H86' },
    { d: 'M22 78 V54' },
    { d: 'M40 78 V36' },
    { d: 'M58 78 V48' },
    { d: 'M76 78 V18' },
  ],
  queue: [
    { circle: [16, 24, 6], fill: true },
    { circle: [16, 48, 6], fill: true },
    { circle: [16, 72, 6], fill: true },
    { d: 'M34 24 H88' },
    { d: 'M34 48 H88' },
    { d: 'M34 72 H70' },
  ],
  performance: [
    { d: 'M30 12 H66 V34 C66 47 58 55 48 55 C38 55 30 47 30 34 Z' },
    { d: 'M30 18 H16 C16 33 24 39 31 40' },
    { d: 'M66 18 H80 C80 33 72 39 65 40' },
    { d: 'M48 55 V68' },
    { d: 'M36 68 H60 V82 H36 Z' },
    { d: 'M26 88 H70' },
  ],
  launch: [
    { d: 'M48 6 C64 20 72 38 72 54 L48 70 L24 54 C24 38 32 20 48 6 Z' },
    { circle: [48, 36, 10] },
    { d: 'M32 62 L18 88 L38 78' },
    { d: 'M64 62 L78 88 L58 78' },
  ],
};

// ── Panels ───────────────────────────────────────────────────────────────────
// key -> the wording printed on the header.

const PANELS = [
  { key: 'welcome', title: 'Welcome', subtitle: 'Start here' },
  { key: 'verify', title: 'Verification', subtitle: 'One click to unlock the server' },
  { key: 'freeCommission', title: 'Free Service', subtitle: 'Earn a build through referrals' },
  { key: 'rules', title: 'Rules', subtitle: 'How this server operates' },
  { key: 'faq', title: 'FAQ', subtitle: 'The questions we get most' },
  { key: 'tos', title: 'Terms of Service', subtitle: 'The agreement behind every project' },
  { key: 'pricing', title: 'Pricing', subtitle: 'Quoted per project, never guessed' },
  { key: 'portfolio', title: 'Portfolio', subtitle: 'Work we have delivered' },
  { key: 'reviews', title: 'Reviews', subtitle: 'Verified customer feedback' },
  { key: 'ticket', title: 'Create a Ticket', subtitle: 'Start a project or ask a question' },
  { key: 'status', title: 'Developer Status', subtitle: 'Live availability' },
  { key: 'hours', title: 'Working Hours', subtitle: 'Open daily, 12:00 – 21:00' },
  { key: 'statistics', title: 'Statistics', subtitle: 'Numbers we are happy to be judged on' },
  { key: 'queue', title: 'Project Queue', subtitle: 'What is in the pipeline right now' },
  { key: 'performance', title: 'Team Performance', subtitle: 'Internal leaderboard' },
  { key: 'launch', title: 'Launch Week', subtitle: 'Free plugin commissions' },
];

// ── Template ─────────────────────────────────────────────────────────────────

const WIDTH = 1200;
const HEIGHT = 300;

/** Render one glyph shape into stroked SVG. */
function shape({ d, circle, fill }) {
  if (circle) {
    const [cx, cy, r] = circle;
    return fill
      ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="url(#glyph)" stroke="none"/>`
      : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="none"/>`;
  }
  return `<path d="${d}" fill="none"/>`;
}

/**
 * Escape the five XML metacharacters. The panel wording is ours rather than
 * user input, but `&` already appears in it and an unescaped one is a parse
 * error, not a cosmetic problem.
 */
const escape = (value) => String(value)
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

function template({ key, title, subtitle }) {
  const glyph = GLYPHS[key];
  if (!glyph) throw new Error(`No glyph defined for panel "${key}"`);

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}">
  <!-- SamotWorks panel header — ${key}. Generated by scripts/build-panel-art.js; edit that, not this. -->
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#12141d"/>
      <stop offset="60%" stop-color="#161927"/>
      <stop offset="100%" stop-color="#1c1533"/>
    </linearGradient>
    <linearGradient id="brand" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#818cf8"/>
      <stop offset="55%" stop-color="#6366f1"/>
      <stop offset="100%" stop-color="#a855f7"/>
    </linearGradient>
    <!--
      Separate gradient for the glyphs, in user space over the 96×96 glyph box.
      It cannot share #brand: that one uses the default objectBoundingBox units,
      and a perfectly horizontal or vertical stroke has a zero-height or
      zero-width bounding box — which the SVG spec says renders *nothing at all*.
      Every straight segment in these icons (ticket perforations, chart bars,
      trophy stem, list rules) silently disappeared until this was split out.
    -->
    <linearGradient id="glyph" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="96" y2="96">
      <stop offset="0%" stop-color="#818cf8"/>
      <stop offset="55%" stop-color="#6366f1"/>
      <stop offset="100%" stop-color="#a855f7"/>
    </linearGradient>
    <linearGradient id="fade" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#6366f1" stop-opacity="0.6"/>
      <stop offset="100%" stop-color="#a855f7" stop-opacity="0"/>
    </linearGradient>
    <filter id="soft" x="-50%" y="-50%" width="200%" height="200%">
      <feGaussianBlur stdDeviation="55"/>
    </filter>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M40 0 L0 0 0 40" fill="none" stroke="#ffffff" stroke-opacity="0.04" stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#bg)"/>
  <rect width="${WIDTH}" height="${HEIGHT}" fill="url(#grid)"/>

  <!-- Ambient light: one warm pool under the glyph, one cool pool behind the text -->
  <ellipse cx="1010" cy="150" rx="200" ry="150" fill="#a855f7" opacity="0.20" filter="url(#soft)"/>
  <ellipse cx="120" cy="240" rx="230" ry="140" fill="#6366f1" opacity="0.16" filter="url(#soft)"/>

  <!-- Left accent bar, the one element every header shares in exactly the same place -->
  <rect x="0" y="0" width="7" height="${HEIGHT}" fill="url(#brand)"/>

  <!-- Wordmark eyebrow. The mark is scaled to 0.24 and sat at y=44 so its lowest
       point (y≈106) clears the title's cap height (y≈137) with room to spare. -->
  <g transform="translate(72 44) scale(0.24)">
    <path d="M110 40 L32 146 L110 252" fill="none" stroke="url(#brand)" stroke-width="30"
          stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M214 32 L146 260" fill="none" stroke="url(#brand)" stroke-width="30" stroke-linecap="round"/>
    <path d="M250 40 L328 146 L250 252" fill="none" stroke="url(#brand)" stroke-width="30"
          stroke-linecap="round" stroke-linejoin="round"/>
  </g>
  <text x="166" y="88" font-family="${FONT}" font-size="20" font-weight="700"
        fill="#8b90a5" letter-spacing="5.5">SAMOTWORKS</text>

  <!-- Panel title -->
  <text x="72" y="182" font-family="${FONT}" font-size="62" font-weight="700"
        fill="#f8fafc" letter-spacing="-1.5">${escape(title)}</text>
  <text x="74" y="224" font-family="${FONT}" font-size="25" font-weight="400"
        fill="#8b90a5">${escape(subtitle)}</text>

  <rect x="74" y="250" width="260" height="3" rx="1.5" fill="url(#fade)"/>

  <!-- Glyph -->
  <g transform="translate(940 54) scale(2.0)" stroke="url(#glyph)" stroke-width="6"
     stroke-linecap="round" stroke-linejoin="round">
${glyph.map((entry) => `    ${shape(entry)}`).join('\n')}
  </g>
</svg>
`;
}

// ── Entry point ──────────────────────────────────────────────────────────────

fs.mkdirSync(OUT, { recursive: true });

for (const panel of PANELS) {
  const file = path.join(OUT, `${panel.key}.svg`);
  fs.writeFileSync(file, template(panel), 'utf8');
  process.stdout.write(`  ${panel.key.padEnd(16)} ${path.relative(process.cwd(), file)}\n`);
}

process.stdout.write(`\n  ${PANELS.length} panel headers written to brand/panels/\n`);

module.exports = { PANELS, GLYPHS };
