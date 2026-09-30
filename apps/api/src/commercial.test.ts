import { createAICostEngine, createAIUsageLedger } from '@melonoffice/ai-usage';
import { describe, expect, it } from 'vitest';
import { joinAccount, setupApp, STORES, type Stores } from './test-api.js';

/**
 * The commercial layer's routes (ADR-0086). The numbered cases are the brief's security tests;
 * they run against memory and, where the emulator runs, Firestore.
 *
 * People: Alice owns Tenant A and is the platform administrator. Bob owns Tenant B. Carol is
 * Partner A's admin, Dave Partner B's admin, Erin Agency A's admin, Frank Partner A's support.
 */
type Body = Record<string, unknown> & { error?: string };

describe.each(STORES)('the commercial layer with storage in %s', (_name, createStores) => {
  async function setup() {
    const stores: Stores = createStores();
    const first = setupApp(stores);
    const ids: Record<string, string> = {};
    for (const who of ['alice', 'bob', 'carol', 'dave', 'erin', 'frank']) {
      ids[who] = await first.register(`token-${who}`);
    }
    const ctx = setupApp(stores, undefined, undefined, undefined, undefined, {
      platformAdmins: [ids.alice as string],
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
    const account = async (type: string, name: string, admin: string, customers = 5) => {
      const created = await call('alice', 'POST', '/v1/platform/commercial-accounts', {
        type,
        name,
        adminUserId: ids[admin],
        limits: { customers, members: 3 },
      });
      expect(created.status).toBe(201);
      return (created.body.account as { id: string }).id;
    };
    const partnerA = await account('partner', 'Partner A', 'carol');
    const partnerB = await account('partner', 'Partner B', 'dave');
    const agencyA = await account('agency', 'Agency A', 'erin');
    const acc = (id: string) => `/v1/commercial/accounts/${id}`;
    const rel = (org: string) => `/v1/organizations/${org}/commercial-relationships`;
    /** Invites a tenant and has its owner accept it with these scopes. */
    const relate = async (
      who: string,
      accountId: string,
      owner: string,
      tenant: string,
      mode: string,
      scopes: string[],
    ) => {
      const invited = await call(who, 'POST', `${acc(accountId)}/customers`, {
        organizationId: tenant,
        mode,
        scopes,
      });
      expect(invited.status).toBe(201);
      const pending = (await call(owner, 'GET', rel(tenant))).body.relationships as {
        commercialAccountId: string;
        updatedAt: string;
      }[];
      const mine = pending.find((r) => r.commercialAccountId === accountId);
      const accepted = await call(owner, 'POST', `${rel(tenant)}/${accountId}/accept`, {
        scopes,
        expectedUpdatedAt: mine?.updatedAt,
      });
      expect(accepted.status).toBe(200);
      return accepted.body.relationship as { updatedAt: string };
    };
    return {
      ...ctx,
      stores,
      ids,
      call,
      tenantA,
      tenantB,
      partnerA,
      partnerB,
      agencyA,
      acc,
      rel,
      relate,
    };
  }

  it('lets only the platform administrator create accounts, audited either way', async () => {
    const { call, ids, stores, partnerA } = await setup();
    const refused = await call('carol', 'POST', '/v1/platform/commercial-accounts', {
      type: 'partner',
      name: 'Mine',
      adminUserId: ids.carol,
      limits: { customers: 1, members: 1 },
    });
    expect(refused).toEqual({ status: 403, body: { error: 'platform_forbidden' } });
    expect((await call('carol', 'GET', '/v1/platform/commercial-accounts')).status).toBe(403);
    const listed = await call('alice', 'GET', '/v1/platform/commercial-accounts');
    expect((listed.body.accounts as unknown[]).length).toBe(3);
    for (const bad of [
      { type: 'reseller', name: 'X', adminUserId: ids.carol, limits: { customers: 1, members: 1 } },
      { type: 'partner', name: '', adminUserId: ids.carol, limits: { customers: 1, members: 1 } },
      { type: 'partner', name: 'X', adminUserId: 'carol', limits: { customers: 1, members: 1 } },
      { type: 'partner', name: 'X', adminUserId: ids.carol },
      { type: 'partner', name: 'X', adminUserId: ids.carol, limits: { customers: 1, members: 0 } },
    ]) {
      expect((await call('alice', 'POST', '/v1/platform/commercial-accounts', bad)).status).toBe(
        400,
      );
    }
    const events = await stores.auditEvents();
    expect(
      events.filter((e) => e.action === 'commercial_account.created').map((e) => e.result),
    ).toEqual(['success', 'success', 'success', 'denied']);
    expect(events).toContainEqual(
      expect.objectContaining({
        action: 'commercial_membership.created',
        commercialAccountId: partnerA,
        reference: 'partner.admin',
      }),
    );
  });

  it('1. Tenant A cannot read Tenant B, and 14. Direct SaaS stays as it was', async () => {
    const { call, tenantA, tenantB, rel } = await setup();
    expect((await call('alice', 'GET', `/v1/organizations/${tenantB}`)).status).toBe(403);
    expect((await call('alice', 'GET', rel(tenantB))).status).toBe(403);
    expect((await call('alice', 'GET', `/v1/organizations/${tenantA}`)).status).toBe(200);
    // One organization per person, as before: a commercial account changes nothing about it.
    expect((await call('alice', 'POST', '/v1/organizations', { name: 'Again' })).status).toBe(409);
    expect((await call('alice', 'GET', rel(tenantA))).body).toEqual({ relationships: [] });
  });

  it('2. and 4. a partner or agency cannot act in another account', async () => {
    const { call, acc, partnerA, partnerB, agencyA } = await setup();
    expect((await call('carol', 'GET', acc(partnerA))).status).toBe(200);
    for (const [who, other] of [
      ['carol', partnerB],
      ['dave', partnerA],
      ['erin', partnerA],
      ['carol', agencyA],
    ] as const) {
      expect(await call(who, 'GET', acc(other))).toEqual({
        status: 403,
        body: { error: 'commercial_account_forbidden' },
      });
      expect((await call(who, 'GET', `${acc(other)}/customers`)).status).toBe(403);
    }
    // Each person sees only their own accounts.
    expect(
      (
        (await call('carol', 'GET', '/v1/commercial/accounts')).body.accounts as { id: string }[]
      ).map((a) => a.id),
    ).toEqual([partnerA]);
    expect((await call('alice', 'GET', '/v1/commercial/accounts')).body).toEqual({ accounts: [] });
  });

  it('3., 5. and 8. reaches a customer only through an accepted relationship of that account', async () => {
    const { call, acc, rel, tenantA, tenantB, partnerA, partnerB, agencyA, relate } = await setup();
    const summary = (who: string, account: string, tenant: string) =>
      call(who, 'GET', `${acc(account)}/customers/${tenant}`);
    // Scopes nothing reads yet are not asked for (ADR-0097).
    for (const scope of ['support', 'knowledge', 'conversations']) {
      expect(
        (
          await call('carol', 'POST', `${acc(partnerA)}/customers`, {
            organizationId: tenantA,
            mode: 'reseller',
            scopes: [scope],
          })
        ).body,
      ).toEqual({ error: 'invalid_commercial_request', field: 'scopes' });
    }
    // Knowing the id is not enough, and a pending invitation grants nothing.
    await call('carol', 'POST', `${acc(partnerA)}/customers`, {
      organizationId: tenantA,
      mode: 'reseller',
      scopes: ['summary'],
    });
    expect(await summary('carol', partnerA, tenantA)).toEqual({
      status: 403,
      body: { error: 'customer_forbidden' },
    });
    expect((await call('carol', 'GET', `${acc(partnerA)}/customers`)).body.customers).toEqual([]);
    // Alice accepts: now Partner A sees Tenant A's summary, and nothing of Tenant B.
    const pending = (await call('alice', 'GET', rel(tenantA))).body.relationships as {
      updatedAt: string;
    }[];
    await call('alice', 'POST', `${rel(tenantA)}/${partnerA}/accept`, {
      scopes: ['summary'],
      expectedUpdatedAt: pending[0]?.updatedAt,
    });
    const seen = await summary('carol', partnerA, tenantA);
    expect(seen.status).toBe(200);
    expect(seen.body.organization).toEqual({ id: tenantA, name: 'Tenant A', status: 'active' });
    expect((await summary('carol', partnerA, tenantB)).status).toBe(403);
    // Tenant B is Partner B's customer: Partner A and Agency A still cannot reach it.
    await relate('dave', partnerB, 'bob', tenantB, 'white_label', ['summary']);
    expect((await summary('dave', partnerB, tenantB)).status).toBe(200);
    expect((await summary('carol', partnerA, tenantB)).status).toBe(403);
    expect((await summary('erin', agencyA, tenantB)).status).toBe(403);
    // Asking through another account's path does not help either.
    expect((await summary('carol', partnerB, tenantB)).status).toBe(403);
  });

  it('6. and 7. grants no company memory or conversations, and a scope the owner did not grant stays closed', async () => {
    const { call, acc, rel, tenantA, agencyA, relate } = await setup();
    // The agency asked for nothing: the owner accepts, and it sees that the customer exists only.
    await relate('erin', agencyA, 'alice', tenantA, 'agency', []);
    const customers = (await call('erin', 'GET', `${acc(agencyA)}/customers`)).body.customers;
    expect(customers).toEqual([
      { organizationId: tenantA, mode: 'agency', scopes: [], name: null },
    ]);
    expect((await call('erin', 'GET', `${acc(agencyA)}/customers/${tenantA}`)).status).toBe(403);
    // A commercial membership never opens the customer's own routes (memory, conversations).
    for (const path of ['brain', 'conversations', 'documents']) {
      expect((await call('erin', 'GET', `/v1/organizations/${tenantA}/${path}`)).status).toBe(403);
    }
    // The owner cannot grant more than was asked for.
    const list = (await call('alice', 'GET', rel(tenantA))).body.relationships as {
      updatedAt: string;
    }[];
    expect(
      (
        await call('alice', 'POST', `${rel(tenantA)}/${agencyA}/scopes`, {
          scopes: ['knowledge'],
          expectedUpdatedAt: list[0]?.updatedAt,
        })
      ).status,
    ).toBe(400);
  });

  it('9. the web cannot raise a role: support reads, only admins manage', async () => {
    const { call, acc, ids, tenantB, partnerA } = await setup();
    // Carol invites Frank as support and he accepts. Frank cannot add people, invite, or promote
    // himself.
    expect((await joinAccount(call, 'carol', partnerA, 'frank', 'partner.support')).status).toBe(
      200,
    );
    expect((await call('frank', 'GET', `${acc(partnerA)}/members`)).status).toBe(200);
    for (const [path, body] of [
      ['members', { userId: ids.frank, role: 'partner.admin' }],
      ['members', { userId: ids.bob, role: 'partner.support' }],
      ['customers', { organizationId: tenantB, mode: 'reseller', scopes: [] }],
    ] as const) {
      expect(await call('frank', 'POST', `${acc(partnerA)}/${path}`, body)).toEqual({
        status: 403,
        body: { error: 'permission_denied' },
      });
    }
    // A role of another kind of account, or an unknown one, is refused.
    for (const role of ['agency.admin', 'owner', 'platform.admin']) {
      expect(
        (await call('carol', 'POST', `${acc(partnerA)}/members`, { userId: ids.bob, role })).status,
      ).toBe(400);
    }
    // Nobody removes themselves or changes their own role.
    expect(
      (await call('carol', 'POST', `${acc(partnerA)}/members/${ids.carol}/revoke`)).status,
    ).toBe(409);
    // Revoked, Frank reaches nothing.
    await call('carol', 'POST', `${acc(partnerA)}/members/${ids.frank}/revoke`);
    expect((await call('frank', 'GET', acc(partnerA))).status).toBe(403);
  });

  it('keeps each account within its limits and one relationship per customer', async () => {
    const { call, acc, ids, tenantA, tenantB, stores } = await setup();
    const small = await call('alice', 'POST', '/v1/platform/commercial-accounts', {
      type: 'partner',
      name: 'Small',
      adminUserId: ids.carol,
      limits: { customers: 1, members: 1 },
    });
    const id = (small.body.account as { id: string }).id;
    const invite = (organizationId: string) =>
      call('carol', 'POST', `${acc(id)}/customers`, { organizationId, mode: 'reseller' });
    expect((await invite(tenantA)).status).toBe(201);
    expect(await invite(tenantA)).toEqual({ status: 409, body: { error: 'relationship_exists' } });
    expect(await invite(tenantB)).toEqual({
      status: 409,
      body: { error: 'commercial_limit_reached' },
    });
    expect(await joinAccount(call, 'carol', id, 'frank', 'partner.support')).toEqual({
      status: 409,
      body: { error: 'commercial_limit_reached' },
    });
    // A mode the account type does not use, an unknown organization.
    expect(
      (
        await call('carol', 'POST', `${acc(id)}/customers`, {
          organizationId: tenantB,
          mode: 'agency',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await call('carol', 'POST', `${acc(id)}/customers`, {
          organizationId: '99999999-9999-4999-8999-999999999999',
          mode: 'reseller',
        })
      ).status,
    ).toBe(403);
    const created = (await stores.auditEvents()).filter(
      (e) => e.action === 'customer_relationship.created',
    );
    expect(created).toContainEqual(
      expect.objectContaining({
        commercialAccountId: id,
        organizationId: tenantA,
        reference: 'reseller',
      }),
    );
  });

  it('lets only the owner decide, once, on the version they read; ending closes access', async () => {
    const { call, acc, rel, tenantA, tenantB, partnerA, stores } = await setup();
    await call('carol', 'POST', `${acc(partnerA)}/customers`, {
      organizationId: tenantA,
      mode: 'reseller',
      scopes: ['summary', 'usage'],
    });
    const [pending] = (await call('alice', 'GET', rel(tenantA))).body.relationships as {
      updatedAt: string;
      account: unknown;
    }[];
    expect(pending?.account).toEqual({ name: 'Partner A', type: 'partner' });
    // Bob, owner of another organization, cannot accept it; nor can the partner.
    expect((await call('bob', 'POST', `${rel(tenantA)}/${partnerA}/accept`, {})).status).toBe(403);
    expect((await call('carol', 'POST', `${rel(tenantA)}/${partnerA}/accept`, {})).status).toBe(
      403,
    );
    expect((await call('bob', 'POST', `${rel(tenantB)}/${partnerA}/accept`, {})).status).toBe(404);
    // A stale version is refused.
    expect(
      (
        await call('alice', 'POST', `${rel(tenantA)}/${partnerA}/accept`, {
          scopes: ['summary'],
          expectedUpdatedAt: '2000-01-01T00:00:00.000Z',
        })
      ).status,
    ).toBe(409);
    const accepted = await call('alice', 'POST', `${rel(tenantA)}/${partnerA}/accept`, {
      scopes: ['summary'],
      expectedUpdatedAt: pending?.updatedAt,
    });
    expect(accepted.body.relationship).toMatchObject({ status: 'active', scopes: ['summary'] });
    const updatedAt = (accepted.body.relationship as { updatedAt: string }).updatedAt;
    expect((await call('carol', 'GET', `${acc(partnerA)}/customers/${tenantA}`)).status).toBe(200);
    expect(
      (
        await call('alice', 'POST', `${rel(tenantA)}/${partnerA}/end`, {
          expectedUpdatedAt: updatedAt,
        })
      ).body.relationship,
    ).toMatchObject({ status: 'ended', scopes: [] });
    expect((await call('carol', 'GET', `${acc(partnerA)}/customers/${tenantA}`)).status).toBe(403);
    const updates = (await stores.auditEvents()).filter(
      (e) => e.action === 'customer_relationship.updated',
    );
    expect(updates.map((e) => e.transition)).toEqual([
      { from: 'pending', to: 'active' },
      { from: 'active', to: 'ended' },
    ]);
    expect(updates[0]).toMatchObject({ organizationId: tenantA, commercialAccountId: partnerA });
  });

  it('13. has no route that moves credits, and 15. keeps the platform administrator apart from owners', async () => {
    const { call, acc, partnerA, tenantA, relate } = await setup();
    await relate('carol', partnerA, 'alice', tenantA, 'reseller', ['summary', 'usage', 'billing']);
    for (const path of ['credits', 'credits/grant', 'wallet', 'billing']) {
      const response = await call(
        'carol',
        'POST',
        `${acc(partnerA)}/customers/${tenantA}/${path}`,
        {
          amount: 100,
        },
      );
      expect(response.status).toBe(404);
    }
    // Bob owns an organization but is no platform administrator.
    expect((await call('bob', 'GET', '/v1/platform/commercial-accounts')).status).toBe(403);
    // Alice is the platform administrator but no member of Partner A.
    expect((await call('alice', 'GET', acc(partnerA))).status).toBe(403);
  });

  it("reads a customer's AI usage and subscription only with its scopes, and never who used it or what it cost", async () => {
    const { call, ids, stores, acc, partnerA, relate, tenantA, tenantB } = await setup();
    await joinAccount(call, 'carol', partnerA, 'frank', 'partner.support');
    await relate('carol', partnerA, 'alice', tenantA, 'reseller', ['usage', 'billing']);
    await relate('carol', partnerA, 'bob', tenantB, 'reseller', ['summary']);
    const day = '2026-09-29';
    const engine = createAICostEngine();
    await createAIUsageLedger(stores.aiUsage).record({
      id: 'usage-1',
      occurredAt: `${day}T10:00:00.000Z`,
      attribution: { organizationId: tenantA as never, actor: 'user', userId: ids.alice as never },
      capability: 'llm',
      provider: 'deepseek',
      model: 'deepseek-chat',
      modelVersion: 'v1',
      operation: 'generate',
      outcome: 'completed',
      cost: engine.cost({
        capability: 'llm',
        provider: 'deepseek',
        model: 'deepseek-chat',
        operation: 'generate',
        pricing: { status: 'unknown' },
        usage: { quantities: [{ unit: 'input_tokens', quantity: 10 }] },
      }),
      credits: 2,
      source: 'test',
      requestId: 'req-usage-1',
    });
    const usage = `${acc(partnerA)}/customers/${tenantA}/usage?from=${day}&to=${day}`;
    for (const who of ['carol', 'frank']) {
      expect(await call(who, 'GET', usage)).toEqual({
        status: 200,
        body: {
          from: day,
          to: day,
          totals: { operations: 1, credits: 2 },
          byCapability: { llm: { operations: 1, credits: 2 } },
        },
      });
    }
    const billing = await call('carol', 'GET', `${acc(partnerA)}/customers/${tenantA}/billing`);
    expect(billing.status).toBe(200);
    expect(billing.body).toMatchObject({ billedTo: null });
    expect(Object.keys(billing.body)).toEqual(['billedTo', 'subscription']);
    // Support reads usage, never billing; a customer without the scope shows neither.
    expect(
      (await call('frank', 'GET', `${acc(partnerA)}/customers/${tenantA}/billing`)).body.error,
    ).toBe('customer_forbidden');
    for (const path of ['usage', 'billing']) {
      expect(
        (await call('carol', 'GET', `${acc(partnerA)}/customers/${tenantB}/${path}?from=${day}`))
          .body.error,
      ).toBe('customer_forbidden');
    }
    expect((await call('carol', 'GET', `${usage.split('?')[0]}?from=yesterday`)).status).toBe(400);
    const denied = (await stores.auditEvents()).filter(
      (e) => e.action === 'commercial.access' && e.permission === 'customer.read_billing',
    );
    expect(denied.map((e) => e.reason)).toEqual(['permission_denied', 'scope_not_granted']);
  });
});
