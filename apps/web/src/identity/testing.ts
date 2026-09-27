import { REFRESH_URL, SIGN_IN_URL } from './identityPlatform.js';
import type { KeyValueStore } from './session.js';

/**
 * A fake Identity Platform and MelonOffice API for tests: one user, `ana@example.com` with
 * password `correct-horse`, a member of one organization. Every call is recorded.
 */

export const API = 'https://api.example.test';
export const KEY = 'test-browser-key-not-a-real-one';

export interface Call {
  readonly url: string;
  readonly method: string;
  readonly authorization: string | null;
  readonly body: string | undefined;
}

export interface FakeBackend {
  readonly fetch: typeof fetch;
  readonly calls: Call[];
  /** Mutable: how the fake answers. */
  readonly options: {
    /** ID tokens the API accepts. */
    validTokens: Set<string>;
    /** Refresh tokens Identity Platform still honours. */
    validRefresh: Set<string>;
    /** The API's answer to every `/v1/...` call, if forced. */
    apiStatus?: number;
    registered: boolean;
    organizations: { id: string; name: string; role: string }[];
    permissions: string[];
    idTokenSeconds: number;
  };
  apiCalls(): Call[];
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

export function fakeBackend(): FakeBackend {
  let issued = 0;
  const calls: Call[] = [];
  const options: FakeBackend['options'] = {
    validTokens: new Set(),
    validRefresh: new Set(),
    registered: true,
    organizations: [{ id: 'org_1', name: 'Acme', role: 'owner' }],
    permissions: ['conversation.read', 'organization.read'],
    idTokenSeconds: 3600,
  };

  function issue() {
    issued += 1;
    const idToken = `id-${issued}`;
    const refreshToken = `refresh-${issued}`;
    options.validTokens.add(idToken);
    options.validRefresh.add(refreshToken);
    return { idToken, refreshToken };
  }

  const fetcher: typeof fetch = async (input, init = {}) => {
    const url = typeof input === 'string' ? input : input.toString();
    const headers = new Headers(init.headers);
    const body = typeof init.body === 'string' ? init.body : undefined;
    const method = init.method ?? 'GET';
    calls.push({ url, method, authorization: headers.get('authorization'), body });

    if (url === `${SIGN_IN_URL}?key=${KEY}`) {
      const { email, password } = JSON.parse(body ?? '{}') as Record<string, string>;
      if (email !== 'ana@example.com' || password !== 'correct-horse') {
        return json(400, { error: { code: 400, message: 'INVALID_LOGIN_CREDENTIALS' } });
      }
      const { idToken, refreshToken } = issue();
      return json(200, { idToken, refreshToken, expiresIn: String(options.idTokenSeconds) });
    }
    if (url === `${REFRESH_URL}?key=${KEY}`) {
      const held = new URLSearchParams(body).get('refresh_token') ?? '';
      if (!options.validRefresh.has(held)) {
        return json(400, { error: { code: 400, message: 'TOKEN_EXPIRED' } });
      }
      const { idToken, refreshToken } = issue();
      return json(200, {
        id_token: idToken,
        refresh_token: refreshToken,
        expires_in: String(options.idTokenSeconds),
      });
    }
    if (!url.startsWith(`${API}/v1/`)) return json(404, { error: 'not_found' });

    const token = headers.get('authorization')?.replace(/^Bearer /, '');
    if (token === undefined || !options.validTokens.has(token)) {
      return json(401, { error: token === undefined ? 'missing_token' : 'invalid_token' });
    }
    if (options.apiStatus !== undefined) {
      return json(options.apiStatus, {
        error: options.apiStatus === 403 ? 'forbidden' : 'internal',
      });
    }
    const path = url.slice(API.length);
    const me = { userId: 'user_ana', email: 'ana@example.com', emailVerified: true };
    if (path === '/v1/me') {
      if (method === 'POST') options.registered = true;
      if (!options.registered) return json(403, { error: 'user_not_registered' });
      return json(200, me);
    }
    if (path === '/v1/me/organizations') {
      return json(200, {
        organizations: options.organizations.map(({ id, name, role }) => ({
          organization: { id, name, status: 'active' },
          membership: { id: `m_${id}`, role, status: 'active' },
        })),
      });
    }
    const match = /^\/v1\/organizations\/([^/]+)$/.exec(path);
    const organization = options.organizations.find((o) => o.id === match?.[1]);
    if (organization !== undefined) {
      return json(200, { organization, permissions: options.permissions });
    }
    return json(404, { error: 'organization_not_found' });
  };

  return {
    fetch: fetcher,
    calls,
    options,
    apiCalls: () => calls.filter((call) => call.url.startsWith(API)),
  };
}

export function memoryStore(): KeyValueStore & { readonly data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => void data.set(key, value),
    removeItem: (key) => void data.delete(key),
  };
}
