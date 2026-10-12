import { I18nProvider } from '@melonoffice/i18n';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConsoleRequestError } from '../commercial/consoleClient.js';
import { failureOf } from '../commercial/PartnerConsole.js';
import { createApiClient } from './apiClient.js';
import { PasskeySecurity } from './PasskeySecurity.js';
import { PasskeysProvider } from './PasskeysContext.js';
import {
  forgetPasskeyConfirmation,
  holdPasskeyConfirmation,
  passkeyConfirmation,
} from './passkeyConfirmation.js';
import {
  createPasskeysClient,
  type PasskeyDevice,
  type PasskeyOverview,
} from './passkeysClient.js';
import type { Session } from './session.js';
import { PASSKEY_REQUIRED, SignInAgain } from './SignInAgain.js';

vi.mock('./AuthProvider.js', () => ({ useAuth: () => ({ signOut: vi.fn() }) }));

afterEach(() => {
  cleanup();
  forgetPasskeyConfirmation();
  vi.restoreAllMocks();
});

const TOKEN = 'c'.repeat(43);
const LATER = new Date(Date.now() + 30 * 60_000).toISOString();

/** A device that answers whatever it is asked, and records what it was asked. */
function device(supported = true): PasskeyDevice & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    supported: () => supported,
    register: async (options) => {
      asked.push(`register:${options.challenge}`);
      return { id: 'cred', type: 'public-key' };
    },
    confirm: async (options) => {
      asked.push(`confirm:${options.challenge}`);
      return { id: 'cred', type: 'public-key' };
    },
  };
}

/** A fake API: answers by method and path; each answer is JSON with its status. */
function api(answers: Record<string, [number, unknown]>) {
  const calls: { path: string; method: string; body: unknown }[] = [];
  const request = async (path: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    calls.push({
      path,
      method,
      body: init.body === undefined ? undefined : JSON.parse(String(init.body)),
    });
    const [status, body] = answers[`${method} ${path}`] ?? [404, { error: 'not_found' }];
    return new Response(JSON.stringify(body), { status });
  };
  return { request, calls };
}

const overview = (o: Partial<PasskeyOverview> = {}): PasskeyOverview => ({
  available: true,
  administrator: true,
  passkeys: [],
  confirmedUntil: null,
  ...o,
});

describe('passkeys in the browser (ADR-0188)', () => {
  it('adds a passkey: the API asks, the device answers, the API checks', async () => {
    const d = device();
    const { request, calls } = api({
      'POST /v1/me/passkeys/registration-options': [
        200,
        { challengeId: 'ch-1', options: { challenge: 'abc' } },
      ],
      'POST /v1/me/passkeys': [201, { passkey: { id: 'pk-1', createdAt: 't', lastUsedAt: null } }],
    });
    const added = await createPasskeysClient(request, d).add();
    expect(added.id).toBe('pk-1');
    expect(d.asked).toEqual(['register:abc']);
    expect(calls[1]).toEqual({
      path: '/v1/me/passkeys',
      method: 'POST',
      body: { challengeId: 'ch-1', response: { id: 'cred', type: 'public-key' } },
    });
  });

  it('a confirmation is held in memory and sent with every request until it expires or the person signs out', async () => {
    const { request } = api({
      'POST /v1/me/passkeys/confirmation-options': [
        200,
        { challengeId: 'ch-2', options: { challenge: 'xyz' } },
      ],
      'POST /v1/me/passkeys/confirmations': [201, { token: TOKEN, expiresAt: LATER }],
    });
    await createPasskeysClient(request, device()).confirm();
    expect(passkeyConfirmation()).toBe(TOKEN);

    const sent: Headers[] = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      sent.push(new Headers(init.headers));
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;
    const session = {
      token: async () => 'id-token',
      expire: () => undefined,
    } as unknown as Session;
    await createApiClient('https://api.example', session, fetcher).request('/v1/me');
    expect(sent[0]?.get('x-melon-passkey')).toBe(TOKEN);

    expect(passkeyConfirmation(Date.parse(LATER) + 1)).toBeUndefined();
    holdPasskeyConfirmation(TOKEN, LATER);
    forgetPasskeyConfirmation();
    expect(passkeyConfirmation()).toBeUndefined();
  });

  it('asks a person with passkeys to confirm with one, then to repeat the change', async () => {
    const { request } = api({
      'POST /v1/me/passkeys/confirmation-options': [
        200,
        { challengeId: 'ch-3', options: { challenge: 'q' } },
      ],
      'POST /v1/me/passkeys/confirmations': [201, { token: TOKEN, expiresAt: LATER }],
    });
    render(
      <I18nProvider locale="es">
        <PasskeysProvider client={createPasskeysClient(request, device())}>
          <SignInAgain code={PASSKEY_REQUIRED} />
        </PasskeysProvider>
      </I18nProvider>,
    );
    expect(
      screen.getByText(
        'Por tu seguridad, confirma que eres tú con tu passkey para hacer este cambio.',
      ),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Confirmar con mi passkey' }));
    expect(await screen.findByText('Confirmado. Ahora vuelve a hacer el cambio.')).toBeTruthy();
    expect(passkeyConfirmation()).toBe(TOKEN);
  });

  it('says so when the browser cannot use passkeys', () => {
    const { request } = api({});
    render(
      <I18nProvider locale="en">
        <PasskeysProvider client={createPasskeysClient(request, device(false))}>
          <SignInAgain code={PASSKEY_REQUIRED} />
        </PasskeysProvider>
      </I18nProvider>,
    );
    expect(screen.getByText(/This browser can't use passkeys/)).toBeTruthy();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('is what the partner console shows for that refusal', () => {
    expect(failureOf(new ConsoleRequestError(403, PASSKEY_REQUIRED))).toEqual({
      id: 'identity.passkey.confirm.message',
    });
  });
});

describe('the sign-in security section (ADR-0188)', () => {
  const show = (request: (path: string, init: RequestInit) => Promise<Response>, d = device()) =>
    render(
      <I18nProvider locale="en">
        <PasskeySecurity client={createPasskeysClient(request, d)} />
      </I18nProvider>,
    );

  it('shows nothing to someone who administers nothing, or where passkeys are not set up', async () => {
    const owner = api({ 'GET /v1/me/passkeys': [200, overview({ administrator: false })] });
    const { container } = show(owner.request);
    await vi.waitFor(() => expect(owner.calls).toHaveLength(1));
    expect(container.textContent).toBe('');
    cleanup();
    const off = api({ 'GET /v1/me/passkeys': [200, overview({ available: false })] });
    const second = show(off.request);
    await vi.waitFor(() => expect(off.calls).toHaveLength(1));
    expect(second.container.textContent).toBe('');
  });

  it('an administrator adds a passkey on this device and sees it listed', async () => {
    let listed: PasskeyOverview = overview();
    const passkey = { id: 'pk-1', createdAt: '2026-10-11T10:00:00.000Z', lastUsedAt: null };
    const answers: Record<string, [number, unknown]> = {
      'POST /v1/me/passkeys/registration-options': [
        200,
        { challengeId: 'ch', options: { challenge: 'a' } },
      ],
      'POST /v1/me/passkeys': [201, { passkey }],
    };
    const request = async (path: string, init: RequestInit) => {
      if ((init.method ?? 'GET') === 'GET')
        return new Response(JSON.stringify(listed), { status: 200 });
      if (path === '/v1/me/passkeys') listed = overview({ passkeys: [passkey] });
      return api(answers).request(path, init);
    };
    show(request);
    expect(await screen.findByText(/You have no passkeys yet/)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Add a passkey on this device' }));
    expect(await screen.findByText(/Passkey added\. From now on/)).toBeTruthy();
    expect(screen.getByText(/Passkey added on/)).toBeTruthy();
    expect(screen.getByText('not used yet')).toBeTruthy();
  });

  it('with a passkey already, adding another first asks to confirm with one', async () => {
    const { request } = api({
      'GET /v1/me/passkeys': [
        200,
        overview({
          passkeys: [{ id: 'pk-1', createdAt: '2026-10-11T10:00:00.000Z', lastUsedAt: null }],
        }),
      ],
      'POST /v1/me/passkeys/registration-options': [403, { error: 'passkey_required' }],
    });
    show(request);
    fireEvent.click(await screen.findByRole('button', { name: 'Add a passkey on this device' }));
    expect(await screen.findByRole('button', { name: 'Confirm with my passkey' })).toBeTruthy();
  });
});
