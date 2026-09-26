import { createLogger } from '@melonoffice/observability';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { setupApp, STORES } from './test-api.js';

const ORG_A = '00000000-0000-4000-8000-00000000000a';

describe.each(STORES)('with users in %s', (_name, createStores) => {
  const setup = () => setupApp(createStores());

  describe('POST /v1/me (registration)', () => {
    it('creates the user from a valid token, once', async () => {
      const { app, as } = setup();
      const first = await app.request('/v1/me', as('token-alice', { method: 'POST' }));
      expect(first.status).toBe(201);
      const created = (await first.json()) as Record<string, unknown>;
      expect(created).toEqual({
        userId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        email: 'alice@example.com',
        emailVerified: true,
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        lastLoginAt: expect.any(String),
      });
      const again = await app.request('/v1/me', as('token-alice', { method: 'POST' }));
      expect(again.status).toBe(200);
      const repeated = (await again.json()) as Record<string, unknown>;
      expect(repeated.userId).toBe(created.userId);
      expect(repeated.createdAt).toBe(created.createdAt);
    });

    it('ignores any user id, email or organization in the body', async () => {
      const { app, as, register, users } = setup();
      const bobId = await register('token-bob');
      const response = await app.request(
        '/v1/me',
        as('token-alice', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            userId: bobId,
            subject: 'uid-bob',
            email: 'mallory@example.com',
            emailVerified: true,
            organizationId: ORG_A,
          }),
        }),
      );
      const body = (await response.json()) as { userId: string; email: string };
      expect(body.userId).not.toBe(bobId);
      expect(body.email).toBe('alice@example.com');
      expect(body).not.toHaveProperty('organizationId');
      const stored = await users.findBySubject('uid-alice');
      expect(stored?.id).toBe(body.userId);
      expect(stored?.email).toBe('alice@example.com');
      expect((await users.findBySubject('uid-bob'))?.email).toBe('bob@example.com');
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
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
        lastLoginAt: expect.any(String),
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

    it('user A can never read user B, whatever the query or headers say', async () => {
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
