import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * Manual commercial operations by the platform administrator (ADR-0091): suspending, reactivating
 * and closing partner and agency accounts, changing their limits, and adding credits by hand.
 * They run against memory and, where the emulator runs, Firestore.
 *
 * People: Alice is a platform administrator with a verified email and owns Tenant A. Bob owns
 * Tenant B and is also listed as an administrator, but his email is not verified. Carol is
 * Partner A's admin; Dave has signed in and belongs to nothing.
 */
type Body = Record<string, unknown> & { error?: string };

const KEY = '11111111-1111-4111-8111-111111111111';
const OTHER_KEY = '22222222-2222-4222-8222-222222222222';
const UNKNOWN_USER = '33333333-3333-4333-8333-333333333333';

describe.each(STORES)('platform operations with storage in %s', (_name, createStores) => {
  async function setup() {
    const stores: Stores = createStores();
    const first = setupApp(stores);
    const ids: Record<string, string> = {};
    for (const who of ['alice', 'bob', 'carol', 'dave']) {
      ids[who] = await first.register(`token-${who}`);
    }
    const ctx = setupApp(stores, undefined, undefined, undefined, undefined, {
      platformAdmins: [ids.alice as string, ids.bob as string],
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
      return { status: response.status, body: (await response.json()) as Body };
    };
    const org = async (who: string, name: string) =>
      ((await call(who, 'POST', '/v1/organizations', { name })).body.organization as { id: string })
        .id;
    const tenantA = await org('alice', 'Tenant A');
    const tenantB = await org('bob', 'Tenant B');
    const created = await call('alice', 'POST', '/v1/platform/commercial-accounts', {
      type: 'partner',
      name: 'Partner A',
      adminUserId: ids.carol,
      limits: { customers: 2, members: 2 },
    });
    expect(created.status).toBe(201);
    const partnerA = created.body.account as { id: string; updatedAt?: string };
    const accounts = '/v1/platform/commercial-accounts';
    const current = async () =>
      (
        (await call('alice', 'GET', accounts)).body.accounts as {
          id: string;
          status: string;
          limits: { customers: number; members: number };
          updatedAt: string;
        }[]
      ).find((a) => a.id === partnerA.id) as {
        id: string;
        status: string;
        limits: { customers: number; members: number };
        updatedAt: string;
      };
    const events = async (action: string) =>
      (await stores.auditEvents()).filter((e) => e.action === action);
    return { ...ctx, stores, ids, call, tenantA, tenantB, partnerA, accounts, current, events };
  }

  describe('the account lifecycle', () => {
    it('suspends, reactivates and closes, audited, keeping members and history', async () => {
      const { call, accounts, partnerA, current, events } = await setup();
      const path = `${accounts}/${partnerA.id}/status`;
      const before = await current();
      expect(before.status).toBe('active');

      const suspended = await call('alice', 'POST', path, {
        status: 'suspended',
        expectedUpdatedAt: before.updatedAt,
      });
      expect(suspended.status).toBe(200);
      expect((suspended.body.account as { status: string }).status).toBe('suspended');
      // Suspended: its admin can no longer act in it, nor even see it listed as theirs.
      expect((await call('carol', 'GET', `/v1/commercial/accounts/${partnerA.id}`)).status).toBe(
        403,
      );
      expect((await call('carol', 'GET', '/v1/commercial/accounts')).body.accounts).toEqual([]);

      const back = await call('alice', 'POST', path, {
        status: 'active',
        expectedUpdatedAt: (await current()).updatedAt,
      });
      expect(back.status).toBe(200);
      const members = await call('carol', 'GET', `/v1/commercial/accounts/${partnerA.id}/members`);
      expect(members.status).toBe(200);
      expect(members.body.members).toHaveLength(1);

      // Closing asks for the account's exact name, and is final.
      const latest = (await current()).updatedAt;
      expect(
        await call('alice', 'POST', path, {
          status: 'closed',
          expectedUpdatedAt: latest,
          confirmName: 'partner a',
        }),
      ).toEqual({ status: 400, body: { error: 'close_not_confirmed' } });
      const closed = await call('alice', 'POST', path, {
        status: 'closed',
        expectedUpdatedAt: latest,
        confirmName: 'Partner A',
      });
      expect(closed.status).toBe(200);
      expect(
        await call('alice', 'POST', path, {
          status: 'active',
          expectedUpdatedAt: (await current()).updatedAt,
        }),
      ).toEqual({ status: 409, body: { error: 'invalid_account_transition' } });
      // The account is still there, closed, with the same id.
      expect((await current()).status).toBe('closed');

      const changes = await events('commercial_account.status_changed');
      expect(changes.filter((e) => e.result === 'success').map((e) => e.transition)).toEqual([
        { from: 'active', to: 'suspended' },
        { from: 'suspended', to: 'active' },
        { from: 'active', to: 'closed' },
      ]);
      expect(changes.every((e) => e.actorRole === 'platform_admin')).toBe(true);
      // The refused attempts are recorded too, with why, and change nothing.
      expect(
        changes.filter((e) => e.result === 'denied').map((e) => [e.reason, e.target?.id]),
      ).toEqual([
        ['close_not_confirmed', partnerA.id],
        ['invalid_account_transition', partnerA.id],
      ]);
    });

    it('a suspended or closed partner gains no customer, even from a request already made', async () => {
      const { call, accounts, partnerA, tenantA, current } = await setup();
      const rel = `/v1/organizations/${tenantA}/commercial-relationships`;
      expect(
        (
          await call('carol', 'POST', `/v1/commercial/accounts/${partnerA.id}/customers`, {
            organizationId: tenantA,
            mode: 'reseller',
            scopes: ['summary'],
          })
        ).status,
      ).toBe(201);
      const pending = async () =>
        ((await call('alice', 'GET', rel)).body.relationships as { updatedAt: string }[])[0]
          ?.updatedAt;
      await call('alice', 'POST', `${accounts}/${partnerA.id}/status`, {
        status: 'suspended',
        expectedUpdatedAt: (await current()).updatedAt,
      });
      expect(
        await call('alice', 'POST', `${rel}/${partnerA.id}/accept`, {
          scopes: ['summary'],
          expectedUpdatedAt: await pending(),
        }),
      ).toEqual({ status: 409, body: { error: 'commercial_account_inactive' } });
      await call('alice', 'POST', `${accounts}/${partnerA.id}/status`, {
        status: 'closed',
        expectedUpdatedAt: (await current()).updatedAt,
        confirmName: 'Partner A',
      });
      expect(
        (
          await call('alice', 'POST', `${rel}/${partnerA.id}/accept`, {
            scopes: ['summary'],
            expectedUpdatedAt: await pending(),
          })
        ).body.error,
      ).toBe('commercial_account_inactive');
      // The owner can still end the request.
      expect(
        (
          await call('alice', 'POST', `${rel}/${partnerA.id}/end`, {
            expectedUpdatedAt: await pending(),
          })
        ).status,
      ).toBe(200);
    });

    it('refuses a stale version, an unknown status and an unknown account, audited', async () => {
      const { call, accounts, partnerA, events } = await setup();
      const path = `${accounts}/${partnerA.id}/status`;
      expect(
        await call('alice', 'POST', path, {
          status: 'suspended',
          expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
        }),
      ).toEqual({ status: 409, body: { error: 'commercial_conflict' } });
      expect((await call('alice', 'POST', path, { status: 'deleted' })).body).toEqual({
        error: 'invalid_commercial_request',
        field: 'status',
      });
      expect(
        (
          await call('alice', 'POST', `${accounts}/${UNKNOWN_USER}/status`, {
            status: 'suspended',
            expectedUpdatedAt: 'x',
          })
        ).status,
      ).toBe(404);
      expect(
        (await events('commercial_account.status_changed')).map((e) => [e.result, e.reason]),
      ).toEqual([
        ['denied', 'commercial_conflict'],
        ['denied', 'invalid_commercial_request'],
        ['denied', 'commercial_account_not_found'],
      ]);
    });

    it('changes limits; a lower limit stops new additions and removes nobody', async () => {
      const { call, accounts, partnerA, current, ids, events } = await setup();
      const limits = `${accounts}/${partnerA.id}/limits`;
      expect(
        (
          await call('alice', 'POST', limits, {
            limits: { customers: 1, members: 0 },
            expectedUpdatedAt: (await current()).updatedAt,
          })
        ).body,
      ).toEqual({ error: 'invalid_commercial_request', field: 'limits' });
      const changed = await call('alice', 'POST', limits, {
        limits: { customers: 0, members: 1 },
        expectedUpdatedAt: (await current()).updatedAt,
      });
      expect(changed.status).toBe(200);
      expect((changed.body.account as { limits: unknown }).limits).toEqual({
        customers: 0,
        members: 1,
      });
      // Carol stays; nobody new can be added past the limit.
      const added = await call('carol', 'POST', `/v1/commercial/accounts/${partnerA.id}/members`, {
        userId: ids.dave,
        role: 'partner.support',
      });
      expect(added).toEqual({ status: 409, body: { error: 'commercial_limit_reached' } });
      expect(
        (await events('commercial_account.limits_changed')).filter((e) => e.result === 'success'),
      ).toHaveLength(1);
    });

    it('lets nobody else change an account, and audits the refusal', async () => {
      const { call, accounts, partnerA, current, events } = await setup();
      const version = (await current()).updatedAt;
      for (const [who, error] of [
        ['carol', 'platform_forbidden'],
        ['dave', 'platform_forbidden'],
        ['bob', 'platform_email_unverified'],
      ] as const) {
        expect(
          await call(who, 'POST', `${accounts}/${partnerA.id}/status`, {
            status: 'suspended',
            expectedUpdatedAt: version,
          }),
        ).toEqual({ status: 403, body: { error } });
        expect(
          await call(who, 'POST', `${accounts}/${partnerA.id}/limits`, {
            limits: { customers: 100, members: 100 },
            expectedUpdatedAt: version,
          }),
        ).toEqual({ status: 403, body: { error } });
      }
      expect((await current()).status).toBe('active');
      const denied = (await events('commercial_account.status_changed')).filter(
        (e) => e.result === 'denied',
      );
      expect(denied.map((e) => e.reason)).toEqual([
        'not_platform_admin',
        'not_platform_admin',
        'platform_email_unverified',
      ]);
    });
  });

  describe('the platform administrator', () => {
    it('needs a verified email for every platform route, before anything changes', async () => {
      const { call, accounts, ids } = await setup();
      for (const [method, path] of [
        ['GET', accounts],
        ['GET', '/v1/platform/domain-bindings'],
        ['GET', '/v1/platform/ai'],
      ] as const) {
        expect(await call('bob', method, path)).toEqual({
          status: 403,
          body: { error: 'platform_email_unverified' },
        });
      }
      expect(
        await call('bob', 'POST', accounts, {
          type: 'partner',
          name: 'Unverified',
          adminUserId: ids.dave,
          limits: { customers: 1, members: 1 },
        }),
      ).toEqual({ status: 403, body: { error: 'platform_email_unverified' } });
      expect((await call('alice', 'GET', accounts)).body.accounts).toHaveLength(1);
      expect((await call('bob', 'GET', '/v1/platform/access')).body).toEqual({
        platformAdmin: true,
        emailVerified: false,
      });
    });

    it('names only a person who has signed in as an account admin or member', async () => {
      const { call, accounts, partnerA } = await setup();
      expect(
        (
          await call('alice', 'POST', accounts, {
            type: 'partner',
            name: 'Ghost',
            adminUserId: UNKNOWN_USER,
            limits: { customers: 1, members: 1 },
          })
        ).body,
      ).toEqual({ error: 'invalid_commercial_request', field: 'adminUserId' });
      expect(
        (
          await call('carol', 'POST', `/v1/commercial/accounts/${partnerA.id}/members`, {
            userId: UNKNOWN_USER,
            role: 'partner.support',
          })
        ).body,
      ).toEqual({ error: 'invalid_commercial_request', field: 'userId' });
    });
  });

  describe('manual credit grants', () => {
    const grants = (org: string) => `/v1/platform/organizations/${org}/credit-grants`;

    it('adds credits once per idempotency key, audited with the administrator', async () => {
      const { call, tenantA, events } = await setup();
      const before = await call('alice', 'GET', `/v1/platform/organizations/${tenantA}`);
      expect(before.status).toBe(200);
      expect(before.body).toMatchObject({
        organization: { id: tenantA, name: 'Tenant A', status: 'active' },
        credits: { balance: 0 },
      });

      const request = { amount: 250, reason: 'manual_purchase', idempotencyKey: KEY };
      const first = await call('alice', 'POST', grants(tenantA), request);
      expect(first.status).toBe(201);
      expect(first.body).toMatchObject({
        grant: {
          organizationId: tenantA,
          amount: 250,
          reason: 'manual_purchase',
          idempotencyKey: KEY,
        },
        balance: 250,
        replayed: false,
      });
      // A double click, a refresh or a retry: the same grant, nothing added again.
      for (let i = 0; i < 3; i += 1) {
        const again = await call('alice', 'POST', grants(tenantA), request);
        expect(again.status).toBe(200);
        expect(again.body).toMatchObject({ replayed: true, grant: first.body.grant });
      }
      // The same key for a different grant is refused and moves nothing.
      expect(await call('alice', 'POST', grants(tenantA), { ...request, amount: 999 })).toEqual({
        status: 409,
        body: { error: 'idempotency_key_reused' },
      });
      const balance = await call('alice', 'GET', `/v1/organizations/${tenantA}/credits`);
      expect(balance.body.balance).toBe(250);

      const recorded = await events('credits.platform_grant');
      const success = recorded.filter((e) => e.result === 'success');
      expect(success).toHaveLength(1);
      expect(success[0]).toMatchObject({
        actorRole: 'platform_admin',
        organizationId: tenantA,
        target: { type: 'credit_entry' },
        reason: 'manual_purchase',
        reference: `platform-grant:${KEY}`,
      });
      expect(recorded.filter((e) => e.result === 'denied').map((e) => e.reason)).toEqual([
        'idempotency_key_reused',
      ]);
      // A grant is not AI consumption, and it is not a tenant's own `credits.grant`.
      expect(await events('credits.consume')).toEqual([]);
      expect(await events('credits.grant')).toEqual([]);
    });

    it('checks the amount, the reason, the key and the organization on the server', async () => {
      const { call, tenantA, stores } = await setup();
      const ok = { amount: 10, reason: 'courtesy', idempotencyKey: OTHER_KEY };
      for (const [change, field] of [
        [{ amount: 0 }, 'amount'],
        [{ amount: -5 }, 'amount'],
        [{ amount: 1.5 }, 'amount'],
        [{ amount: '10' }, 'amount'],
        [{ reason: 'because' }, 'reason'],
        [{ reason: undefined }, 'reason'],
        [{ idempotencyKey: 'abc' }, 'idempotencyKey'],
        [{ idempotencyKey: undefined }, 'idempotencyKey'],
      ] as const) {
        expect(await call('alice', 'POST', grants(tenantA), { ...ok, ...change })).toEqual({
          status: 400,
          body: { error: 'invalid_credit_grant', field },
        });
      }
      expect((await call('alice', 'POST', grants(UNKNOWN_USER), ok)).status).toBe(404);
      expect((await call('alice', 'POST', grants('not-an-id'), ok)).status).toBe(404);
      const wallet = await stores.credits.findWallet(tenantA as never);
      expect(wallet?.balance).toBe(0);
    });

    it('is refused to everyone but a verified platform administrator', async () => {
      const { call, tenantA, tenantB, events, stores } = await setup();
      const request = { amount: 100, reason: 'courtesy', idempotencyKey: KEY };
      expect(await call('carol', 'POST', grants(tenantA), request)).toEqual({
        status: 403,
        body: { error: 'platform_forbidden' },
      });
      // Bob owns Tenant B and is listed, but not verified: not even his own company.
      expect(await call('bob', 'POST', grants(tenantB), request)).toEqual({
        status: 403,
        body: { error: 'platform_email_unverified' },
      });
      expect((await call('carol', 'GET', `/v1/platform/organizations/${tenantA}`)).status).toBe(
        403,
      );
      expect((await stores.credits.findWallet(tenantA as never))?.balance).toBe(0);
      expect((await stores.credits.findWallet(tenantB as never))?.balance).toBe(0);
      expect((await events('credits.platform_grant')).map((e) => [e.result, e.reason])).toEqual([
        ['denied', 'not_platform_admin'],
        ['denied', 'platform_email_unverified'],
      ]);
      // An organization owner still has no route that adds credits to its own wallet.
      expect(
        (await call('alice', 'POST', `/v1/organizations/${tenantA}/credits`, request)).status,
      ).toBe(404);
    });
  });
});
