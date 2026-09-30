import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * White label → resellers → customers (ADR-0098), against memory and, where the emulator runs,
 * Firestore. Alice is the platform administrator. Carol runs White Label A, Dave White Label B.
 * Frank becomes the admin of Carol's Reseller 1 and Erin of her Reseller 2. Heidi owns Company H,
 * a customer of Reseller 1; Ivan owns Company I, a customer of Reseller 2.
 */
type Body = Record<string, unknown> & { error?: string };

describe.each(STORES)('white labels and their resellers with storage in %s', (_name, create) => {
  async function setup() {
    const stores: Stores = create();
    const first = setupApp(stores);
    const ids: Record<string, string> = {};
    for (const who of ['alice', 'carol', 'dave', 'erin', 'frank', 'heidi', 'ivan']) {
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
    const acc = (id: string) => `/v1/commercial/accounts/${id}`;
    const whiteLabel = async (name: string, admin: string) => {
      const created = await call('alice', 'POST', '/v1/platform/commercial-accounts', {
        type: 'white_label',
        name,
        adminUserId: ids[admin],
        limits: { customers: 5, members: 3, resellers: 2 },
      });
      expect(created.status).toBe(201);
      return created.body.account as { id: string; updatedAt: string };
    };
    const wlA = await whiteLabel('Acme AI', 'carol');
    const wlB = await whiteLabel('Beta AI', 'dave');
    /** Carol creates a reseller and its admin accepts the link. */
    const reseller = async (name: string, admin: string) => {
      const created = await call('carol', 'POST', `${acc(wlA.id)}/resellers`, {
        name,
        adminEmail: `${admin}@example.com`,
        limits: { customers: 2, members: 2 },
      });
      expect(created.status).toBe(201);
      const token = created.body.token;
      const looked = await call(admin, 'POST', '/v1/member-invitations/lookup', { token });
      const joined = await call(admin, 'POST', '/v1/member-invitations/accept', {
        token,
        expectedUpdatedAt: (looked.body.invitation as { updatedAt: string }).updatedAt,
      });
      expect(joined.status).toBe(200);
      return created.body.reseller as { id: string; updatedAt: string };
    };
    const org = async (who: string, name: string) =>
      ((await call(who, 'POST', '/v1/organizations', { name })).body.organization as { id: string })
        .id;
    /** A reseller asks a company to be its customer and the owner grants `summary`. */
    const serve = async (who: string, accountId: string, owner: string, tenant: string) => {
      const asked = await call(who, 'POST', `${acc(accountId)}/customers`, {
        organizationId: tenant,
        mode: 'white_label',
        scopes: ['summary', 'branding'],
      });
      expect(asked.status).toBe(201);
      const rel = `/v1/organizations/${tenant}/commercial-relationships`;
      const pending = (await call(owner, 'GET', rel)).body.relationships as {
        commercialAccountId: string;
        updatedAt: string;
      }[];
      const accepted = await call(owner, 'POST', `${rel}/${accountId}/accept`, {
        scopes: ['summary', 'branding'],
        expectedUpdatedAt: pending.find((r) => r.commercialAccountId === accountId)?.updatedAt,
      });
      expect(accepted.status).toBe(200);
    };
    return { stores, ids, call, acc, wlA, wlB, reseller, org, serve };
  }

  it('a white label creates its resellers; each admin joins only by accepting the link', async () => {
    const { call, acc, wlA, reseller, stores } = await setup();
    const r1 = await reseller('Reseller 1', 'frank');
    expect(r1).toMatchObject({ parentAccountId: wlA.id, type: 'reseller', status: 'active' });
    // Frank works in Reseller 1, and sees it as a reseller of Acme AI.
    const mine = (await call('frank', 'GET', '/v1/commercial/accounts')).body.accounts;
    expect(mine).toEqual([
      expect.objectContaining({ id: r1.id, role: 'reseller.admin', parentAccountId: wlA.id }),
    ]);
    // Carol sees her reseller, its customers count and no pending admin any more.
    const listed = await call('carol', 'GET', `${acc(wlA.id)}/resellers`);
    expect(listed.body).toMatchObject({
      limit: 2,
      resellers: [{ id: r1.id, name: 'Reseller 1', customers: 0, pendingAdmins: [] }],
    });
    // Created with the invitation, in one audited step; the secret is never recorded.
    const events = await stores.auditEvents();
    expect(events.filter((e) => e.action === 'commercial_account.created').at(-1)).toMatchObject({
      commercialAccountId: r1.id,
      reference: `reseller_of:${wlA.id}`,
    });
    expect(JSON.stringify(events)).not.toContain('frank@example.com');
  });

  it('keeps white labels, resellers and customers apart', async () => {
    const { call, acc, wlA, wlB, reseller, org, serve } = await setup();
    const r1 = await reseller('Reseller 1', 'frank');
    const r2 = await reseller('Reseller 2', 'erin');
    const companyH = await org('heidi', 'Company H');
    const companyI = await org('ivan', 'Company I');
    await serve('frank', r1.id, 'heidi', companyH);
    await serve('erin', r2.id, 'ivan', companyI);
    const forbidden = { status: 403, body: { error: 'commercial_account_forbidden' } };

    // White Label B sees none of A's resellers and cannot touch them.
    expect((await call('dave', 'GET', `${acc(wlB.id)}/resellers`)).body.resellers).toEqual([]);
    expect(
      await call('dave', 'POST', `${acc(wlB.id)}/resellers/${r1.id}/status`, {
        status: 'suspended',
        expectedUpdatedAt: r1.updatedAt,
      }),
    ).toEqual(forbidden);
    expect(await call('dave', 'GET', `${acc(wlA.id)}/resellers`)).toEqual(forbidden);
    expect(await call('dave', 'GET', acc(r1.id))).toEqual(forbidden);

    // Reseller 1 never reaches Reseller 2, its customer, or the white label's own routes.
    expect(await call('frank', 'GET', acc(r2.id))).toEqual(forbidden);
    expect(await call('frank', 'GET', `${acc(r2.id)}/customers/${companyI}`)).toEqual(forbidden);
    expect((await call('frank', 'GET', `${acc(r1.id)}/customers/${companyI}`)).status).toBe(403);
    expect(await call('frank', 'GET', acc(wlA.id))).toEqual(forbidden);
    expect(await call('frank', 'GET', `${acc(r1.id)}/resellers`)).toEqual(forbidden);
    expect(
      (
        await call('frank', 'POST', `${acc(r1.id)}/resellers`, {
          name: 'Sub',
          adminEmail: 'x@example.com',
          limits: { customers: 1, members: 1 },
        })
      ).body,
    ).toEqual({ error: 'permission_denied' });
    // …and Reseller 2 never reaches Reseller 1's customer.
    expect((await call('erin', 'GET', `${acc(r2.id)}/customers/${companyH}`)).status).toBe(403);

    // Each reseller reads only what its own customer granted it.
    expect((await call('frank', 'GET', `${acc(r1.id)}/customers/${companyH}`)).status).toBe(200);
    // The white label administers its resellers, but its customers' data is not its own: Company
    // H granted its scopes to Reseller 1 only.
    expect((await call('carol', 'GET', `${acc(wlA.id)}/customers/${companyH}`)).status).toBe(403);
    const listed = (await call('carol', 'GET', `${acc(wlA.id)}/resellers`)).body.resellers as {
      id: string;
      customers: number;
    }[];
    expect(listed.map((r) => [r.id, r.customers])).toEqual(
      expect.arrayContaining([
        [r1.id, 1],
        [r2.id, 1],
      ]),
    );
    expect(JSON.stringify(listed)).not.toContain('Company');

    // One customer never reaches another: Heidi's membership opens only Company H.
    expect((await call('heidi', 'GET', `/v1/organizations/${companyI}/brand`)).status).toBe(403);
    expect((await call('ivan', 'GET', `/v1/organizations/${companyH}/brand`)).status).toBe(403);
  });

  it("a reseller's customers show the white label's brand, and only while it is active", async () => {
    const { call, acc, wlA, reseller, org, serve } = await setup();
    const r1 = await reseller('Reseller 1', 'frank');
    const companyH = await org('heidi', 'Company H');
    await serve('frank', r1.id, 'heidi', companyH);
    const saved = await call('carol', 'PUT', `${acc(wlA.id)}/brand`, {
      config: { brandName: 'Acme AI', productName: 'Acme Office' },
      expectedUpdatedAt: null,
    });
    expect(saved.status).toBe(200);
    const brand = async () =>
      (
        (await call('heidi', 'GET', `/v1/organizations/${companyH}/brand`)).body.brand as {
          productName: string;
        }
      ).productName;
    expect(await brand()).toBe('Acme Office');
    // The platform suspends the white label: its resellers stop, and its brand no longer shows.
    const suspended = await call(
      'alice',
      'POST',
      `/v1/platform/commercial-accounts/${wlA.id}/status`,
      { status: 'suspended', expectedUpdatedAt: wlA.updatedAt },
    );
    expect(suspended.status).toBe(200);
    expect(await brand()).toBe('MelonOffice');
    expect((await call('frank', 'GET', acc(r1.id))).status).toBe(403);
    expect((await call('frank', 'GET', '/v1/commercial/accounts')).body.accounts).toEqual([]);
  });

  it('suspends and reactivates its own resellers, within its limits', async () => {
    const { call, acc, wlA, reseller } = await setup();
    const r1 = await reseller('Reseller 1', 'frank');
    const suspend = await call('carol', 'POST', `${acc(wlA.id)}/resellers/${r1.id}/status`, {
      status: 'suspended',
      expectedUpdatedAt: r1.updatedAt,
    });
    expect(suspend.body.reseller).toMatchObject({ status: 'suspended' });
    expect((await call('frank', 'GET', acc(r1.id))).status).toBe(403);
    // A stale version and closing are refused; closing is the platform's.
    expect(
      (
        await call('carol', 'POST', `${acc(wlA.id)}/resellers/${r1.id}/status`, {
          status: 'active',
          expectedUpdatedAt: r1.updatedAt,
        })
      ).body,
    ).toEqual({ error: 'commercial_conflict' });
    expect(
      (
        await call('carol', 'POST', `${acc(wlA.id)}/resellers/${r1.id}/status`, {
          status: 'closed',
          expectedUpdatedAt: (suspend.body.reseller as { updatedAt: string }).updatedAt,
        })
      ).status,
    ).toBe(400);
    const back = await call('carol', 'POST', `${acc(wlA.id)}/resellers/${r1.id}/status`, {
      status: 'active',
      expectedUpdatedAt: (suspend.body.reseller as { updatedAt: string }).updatedAt,
    });
    expect(back.body.reseller).toMatchObject({ status: 'active' });
    expect((await call('frank', 'GET', acc(r1.id))).status).toBe(200);

    // Never above the white label's own limits, and never more resellers than it may have.
    const create = (limits: unknown, email = 'x@example.com') =>
      call('carol', 'POST', `${acc(wlA.id)}/resellers`, {
        name: 'Another',
        adminEmail: email,
        limits,
      });
    expect((await create({ customers: 6, members: 1 })).body).toEqual({
      error: 'invalid_commercial_request',
      field: 'limits',
    });
    expect((await create({ customers: 1, members: 1 })).status).toBe(201);
    expect((await create({ customers: 1, members: 1 }, 'y@example.com')).body).toEqual({
      error: 'commercial_limit_reached',
    });
  });

  it('serves each kind of account in its own way', async () => {
    const { call, acc, ids, reseller, org } = await setup();
    const r1 = await reseller('Reseller 1', 'frank');
    const companyH = await org('heidi', 'Company H');
    // Under a white label, a reseller serves in white label only.
    const ask = (who: string, accountId: string, mode: string) =>
      call(who, 'POST', `${acc(accountId)}/customers`, {
        organizationId: companyH,
        mode,
        scopes: [],
      });
    expect((await ask('frank', r1.id, 'reseller')).body).toMatchObject({ field: 'mode' });
    // A reseller alone serves under MelonOffice, never in white label.
    const alone = await call('alice', 'POST', '/v1/platform/commercial-accounts', {
      type: 'reseller',
      name: 'Solo Reseller',
      adminUserId: ids.ivan,
      limits: { customers: 2, members: 2 },
    });
    expect(alone.body.account).toMatchObject({ type: 'reseller', parentAccountId: null });
    const solo = (alone.body.account as { id: string }).id;
    expect((await ask('ivan', solo, 'white_label')).body).toMatchObject({ field: 'mode' });
    expect((await ask('ivan', solo, 'reseller')).status).toBe(201);
    // It has no resellers of its own.
    expect((await call('ivan', 'GET', `${acc(solo)}/resellers`)).status).toBe(403);
    // A white label needs a reseller limit from the platform.
    expect(
      (
        await call('alice', 'POST', '/v1/platform/commercial-accounts', {
          type: 'white_label',
          name: 'No limit',
          adminUserId: ids.ivan,
          limits: { customers: 2, members: 2 },
        })
      ).body,
    ).toEqual({ error: 'invalid_commercial_request', field: 'limits' });
  });
});
