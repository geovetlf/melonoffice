import { catalogs, I18nProvider, pseudoLocalizeCatalog } from '@melonoffice/i18n';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
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
const apiPaths = (backend: FakeBackend) =>
  backend.apiCalls().map((call) => `${call.method} ${call.url.slice(API.length)}`);

describe('the public page', () => {
  const loading = () => new Promise<undefined>(() => {});

  it('renders in English', () => {
    render(<Root initialLocale="en" loadIdentity={loading} />);
    expect(screen.getByRole('heading', { level: 1, name: 'MelonOffice' })).toBeTruthy();
    expect(screen.getByText('Your intelligent office')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'English', pressed: true })).toBeTruthy();
    expect(document.documentElement.lang).toBe('en');
  });

  it('renders in Spanish and switches language without reloading', () => {
    render(<Root initialLocale="es" loadIdentity={loading} />);
    expect(screen.getByText('Tu oficina inteligente')).toBeTruthy();
    expect(document.documentElement.lang).toBe('es');
    fireEvent.click(screen.getByRole('button', { name: 'English' }));
    expect(screen.getByText('Your intelligent office')).toBeTruthy();
  });

  it('says when sign-in is not set up on this site', async () => {
    render(<Root initialLocale="en" loadIdentity={() => Promise.resolve(undefined)} />);
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
    expect(await screen.findByRole('heading', { name: 'Your office' })).toBeTruthy();
    expect(path()).toBe('/');
    expect(screen.getByText('Acme')).toBeTruthy();
    expect(screen.getByText('ana@example.com')).toBeTruthy();
    expect(
      screen.getByText('You are signed in. The Conversations Center will open here.'),
    ).toBeTruthy();
    expect(apiPaths(backend)).toEqual([
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
    expect(
      screen.getByText('You are signed in. Your role does not include conversations.'),
    ).toBeTruthy();
  });

  it('a user with no organization gets no workspace', async () => {
    const { services, backend } = start({ path: '/login' });
    backend.options.organizations = [];
    renderApp(services);
    await signIn();
    expect(
      await screen.findByText('Your account is not part of any organization yet.'),
    ).toBeTruthy();
    expect(apiPaths(backend)).not.toContain('GET /v1/organizations/org_1');
  });
});

describe('a session', () => {
  it('shows loading, then the protected page, when resumed after a reload', async () => {
    const { services, backend } = start({ path: '/', refreshToken: 'refresh-kept' });
    renderApp(services);
    expect(screen.getByRole('status').textContent).toBe('Loading your office…');
    expect(await screen.findByRole('heading', { name: 'Your office' })).toBeTruthy();
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
    await screen.findByRole('heading', { name: 'Your office' });
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
    expect(screen.queryByRole('heading', { name: 'Your office' })).toBeNull();
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
    expect(await screen.findByRole('heading', { name: 'Your office' })).toBeTruthy();
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
