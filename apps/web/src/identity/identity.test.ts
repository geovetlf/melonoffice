import { describe, expect, it, vi } from 'vitest';
import { ApiError, createApiClient } from './apiClient.js';
import { loadConfig, parseConfig } from './config.js';
import { createIdentityClient, IdentityError } from './identityPlatform.js';
import { PROVIDER_KEY, REFRESH_KEY, createSession } from './session.js';
import { API, GOOGLE_AUTH_URI, KEY, fakeBackend, memoryStore } from './testing.js';

function setup(now = () => 1_000_000) {
  const backend = fakeBackend();
  const store = memoryStore();
  const session = createSession(createIdentityClient(KEY, backend.fetch, now), store, now);
  const api = createApiClient(API, session, backend.fetch);
  return { backend, store, session, api };
}

describe('Identity Platform sign-in (ADR-0036)', () => {
  it('signs in with email and password and gets tokens', async () => {
    const { backend } = setup();
    const client = createIdentityClient(KEY, backend.fetch, () => 0);
    const tokens = await client.signIn('ana@example.com', 'correct-horse');
    expect(tokens).toEqual({ idToken: 'id-1', refreshToken: 'refresh-1', expiresAt: 3_600_000 });
  });

  it('explains a failed sign-in with a stable code', async () => {
    const { backend } = setup();
    const client = createIdentityClient(KEY, backend.fetch);
    await expect(client.signIn('ana@example.com', 'wrong')).rejects.toEqual(
      new IdentityError('invalid_credentials'),
    );
    const offline = createIdentityClient(KEY, () => Promise.reject(new TypeError('offline')));
    await expect(offline.signIn('a@b.c', 'x')).rejects.toEqual(new IdentityError('network'));
  });
});

describe('Google sign-in (ADR-0105)', () => {
  const BACK = 'https://web.example/login';

  it('sends the browser to Google, then signs in from the page Google sends it back to', async () => {
    const { session, store, backend } = setup();
    expect(await session.startProvider(BACK)).toBe(GOOGLE_AUTH_URI);
    expect(JSON.parse(backend.calls[0]?.body ?? '{}')).toEqual({
      providerId: 'google.com',
      continueUri: BACK,
    });
    expect(session.providerPending).toBe(true);
    const events: string[] = [];
    session.subscribe((event) => events.push(event));
    await session.finishProvider(`${BACK}?state=s&code=c`);
    expect(events).toEqual(['signed_in']);
    expect(await session.token()).toBe('id-1');
    // The handle is used once; only the refresh token stays.
    expect([...store.data.entries()]).toEqual([[REFRESH_KEY, 'refresh-1']]);
    expect(session.providerPending).toBe(false);
  });

  it('says so when Google sign-in is not turned on', async () => {
    const { session, backend, store } = setup();
    backend.options.google = 'off';
    await expect(session.startProvider(BACK)).rejects.toEqual(
      new IdentityError('provider_disabled'),
    );
    expect(store.data.has(PROVIDER_KEY)).toBe(false);
  });

  it('treats a refusal on Google, or a return with no sign-in under way, as not completed', async () => {
    const { session } = setup();
    await session.startProvider(BACK);
    await expect(session.finishProvider(`${BACK}#error=access_denied&state=s`)).rejects.toEqual(
      new IdentityError('provider_cancelled'),
    );
    expect(session.present).toBe(false);
    await expect(session.finishProvider(`${BACK}?state=s&code=c`)).rejects.toEqual(
      new IdentityError('provider_cancelled'),
    );
  });

  it('points an email that already signs in with a password to that', async () => {
    const { session, backend } = setup();
    backend.options.google = 'linked';
    await session.startProvider(BACK);
    await expect(session.finishProvider(`${BACK}?state=s&code=c`)).rejects.toEqual(
      new IdentityError('account_exists'),
    );
    expect(session.present).toBe(false);
  });

  it('accepts only a Google page to send the browser to', async () => {
    const client = createIdentityClient(KEY, () =>
      Promise.resolve(
        new Response(JSON.stringify({ authUri: 'https://evil.example/', sessionId: 's' })),
      ),
    );
    await expect(client.startProvider(BACK)).rejects.toEqual(
      new IdentityError('provider_disabled'),
    );
  });
});

describe('the browser session', () => {
  it('keeps the ID token in memory and only the refresh token in session storage', async () => {
    const { session, store } = setup();
    expect(session.present).toBe(false);
    await session.signIn('ana@example.com', 'correct-horse');
    expect(session.present).toBe(true);
    expect([...store.data.entries()]).toEqual([[REFRESH_KEY, 'refresh-1']]);
    expect(await session.token()).toBe('id-1');
    expect(globalThis.localStorage.length).toBe(0);
  });

  it('refreshes an ID token about to expire, once for concurrent callers', async () => {
    let clock = 0;
    const { session, backend } = setup(() => clock);
    await session.signIn('ana@example.com', 'correct-horse');
    clock = 3_600_000 - 30_000; // inside the one-minute margin
    const [a, b] = await Promise.all([session.token(), session.token()]);
    expect(a).toBe('id-2');
    expect(b).toBe('id-2');
    expect(backend.calls.filter((call) => call.url.includes('securetoken'))).toHaveLength(1);
  });

  it('resumes after a reload from the refresh token alone', async () => {
    const { backend, store } = setup();
    backend.options.validRefresh.add('refresh-kept');
    store.setItem(REFRESH_KEY, 'refresh-kept');
    const session = createSession(createIdentityClient(KEY, backend.fetch), store);
    expect(session.present).toBe(true);
    expect(await session.token()).toBe('id-1');
  });

  it('ends an expired session and says so', async () => {
    const { backend, store } = setup();
    store.setItem(REFRESH_KEY, 'refresh-revoked');
    const session = createSession(createIdentityClient(KEY, backend.fetch), store);
    const events: string[] = [];
    session.subscribe((event) => events.push(event));
    expect(await session.token()).toBeUndefined();
    expect(events).toEqual(['expired']);
    expect(session.present).toBe(false);
    expect(store.data.size).toBe(0);
  });

  it('signs out: tokens forgotten', async () => {
    const { session, store } = setup();
    await session.signIn('ana@example.com', 'correct-horse');
    const listener = vi.fn();
    session.subscribe(listener);
    session.signOut();
    expect(listener).toHaveBeenCalledWith('signed_out');
    expect(session.present).toBe(false);
    expect(await session.token()).toBeUndefined();
    expect(store.data.size).toBe(0);
  });
});

describe('the API client', () => {
  it('sends the ID token to /v1/me', async () => {
    const { session, api, backend } = setup();
    await session.signIn('ana@example.com', 'correct-horse');
    await expect(api.json('/v1/me')).resolves.toMatchObject({ userId: 'user_ana' });
    expect(backend.apiCalls()).toEqual([
      expect.objectContaining({ url: `${API}/v1/me`, authorization: 'Bearer id-1' }),
    ]);
  });

  it('sends no token without a session, and the API refuses the call', async () => {
    const { api, backend } = setup();
    await expect(api.json('/v1/me')).rejects.toMatchObject({ status: 401, kind: 'unauthorized' });
    expect(backend.apiCalls()[0]?.authorization).toBeNull();
  });

  it('on a 401, refreshes the token once and retries', async () => {
    const { session, api, backend } = setup();
    await session.signIn('ana@example.com', 'correct-horse');
    backend.options.validTokens.delete('id-1'); // revoked or expired early
    await expect(api.json('/v1/me')).resolves.toMatchObject({ userId: 'user_ana' });
    expect(backend.apiCalls().map((call) => call.authorization)).toEqual([
      'Bearer id-1',
      'Bearer id-2',
    ]);
  });

  it('on a second 401, ends the session', async () => {
    const { session, api, backend } = setup();
    await session.signIn('ana@example.com', 'correct-horse');
    const events: string[] = [];
    session.subscribe((event) => events.push(event));
    backend.options.apiStatus = 401; // the API accepts no token, even a fresh one
    await expect(api.json('/v1/me')).rejects.toMatchObject({ kind: 'unauthorized' });
    expect(events).toEqual(['expired']);
    expect(session.present).toBe(false);
  });

  it('reports 403, 404 and 5xx as their kinds, with the code only', async () => {
    const { session, api, backend } = setup();
    await session.signIn('ana@example.com', 'correct-horse');
    await expect(api.json('/v1/organizations/org_other')).rejects.toMatchObject({
      status: 404,
      kind: 'not_found',
    });
    backend.options.apiStatus = 403;
    const forbidden = await api.json('/v1/me').catch((error: unknown) => error);
    expect(forbidden).toBeInstanceOf(ApiError);
    expect(forbidden).toMatchObject({ kind: 'forbidden', message: 'forbidden' });
    backend.options.apiStatus = 503;
    await expect(api.json('/v1/me')).rejects.toMatchObject({ kind: 'server' });
    expect(session.present).toBe(true);
  });

  it('calls only the API: no other origin, no cookies', async () => {
    const { session, api, backend } = setup();
    await session.signIn('ana@example.com', 'correct-horse');
    await expect(api.request('https://elsewhere.example/v1/me')).rejects.toThrow('invalid_path');
    const fetcher = vi.fn(backend.fetch);
    await createApiClient(API, session, fetcher).request('/v1/me');
    expect(fetcher.mock.calls[0]?.[1]).toMatchObject({ credentials: 'omit' });
  });
});

describe('the site configuration', () => {
  it('accepts an API origin and a key, and nothing malformed', () => {
    expect(parseConfig({ apiUrl: API, identityApiKey: KEY })).toEqual({
      apiUrl: API,
      identityApiKey: KEY,
    });
    expect(parseConfig({ apiUrl: '', identityApiKey: '' })).toBeUndefined();
    expect(parseConfig({ apiUrl: `${API}/v1`, identityApiKey: KEY })).toBeUndefined();
    expect(parseConfig({ apiUrl: 'http://api.example.test', identityApiKey: KEY })).toBeUndefined();
    expect(parseConfig({ apiUrl: API, identityApiKey: 'short' })).toBeUndefined();
  });

  it('treats a missing or broken /config.json as not configured', async () => {
    await expect(
      loadConfig(() => Promise.resolve(new Response('', { status: 404 }))),
    ).resolves.toBe(undefined);
    await expect(loadConfig(() => Promise.resolve(new Response('{oops')))).resolves.toBe(undefined);
    await expect(loadConfig(() => Promise.reject(new TypeError('offline')))).resolves.toBe(
      undefined,
    );
  });
});
