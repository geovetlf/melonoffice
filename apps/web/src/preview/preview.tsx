import '@melonoffice/ui/styles.css';
import '../app.css';
import '../office.css';
import '../home.css';
import type { Locale } from '@melonoffice/i18n';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';
import { Root } from '../Root.js';
import { SCENARIOS, type ScenarioName } from './scenarios.js';

/**
 * A local preview of the signed-in app for design review and screenshots, on the fake backend
 * the tests use (`identity/testing.ts`). It is served by `vite` at `/preview.html` only: the
 * production build has `index.html` as its one entry, so none of this ships.
 *
 * `?scenario=` picks the office's state (see `scenarios.ts`), `?route=` the page to open and
 * `?locale=` the language.
 */
const params = new URLSearchParams(globalThis.location.search);
const scenario: ScenarioName = params.get('scenario') === 'empty' ? 'empty' : 'active';
const locale: Locale = params.get('locale') === 'en' ? 'en' : 'es';
const route = params.get('route') ?? '/';

const backend = fakeBackend();
const store = memoryStore();
backend.options.validRefresh.add('refresh-preview');
store.setItem(REFRESH_KEY, 'refresh-preview');
SCENARIOS[scenario](backend);
const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);

globalThis.history.replaceState(null, '', route);

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <Root
      initialLocale={locale}
      loadIdentity={() => Promise.resolve(services)}
      loadBrand={() => Promise.resolve(undefined)}
    />
  </StrictMode>,
);
