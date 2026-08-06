'use strict';

/**
 * Rasterise the brand SVGs to PNG.
 *
 * Discord will not render an SVG in an embed, so every piece of artwork has to
 * ship as a PNG. This uses Playwright rather than `chrome --headless
 * --screenshot`: the CLI flag captures a viewport taller than `--window-size`
 * and leaves a band of page background along the bottom edge, whereas
 * Playwright sets the viewport over CDP so the capture matches the requested
 * box exactly.
 *
 *   npm install --no-save playwright-core
 *   node scripts/render-brand.js
 *
 * Set CHROMIUM_PATH if the browser is not on the default Playwright path.
 * Committing the PNGs means contributors never have to run this.
 */

const fs = require('node:fs');
const path = require('node:path');

const BRAND = path.join(__dirname, '..', 'brand');
const PANELS = path.join(BRAND, 'panels');

/** Fixed-size renders of the identity artwork. */
const IDENTITY = [
  { svg: path.join(BRAND, 'logo.svg'), png: path.join(BRAND, 'logo.png'), width: 512, height: 512 },
  { svg: path.join(BRAND, 'logo.svg'), png: path.join(BRAND, 'bot-avatar.png'), width: 1024, height: 1024 },
  { svg: path.join(BRAND, 'banner.svg'), png: path.join(BRAND, 'banner.png'), width: 1200, height: 400 },
];

/** Every generated panel header, at the 4:1 size the template is drawn for. */
const panelJobs = () => (fs.existsSync(PANELS)
  ? fs.readdirSync(PANELS)
    .filter((file) => file.endsWith('.svg'))
    .map((file) => ({
      svg: path.join(PANELS, file),
      png: path.join(PANELS, file.replace(/\.svg$/, '.png')),
      width: 1200,
      height: 300,
    }))
  : []);

function resolveChromium() {
  if (process.env.CHROMIUM_PATH) return process.env.CHROMIUM_PATH;

  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (!fs.existsSync(root)) return undefined;

  const dir = fs.readdirSync(root).find((entry) => entry.startsWith('chromium-'));
  if (!dir) return undefined;

  for (const candidate of ['chrome-linux/chrome', 'chrome-mac/Chromium.app/Contents/MacOS/Chromium']) {
    const full = path.join(root, dir, candidate);
    if (fs.existsSync(full)) return full;
  }
  return undefined;
}

async function main() {
  let chromium;
  try {
    ({ chromium } = require('playwright-core'));
  } catch {
    process.stderr.write('playwright-core is not installed. Run:\n\n  npm install --no-save playwright-core\n\n');
    process.exitCode = 1;
    return;
  }

  const jobs = [...IDENTITY, ...panelJobs()];
  const browser = await chromium.launch({ executablePath: resolveChromium(), args: ['--no-sandbox'] });

  try {
    for (const job of jobs) {
      const svg = fs.readFileSync(job.svg, 'utf8');
      // eslint-disable-next-line no-await-in-loop -- one page at a time keeps memory flat
      const page = await browser.newPage({
        viewport: { width: job.width, height: job.height },
        deviceScaleFactor: 1,
      });

      // The reset matters: an unstyled <svg> inherits the document's 8px body
      // margin and renders 8px down and to the right of where it should.
      // eslint-disable-next-line no-await-in-loop
      await page.setContent(
        `<!doctype html><html><head><meta charset="utf-8"><style>
          *{margin:0;padding:0;border:0}
          html,body{width:${job.width}px;height:${job.height}px;overflow:hidden;background:#12141d}
          svg{display:block;width:${job.width}px;height:${job.height}px}
        </style></head><body>${svg}</body></html>`,
        { waitUntil: 'load' },
      );

      // eslint-disable-next-line no-await-in-loop
      await page.screenshot({ path: job.png, clip: { x: 0, y: 0, width: job.width, height: job.height } });
      // eslint-disable-next-line no-await-in-loop
      await page.close();

      const size = fs.statSync(job.png).size;
      process.stdout.write(`  ${path.basename(job.png).padEnd(22)} ${job.width}×${job.height}  ${(size / 1024).toFixed(1)} KB\n`);
    }
  } finally {
    await browser.close();
  }

  process.stdout.write(`\n  ${jobs.length} images rendered.\n`);
}

module.exports = { resolveChromium };

// Only render when invoked directly, so `build-animated-brand.js` can import
// the browser resolver without kicking off a full still render.
if (require.main === module) {
  main().catch((err) => {
    process.stderr.write(`${err.stack}\n`);
    process.exitCode = 1;
  });
}
