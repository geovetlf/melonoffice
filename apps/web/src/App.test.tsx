import { catalogs, I18nProvider, pseudoLocalizeCatalog } from '@melonoffice/i18n';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App.js';
import { REFRESH_KEY } from './identity/session.js';
import { createServices, type IdentityServices } from './identity/services.js';
import { API, KEY, fakeBackend, memoryStore, type FakeBackend } from './identity/testing.js';
import { Root } from './Root.js';

afterEach(cleanup);
beforeEach(() => globalThis.history.replaceState(null, '', '/'));

function start({ path = '/', refreshToken }: { path?: string; refreshToken?: string } = {}) {
  globalThis.history.replaceState(null, '', path);
  const backend = fakeBackend();
  const store = memoryStore();
  if (refreshToken !== undefined) {
    backend.options.validRefresh.add(refreshToken);
    store.setItem(REFRESH_KEY, refreshToken);
  }
  const services = createServices({ apiUrl: API, identityApiKey: KEY }, backend.fetch, store);
  return { backend, store, services };
}

const renderApp = (services: IdentityServices | undefined | 'loading') =>
  render(
    <I18nProvider locale="en">
      <App identity={services} locale="en" onLocaleChange={vi.fn()} />
    </I18nProvider>,
  );

async function signIn(password = 'correct-horse') {
  fireEvent.change(await screen.findByLabelText('Email'), {
    target: { value: 'ana@example.com' },
  });
  fireEvent.change(screen.getByLabelText('Password'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Sign in' }));
}

const path = () => globalThis.location.pathname;
/** The Home's heading while the office has no active agents yet (ADR-0040). */
const HOME = { level: 1, name: 'Your office is ready to work' } as const;
const apiPaths = (backend: FakeBackend) =>
  backend.apiCalls().map((call) => `${call.method} ${call.url.slice(API.length)}`);

describe('the public page', () => {
  const loading = () => new Promise<undefined>(() => {});
  const noBrand = () => Promise.resolve(undefined);

  it('renders in English', () => {
    render(<Root initialLocale="en" loadIdentity={loading} loadBrand={noBrand} />);
    expect(screen.getByRole('heading', { level: 1, name: 'MelonOffice' })).toBeTruthy();
    expect(screen.getByText('Your intelligent office')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'English', pressed: true })).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
  });

  it('renders in Spanish and switches language without reloading', () => {
    render(<Root initialLocale="es" loadIdentity={loading} loadBrand={noBrand} />);
    expect(screen.getByText('Tu oficina inteligente')).toBeTruthy();
    expect(document.documentElement.lang).toBe('es');
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(screen.getByText('Your intelligent office')).toBeTruthy();
  });

  it('says when sign-in is not set up on this site', async () => {
    render(
      <Root
        initialLocale="en"
        loadIdentity={() => Promise.resolve(undefined)}
        loadBrand={noBrand}
      />,
    );
    expect(await screen.findByText('Sign-in is not set up on this site yet.')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 1, name: 'MelonOffice' })).toBeTruthy();
  });

  it('shows no hard-coded text: every visible string comes from the catalog', async () => {
    const { services } = start({ path: '/login' });
    render(
      <I18nProvider locale="en" messages={pseudoLocalizeCatalog(catalogs.en)}>
        <App identity={services} locale="en" onLocaleChange={vi.fn()} />
      </I18nProvider>,
    );
    await screen.findByRole('textbox');
    const textNodes = [...document.body.querySelectorAll('h1, h2, p, span, label, button')]
      .map((element) => element.textContent?.trim() ?? '')
      .filter(Boolean);
    expect(textNodes.length).toBeGreaterThan(0);
    for (const text of textNodes) expect(text, text).toMatch(/^\[.*\]$/);
  });
});

describe('signing in (ADR-0036)', () => {
  it('without a session, a protected page sends you to sign-in and calls no API', async () => {
    const { services, backend } = start({ path: '/' });
    renderApp(services);
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(path()).toBe('/login');
    expect(backend.calls).toEqual([]);
  });

  it('signs in: registers the sign-in, loads the user, the organization and its permissions', async () => {
    const { services, backend, store } = start({ path: '/login' });
    renderApp(services);
    await signIn();
    expect(await screen.findByRole('heading', HOME)).toBeTruthy();
    expect(path()).toBe('/');
    expect(screen.getByText('Acme')).toBeTruthy();
    expect(screen.getByText('ana@example.com')).toBeTruthy();
    expect(apiPaths(backend).slice(0, 3)).toEqual([
      'POST /v1/me',
      'GET /v1/me/organizations',
      'GET /v1/organizations/org_1',
    ]);
    expect(backend.apiCalls().every((call) => call.authorization === 'Bearer id-1')).toBe(true);
    // The password went to Identity Platform only, and nothing but the refresh token is kept.
    expect(backend.apiCalls().some((call) => call.body?.includes('correct-horse'))).toBe(false);
    expect([...store.data.keys()]).toEqual([REFRESH_KEY]);
    expect((screen.queryByLabelText('Password') as HTMLInputElement | null)?.value).toBeUndefined();
  });

  it('refuses a wrong password and keeps you on sign-in', async () => {
    const { services, backend } = start({ path: '/login' });
    renderApp(services);
    await signIn('wrong');
    expect((await screen.findByRole('alert')).textContent).toBe(
      'The email or password is not correct.',
    );
    expect(path()).toBe('/login');
    expect((screen.getByLabelText('Password') as HTMLInputElement).value).toBe('');
    expect(backend.apiCalls()).toEqual([]);
  });

  it('uses only the organization the API lists for the user, and shows only what the role allows', async () => {
    const { services, backend } = start({ path: '/login' });
    backend.options.organizations = [{ id: 'org_7', name: 'Mine', role: 'owner' }];
    backend.options.permissions = ['organization.read'];
    renderApp(services);
    await signIn();
    expect(await screen.findByText('Mine')).toBeTruthy();
    expect(apiPaths(backend)).toContain('GET /v1/organizations/org_7');
    // No department, agent or credit is read without its permission, and no inbox link is shown.
    expect(apiPaths(backend).some((p) => /departments|specialists|credits|billing/.test(p))).toBe(
      false,
    );
    expect(
      await screen.findByText('Your role does not include seeing the departments.'),
    ).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'Communications' })).toBeNull();
    act(() => {
      globalThis.history.pushState(null, '', '/conversations');
      globalThis.dispatchEvent(new PopStateEvent('popstate'));
    });
    expect(
      await screen.findByText('You are signed in. Your role does not include conversations.'),
    ).toBeTruthy();
    expect(screen.queryByRole('heading', { level: 1, name: 'Conversations' })).toBeNull();
  });

  it('a user with no organization gets no workspace', async () => {
    const { services, backend } = start({ path: '/login' });
    backend.options.organizations = [];
    renderApp(services);
    await signIn();
    expect(
      await screen.findByText(
        'Your account is not part of any organization yet. Create one to start.',
      ),
    ).toBeTruthy();
    expect(apiPaths(backend)).not.toContain('GET /v1/organizations/org_1');
  });
});

describe('a new user without an organization', () => {
  it('creates one, becomes its owner and lands in its office', async () => {
    const { services, backend } = start({ path: '/login' });
    backend.options.organizations = [];
    renderApp(services);
    await signIn();
    expect(await screen.findByRole('heading', { name: 'Create your organization' })).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Organization name'), {
      target: { value: '  Panadería Luna  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));
    expect(await screen.findByRole('heading', HOME)).toBeTruthy();
    expect(screen.getByText('Panadería Luna')).toBeTruthy();
    const create = backend.apiCalls().find((call) => call.url === `${API}/v1/organizations`);
    expect(create?.method).toBe('POST');
    expect(JSON.parse(create?.body ?? '{}')).toEqual({ name: 'Panadería Luna' });
  });

  it('shows why the API refused to create it', async () => {
    const { services, backend } = start({ path: '/login' });
    backend.options.organizations = [];
    backend.options.organizationLimitReached = true;
    renderApp(services);
    await signIn();
    fireEvent.change(await screen.findByLabelText('Organization name'), {
      target: { value: 'Otra' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Create organization' }));
    expect((await screen.findByRole('alert')).textContent).toBe(
      'You cannot create more organizations.',
    );
    expect(screen.queryByRole('heading', { level: 1, name: 'Conversations' })).toBeNull();
  });
});

describe('a session', () => {
  it('shows loading, then the protected page, when resumed after a reload', async () => {
    const { services, backend } = start({ path: '/', refreshToken: 'refresh-kept' });
    renderApp(services);
    expect(screen.getByRole('status').textContent).toBe('Loading your office…');
    expect(await screen.findByRole('heading', HOME)).toBeTruthy();
    // A resumed session only reads /v1/me; it does not record a new sign-in.
    expect(apiPaths(backend)[0]).toBe('GET /v1/me');
  });

  it('that expired sends you to sign-in and says why', async () => {
    const { services, backend, store } = start({ path: '/', refreshToken: 'refresh-expired' });
    backend.options.validRefresh.clear();
    renderApp(services);
    expect(await screen.findByText('Your session has ended. Please sign in again.')).toBeTruthy();
    expect(path()).toBe('/login');
    expect(store.data.size).toBe(0);
  });

  it('whose token the API refuses (401) ends and goes back to sign-in', async () => {
    const { services, backend } = start({ path: '/login' });
    renderApp(services);
    await signIn();
    await screen.findByRole('heading', HOME);
    backend.options.apiStatus = 401;
    await act(() => services.api.json('/v1/me').catch(() => undefined));
    expect(await screen.findByText('Your session has ended. Please sign in again.')).toBeTruthy();
    expect(path()).toBe('/login');
  });

  it('refused by the API (403) shows access denied, not the office', async () => {
    const { services, backend } = start({ path: '/', refreshToken: 'refresh-kept' });
    backend.options.apiStatus = 403;
    renderApp(services);
    expect(await screen.findByRole('heading', { name: 'Access denied' })).toBeTruthy();
    expect(screen.queryByRole('heading', HOME)).toBeNull();
  });

  it('when the API is down, says so and can try again', async () => {
    const { services, backend } = start({ path: '/', refreshToken: 'refresh-kept' });
    backend.options.apiStatus = 503;
    renderApp(services);
    expect(
      await screen.findByText('We could not load your office right now. Please try again.'),
    ).toBeTruthy();
    delete backend.options.apiStatus;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('heading', HOME)).toBeTruthy();
  });

  it('signs out: back to sign-in, tokens forgotten, protected pages closed', async () => {
    const { services, store } = start({ path: '/login' });
    renderApp(services);
    await signIn();
    fireEvent.click(await screen.findByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(path()).toBe('/login');
    expect(store.data.size).toBe(0);
    expect(await services.session.token()).toBeUndefined();
    act(() => globalThis.history.pushState(null, '', '/'));
    act(() => globalThis.dispatchEvent(new PopStateEvent('popstate')));
    await waitFor(() => expect(path()).toBe('/login'));
  });
});

describe('the Conversations Center, signed in (ADR-0035, ADR-0036)', () => {
  async function signedIn() {
    const started = start({ path: '/login' });
    renderApp(started.services);
    await signIn();
    fireEvent.click(await screen.findByRole('link', { name: 'Communications' }));
    await screen.findByRole('heading', { level: 1, name: 'Conversations' });
    expect(path()).toBe('/conversations');
    return started;
  }
  const inbox = () => screen.findByRole('list', { name: 'Conversations' });

  it('opens after sign-in with the organization’s conversations only, through the signed-in client', async () => {
    const { backend } = await signedIn();
    expect(await within(await inbox()).findByText('Juan Pérez')).toBeTruthy();
    expect(screen.queryByText('Another company’s customer')).toBeNull();
    const inboxCalls = backend
      .apiCalls()
      .filter((call) => call.url.includes('/conversations') || call.url.includes('/departments'));
    expect(inboxCalls.length).toBeGreaterThan(0);
    for (const call of inboxCalls) {
      expect(call.url.startsWith(`${API}/v1/organizations/org_1/`)).toBe(true);
      expect(call.authorization).toBe('Bearer id-1');
    }
  });

  it('another organization’s inbox is refused by the API, whatever the screen asks', async () => {
    const { services } = await signedIn();
    const response = await services.api.request('/v1/organizations/org_other/conversations');
    expect(response.status).toBe(403);
  });

  it('searches, opens a conversation, changes its priority and replies through the send route', async () => {
    const { backend } = await signedIn();
    fireEvent.change(screen.getByLabelText('Search'), { target: { value: 'juan' } });
    await waitFor(() =>
      expect(apiPaths(backend)).toContain(
        'GET /v1/organizations/org_1/conversations?q=juan&sort=last_activity',
      ),
    );
    fireEvent.click(await within(await inbox()).findByText('Juan Pérez'));
    const panel = await screen.findByRole('article', { name: 'Juan Pérez' });
    fireEvent.change(within(panel).getByLabelText('Priority'), { target: { value: 'urgent' } });
    await waitFor(() =>
      expect(apiPaths(backend)).toContain('POST /v1/organizations/org_1/conversations/c1/priority'),
    );
    fireEvent.change(within(panel).getByRole('textbox', { name: 'Your reply' }), {
      target: { value: 'Hola Juan' },
    });
    fireEvent.click(within(panel).getByRole('button', { name: 'Send' }));
    expect(await within(panel).findByText('Sent.')).toBeTruthy();
    const send = backend.apiCalls().find((call) => call.url.endsWith('/conversations/c1/messages'));
    expect(send?.authorization).toBe('Bearer id-1');
    expect(Object.keys(JSON.parse(send?.body ?? '{}')).sort()).toEqual(['clientMessageId', 'text']);
    // Only the MelonOffice API and Identity Platform are ever called: never a channel provider.
    expect(
      backend.calls.every(
        (call) => call.url.startsWith(API) || call.url.includes('googleapis.com'),
      ),
    ).toBe(true);
  });

  it('a refused action shows the reason: the API, not the screen, decides', async () => {
    const { backend } = await signedIn();
    backend.options.permissions = backend.options.permissions.filter(
      (p) => p !== 'conversation.manage',
    );
    fireEvent.click(await within(await inbox()).findByText('Juan Pérez'));
    const panel = await screen.findByRole('article', { name: 'Juan Pérez' });
    fireEvent.change(within(panel).getByLabelText('Priority'), { target: { value: 'high' } });
    expect(
      within(await screen.findByRole('alert')).getByText('You do not have permission to do that.'),
    ).toBeTruthy();
  });

  it('is closed again after sign-out', async () => {
    await signedIn();
    fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(await screen.findByRole('heading', { name: 'Sign in' })).toBeTruthy();
    expect(screen.queryByRole('list', { name: 'Conversations' })).toBeNull();
  });
});
