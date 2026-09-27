import {
  createCreditService,
  entryIdOf,
  verifyLedger,
  type CreditService,
  type CreditStore,
} from '@melonoffice/credits';
import type { OrganizationId, UserId } from '@melonoffice/domain';
import { createAuthorizationService, type AuthorizationService } from '@melonoffice/rbac';
import { resolveTenant, type TenantContext } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

interface View {
  organization: { id: string };
}

/** The value, or a failed test when it is missing. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing value');
  return value;
}

const MISSING_ORG = '99999999-9999-4999-8999-999999999999';
const req = (amount: number, referenceId: string, reason = 'test') => ({
  amount,
  referenceId,
  reason,
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof Error && 'code' in error) return String(error.code);
    throw error;
  }
  return 'accepted';
}

describe.each(STORES)('credits with storage in %s', (_name, createStores) => {
  async function setup(
    options: {
      authorization?: AuthorizationService;
      createBody?: Record<string, unknown>;
      wrap?: (store: CreditStore) => CreditStore;
    } = {},
  ) {
    const stores: Stores = createStores();
    const store = options.wrap?.(stores.credits) ?? stores.credits;
    const ctx = setupApp(stores, options.authorization, undefined, undefined, store);
    const aliceId = (await ctx.register('token-alice')) as UserId;
    const bobId = (await ctx.register('token-bob')) as UserId;
    const create = async (token: string, body: unknown) =>
      ctx.app.request(
        '/v1/organizations',
        ctx.as(token, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    const orgA = (
      (await (await create('token-alice', { ...options.createBody, name: 'A' })).json()) as View
    ).organization.id as OrganizationId;
    const orgB = ((await (await create('token-bob', { name: 'B' })).json()) as View).organization
      .id as OrganizationId;
    const request = async (token: string, path: string, init: RequestInit = {}) => {
      const response = await ctx.app.request(path, ctx.as(token, init));
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const credits = (token: string, id: string, init: RequestInit = {}) =>
      request(token, `/v1/organizations/${encodeURIComponent(id)}/credits`, init);
    // Operations run server side, through the service, on a tenant tenancy resolved.
    const service: CreditService = createCreditService({ store, organizations: stores.tenancy });
    const tenantOf = (userId: UserId, organizationId: OrganizationId): Promise<TenantContext> =>
      resolveTenant({ actor: 'user', userId, emailVerified: true }, organizationId, stores.tenancy);
    const tenantA = await tenantOf(aliceId, orgA);
    const tenantB = await tenantOf(bobId, orgB);
    const balanceOf = async (organizationId: OrganizationId) =>
      (await stores.credits.findWallet(organizationId))?.balance;
    const events = async (prefix: string) =>
      (await stores.auditEvents()).filter((e) => e.action.startsWith(prefix));
    return {
      ...ctx,
      stores,
      aliceId,
      bobId,
      orgA,
      orgB,
      create,
      request,
      credits,
      service,
      tenantOf,
      tenantA,
      tenantB,
      balanceOf,
      events,
    };
  }

  describe('organization creation opens an empty wallet', () => {
    it('15. opens exactly one wallet per organization, at 0, with no ledger entry', async () => {
      const { stores, orgA, orgB, create, events } = await setup();
      for (const org of [orgA, orgB]) {
        expect(await stores.credits.findWallet(org)).toMatchObject({
          organizationId: org,
          balance: 0,
        });
        expect(await stores.credits.ledger(org)).toEqual([]);
      }
      expect((await create('token-alice', { name: 'Second' })).status).toBe(409);
      expect(await events('credits.')).toEqual([]);
    });

    it('ignores any balance, wallet or credits the client sends', async () => {
      const { stores, orgA } = await setup({
        createBody: { balance: 1000, credits: 1000, wallet: { balance: 1000 }, walletId: 'x' },
      });
      const wallet = await stores.credits.findWallet(orgA);
      expect(wallet?.balance).toBe(0);
      expect(wallet?.id).not.toBe('x');
    });
  });

  describe('GET /v1/organizations/:organizationId/credits', () => {
    it('1. shows the owner their balance, and nothing from the ledger', async () => {
      const { credits, service, tenantA, orgA, stores } = await setup();
      await service.grant(tenantA, req(100, 'g1'));
      await service.consume(tenantA, req(30, 'c1'));
      const wallet = await stores.credits.findWallet(orgA);
      expect(await credits('token-alice', orgA)).toEqual({
        status: 200,
        body: {
          organizationId: orgA,
          status: 'present',
          balance: 70,
          updatedAt: wallet?.updatedAt,
        },
      });
    });

    it('2. never shows another organization balance, whatever id is sent, and audits it', async () => {
      const { credits, orgA, orgB, bobId, events } = await setup();
      for (const target of [orgA, MISSING_ORG, 'org-a', orgA.toUpperCase(), `${orgA}_x`]) {
        expect(await credits('token-bob', target)).toEqual({
          status: 403,
          body: { error: 'organization_forbidden' },
        });
      }
      expect((await credits('token-alice', orgB)).status).toBe(403);
      expect(await events('tenancy.resolve')).toContainEqual(
        expect.objectContaining({
          actor: { type: 'user', userId: bobId, via: 'direct' },
          requestedOrganizationId: orgA,
          reason: 'organization_forbidden',
        }),
      );
    });

    it.each(['suspended', 'revoked'] as const)(
      '5 and 6. refuses a %s membership, for reading and for operations',
      async (status) => {
        const { credits, put, tenancy, orgA, aliceId, tenantOf, service, tenantA } = await setup();
        await service.grant(tenantA, req(100, 'g1'));
        const membership = await tenancy.findMembership(orgA, aliceId);
        if (membership === undefined) throw new Error('missing membership');
        await put({ ...membership, status });
        expect(await credits('token-alice', orgA)).toEqual({
          status: 403,
          body: { error: 'organization_forbidden' },
        });
        await expect(tenantOf(aliceId, orgA)).rejects.toThrow();
      },
    );

    it('7. refuses a suspended organization, even with a tenant resolved before', async () => {
      const { credits, put, tenancy, orgA, service, tenantA, balanceOf } = await setup();
      await service.grant(tenantA, req(100, 'g1'));
      const organization = await tenancy.findOrganization(orgA);
      if (organization === undefined) throw new Error('missing organization');
      await put({ ...organization, status: 'suspended' });
      expect((await credits('token-alice', orgA)).status).toBe(403);
      expect(await codeOf(service.consume(tenantA, req(1, 'c1')))).toBe('organization_inactive');
      expect(await balanceOf(orgA)).toBe(100);
    });

    it('refuses no token and a forged token', async () => {
      const { app, orgA } = await setup();
      expect((await app.request(`/v1/organizations/${orgA}/credits`)).status).toBe(401);
      const forged = await app.request(`/v1/organizations/${orgA}/credits`, {
        headers: { authorization: 'Bearer forged' },
      });
      expect(forged.status).toBe(401);
    });

    it('refuses a member whose role lacks credits.read, and audits it', async () => {
      const { credits, orgA, events } = await setup({
        authorization: createAuthorizationService({ owner: ['organization.read'] }),
      });
      expect(await credits('token-alice', orgA)).toEqual({
        status: 403,
        body: { error: 'permission_denied' },
      });
      expect(await events('authorization.check')).toContainEqual(
        expect.objectContaining({ permission: 'credits.read', reason: 'permission_denied' }),
      );
    });

    it('answers an organization without a wallet explicitly, inventing no balance', async () => {
      const { credits, stores, orgA, lines, service, tenantA } = await setup();
      await stores.removeWallet(orgA);
      expect(await credits('token-alice', orgA)).toEqual({
        status: 200,
        body: { organizationId: orgA, status: 'unavailable', reason: 'credits_wallet_missing' },
      });
      expect(lines.join('\n')).toContain('"reason":"credits_wallet_missing"');
      expect(await codeOf(service.grant(tenantA, req(1, 'g1')))).toBe('credits_wallet_missing');
    });

    it('19, 20 and 21. ignores organization ids and balances in body, query and headers', async () => {
      const { request, orgA, orgB, service, tenantA, tenantB, balanceOf } = await setup();
      await service.grant(tenantA, req(100, 'g1'));
      await service.grant(tenantB, req(7, 'g1'));
      const path = (id: string) => `/v1/organizations/${id}/credits`;
      const query = await request(
        'token-alice',
        `${path(orgA)}?organizationId=${orgB}&balance=999&walletId=x`,
      );
      expect(query.body).toEqual(expect.objectContaining({ organizationId: orgA, balance: 100 }));
      const headers = await request('token-alice', path(orgA), {
        headers: { 'x-organization-id': orgB, 'x-tenant-id': orgB, 'x-balance': '999' },
      });
      expect(headers.body).toEqual(expect.objectContaining({ organizationId: orgA, balance: 100 }));
      // A body reaches no credits route: there is none that reads one.
      const body = await request('token-alice', path(orgA), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ organizationId: orgB, balance: 999, amount: 999 }),
      });
      expect(body.status).toBe(404);
      const bob = await request('token-bob', `${path(orgB)}?organizationId=${orgA}`, {
        headers: { 'x-organization-id': orgA },
      });
      expect(bob.body).toEqual(expect.objectContaining({ organizationId: orgB, balance: 7 }));
      expect(await balanceOf(orgA)).toBe(100);
      expect(await balanceOf(orgB)).toBe(7);
    });

    it('17 and 18. offers clients no way to grant, consume, refund, adjust or list', async () => {
      const { request, orgA, balanceOf, stores } = await setup();
      const body = JSON.stringify({
        amount: 1000,
        referenceId: 'x',
        reason: 'test',
        balance: 1000,
      });
      const init = (method: string): RequestInit => ({
        method,
        headers: { 'content-type': 'application/json' },
        body,
      });
      const base = `/v1/organizations/${orgA}/credits`;
      for (const [method, path] of [
        ['POST', base],
        ['PUT', base],
        ['PATCH', base],
        ['DELETE', base],
        ['POST', `${base}/grant`],
        ['POST', `${base}/consume`],
        ['POST', `${base}/refund`],
        ['POST', `${base}/adjust`],
        ['POST', `${base}/adjustment`],
        ['POST', `${base}/transfer`],
        ['GET', `${base}/ledger`],
        ['POST', `${base}/ledger`],
        ['GET', `${base}/entries`],
        ['POST', '/v1/credits/grant'],
        ['POST', `/v1/organizations/${orgA}/wallet`],
      ] as const) {
        const status = (await request('token-alice', path, method === 'GET' ? {} : init(method)))
          .status;
        expect([404, 405]).toContain(status);
      }
      expect(await balanceOf(orgA)).toBe(0);
      expect(await stores.credits.ledger(orgA)).toEqual([]);
    });
  });

  describe('operations', () => {
    it('3, 11 and ledger integrity: grant, consume to 0, refuse, refund', async () => {
      const { service, tenantA, orgA, stores, events } = await setup();
      expect((await service.grant(tenantA, req(100, 'g1'))).balance).toBe(100);
      expect((await service.consume(tenantA, req(30, 'c1'))).balance).toBe(70);
      expect((await service.consume(tenantA, req(70, 'c2'))).balance).toBe(0);
      expect(await codeOf(service.consume(tenantA, req(1, 'c3')))).toBe('credits_insufficient');
      expect((await service.refund(tenantA, { ...req(30, 'r1'), refundOf: 'c1' })).balance).toBe(
        30,
      );
      const entries = await stores.credits.ledger(orgA);
      expect(entries.map((e) => [e.type, e.amount, e.balanceAfter])).toEqual([
        ['grant', 100, 100],
        ['consume', -30, 70],
        ['consume', -70, 0],
        ['refund', 30, 30],
      ]);
      const wallet = await stores.credits.findWallet(orgA);
      expect(wallet?.balance).toBe(30);
      expect(verifyLedger(must(wallet), entries)).toEqual([]);
      expect((await events('credits.')).map((e) => e.action)).toEqual([
        'credits.grant',
        'credits.consume',
        'credits.consume',
        'credits.refund',
      ]);
    });

    it('4. OrgA cannot consume, refund or read OrgB credits', async () => {
      const { service, tenantA, tenantB, orgB, balanceOf, stores } = await setup();
      await service.grant(tenantB, req(100, 'gb'));
      await service.consume(tenantB, req(10, 'cb'));
      expect(await codeOf(service.consume(tenantA, req(1, 'c1')))).toBe('credits_insufficient');
      expect(await codeOf(service.refund(tenantA, { ...req(1, 'r1'), refundOf: 'cb' }))).toBe(
        'credits_refund_invalid',
      );
      const forged = { ...tenantA, organizationId: orgB } as TenantContext;
      expect(await codeOf(service.consume(forged, req(1, 'c2')))).toBe('unresolved_tenant');
      expect(await balanceOf(orgB)).toBe(90);
      expect(await stores.credits.ledger(orgB)).toHaveLength(2);
    });

    it.each([
      ['8. amount 0', { amount: 0 }, 'invalid_amount'],
      ['9. a negative amount', { amount: -10 }, 'invalid_amount'],
      ['10. a decimal amount', { amount: 1.5 }, 'invalid_amount'],
      ['NaN', { amount: Number.NaN }, 'invalid_amount'],
      ['Infinity', { amount: Number.POSITIVE_INFINITY }, 'invalid_amount'],
      ['a string amount', { amount: '10' }, 'invalid_amount'],
      ['an amount out of range', { amount: 1e13 }, 'invalid_amount'],
      ['an empty reference', { referenceId: '' }, 'invalid_reference'],
    ])('refuses %s and writes nothing', async (_, override, code) => {
      const { service, tenantA, orgA, stores, events } = await setup();
      const request = { ...req(10, 'op'), ...override } as never;
      expect(await codeOf(service.grant(tenantA, request))).toBe(code);
      expect(await codeOf(service.consume(tenantA, request))).toBe(code);
      expect(await stores.credits.ledger(orgA)).toEqual([]);
      expect((await stores.credits.findWallet(orgA))?.balance).toBe(0);
      expect(await events('credits.')).toEqual([]);
    });

    it(
      '12. lets only one of two concurrent 80-credit consumes spend 100',
      { timeout: 30_000 },
      async () => {
        const { service, tenantA, orgA, stores } = await setup();
        await service.grant(tenantA, req(100, 'g1'));
        const results = await Promise.all([
          codeOf(service.consume(tenantA, req(80, 'c1'))),
          codeOf(service.consume(tenantA, req(80, 'c2'))),
        ]);
        expect(results.sort()).toEqual(['accepted', 'credits_insufficient']);
        const wallet = await stores.credits.findWallet(orgA);
        expect(wallet?.balance).toBe(20);
        expect(verifyLedger(must(wallet), await stores.credits.ledger(orgA))).toEqual([]);
      },
    );

    it('12. never overspends under many concurrent consumes', { timeout: 60_000 }, async () => {
      const { service, tenantA, orgA, stores } = await setup();
      await service.grant(tenantA, req(50, 'g1'));
      const results = await Promise.all(
        Array.from({ length: 10 }, (_, i) => codeOf(service.consume(tenantA, req(7, `c${i}`)))),
      );
      expect(results.filter((r) => r === 'accepted')).toHaveLength(7);
      const wallet = await stores.credits.findWallet(orgA);
      expect(wallet?.balance).toBe(1);
      const entries = await stores.credits.ledger(orgA);
      expect(entries).toHaveLength(8);
      expect(verifyLedger(must(wallet), entries)).toEqual([]);
    });

    it(
      '13. repeats of the same reference move credits once, even concurrently',
      { timeout: 30_000 },
      async () => {
        const { service, tenantA, orgA, stores, events } = await setup();
        const grant = await service.grant(tenantA, req(100, 'g1'));
        expect(await service.grant(tenantA, req(100, 'g1'))).toEqual({ ...grant, replayed: true });
        const consumes = await Promise.all(
          Array.from({ length: 4 }, () => service.consume(tenantA, req(30, 'c1'))),
        );
        expect(consumes.filter((r) => !r.replayed)).toHaveLength(1);
        const refund = await service.refund(tenantA, { ...req(10, 'r1'), refundOf: 'c1' });
        expect(await service.refund(tenantA, { ...req(10, 'r1'), refundOf: 'c1' })).toEqual({
          ...refund,
          replayed: true,
        });
        expect(await stores.credits.ledger(orgA)).toHaveLength(3);
        expect(await events('credits.')).toHaveLength(3);
        expect((await stores.credits.findWallet(orgA))?.balance).toBe(80);
        expect(await codeOf(service.consume(tenantA, req(31, 'c1')))).toBe(
          'credits_reference_conflict',
        );
        expect(await codeOf(service.grant(tenantA, req(30, 'c1')))).toBe(
          'credits_reference_conflict',
        );
      },
    );

    it('14. a different reference is an independent operation', async () => {
      const { service, tenantA, orgA, stores } = await setup();
      await service.grant(tenantA, req(100, 'g1'));
      await service.consume(tenantA, req(10, 'c1'));
      await service.consume(tenantA, req(10, 'c2'));
      const entries = await stores.credits.ledger(orgA);
      expect(entries).toHaveLength(3);
      expect(new Set(entries.map((e) => e.id)).size).toBe(3);
      expect(entries[1]?.id).toBe(entryIdOf(orgA, 'c1'));
      expect((await stores.credits.findWallet(orgA))?.balance).toBe(80);
    });

    it('16. keeps the ledger append-only: an entry is never replaced', async () => {
      const { service, tenantA, orgA, stores } = await setup();
      await service.grant(tenantA, req(100, 'g1'));
      const [first] = await stores.credits.ledger(orgA);
      await expect(
        stores.credits.transact(orgA, async (tx) => {
          const wallet = await tx.wallet();
          tx.commit(
            { ...must(wallet), balance: 1 },
            { ...must(first), amount: 1, balanceAfter: 1 },
            [],
          );
        }),
      ).rejects.toThrow();
      expect(await stores.credits.ledger(orgA)).toEqual([first]);
      expect((await stores.credits.findWallet(orgA))?.balance).toBe(100);
    });

    it('records operations in the audit log with actor, reference and reason only', async () => {
      const { service, tenantA, aliceId, orgA, events } = await setup();
      await service.grant(tenantA, req(100, 'g1', 'setup'));
      await service.consume(tenantA, req(30, 'c1', 'task_execution'));
      const recorded = await events('credits.');
      expect(recorded).toEqual([
        expect.objectContaining({
          action: 'credits.grant',
          result: 'success',
          actor: { type: 'user', userId: aliceId, via: 'direct' },
          organizationId: orgA,
          target: { type: 'credit_entry', id: entryIdOf(orgA, 'g1') },
          reference: 'g1',
          reason: 'setup',
          source: 'api',
        }),
        expect.objectContaining({ action: 'credits.consume', reference: 'c1' }),
      ]);
      for (const event of recorded) {
        expect(JSON.stringify(event)).not.toMatch(/amount|balance|token|bearer|authorization/i);
      }
    });
  });

  describe('transaction failure', () => {
    it('leaves no partial wallet, ledger or balance when the transaction fails', async () => {
      let fail = false;
      const { service, tenantA, orgA, stores, events } = await setup({
        wrap: (store) => ({
          findWallet: (id) => store.findWallet(id),
          ledger: (id) => store.ledger(id),
          transact: (id, work) =>
            store.transact(id, async (tx) => {
              const result = await work(tx);
              if (fail) throw new Error('storage unavailable');
              return result;
            }),
        }),
      });
      await service.grant(tenantA, req(100, 'g1'));
      fail = true;
      await expect(service.consume(tenantA, req(30, 'c1'))).rejects.toThrow('storage unavailable');
      await expect(service.refund(tenantA, { ...req(1, 'r1'), refundOf: 'g1' })).rejects.toThrow();
      fail = false;
      const wallet = await stores.credits.findWallet(orgA);
      expect(wallet?.balance).toBe(100);
      const entries = await stores.credits.ledger(orgA);
      expect(entries).toHaveLength(1);
      expect(verifyLedger(must(wallet), entries)).toEqual([]);
      expect(await events('credits.')).toHaveLength(1);
      expect((await service.consume(tenantA, req(30, 'c1'))).balance).toBe(70);
    });
  });
});
