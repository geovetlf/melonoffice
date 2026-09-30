/**
 * Bakes the office's 3D art (scene3d/) to WebP for the Home (Home V4): the rooms at 2x and 1x,
 * and the workstation layers. three.js is not a dependency of the app: pass its package folder.
 *
 *   THREE_DIR=/path/to/three SMOKE_CHROMIUM_PATH=/path/to/chromium node apps/web/scripts/office-art/bake.mjs
 *
 * Chromium renders with WebGL (SwiftShader when there is no GPU). ONLY=room-growth,headquarters
 * bakes a few; OUT=dir writes somewhere else. The screen corners are printed for Workstation.tsx.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';

const here = dirname(fileURLToPath(import.meta.url));
const out = process.env['OUT'] ?? join(here, '../../src/office/scene/art');
const threeDir = process.env['THREE_DIR'];
if (!threeDir) throw new Error('THREE_DIR is required (the three package folder).');
const only = process.env['ONLY']?.split(',');
const QUALITY = 0.82;

const MOTIFS = [
  'growth',
  'dashboard',
  'social',
  'video',
  'network',
  'finance',
  'generic',
  'meeting',
];
const SIDE = [1152, 640];
const CENTRE = [806, 640];
const jobs = [
  ...MOTIFS.map((motif, i) => ({
    name: `room-${motif}`,
    call: ['sideRoom', motif, i + 1],
    size: SIDE,
  })),
  { name: 'headquarters', call: ['headquarters'], size: CENTRE },
  { name: 'gia', call: ['giaRoom'], size: CENTRE },
  { name: 'atrium', call: ['atrium'], size: CENTRE },
  { name: 'lounge', call: ['lounge'], size: CENTRE },
  // A workstation: the desk (its monitor showing the department's kind of work), and a person.
  ...[...MOTIFS.filter((motif) => motif !== 'meeting'), 'map'].map((motif) => ({
    name: `desk-${motif}`,
    call: ['workstation', 'desk', motif],
    size: [200, 200],
  })),
  ...[0, 1, 2, 3, 4, 5].map((i) => ({
    name: `desk-person-${i}`,
    call: ['workstation', `person-${i}`, 'generic'],
    size: [200, 200],
  })),
].filter((job) => !only || only.includes(job.name));

const TYPES = { '.js': 'text/javascript', '.html': 'text/html' };
const page0 = `<!doctype html><html><body style="margin:0">
<script type="importmap">{"imports":{"three":"/three/build/three.module.js","three/addons/":"/three/examples/jsm/"}}</script>
<script type="module">import * as art from '/scene/main.js'; window.art = art; window.ready = true;</script>
</body></html>`;

const executablePath = process.env['SMOKE_CHROMIUM_PATH'];
const browser = await chromium.launch({
  ...(executablePath ? { executablePath } : {}),
  args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage();
page.on('console', (message) => console.log('[page]', message.text()));
page.on('pageerror', (error) => console.error('[page]', error.message));
await page.route('http://art.local/**', async (route) => {
  const path = new URL(route.request().url()).pathname;
  if (path === '/') return route.fulfill({ body: page0, contentType: 'text/html' });
  const file = path.startsWith('/three/')
    ? join(threeDir, path.slice(7))
    : join(here, 'scene3d', path.slice(7));
  return route.fulfill({
    body: await readFile(file),
    contentType: TYPES[extname(file)] ?? 'application/octet-stream',
  });
});
await page.goto('http://art.local/');
await page.waitForFunction(() => window.ready, null, { timeout: 120_000 });

let corners;
for (const job of jobs) {
  const started = Date.now();
  const [fn, ...args] = job.call;
  const [w, h] = job.size;
  // Rendered at twice the 2x size, then scaled down: that is the anti-aliasing.
  const result = await page.evaluate(
    async ({ fn, args, w, h, quality }) => {
      const value = window.art[fn](...args, w * 2, h * 2);
      const data = typeof value === 'string' ? value : value.data;
      const image = new Image();
      image.src = data;
      await image.decode();
      const encode = (scale) => {
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(w * scale);
        canvas.height = Math.round(h * scale);
        const context = canvas.getContext('2d');
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/webp', quality);
      };
      return {
        x2: encode(1),
        x1: encode(0.5),
        corners: value.corners,
        floor: value.floor,
        gia: value.gia,
        screen: value.screen,
      };
    },
    { fn, args, w, h, quality: QUALITY },
  );
  corners ??= result.corners;
  if (result.floor) console.log('FLOOR', job.name, JSON.stringify(result.floor));
  if (result.gia) console.log('GIA', JSON.stringify(result.gia));
  if (result.screen) console.log('SCREEN', job.name, JSON.stringify(result.screen));
  await writeFile(join(out, `${job.name}@2x.webp`), Buffer.from(result.x2.split(',')[1], 'base64'));
  // Workstations are small in the Home and drawn in SVG, which takes one picture: 2x only.
  if (!job.name.startsWith('desk-')) {
    await writeFile(join(out, `${job.name}.webp`), Buffer.from(result.x1.split(',')[1], 'base64'));
  }
  console.log(job.name, `${((Date.now() - started) / 1000).toFixed(1)}s`);
}
if (corners) console.log('SCREEN_CORNERS', JSON.stringify(corners));
await browser.close();
