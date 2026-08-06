'use strict';

/**
 * Animated logo and banner.
 *
 * Discord animates GIFs in embeds, as a server icon (boost level 1) and as a
 * server banner (level 2), so GIF is the format that works everywhere the
 * static artwork already does.
 *
 * Two decisions worth knowing about:
 *
 * 1. **The mark is never absent.** A "draws itself in" animation looks good
 *    once and terrible as a server icon, because for a fifth of every loop the
 *    icon is blank or half-drawn. The mark is always complete; what moves is a
 *    highlight sweeping through it, a cursor, and the code rain behind.
 *
 * 2. **Frames are sampled by function, not by CSS clock.** The page exposes
 *    `renderFrame(t)` where t runs 0→1, and every animated value is computed
 *    from t. Screenshotting a CSS animation means trusting that the compositor
 *    is exactly where you asked it to be; this way each frame is exact and the
 *    loop closes perfectly, because t=1 is defined to equal t=0.
 *
 *   npm install --no-save playwright-core gifenc
 *   node scripts/build-animated-brand.js
 */

/* `window` below appears only inside a page.evaluate callback, whose body is
   serialised and run inside Chromium rather than in Node. */
/* global window */

const fs = require('node:fs');
const path = require('node:path');

const BRAND = path.join(__dirname, '..', 'brand');

/** 48 frames at 80ms is a 3.84s loop — long enough to read, small enough to ship. */
const FRAMES = 48;
const FRAME_MS = 80;

const JOBS = [
  { name: 'logo-animated.gif', width: 512, height: 512, mode: 'logo' },
  { name: 'banner-animated.gif', width: 1200, height: 400, mode: 'banner' },
];

/** Lines the banner types out, in order, looping. */
const PHRASES = [
  'building plugins',
  'shipping bots',
  'quoting honestly',
];

/**
 * The page. Everything animated is a pure function of `t`, so a frame can be
 * requested in any order and the loop closes exactly.
 */
function page({ width, height, mode }) {
  return `<!doctype html><html><head><meta charset="utf-8"><style>
  *{margin:0;padding:0;border:0}
  html,body{width:${width}px;height:${height}px;overflow:hidden;background:#12141d}
  svg{display:block}
</style></head><body>
<svg id="art" xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#12141d"/>
      <stop offset="60%" stop-color="#161927"/>
      <stop offset="100%" stop-color="#1c1533"/>
    </linearGradient>
    <linearGradient id="brand" gradientUnits="objectBoundingBox" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="#818cf8"/>
      <stop offset="55%" stop-color="#6366f1"/>
      <stop offset="100%" stop-color="#a855f7"/>
    </linearGradient>
    <!-- The sweep: a narrow bright band that travels across the mark. -->
    <linearGradient id="sweep" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="${width}" y2="0">
      <stop id="s0" offset="0%"   stop-color="#ffffff" stop-opacity="0"/>
      <stop id="s1" offset="8%"   stop-color="#ffffff" stop-opacity="0.62"/>
      <stop id="s2" offset="16%"  stop-color="#ffffff" stop-opacity="0"/>
    </linearGradient>
    <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
      <path d="M40 0 L0 0 0 40" fill="none" stroke="#ffffff" stroke-opacity="0.04" stroke-width="1"/>
    </pattern>
  </defs>

  <rect width="${width}" height="${height}" fill="url(#bg)"/>
  <g id="rain"></g>
  <rect width="${width}" height="${height}" fill="url(#grid)"/>
  <g id="content"></g>
</svg>
<script>
const W = ${width}, H = ${height}, MODE = ${JSON.stringify(mode)};
const PHRASES = ${JSON.stringify(PHRASES)};
const NS = 'http://www.w3.org/2000/svg';
const el = (tag, attrs) => {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  return node;
};

// ── Code rain ──────────────────────────────────────────────────────────────
// Deterministic: a tiny LCG seeded once, so every run produces the same art.
let seed = 20260805;
const rnd = () => (seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296;

const GLYPHS = '01{}<>[]()=;:+-*/&|!$#_.';
const CELL = 18;
const COLS = Math.ceil(W / 46);
const columns = [];
for (let i = 0; i < COLS; i += 1) {
  const rows = Math.ceil(H / CELL) + 2;
  columns.push({
    x: 14 + i * 46 + rnd() * 10,
    // Whole number of cells per loop, so the rain wraps seamlessly.
    speed: (1 + Math.floor(rnd() * 3)) * CELL * rows,
    offset: rnd() * H,
    chars: Array.from({ length: rows }, () => GLYPHS[Math.floor(rnd() * GLYPHS.length)]),
  });
}

const rainGroup = document.getElementById('rain');
const rainNodes = columns.map((col) => {
  const g = el('g', {});
  col.chars.forEach((ch, index) => {
    const t = el('text', {
      x: col.x,
      y: index * CELL,
      'font-family': 'DejaVu Sans Mono, Liberation Mono, monospace',
      'font-size': 14,
      fill: '#818cf8',
      // Bright enough to survive a 256-colour palette. Below about 0.10 the
      // quantiser folds the glyphs into the background and the rain vanishes.
      'fill-opacity': 0.10 + (index % 5) * 0.035,
    });
    t.textContent = ch;
    g.appendChild(t);
  });
  rainGroup.appendChild(g);
  return g;
});

// ── Mark ───────────────────────────────────────────────────────────────────
// The same three strokes as the static logo, drawn twice: once in the brand
// gradient, once in the sweep gradient on top.
const MARK = [
  'M110 40 L32 146 L110 252',
  'M214 32 L146 260',
  'M250 40 L328 146 L250 252',
];

const content = document.getElementById('content');
const markScale = MODE === 'logo' ? 1.12 : 0.62;
const markX = MODE === 'logo' ? (W - 360 * markScale) / 2 : 96;
const markY = MODE === 'logo' ? (H - 292 * markScale) / 2 - 10 : 118;

const markGroup = el('g', { transform: 'translate(' + markX + ' ' + markY + ') scale(' + markScale + ')' });
for (const paint of ['url(#brand)', 'url(#sweep)']) {
  for (const d of MARK) {
    markGroup.appendChild(el('path', {
      d, fill: 'none', stroke: paint, 'stroke-width': 30,
      'stroke-linecap': 'round', 'stroke-linejoin': 'round',
    }));
  }
}
content.appendChild(markGroup);

// ── Wordmark and typed line (banner only) ──────────────────────────────────
let typed = null;
let caret = null;
if (MODE === 'banner') {
  const word = el('text', {
    x: 330, y: 196,
    'font-family': 'Liberation Sans, Segoe UI, Arial, sans-serif',
    'font-size': 76, 'font-weight': 700, fill: '#f8fafc', 'letter-spacing': -1.5,
  });
  word.textContent = 'SamotWorks';
  content.appendChild(word);

  typed = el('text', {
    x: 334, y: 248,
    'font-family': 'DejaVu Sans Mono, Liberation Mono, monospace',
    'font-size': 24, fill: '#8b90a5',
  });
  content.appendChild(typed);

  caret = el('rect', { y: 230, width: 11, height: 22, fill: '#a855f7' });
  content.appendChild(caret);
}
// The square mark has no cursor: it is used as a server icon at 128px or less,
// where a 12px rectangle reads as a stray dot rather than a caret. The sweep
// and the rain carry the animation there.

// ── Frame ──────────────────────────────────────────────────────────────────
window.renderFrame = (t) => {
  // Rain: each column advances a whole number of cells across the loop.
  rainNodes.forEach((node, i) => {
    const col = columns[i];
    const y = ((col.offset + t * col.speed) % (H + CELL * 2)) - CELL * 2;
    node.setAttribute('transform', 'translate(0 ' + y.toFixed(2) + ')');
  });

  // Sweep: the bright band crosses the full width once per loop, entering and
  // leaving completely so there is no jump at the seam.
  const head = t * 1.4 - 0.2;
  document.getElementById('s0').setAttribute('offset', Math.max(0, Math.min(1, head - 0.08)) * 100 + '%');
  document.getElementById('s1').setAttribute('offset', Math.max(0, Math.min(1, head)) * 100 + '%');
  document.getElementById('s2').setAttribute('offset', Math.max(0, Math.min(1, head + 0.08)) * 100 + '%');

  // Cursor blinks twice per loop. Banner only — see above.
  if (caret) caret.setAttribute('opacity', (t * 4) % 1 < 0.55 ? 1 : 0.12);

  if (MODE === 'banner') {
    // Type each phrase, hold it, delete it. The phases divide the loop evenly,
    // so the last frame leaves the line empty exactly as the first one found it.
    const per = 1 / PHRASES.length;
    const index = Math.min(PHRASES.length - 1, Math.floor(t / per));
    const local = (t - index * per) / per;
    const phrase = PHRASES[index];

    let shown;
    if (local < 0.35) shown = Math.round((local / 0.35) * phrase.length);
    else if (local < 0.75) shown = phrase.length;
    else shown = Math.round((1 - (local - 0.75) / 0.25) * phrase.length);

    const text = '> ' + phrase.slice(0, Math.max(0, shown));
    typed.textContent = text;
    caret.setAttribute('x', 334 + typed.getComputedTextLength() + 4);
  }
};
window.renderFrame(0);
</script></body></html>`;
}

async function main() {
  let chromium;
  let gifenc;
  let PNG;
  try {
    ({ chromium } = require('playwright-core'));
    gifenc = require('gifenc');
    ({ PNG } = require('pngjs'));
  } catch (err) {
    process.stderr.write(`Missing tooling (${err.message}). Run:\n\n`
      + '  npm install --no-save playwright-core gifenc pngjs\n\n'
      + 'Install them in one command: npm prunes anything not in package.json on\n'
      + 'the next install, so a second --no-save install removes the first.\n\n');
    process.exitCode = 1;
    return;
  }

  const { GIFEncoder, quantize, applyPalette } = gifenc;
  // Reuse the browser resolver from the still renderer rather than duplicating
  // the path-guessing logic in two places.
  const { resolveChromium } = require('./render-brand');
  const executablePath = resolveChromium();
  const browser = await chromium.launch({ executablePath, args: ['--no-sandbox'] });

  try {
    for (const job of JOBS) {
      const view = await browser.newPage({
        viewport: { width: job.width, height: job.height },
        deviceScaleFactor: 1,
      });
      await view.setContent(page(job), { waitUntil: 'load' });

      const encoder = GIFEncoder();
      let palette = null;

      for (let frame = 0; frame < FRAMES; frame += 1) {
        const t = frame / FRAMES;
        // eslint-disable-next-line no-await-in-loop
        await view.evaluate((value) => window.renderFrame(value), t);
        // eslint-disable-next-line no-await-in-loop
        const shot = await view.screenshot({ type: 'png' });

        // Decode in Node rather than handing the pixels back through
        // page.evaluate. A 1200x400 frame is 1.92 million channel values, and
        // returning that as a JSON array over CDP took longer per frame than
        // rendering it — minutes for one animation instead of seconds.
        const data = new Uint8ClampedArray(PNG.sync.read(shot).data);

        // One palette for the whole animation. Per-frame palettes shimmer,
        // because the quantiser picks slightly different colours each time and
        // a flat dark background then pulses between near-identical greys.
        if (!palette) palette = quantize(data, 256, { format: 'rgb565' });

        const indexed = applyPalette(data, palette, 'rgb565');
        encoder.writeFrame(indexed, job.width, job.height, {
          palette: frame === 0 ? palette : undefined,
          delay: FRAME_MS,
          repeat: 0,
        });
      }

      encoder.finish();
      const out = path.join(BRAND, job.name);
      fs.writeFileSync(out, Buffer.from(encoder.bytes()));
      await view.close();

      const size = fs.statSync(out).size;
      process.stdout.write(`  ${job.name.padEnd(22)} ${job.width}×${job.height}  ${FRAMES} frames  ${(size / 1024).toFixed(0)} KB\n`);
    }
  } finally {
    await browser.close();
  }
}

module.exports = { page, FRAMES, FRAME_MS, JOBS };

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.stack}\n`);
    process.exitCode = 1;
  });
}
