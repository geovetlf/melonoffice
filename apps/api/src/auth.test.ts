import {
  AuthError,
  InMemoryUserDirectory,
  type AuthDependencies,
  type IdTokenVerifier,
  type VerifiedIdentity,
} from '@melonoffice/auth';
import type { OrganizationId } from '@melonoffice/domain';
import { createLogger } from '@melonoffice/observability';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { requireOrganization } from './auth.js';

const ORG_A = 'org-a' as OrganizationId;
const ORG_B = 'org-b' as OrganizationId;

/**
 * Stands in for Identity Platform. Real signature, issuer and expiry checks are tested in
 * @melonoffice/auth; here each fixed token maps to an outcome.
 */
const IDENTITIES: Record<string, VerifiedIdentity> = {
  'token-alice': { subject: 'uid-alice', email: 'alice@example.com', emailVerified: true },
  'token-bob': { subject: 'uid-bob', email: 'bob@example.com', emailVerified: false },
};
const verifier: IdTokenVerifier = {
  async verify(token) {
    if (token === 'token-expired') throw new AuthError('token_expired');
    if (token === 'token-keys-down') throw new AuthError('verifier_unavailable');
    const identity = IDENTITIES[token];
    if (identity === undefined) throw new AuthError('invalid_token');
    return identity;
  },
};

function setup(options: { memberships?: Record<string, OrganizationId[]> } = {}) {
  const lines: string[] = [];
  const logger = createLogger({ service: 'api', sink: (line) => lines.push(line) });
  const users = new InMemoryUserDirectory();
  const memberships = options.memberships ?? {};
  const auth: AuthDependencies = {
    verifier,
    users,
    memberships: { organizationsOf: async (userId) => memberships[userId] ?? [] },
  };
  const app = createApp({ logger, version: 'test', auth });
  // A route that works inside an organization, like the ones tenancy will add.
  app.get('/v1/org-probe', (c) => {
    const refused = requireOrganization(c);
    if (refused) return refused;
    return c.json({ organizationId: c.get('auth').organizationId });
  });
  const as = (token: string, init: RequestInit = {}) => ({
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) },
  });
  const register = async (token: string) =>
    (
      (await (await app.request('/v1/me', as(token, { method: 'POST' }))).json()) as {
        userId: string;
      }
    ).userId;
  return { app, users, lines, memberships, as, register };
}

describe('POST /v1/me (registration)', () => {
  it('creates the user from a valid token, once', async () => {
    const { app, as } = setup();
    const first = await app.request('/v1/me', as('token-alice', { method: 'POST' }));
    expect(first.status).toBe(201);
    const { userId } = (await first.json()) as { userId: string };
    const again = await app.request('/v1/me', as('token-alice', { method: 'POST' }));
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ userId });
  });

  it('ignores any user id or organization in the body', async () => {
    const { app, as, register, users } = setup();
    const bobId = await register('token-bob');
    const response = await app.request(
      '/v1/me',
      as('token-alice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ userId: bobId, subject: 'uid-bob', organizationId: ORG_A }),
      }),
    );
    const { userId } = (await response.json()) as { userId: string };
    expect(userId).not.toBe(bobId);
    expect((await users.findBySubject('uid-alice'))?.id).toBe(userId);
  });

  it('needs a valid token', async () => {
    const { app, as } = setup();
    expect((await app.request('/v1/me', { method: 'POST' })).status).toBe(401);
    expect((await app.request('/v1/me', as('forged', { method: 'POST' }))).status).toBe(401);
  });
});

describe('GET /v1/me', () => {
  it('returns the identity derived from the token', async () => {
    const { app, as, register } = setup();
    const userId = await register('token-alice');
    const response = await app.request('/v1/me', as('token-alice'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      userId,
      email: 'alice@example.com',
      emailVerified: true,
      organizationId: null,
    });
  });

  it.each([
    ['no token', undefined, 401, 'missing_token'],
    ['an invalid token', 'Bearer forged', 401, 'invalid_token'],
    ['an expired token', 'Bearer token-expired', 401, 'token_expired'],
    ['a malformed header', 'Basic abc', 401, 'invalid_token'],
    ['a valid token of an unregistered user', 'Bearer token-bob', 403, 'user_not_registered'],
    ['unreachable signing keys', 'Bearer token-keys-down', 503, 'verifier_unavailable'],
  ])('refuses %s', async (_name, authorization, status, error) => {
    const { app, register } = setup();
    await register('token-alice');
    const headers: Record<string, string> = authorization ? { authorization } : {};
    const response = await app.request('/v1/me', { headers });
    expect(response.status).toBe(status);
    expect(await response.json()).toEqual({ error });
    if (status === 401) expect(response.headers.get('www-authenticate')).toMatch(/^Bearer /);
  });

  it('cannot be pointed at another user by query or header', async () => {
    const { app, as, register } = setup();
    const aliceId = await register('token-alice');
    const bobId = await register('token-bob');
    const response = await app.request(
      `/v1/me?userId=${bobId}`,
      as('token-alice', { headers: { 'x-user-id': bobId } }),
    );
    expect(((await response.json()) as { userId: string }).userId).toBe(aliceId);
  });

  it('never logs the token', async () => {
    const { app, as, lines } = setup();
    await app.request('/v1/me', as('token-alice'));
    await app.request('/v1/me', as('token-expired'));
    expect(lines.join('\n')).not.toMatch(/token-alice|token-expired/);
    expect(lines.join('\n')).toContain('"code":"token_expired"');
  });
});

describe('organizations', () => {
  it('a route that needs an organization refuses a user without one', async () => {
    const { app, as, register } = setup();
    await register('token-alice');
    const response = await app.request('/v1/org-probe', as('token-alice'));
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({ error: 'organization_required' });
  });

  it("a client-sent organization id cannot reach another user's organization", async () => {
    const { app, as, register, memberships } = setup();
    memberships[await register('token-alice')] = [ORG_A];
    memberships[await register('token-bob')] = [ORG_B];
    const own = await app.request('/v1/org-probe', as('token-alice'));
    expect(await own.json()).toEqual({ organizationId: ORG_A });
    const other = await app.request(
      '/v1/org-probe',
      as('token-alice', { headers: { 'x-organization-id': ORG_B } }),
    );
    expect(other.status).toBe(403);
    expect(await other.json()).toEqual({ error: 'organization_forbidden' });
    const missing = await app.request(
      '/v1/org-probe',
      as('token-alice', { headers: { 'x-organization-id': 'org-does-not-exist' } }),
    );
    expect(await missing.json()).toEqual({ error: 'organization_forbidden' });
  });
});

describe('without auth configured', () => {
  it('every /v1 route fails closed and health still works', async () => {
    const logger = createLogger({ service: 'api', sink: () => undefined });
    const app = createApp({ logger, version: 'test' });
    const response = await app.request('/v1/me', { headers: { authorization: 'Bearer x' } });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'auth_not_configured' });
    expect((await app.request('/health')).status).toBe(200);
  });
});
