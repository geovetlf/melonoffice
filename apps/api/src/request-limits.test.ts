import { describe, expect, it } from 'vitest';
import { scopesOf } from './request-limits.js';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * Limits on sensitive requests per person (ADR-0092), against memory and, where the emulator
 * runs, Firestore. Alice is a platform administrator with a verified email and owns Tenant A;
 * Carol is Partner A's admin.
 */
type Body = Record<string, unknown> & { error?: string };

describe('which requests count', () => {
  it('limits only sensitive writes, never reads', () => {
    expect(scopesOf('GET', '/v1/platform/commercial-accounts')).toEqual([]);
    expect(scopesOf('POST', '/v1/platform/commercial-accounts')).toEqual(['platform_write']);
    expect(scopesOf('POST', '/v1/platform/organizations/x/credit-grants')).toEqual([
      'credit_grant',
      'platform_write',
    ]);
    expect(scopesOf('POST', '/v1/invitations/lookup')).toEqual(['invitation_token']);
    expect(scopesOf('POST', '/v1/commercial/accounts/a/members')).toEqual(['commercial_write']);
    expect(scopesOf('DELETE', '/v1/commercial/accounts/a/members/m')).toEqual(['commercial_write']);
    expect(scopesOf('POST', '/v1/organizations/o/commercial-relationships/a/accept')).toEqual([
      'relationship_write',
    ]);
    expect(scopesOf('POST', '/v1/organizations/o/conversations')).toEqual([]);
  });
});

describe.each(STORES)('request limits with storage in %s', (_name, createStores) => {
  async function setup() {
    const stores: Stores = createStores();
    const first = setupApp(stores);
    const ids: Record<string, string> = {};
    for (const who of ['alice', 'bob', 'carol']) ids[who] = await first.register(`token-${who}`);
    const ctx = setupApp(stores, undefined, undefined, undefined, undefined, {
      platformAdmins: [ids.alice as string],
      requestLimits: {
        platform_write: { maxSends: 3, windowMs: 60_000 },
        credit_grant: { maxSends: 2, windowMs: 60_000 },
        invitation_token: { maxSends: 2, windowMs: 60_000 },
      },
    });
    const call = async (who: string, method: string, path: string, body?: unknown) => {
      const response = await ctx.app.request(
        path,
        ctx.as(`token-${who}`, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        }),
      );
      return {
        status: response.status,
        retryAfter: response.headers.get('retry-after'),
        body: (await response.json()) as Body,
      };
    };
    const tenantA = (
      (await call('alice', 'POST', '/v1/organizations', { name: 'Tenant A' })).body
        .organization as { id: string }
    ).id;
    return { ctx, stores, ids, call, tenantA };
  }

  it('refuses a person past the limit with 429 and Retry-After, changing nothing, reads still work', async () => {
    const { call, ids, stores } = await setup();
    const create = (name: string) =>
      call('alice', 'POST', '/v1/platform/commercial-accounts', {
        type: 'partner',
        name,
        adminUserId: ids.carol,
        limits: { customers: 1, members: 1 },
      });
    for (const name of ['P1', 'P2', 'P3']) expect((await create(name)).status).toBe(201);
    const refused = await create('P4');
    expect(refused.status).toBe(429);
    expect(refused.body).toMatchObject({ error: 'rate_limited' });
    expect(Number(refused.retryAfter)).toBeGreaterThan(0);
    const listed = await call('alice', 'GET', '/v1/platform/commercial-accounts');
    expect(listed.status).toBe(200);
    expect((listed.body.accounts as { name: string }[]).map((a) => a.name).sort()).toEqual([
      'P1',
      'P2',
      'P3',
    ]);
    // The refused request left no audit event: it never reached its route.
    const created = (await stores.auditEvents()).filter(
      (e) => e.action === 'commercial_account.created',
    );
    expect(created).toHaveLength(3);
  });

  it('limits credit grants on their own, per person, replays included', async () => {
    const { call, tenantA } = await setup();
    const grant = (key: string) =>
      call('alice', 'POST', `/v1/platform/organizations/${tenantA}/credit-grants`, {
        amount: 5,
        reason: 'testing',
        idempotencyKey: key,
      });
    const key = '11111111-1111-4111-8111-111111111111';
    expect((await grant(key)).status).toBe(201);
    expect((await grant(key)).status).toBe(200);
    const third = await grant('22222222-2222-4222-8222-222222222222');
    expect(third.status).toBe(429);
    const org = await call('alice', 'GET', `/v1/platform/organizations/${tenantA}`);
    expect((org.body.credits as { balance: number }).balance).toBe(5);
  });

  it('keeps each person to their own window: one person at the limit does not stop another', async () => {
    const { call } = await setup();
    const lookup = (who: string) =>
      call(who, 'POST', '/v1/invitations/lookup', { token: 'x'.repeat(43) });
    expect((await lookup('bob')).status).not.toBe(429);
    expect((await lookup('bob')).status).not.toBe(429);
    expect((await lookup('bob')).status).toBe(429);
    expect((await lookup('carol')).status).not.toBe(429);
  });
});
