import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, render, screen } from '@testing-library/react';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';
import { previewRoutes } from '../preview/routes.js';
import { SCENARIOS } from '../preview/scenarios.js';

/**
 * The Home passes axe (phase 6), a new office and one at work. The rules that need a real layout
 * (colour contrast, target size, scrolling regions) run in a browser instead:
 * `scripts/audit-a11y.mjs` checks them at every width.
 */

afterEach(cleanup);
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

async function violations(scenario: 'empty' | 'active') {
  const backend = fakeBackend();
  const store = memoryStore();
  backend.options.validRefresh.add('refresh-kept');
  store.setItem(REFRESH_KEY, 'refresh-kept');
  SCENARIOS[scenario](backend, previewRoutes());
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  render(
    <I18nProvider locale="es">
      <App identity={services} locale="es" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );
  await screen.findByRole('heading', { level: 1 });
  await screen.findByRole('complementary', { name: 'El día de tu oficina' });
  const result = await axe.run(document.body, {
    runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
    rules: {
      'color-contrast': { enabled: false },
      'target-size': { enabled: false },
      'scrollable-region-focusable': { enabled: false },
    },
  });
  return result.violations.map(
    (v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(', ')}`,
  );
}

describe('the Home with axe', () => {
  it('has no violation in a new office', async () => {
    expect(await violations('empty')).toEqual([]);
  });

  it('has no violation in an office at work', async () => {
    expect(await violations('active')).toEqual([]);
  });
});
