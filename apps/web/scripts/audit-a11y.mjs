/**
 * The accessibility audit of phase 6: the Home (a new office and one at work) and every secondary
 * page, at the four widths that matter, on the local preview. For each it records:
 *
 * - axe-core's WCAG 2.2 AA and best-practice violations;
 * - controls smaller than the target size: 44 px tall at 768 and 390 (a touch screen), 24 px on a
 *   desktop. Links inside a sentence are exempt, as WCAG 2.5.8 allows;
 * - sideways scroll and the number of `h1` headings;
 * - on the Home: the keyboard walk (every stop shows a focus ring, the first is the skip link and
 *   it moves focus to the main content), and the animations that run, which must all show real
 *   work and must all stop with `prefers-reduced-motion: reduce`.
 *
 *   pnpm --filter @melonoffice/web exec vite --port 5198   # in another terminal
 *   node apps/web/scripts/audit-a11y.mjs <out-dir> [base-url] [--home-only]
 *
 * It writes `<out-dir>/audit.json` and exits with 1 if the Home fails any check, or if a
 * secondary page overflows, has no single h1 or has an axe violation.
 * CAPTURE_CHROMIUM_PATH points at a Chromium when Playwright's own is not installed.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const [out = 'audit', base = 'http://localhost:5198'] = args;
const homeOnly = process.argv.includes('--home-only');

const require = createRequire(import.meta.url);
const axeSource = await readFile(require.resolve('axe-core/axe.min.js'), 'utf8');

const VIEWPORTS = [
  { width: 1440, height: 900 },
  { width: 1024, height: 768 },
  { width: 768, height: 1024 },
  { width: 390, height: 844 },
];
const TOUCH_WIDTHS = new Set([768, 390]);

/** Animations of real work (ADR-0109): live wall screens, their work bars, typing, a desk's light, a room's data. */
const WORK_ANIMATIONS = new Set([
  'wall-screen-refresh',
  'wall-screen-work',
  'desk-typing',
  'desk-light',
  'room-data',
]);

const TOKEN = 'p'.repeat(43);
const page = (name, route, query = { scenario: 'pages' }) => ({ name, route, query });
const HOME = [
  page('home-active', '/', { scenario: 'active' }),
  page('home-empty', '/', { scenario: 'empty' }),
];
const PAGES = [
  page('agents', '/agents'),
  page('approvals', '/approvals'),
  page('documents', '/documents'),
  page('reports', '/reports'),
  page('ai-usage', '/ai-usage'),
  page('command-center', '/command-center'),
  page('conversation-open', '/conversations?c=c1'),
  page('automations', '/automations'),
  page('connections', '/settings/connections'),
  page('gia', '/gia'),
  page('office-sales', '/office/sales'),
  page('office-sales-pipeline', '/office/sales?view=pipeline'),
  page('office-sales-follow-ups', '/office/sales?view=follow-ups'),
  page('office-sales-contact', '/office/sales?contact=ct_1'),
  page('memory', '/memory'),
  page('brand', '/settings/brand'),
  page('partners', '/settings/partners'),
  page('platform', '/platform'),
  page('partner-console', '/partner'),
  page('invite-decision', `/invite#t=${TOKEN}`),
  page('login', '/login', { scenario: 'pages', signedOut: '1' }),
  page('invite', `/invite#t=${TOKEN}`, { scenario: 'pages', signedOut: '1' }),
];

const executablePath = process.env['CAPTURE_CHROMIUM_PATH'];
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const problems = [];
const report = {};

async function open({ route, query }, viewport, reducedMotion = 'no-preference') {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: 1,
    locale: 'es-ES',
    reducedMotion,
    hasTouch: TOUCH_WIDTHS.has(viewport.width),
  });
  const tab = await context.newPage();
  const errors = [];
  tab.on('pageerror', (error) => errors.push(String(error)));
  const search = new URLSearchParams({ ...query, route });
  await tab.goto(`${base}/preview.html?${search.toString().replaceAll('%23', '%2523')}`);
  await tab.waitForSelector('h1');
  await tab.waitForLoadState('networkidle');
  await tab.evaluate(() => document.fonts.ready);
  await tab.waitForTimeout(800);
  return { context, tab, errors };
}

/** Everything a person can press that is too small to hit. */
function smallTargets(touch) {
  const min = touch ? 44 : 24;
  const controls = document.querySelectorAll(
    'a[href], button, input:not([type=hidden]), select, textarea, summary, [role=tab], [tabindex="0"]',
  );
  return [...controls]
    .filter((e) => {
      if (e.closest('[inert], [hidden], details:not([open]) > :not(summary)')) return false;
      if (!e.checkVisibility({ visibilityProperty: true, opacityProperty: false })) return false;
      if (e.matches('input[type=checkbox], input[type=radio]')) return false;
      const style = getComputedStyle(e);
      // A link inside a sentence takes the sentence's line (WCAG 2.5.8, inline exception).
      if (style.display === 'inline') return false;
      const box = e.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) return false;
      return box.height < min - 0.5;
    })
    .map((e) => {
      const box = e.getBoundingClientRect();
      const name = (e.getAttribute('aria-label') ?? e.textContent ?? '')
        .trim()
        .replace(/\s+/g, ' ');
      return `${e.tagName.toLowerCase()}.${String(e.className).split(' ')[0]} ${Math.round(box.width)}×${Math.round(box.height)} "${name.slice(0, 30)}"`;
    });
}

async function measure(tab, width) {
  await tab.addScriptTag({ content: axeSource });
  const axe = await tab.evaluate(async () => {
    const result = await globalThis.axe.run(document, {
      runOnly: {
        type: 'tag',
        values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice'],
      },
    });
    return result.violations.map((v) => ({
      id: v.id,
      impact: v.impact,
      targets: v.nodes.map((n) => n.target.join(' ')),
      summary: v.nodes[0]?.failureSummary ?? '',
    }));
  });
  const shape = await tab.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
    h1: document.querySelectorAll('h1').length,
  }));
  const small = await tab.evaluate(smallTargets, TOUCH_WIDTHS.has(width));
  return { axe, small, ...shape, overflow: shape.scrollWidth > shape.clientWidth };
}

/** Tab through the Home: where focus goes, and whether each stop shows a ring. */
async function keyboard(tab) {
  const stops = [];
  for (let i = 0; i < 80; i += 1) {
    await tab.keyboard.press('Tab');
    const stop = await tab.evaluate(() => {
      const e = document.activeElement;
      if (e === null || e === document.body) return null;
      const style = getComputedStyle(e);
      // The focus ring is an outline (styles.css); a resting shadow is no ring.
      const ringed = (el) => {
        const s = getComputedStyle(el);
        return s.outlineStyle !== 'none' && parseFloat(s.outlineWidth) >= 2;
      };
      // A field may draw its ring on its frame (`:has(:focus-visible)`).
      const frame = e.parentElement;
      const box = e.getBoundingClientRect();
      return {
        name: (
          e.getAttribute('aria-label') ??
          e.textContent ??
          e.getAttribute('placeholder') ??
          e.tagName
        )
          .trim()
          .replace(/\s+/g, ' ')
          .slice(0, 40),
        ring: ringed(e) || (frame !== null && ringed(frame)),
        visible: box.bottom > 0 && box.top < innerHeight && box.width > 0,
        skip: e.matches('a[href="#main"]'),
        hidden: style.visibility === 'hidden',
      };
    });
    if (stop !== null) stops.push(stop);
  }
  return stops;
}

async function skipLink(tab) {
  await tab.keyboard.press('Tab');
  const first = await tab.evaluate(() => {
    const e = document.activeElement;
    const box = e?.getBoundingClientRect();
    return {
      isSkip: e?.matches('a[href="#main"]') ?? false,
      onScreen: box !== undefined && box.top >= 0 && box.height > 0,
    };
  });
  await tab.keyboard.press('Enter');
  await tab.waitForTimeout(200);
  const landed = await tab.evaluate(() => document.activeElement?.id === 'main');
  return { ...first, landed };
}

const runningAnimations = (tab) =>
  tab.evaluate(() => [
    ...new Set(
      document
        .getAnimations()
        .filter((a) => a.playState === 'running' && a.animationName)
        .map((a) => a.animationName),
    ),
  ]);

await mkdir(out, { recursive: true });

for (const entry of homeOnly ? HOME : [...HOME, ...PAGES]) {
  const isHome = HOME.includes(entry);
  for (const viewport of VIEWPORTS) {
    const key = `${entry.name}@${viewport.width}`;
    const { context, tab, errors } = await open(entry, viewport);
    const result = await measure(tab, viewport.width);
    if (isHome) {
      result.animations = await runningAnimations(tab);
      result.skip = await skipLink(tab);
      await tab.reload();
      await tab.waitForSelector('h1');
      await tab.waitForTimeout(600);
      result.keyboard = await keyboard(tab);
    }
    await context.close();
    if (isHome) {
      const reduced = await open(entry, viewport, 'reduce');
      result.animationsReduced = await runningAnimations(reduced.tab);
      await reduced.context.close();
    }
    result.errors = errors;
    report[key] = result;

    const fail = (what) => problems.push(`${key}: ${what}`);
    if (result.overflow) fail(`scrolls sideways (${result.scrollWidth} > ${result.clientWidth})`);
    if (result.h1 !== 1) fail(`${result.h1} h1`);
    for (const v of result.axe)
      fail(`axe ${v.id} (${v.impact}) on ${v.targets.slice(0, 3).join(', ')}`);
    for (const e of errors) fail(`page error ${e}`);
    if (isHome) {
      for (const s of result.small) fail(`small target ${s}`);
      const decorative = result.animations.filter((a) => !WORK_ANIMATIONS.has(a));
      if (decorative.length > 0) fail(`decorative motion ${decorative.join(', ')}`);
      if (result.animationsReduced.length > 0)
        fail(`moves with reduced motion: ${result.animationsReduced.join(', ')}`);
      if (!result.skip.isSkip || !result.skip.onScreen || !result.skip.landed)
        fail(`skip link ${JSON.stringify(result.skip)}`);
      for (const s of result.keyboard.filter((s) => !s.ring)) fail(`no focus ring on "${s.name}"`);
      for (const s of result.keyboard.filter((s) => !s.visible || s.hidden))
        fail(`focus off screen on "${s.name}"`);
    }
    console.log(
      key.padEnd(30),
      `axe ${result.axe.length}`,
      `small ${result.small.length}`,
      result.overflow ? 'OVERFLOW' : 'no overflow',
      `h1=${result.h1}`,
      isHome
        ? `motion [${result.animations.join(' ')}] reduced [${result.animationsReduced.join(' ')}]`
        : '',
    );
  }
}

await writeFile(join(out, 'audit.json'), `${JSON.stringify(report, null, 2)}\n`);
await browser.close();
if (problems.length > 0) {
  console.error(`\n${problems.length} problem(s):\n${problems.join('\n')}`);
  process.exitCode = 1;
}
