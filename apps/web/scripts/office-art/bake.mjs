/**
 * Bakes the office scene's rooms (rooms.mjs) to WebP for the Home (Home V4), at 2x and 1x.
 *
 *   SMOKE_CHROMIUM_PATH=/path/to/chromium node apps/web/scripts/office-art/bake.mjs
 *
 * Chromium draws each SVG on a canvas and encodes it; nothing is fetched. The output goes to
 * apps/web/src/office/scene/art and is committed.
 */
import { writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from '@playwright/test';
import { atrium, headquarters, lounge, MOTIFS, sideRoom } from './rooms.mjs';

const out = join(dirname(fileURLToPath(import.meta.url)), '../../src/office/scene/art');
const QUALITY = 0.8;

const rooms = [
  ...MOTIFS.map((motif, i) => [`room-${motif}`, sideRoom(motif, i + 1)]),
  ['headquarters', headquarters()],
  ['atrium', atrium()],
  ['lounge', lounge()],
];

const executablePath = process.env['SMOKE_CHROMIUM_PATH'];
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const page = await browser.newPage();
for (const [name, svg] of rooms) {
  for (const scale of [1, 0.5]) {
    const data = await page.evaluate(
      async ({ svg, scale, quality }) => {
        const image = new Image();
        image.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
        await image.decode();
        const canvas = document.createElement('canvas');
        canvas.width = Math.round(image.naturalWidth * scale);
        canvas.height = Math.round(image.naturalHeight * scale);
        const context = canvas.getContext('2d');
        context.imageSmoothingQuality = 'high';
        context.drawImage(image, 0, 0, canvas.width, canvas.height);
        return canvas.toDataURL('image/webp', quality);
      },
      { svg, scale, quality: QUALITY },
    );
    const file = join(out, `${name}${scale === 1 ? '@2x' : ''}.webp`);
    await writeFile(file, Buffer.from(data.split(',')[1], 'base64'));
    console.log(file);
  }
}
await browser.close();
