/**
 * Screenshots of the signed-in app for design review: every page below, at every width, from
 * the local preview (`preview.html`, on the tests' fake backend).
 *
 *   pnpm --filter @melonoffice/web exec vite --port 5199   # in another terminal
 *   node apps/web/scripts/capture.mjs <out-dir> [base-url]
 *
 * CAPTURE_CHROMIUM_PATH points at a Chromium when Playwright's own is not installed.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [out = 'captures', base = 'http://localhost:5199'] = process.argv.slice(2);

const WIDTHS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
];

/** The Home in both states, and four screens reached from it. */
const PAGES = [
  { name: 'home-active', scenario: 'active', route: '/' },
  { name: 'home-empty', scenario: 'empty', route: '/' },
  { name: 'gia', scenario: 'active', route: '/gia' },
  { name: 'office-sales', scenario: 'active', route: '/office/sales' },
  { name: 'agents', scenario: 'active', route: '/agents' },
  { name: 'approvals', scenario: 'active', route: '/approvals' },
];

await mkdir(out, { recursive: true });
const executablePath = process.env['CAPTURE_CHROMIUM_PATH'];
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const problems = [];

for (const viewport of WIDTHS) {
  for (const page of PAGES) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'es-ES' });
    const tab = await context.newPage();
    tab.on('pageerror', (error) => problems.push(`${page.name}@${viewport.width}: ${error}`));
    const query = new URLSearchParams({ scenario: page.scenario, route: page.route });
    await tab.goto(`${base}/preview.html?${query}`);
    await tab.waitForSelector('h1');
    // Let the office's reads settle and the room art load.
    await tab.waitForLoadState('networkidle');
    await tab.waitForTimeout(1200);
    const file = join(out, `${page.name}-${viewport.width}.jpg`);
    await tab.screenshot({ path: file, fullPage: true, type: 'jpeg', quality: 78 });
    console.log(file);
    await context.close();
  }
}

await browser.close();
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
}
