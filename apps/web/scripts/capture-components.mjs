/**
 * Screenshots of the app's components in use, for the component redesign (phase 3): the screens
 * that hold most of them, the overlays opened by hand (account menu, notifications, search, an
 * agent's card, MelonMotor, GIA's quick ask, the phone menu) and keyboard focus. The same run
 * before and after a change gives comparable images.
 *
 *   pnpm --filter @melonoffice/web exec vite --port 5199   # in another terminal
 *   node apps/web/scripts/capture-components.mjs <out-dir> [base-url]
 *
 * CAPTURE_CHROMIUM_PATH points at a Chromium when Playwright's own is not installed.
 */
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from '@playwright/test';

const [out = 'components', base = 'http://localhost:5199'] = process.argv.slice(2);

const DESKTOP = { width: 1440, height: 900 };
const TABLET = { width: 1024, height: 768 };
const PORTRAIT = { width: 768, height: 1024 };
const PHONE = { width: 390, height: 844 };

/** Screens, whole, at the widths that matter for their components. */
const SCREENS = [
  { name: 'conversations', route: '/conversations', widths: [DESKTOP, PHONE] },
  { name: 'memory', route: '/memory', widths: [DESKTOP, PHONE] },
  { name: 'documents', route: '/documents', widths: [DESKTOP] },
  { name: 'automations', route: '/automations', widths: [DESKTOP] },
  { name: 'connections', route: '/settings/connections', widths: [DESKTOP] },
  { name: 'ai-usage', route: '/ai-usage', widths: [DESKTOP, PHONE] },
  { name: 'reports', route: '/reports', widths: [DESKTOP] },
  { name: 'agents', route: '/agents', widths: [DESKTOP, TABLET, PORTRAIT, PHONE] },
  { name: 'approvals', route: '/approvals', widths: [DESKTOP, TABLET, PORTRAIT, PHONE] },
  { name: 'gia', route: '/gia', widths: [DESKTOP, PHONE] },
  { name: 'office-sales', route: '/office/sales', widths: [DESKTOP, PHONE] },
];

/** Overlays and states on the Home, opened the way a person opens them. */
const INTERACTIONS = [
  {
    name: 'account-menu',
    viewport: DESKTOP,
    act: (tab) => tab.locator('summary[aria-label="Tu cuenta"]').click(),
  },
  {
    name: 'notifications',
    viewport: DESKTOP,
    act: (tab) => tab.locator('summary.topbar__icon').click(),
  },
  {
    name: 'search',
    viewport: DESKTOP,
    act: async (tab) => {
      await tab
        .getByRole('searchbox')
        .or(tab.getByLabel(/^Busca/))
        .first()
        .fill('co');
    },
  },
  {
    name: 'agent-card',
    viewport: DESKTOP,
    act: (tab) =>
      tab
        .getByRole('button', { name: /^Ana Ventas/ })
        .first()
        .click(),
  },
  {
    name: 'agent-card',
    viewport: PHONE,
    act: (tab) =>
      tab
        .getByRole('button', { name: /^Ana Ventas/ })
        .first()
        .click(),
  },
  {
    name: 'motor-panel',
    viewport: DESKTOP,
    act: (tab) =>
      tab
        .getByRole('button', { name: /MelonMotor/ })
        .first()
        .click(),
  },
  {
    name: 'quick-ask',
    viewport: DESKTOP,
    act: (tab) => tab.keyboard.press('Control+k'),
  },
  {
    name: 'focus',
    viewport: DESKTOP,
    act: async (tab) => {
      for (let i = 0; i < 4; i += 1) await tab.keyboard.press('Tab');
    },
  },
  {
    name: 'phone-menu',
    viewport: PHONE,
    act: (tab) => tab.getByRole('button', { name: 'Abrir menú' }).click(),
  },
];

const executablePath = process.env['CAPTURE_CHROMIUM_PATH'];
const browser = await chromium.launch(executablePath ? { executablePath } : {});
const problems = [];

async function open(route, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'es-ES' });
  const tab = await context.newPage();
  tab.on('pageerror', (error) => problems.push(`${route}@${viewport.width}: ${error}`));
  const query = new URLSearchParams({ scenario: 'active', route });
  await tab.goto(`${base}/preview.html?${query}`);
  await tab.waitForSelector('h1, h2');
  await tab.waitForLoadState('networkidle');
  await tab.evaluate(() => document.fonts.ready);
  await tab.waitForTimeout(900);
  return { context, tab };
}

await mkdir(out, { recursive: true });

for (const screen of SCREENS) {
  for (const viewport of screen.widths) {
    const { context, tab } = await open(screen.route, viewport);
    await tab.screenshot({
      path: join(out, `${screen.name}-${viewport.width}.jpg`),
      fullPage: true,
      type: 'jpeg',
      quality: 78,
    });
    await context.close();
  }
}

for (const interaction of INTERACTIONS) {
  const { context, tab } = await open('/', interaction.viewport);
  try {
    await interaction.act(tab);
    await tab.waitForTimeout(700);
    await tab.screenshot({
      path: join(out, `home-${interaction.name}-${interaction.viewport.width}.jpg`),
      type: 'jpeg',
      quality: 80,
    });
  } catch (error) {
    problems.push(`${interaction.name}@${interaction.viewport.width}: ${error.message}`);
  }
  await context.close();
}

// The gallery (components.html): every component, whole, at each width, then states a pointer or
// the keyboard causes, on real elements.
const GALLERY_STATES = [
  {
    name: 'hover-primary',
    target: (tab) => tab.getByRole('button', { name: 'Aprobar' }).first(),
    hover: true,
  },
  {
    name: 'hover-secondary',
    target: (tab) => tab.getByRole('button', { name: 'Ver trabajo' }).first(),
    hover: true,
  },
  {
    name: 'pressed-primary',
    target: (tab) => tab.getByRole('button', { name: 'Aprobar' }).first(),
    press: true,
  },
  {
    name: 'focus-button',
    target: (tab) => tab.getByRole('button', { name: 'Ver trabajo' }).first(),
    focus: true,
  },
  { name: 'hover-chip', target: (tab) => tab.getByRole('button', { name: 'Nuevas' }), hover: true },
  { name: 'focus-field', target: (tab) => tab.getByLabel('Nombre del negocio'), focus: true },
  {
    name: 'hover-menu-item',
    target: (tab) => tab.getByRole('button', { name: 'Configuración' }),
    hover: true,
  },
];

for (const viewport of [DESKTOP, TABLET, PORTRAIT, PHONE]) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1, locale: 'es-ES' });
  const tab = await context.newPage();
  tab.on('pageerror', (error) => problems.push(`gallery@${viewport.width}: ${error}`));
  await tab.goto(`${base}/components.html`);
  await tab.waitForSelector('h1');
  await tab.evaluate(() => document.fonts.ready);
  await tab.screenshot({
    path: join(out, `gallery-${viewport.width}.jpg`),
    fullPage: true,
    type: 'jpeg',
    quality: 80,
  });
  await context.close();
}

for (const state of GALLERY_STATES) {
  const context = await browser.newContext({
    viewport: DESKTOP,
    deviceScaleFactor: 2,
    locale: 'es-ES',
  });
  const tab = await context.newPage();
  await tab.goto(`${base}/components.html`);
  await tab.waitForSelector('h1');
  await tab.evaluate(() => document.fonts.ready);
  try {
    const target = state.target(tab);
    const section = target.locator('xpath=ancestor::section[1]');
    await section.scrollIntoViewIfNeeded();
    if (state.focus) {
      // Keyboard focus, so `:focus-visible` shows: the element before it, then Tab.
      await target.focus();
      await tab.keyboard.press('Shift+Tab');
      await tab.keyboard.press('Tab');
    }
    if (state.hover || state.press) await target.hover();
    if (state.press) await tab.mouse.down();
    await tab.waitForTimeout(250);
    const box = await section.boundingBox();
    if (box === null) throw new Error('no section');
    await tab.screenshot({
      path: join(out, `state-${state.name}.jpg`),
      clip: box,
      type: 'jpeg',
      quality: 82,
    });
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
