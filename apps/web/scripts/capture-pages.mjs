/**
 * Screenshots of every secondary page with representative data, for the page redesign (phase 5):
 * the signed-in pages on the preview's `pages` scenario, the public pages with no session and the
 * page for someone without an organization, each at the four widths that matter. Each page is also
 * measured for horizontal overflow and its `h1` headings counted; both go to `overflow.json`.
 *
 *   pnpm --filter @melonoffice/web exec vite --port 5198   # in another terminal
 *   node apps/web/scripts/capture-pages.mjs <out-dir> [base-url]
 *
 * It exits with 1 if a page overflows sideways or throws, after writing every screenshot.
 * CAPTURE_CHROMIUM_PATH points at a Chromium when Playwright's own is not installed;
 * REDUCED_MOTION=1 captures with `prefers-reduced-motion: reduce`.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [out = 'pages', base = 'http://localhost:5198'] = process.argv.slice(2);

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
];

/** A made-up invitation secret, the shape the links carry (43 URL-safe characters). */
const TOKEN = 'p'.repeat(43);

const signedIn = (name, route) => ({ name, route, query: { scenario: 'pages' } });
const signedOut = (name, route) => ({ name, route, query: { scenario: 'pages', signedOut: '1' } });

const PAGES = [
  signedIn('agents', '/agents'),
  signedIn('approvals', '/approvals'),
  signedIn('documents', '/documents'),
  signedIn('reports', '/reports'),
  signedIn('ai-usage', '/ai-usage'),
  signedIn('command-center', '/command-center'),
  signedIn('conversations', '/conversations'),
  signedIn('conversation-open', '/conversations?c=c1'),
  signedIn('automations', '/automations'),
  signedIn('connections', '/settings/connections'),
  signedIn('gia', '/gia'),
  signedIn('office-sales', '/office/sales'),
  signedIn('office-sales-pipeline', '/office/sales?view=pipeline'),
  signedIn('office-sales-follow-ups', '/office/sales?view=follow-ups'),
  signedIn('office-sales-customers', '/office/sales?stage=customer'),
  signedIn('office-sales-contact', '/office/sales?contact=ct_1'),
  signedIn('office-marketing', '/office/marketing'),
  signedIn('agent-ana', '/office/sales/agent/spec_ana'),
  signedIn('memory', '/memory'),
  signedIn('brand', '/settings/brand'),
  signedIn('partners', '/settings/partners'),
  signedIn('platform', '/platform'),
  signedIn('partner-console', '/partner'),
  signedIn('invite-decision', `/invite#t=${TOKEN}`),
  signedIn('join-decision', `/join#t=${TOKEN}`),
  signedOut('login', '/login'),
  signedOut('signup', '/signup'),
  signedOut('forgot-password', '/forgot-password'),
  signedOut('invite', `/invite#t=${TOKEN}`),
  signedOut('join', `/join#t=${TOKEN}`),
  { name: 'without-organization', route: '/', query: { scenario: 'active', noOrg: '1' } },
  {
    name: 'without-organization-partner',
    route: '/',
    query: { scenario: 'pages', noOrg: '1' },
  },
  {
    name: 'partner-console-without-organization',
    route: '/partner',
    query: { scenario: 'pages', noOrg: '1' },
  },
];

const executablePath = process.env['CAPTURE_CHROMIUM_PATH'];
const reducedMotion = process.env['REDUCED_MOTION'] === '1' ? 'reduce' : 'no-preference';
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const problems = [];
const results = [];

await mkdir(out, { recursive: true });

for (const page of PAGES) {
  for (const viewport of VIEWPORTS) {
    const where = `${page.name}@${viewport.width}`;
    const context = await browser.newContext({
      viewport,
      deviceScaleFactor: 1,
      locale: 'es-ES',
      reducedMotion,
    });
    const tab = await context.newPage();
    tab.on('pageerror', (error) => problems.push(`${where}: ${error}`));
    try {
      const query = new URLSearchParams({ ...page.query, route: page.route });
      await tab.goto(`${base}/preview.html?${query}`);
      await tab.waitForSelector('h1, h2');
      await tab.waitForLoadState('networkidle');
      await tab.evaluate(() => document.fonts.ready);
      await tab.waitForTimeout(900);
      const measured = await tab.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        clientWidth: document.documentElement.clientWidth,
        bodyScrollWidth: document.body.scrollWidth,
        h1: document.querySelectorAll('h1').length,
      }));
      const overflow = measured.scrollWidth > measured.clientWidth;
      results.push({ name: page.name, width: viewport.width, ...measured, overflow });
      if (overflow) {
        problems.push(`${where}: overflows (${measured.scrollWidth} > ${measured.clientWidth})`);
      }
    } catch (error) {
      problems.push(`${where}: ${error.message}`);
    }
    try {
      // A page opened on a section scrolls to it; the whole page is taken from the top.
      await tab.evaluate(() => globalThis.scrollTo(0, 0));
      await tab.screenshot({
        path: join(out, `${page.name}-${viewport.width}.jpg`),
        fullPage: true,
        type: 'jpeg',
        quality: 78,
      });
    } catch (error) {
      problems.push(`${where}: screenshot failed: ${error.message}`);
    }
    await context.close();
  }
}

await browser.close();
await writeFile(join(out, 'overflow.json'), `${JSON.stringify(results, null, 2)}\n`);

const widths = VIEWPORTS.map((v) => v.width);
const cell = (result) =>
  result === undefined
    ? 'error'
    : `${result.overflow ? `+${result.scrollWidth - result.clientWidth}px` : 'ok'} h1=${result.h1}`;
const nameWidth = Math.max(...PAGES.map((p) => p.name.length));
console.log(['page'.padEnd(nameWidth), ...widths.map((w) => String(w).padEnd(14))].join('  '));
for (const page of PAGES) {
  const row = widths.map((width) =>
    cell(results.find((r) => r.name === page.name && r.width === width)).padEnd(14),
  );
  console.log([page.name.padEnd(nameWidth), ...row].join('  '));
}

if (problems.length > 0) {
  console.error(`\n${problems.join('\n')}`);
  process.exitCode = 1;
}
