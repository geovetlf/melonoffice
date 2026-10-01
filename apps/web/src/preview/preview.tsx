import '@melonoffice/ui/styles.css';
import '../app.css';
import '../office.css';
import '../home.css';
import type { Locale } from '@melonoffice/i18n';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import type { PublicBrand } from '../brand/brand.js';
import { createServices } from '../identity/services.js';
import { REFRESH_KEY } from '../identity/session.js';
import { API, KEY, fakeBackend, memoryStore } from '../identity/testing.js';
import { Root } from '../Root.js';
import { giaEngagements } from '../gia/presence.js';
import { applyReviewFont } from './fonts.js';
import { previewFetch, previewRoutes } from './routes.js';
import { SCENARIOS, type ScenarioName } from './scenarios.js';

/**
 * A local preview of the signed-in app for design review and screenshots, on the fake backend
 * the tests use (`identity/testing.ts`). It is served by `vite` at `/preview.html` only: the
 * production build has `index.html` as its one entry, so none of this ships.
 *
 * `?scenario=` picks the office's state (`empty`, `active` or `pages`, see `scenarios.ts`),
 * `?route=` the page to open (its `#` encoded as `%23`, as in `/invite%23t=…`), `?locale=` the
 * language, `?brand=rrggbb` a white-label colour, applied as a host's brand is, and `?font=` one of
 * the typefaces under review (see `fonts.ts`). `?signedOut=1` opens with no session, for the public
 * pages (`/login`, `/signup`, `/forgot-password`, `/invite`, `/join`), and `?noOrg=1` signs in a
 * person who belongs to no organization (the page without an organization). `?gia=<agent>:<task>`
 * starts with GIA having brought that task to that agent (as her chat records it), and
 * `globalThis.giaPreview` records or forgets one while the page is open, to watch her walk.
 */
const params = new URLSearchParams(globalThis.location.search);
const asked = params.get('scenario');
const scenario: ScenarioName =
  asked === 'empty' || asked === 'one' || asked === 'pages' ? asked : 'active';
const locale: Locale = params.get('locale') === 'en' ? 'en' : 'es';
const route = params.get('route') ?? '/';
const brandColor = params.get('brand');
const brand: PublicBrand | undefined =
  brandColor === null
    ? undefined
    : { context: 'organization', productName: 'Acme Office', primaryColor: `#${brandColor}` };

const backend = fakeBackend();
const routes = previewRoutes();
const store = memoryStore();
if (params.get('signedOut') !== '1') {
  backend.options.validRefresh.add('refresh-preview');
  store.setItem(REFRESH_KEY, 'refresh-preview');
}
SCENARIOS[scenario](backend, routes);
if (params.get('noOrg') === '1') backend.options.organizations = [];
giaEngagements.reset();
const brought = params.get('gia')?.split(':');
if (brought?.[0] !== undefined && brought[1] !== undefined) {
  giaEngagements.record({ agentId: brought[0], taskId: brought[1], at: Date.now() });
}
Object.assign(globalThis, { giaPreview: giaEngagements });
const services = createServices(
  { apiUrl: API, identityApiKey: KEY },
  previewFetch(backend, routes),
  store,
);

globalThis.history.replaceState(null, '', route);

await applyReviewFont(params.get('font'));

const container = document.getElementById('root');
if (!container) throw new Error('Missing #root element');

createRoot(container).render(
  <StrictMode>
    <Root
      initialLocale={locale}
      loadIdentity={() => Promise.resolve(services)}
      loadBrand={() => Promise.resolve(brand)}
    />
  </StrictMode>,
);
