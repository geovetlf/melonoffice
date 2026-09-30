/**
 * The Home in each typeface under review (phase 2 of the Home redesign), under the same
 * conditions: the same preview, data, viewport and wait. For each typeface it saves full-page
 * screenshots, and for each part of the Home (sidebar, top bar, header, a room, the side panel,
 * GIA's command box) one side-by-side image of the three typefaces at 2x.
 *
 *   pnpm --filter @melonoffice/web exec vite --port 5199   # in another terminal
 *   node apps/web/scripts/compare-fonts.mjs <out-dir> [base-url]
 *
 * CAPTURE_CHROMIUM_PATH points at a Chromium when Playwright's own is not installed.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [out = 'font-comparison', base = 'http://localhost:5199'] = process.argv.slice(2);

const FONTS = [
  { key: 'onest', label: 'A · Onest' },
  { key: 'figtree', label: 'B · Figtree' },
  { key: 'instrument-sans', label: 'C · Instrument Sans' },
];

const SHOTS = [
  { name: 'home-active-1440', scenario: 'active', viewport: { width: 1440, height: 900 } },
  { name: 'home-active-1024', scenario: 'active', viewport: { width: 1024, height: 768 } },
  { name: 'home-active-390', scenario: 'active', viewport: { width: 390, height: 844 } },
  { name: 'home-empty-1440', scenario: 'empty', viewport: { width: 1440, height: 900 } },
];

/**
 * Parts of the Home, cropped at 1440 and 2x; `height` cuts a tall part to its top. Wide parts are
 * compared one above the other, narrow ones side by side.
 */
const PARTS = [
  { name: 'sidebar', selector: '.sidebar', height: 560 },
  { name: 'topbar', selector: '.topbar', wide: true },
  { name: 'header', selector: '.home4__header', wide: true },
  { name: 'room', selector: '.b-room--department' },
  { name: 'side-panel', selector: '.home4__side' },
  { name: 'command', selector: '.home4__command', wide: true },
];

const executablePath = process.env['CAPTURE_CHROMIUM_PATH'];
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const problems = [];

async function open(fontKey, scenario, viewport, deviceScaleFactor = 1) {
  const context = await browser.newContext({ viewport, deviceScaleFactor, locale: 'es-ES' });
  const tab = await context.newPage();
  tab.on('pageerror', (error) => problems.push(`${fontKey}: ${error}`));
  const query = new URLSearchParams({ scenario, route: '/', font: fontKey });
  await tab.goto(`${base}/preview.html?${query}`);
  await tab.waitForSelector('h1');
  await tab.waitForLoadState('networkidle');
  await tab.evaluate(() => document.fonts.ready);
  await tab.waitForTimeout(1200);
  return { context, tab };
}

await mkdir(join(out, 'parts'), { recursive: true });
const metrics = {};

for (const { key } of FONTS) {
  for (const shot of SHOTS) {
    const { context, tab } = await open(key, shot.scenario, shot.viewport);
    await tab.screenshot({
      path: join(out, `${key}-${shot.name}.jpg`),
      fullPage: true,
      type: 'jpeg',
      quality: 80,
    });
    await context.close();
  }

  const { context, tab } = await open(key, 'active', { width: 1440, height: 900 }, 2);
  // What each typeface costs in space: the same text, measured where it sits.
  metrics[key] = await tab.evaluate(() => {
    const box = (selector) => document.querySelector(selector)?.getBoundingClientRect();
    const title = document.querySelector('.home4__title');
    const range = document.createRange();
    if (title) range.selectNodeContents(title);
    return {
      family: getComputedStyle(document.body).fontFamily.split(',')[0],
      titleWidth: Math.round(range.getBoundingClientRect().width),
      sidePanelHeight: Math.round(box('.home4__side')?.height ?? 0),
      sidebarNavHeight: Math.round(box('.sidebar__nav')?.height ?? 0),
    };
  });
  for (const part of PARTS) {
    const element = tab.locator(part.selector).first();
    const rect = await element.boundingBox();
    if (rect === null) continue;
    await tab.screenshot({
      path: join(out, 'parts', `${key}-${part.name}.png`),
      clip: { ...rect, height: Math.min(rect.height, part.height ?? rect.height) },
    });
  }
  await context.close();
}

// One image per part: the three typefaces together, labelled, on the app's background.
const page = await browser.newPage({ deviceScaleFactor: 1 });
for (const part of PARTS) {
  const images = await Promise.all(
    FONTS.map(async ({ key }) =>
      (await readFile(join(out, 'parts', `${key}-${part.name}.png`))).toString('base64'),
    ),
  );
  const columns = FONTS.map(
    ({ label }, i) =>
      `<figure><figcaption>${label}</figcaption><img src="data:image/png;base64,${images[i]}"></figure>`,
  ).join('');
  await page.setContent(`<!doctype html><style>
    body { margin: 0; padding: 24px; background: #f3f5f8; font: 600 22px system-ui; color: #18202e; }
    main { display: grid; grid-template-columns: repeat(${part.wide ? 1 : 3}, 1fr); gap: 24px; align-items: start; }
    figure { margin: 0; } figcaption { margin-bottom: 12px; }
    img { width: 100%; border: 1px solid #dce1e8; border-radius: 12px; background: #fff; }
  </style><main>${columns}</main>`);
  await page.setViewportSize({ width: part.wide ? 2300 : 2400, height: 400 });
  await page.screenshot({
    path: join(out, `compare-${part.name}.jpg`),
    fullPage: true,
    type: 'jpeg',
    quality: 82,
  });
}

// The phone Home, whole, in the three typefaces side by side.
const phones = await Promise.all(
  FONTS.map(async ({ key }) =>
    (await readFile(join(out, `${key}-home-active-390.jpg`))).toString('base64'),
  ),
);
await page.setContent(`<!doctype html><style>
  body { margin: 0; padding: 24px; background: #f3f5f8; font: 600 22px system-ui; color: #18202e; }
  main { display: grid; grid-template-columns: repeat(3, 390px); gap: 32px; }
  figure { margin: 0; } figcaption { margin-bottom: 12px; }
  img { width: 390px; border: 1px solid #dce1e8; }
</style><main>${FONTS.map(
  ({ label }, i) =>
    `<figure><figcaption>${label}</figcaption><img src="data:image/jpeg;base64,${phones[i]}"></figure>`,
).join('')}</main>`);
await page.setViewportSize({ width: 1300, height: 400 });
await page.screenshot({
  path: join(out, 'compare-phone-390.jpg'),
  fullPage: true,
  type: 'jpeg',
  quality: 80,
});

await writeFile(join(out, 'metrics.json'), `${JSON.stringify(metrics, null, 2)}\n`);
await browser.close();
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
}
