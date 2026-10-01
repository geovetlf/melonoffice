/**
 * Screenshots of the Home for the accessibility pass (phase 6): a new office and one at work at
 * the four widths, and the states a keyboard or a touch causes — the skip link, focus on GIA's
 * command box, a selected chip, the sidebar's current page, the Home on a phone and its menu.
 * The same run before and after a change gives comparable images.
 *
 *   pnpm --filter @melonoffice/web exec vite --port 5198   # in another terminal
 *   node apps/web/scripts/capture-home.mjs <out-dir> [base-url]
 *
 * CAPTURE_CHROMIUM_PATH points at a Chromium when Playwright's own is not installed.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [out = 'home', base = 'http://localhost:5198'] = process.argv.slice(2);

const DESKTOP = { width: 1440, height: 900 };
const PHONE = { width: 390, height: 844 };
const VIEWPORTS = [DESKTOP, { width: 1024, height: 768 }, { width: 768, height: 1024 }, PHONE];

const executablePath = process.env['CAPTURE_CHROMIUM_PATH'];
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const problems = [];

async function open(viewport, scenario = 'active', scale = 1) {
  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: scale,
    locale: 'es-ES',
    reducedMotion: 'reduce',
  });
  const tab = await context.newPage();
  tab.on('pageerror', (error) => problems.push(`${scenario}@${viewport.width}: ${error}`));
  await tab.goto(`${base}/preview.html?scenario=${scenario}&route=/`);
  await tab.waitForSelector('h1');
  await tab.waitForLoadState('networkidle');
  await tab.evaluate(() => document.fonts.ready);
  await tab.waitForTimeout(900);
  return { context, tab };
}

const shot = (tab, name, options = {}) =>
  tab.screenshot({ path: join(out, `${name}.jpg`), type: 'jpeg', quality: 80, ...options });

/** Moves keyboard focus to `target`, so `:focus-visible` shows. */
async function keyboardFocus(tab, target) {
  await target.focus();
  await tab.keyboard.press('Shift+Tab');
  await tab.keyboard.press('Tab');
  await tab.waitForTimeout(150);
}

async function clipAround(tab, locator, pad = 16) {
  const box = await locator.boundingBox();
  if (box === null) throw new Error('nothing to capture');
  const view = tab.viewportSize();
  const x = Math.max(0, box.x - pad);
  const y = Math.max(0, box.y - pad);
  return {
    x,
    y,
    width: Math.min(view.width - x, box.width + pad * 2),
    height: Math.min(view.height - y, box.height + pad * 2),
  };
}

await mkdir(out, { recursive: true });

for (const scenario of ['active', 'empty']) {
  for (const viewport of VIEWPORTS) {
    const { context, tab } = await open(viewport, scenario);
    await shot(tab, `home-${scenario}-${viewport.width}`, { fullPage: true, quality: 72 });
    await context.close();
  }
}

const STATES = [
  {
    name: 'skip-link',
    viewport: DESKTOP,
    act: async (tab) => {
      await tab.keyboard.press('Tab');
      return { clip: { x: 0, y: 0, width: 720, height: 160 } };
    },
  },
  {
    name: 'gia-focus',
    viewport: DESKTOP,
    act: async (tab) => {
      const input = tab.locator('.gia-bar__input').first();
      await input.scrollIntoViewIfNeeded();
      await keyboardFocus(tab, input);
      return { clip: await clipAround(tab, tab.locator('.gia-bar').first(), 24) };
    },
  },
  {
    name: 'chip-selected',
    viewport: DESKTOP,
    act: async (tab) => {
      const chips = tab.locator('.period-picker').first();
      await chips.scrollIntoViewIfNeeded();
      return { clip: await clipAround(tab, chips, 24) };
    },
  },
  {
    name: 'sidebar',
    viewport: DESKTOP,
    act: async () => ({ clip: { x: 0, y: 0, width: 300, height: 900 } }),
  },
  { name: 'home-phone', viewport: PHONE, act: async () => ({}) },
  {
    name: 'phone-menu',
    viewport: PHONE,
    act: async (tab) => {
      await tab.getByRole('button', { name: 'Abrir menú' }).click();
      await tab.waitForTimeout(500);
      return {};
    },
  },
];

for (const state of STATES) {
  const { context, tab } = await open(state.viewport, 'active', state.viewport === PHONE ? 1 : 2);
  try {
    const options = await state.act(tab);
    await shot(tab, `state-${state.name}`, options);
  } catch (error) {
    problems.push(`${state.name}: ${error.message}`);
  }
  await context.close();
}

await browser.close();
if (problems.length > 0) {
  console.error(problems.join('\n'));
  process.exitCode = 1;
}
