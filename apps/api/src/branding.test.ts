import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * Brands and domains (ADR-0087). Cases 10 and 11 are the brief's security tests; they run against
 * memory and, where the emulator runs, Firestore.
 *
 * People: Alice owns Tenant A and is the platform administrator. Bob owns Tenant B. Carol is
 * Partner A's admin, Dave Partner B's admin, Frank Partner A's support.
 */
type Body = Record<string, unknown> & { error?: string };

describe.each(STORES)('brands and domains with storage in %s', (_name, createStores) => {
  async function setup() {
    const stores: Stores = createStores();
    const first = setupApp(stores);
    const ids: Record<string, string> = {};
    for (const who of ['alice', 'bob', 'carol', 'dave', 'frank']) {
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
    /** What a page on this host shows, before anyone signs in. */
    const publicBrand = async (host: string) => {
      const response = await ctx.app.request(`/v1/public/brand?host=${encodeURIComponent(host)}`);
      expect(response.status).toBe(200);
      return (await response.json()) as { context: string; brand: Record<string, unknown> };
    };
    const org = async (who: string, name: string) =>
      ((await call(who, 'POST', '/v1/organizations', { name })).body.organization as { id: string })
        .id;
    const tenantA = await org('alice', 'Tenant A');
    const tenantB = await org('bob', 'Tenant B');
    const account = async (name: string, admin: string) =>
      (
        (
          await call('alice', 'POST', '/v1/platform/commercial-accounts', {
            type: 'partner',
            name,
            adminUserId: ids[admin],
            limits: { customers: 5, members: 3 },
          })
        ).body.account as { id: string }
      ).id;
    const partnerA = await account('Partner A', 'carol');
    const partnerB = await account('Partner B', 'dave');
    const acc = (id: string) => `/v1/commercial/accounts/${id}`;
    const members = await call('carol', 'GET', `${acc(partnerA)}/members`);
    expect(members.status).toBe(200);
    await call('carol', 'POST', `${acc(partnerA)}/members`, {
      userId: ids.frank,
      role: 'partner.support',
    });
    /** Invites a tenant and has its owner accept it with these scopes. */
    const relate = async (
      who: string,
      accountId: string,
      owner: string,
      tenant: string,
      mode: string,
      scopes: string[],
    ) => {
      expect(
        (
          await call(who, 'POST', `${acc(accountId)}/customers`, {
            organizationId: tenant,
            mode,
            scopes,
          })
        ).status,
      ).toBe(201);
      const rel = `/v1/organizations/${tenant}/commercial-relationships`;
      const pending = (await call(owner, 'GET', rel)).body.relationships as {
        commercialAccountId: string;
        updatedAt: string;
      }[];
      const mine = pending.find((r) => r.commercialAccountId === accountId);
      expect(
        (
          await call(owner, 'POST', `${rel}/${accountId}/accept`, {
            scopes,
            expectedUpdatedAt: mine?.updatedAt,
          })
        ).status,
      ).toBe(200);
    };
    const brandOf = async (who: string, tenant: string) =>
      (await call(who, 'GET', `/v1/organizations/${tenant}/brand`)).body;
    return {
      ...ctx,
      stores,
      ids,
      call,
      publicBrand,
      tenantA,
      tenantB,
      partnerA,
      partnerB,
      acc,
      relate,
      brandOf,
    };
  }

  it("lets an organization's owner change only its own brand, checked, versioned and audited", async () => {
    const { call, stores, tenantA, tenantB, brandOf } = await setup();
    const before = await brandOf('alice', tenantA);
    expect(before).toMatchObject({
      brand: { brandName: 'MelonOffice', assistantName: 'GIA' },
      own: null,
      updatedAt: null,
    });
    const path = `/v1/organizations/${tenantA}/brand`;
    const saved = await call('alice', 'PUT', path, {
      config: { brandName: 'Casa Alice', primaryColor: '#123ABC', country: 'PE' },
      expectedUpdatedAt: null,
    });
    expect(saved.status).toBe(200);
    expect(saved.body.config).toEqual({
      brandName: 'Casa Alice',
      primaryColor: '#123abc',
      country: 'PE',
    });
    expect((await brandOf('alice', tenantA)).brand).toMatchObject({
      brandName: 'Casa Alice',
      productName: 'MelonOffice',
      primaryColor: '#123abc',
    });
    // A stale version, an unknown field and a bad value are refused, naming the field only.
    expect(
      (await call('alice', 'PUT', path, { config: { brandName: 'X' }, expectedUpdatedAt: null }))
        .status,
    ).toBe(409);
    for (const [config, field] of [
      [{ theme: 'dark' }, 'theme'],
      [{ logoUrl: 'http://logo.example/a.png' }, 'logoUrl'],
      [{ logoUrl: 'https://user:pw@logo.example/a.png' }, 'logoUrl'],
      [{ primaryColor: 'red' }, 'primaryColor'],
      [{ currency: 'XXXX' }, 'currency'],
      [{ login: { title: 'Hi', script: '<b>' } }, 'login.script'],
    ] as const) {
      expect(
        await call('alice', 'PUT', path, { config, expectedUpdatedAt: saved.body.updatedAt }),
      ).toEqual({ status: 400, body: { error: 'invalid_brand_config', field } });
    }
    // Another organization's owner cannot read or change it.
    expect((await call('bob', 'GET', path)).status).toBe(403);
    expect(
      (await call('bob', 'PUT', path, { config: { brandName: 'Mine' }, expectedUpdatedAt: null }))
        .status,
    ).toBe(403);
    expect((await brandOf('bob', tenantB)).brand).toMatchObject({ brandName: 'MelonOffice' });
    const events = await stores.auditEvents();
    expect(events.filter((e) => e.action === 'brand_config.updated')).toEqual([
      expect.objectContaining({
        organizationId: tenantA,
        reference: 'organization',
        target: { type: 'brand_config', id: `organization_${tenantA}` },
      }),
    ]);
  });

  it("lets only a partner's admin change the partner's own brand, which applies only to its white-label customers", async () => {
    const { call, acc, partnerA, relate, tenantA, tenantB, brandOf } = await setup();
    const path = `${acc(partnerA)}/brand`;
    const config = { brandName: 'Partner A Suite', productName: 'A Office', assistantName: 'Ava' };
    expect((await call('frank', 'PUT', path, { config, expectedUpdatedAt: null })).body.error).toBe(
      'permission_denied',
    );
    expect((await call('dave', 'PUT', path, { config, expectedUpdatedAt: null })).body.error).toBe(
      'commercial_account_forbidden',
    );
    expect((await call('bob', 'PUT', path, { config, expectedUpdatedAt: null })).body.error).toBe(
      'commercial_account_forbidden',
    );
    // A partner never sets the customer's facts.
    expect(
      await call('carol', 'PUT', path, { config: { timeZone: 'UTC' }, expectedUpdatedAt: null }),
    ).toEqual({ status: 400, body: { error: 'invalid_brand_config', field: 'timeZone' } });
    expect((await call('carol', 'PUT', path, { config, expectedUpdatedAt: null })).status).toBe(
      200,
    );
    expect((await call('frank', 'GET', path)).body.brand).toMatchObject(config);
    // A reseller customer keeps MelonOffice's brand; a white-label customer shows the partner's.
    await relate('carol', partnerA, 'bob', tenantB, 'reseller', ['summary']);
    expect((await brandOf('bob', tenantB)).brand).toMatchObject({ brandName: 'MelonOffice' });
    await relate('carol', partnerA, 'alice', tenantA, 'white_label', []);
    const a = await brandOf('alice', tenantA);
    expect(a.brand).toMatchObject(config);
    expect(a.levels).toEqual(['commercial_account']);
  });

  it('10. White Label A cannot modify White Label B', async () => {
    const { call, acc, partnerA, partnerB, relate, tenantA, tenantB, brandOf, stores } =
      await setup();
    await relate('carol', partnerA, 'alice', tenantA, 'white_label', ['branding']);
    await relate('dave', partnerB, 'bob', tenantB, 'white_label', ['branding']);
    const forA = `${acc(partnerA)}/customers/${tenantA}/brand`;
    const forB = `${acc(partnerB)}/customers/${tenantB}/brand`;
    const set = (who: string, path: string, brandName: string) =>
      call(who, 'PUT', path, { config: { brandName }, expectedUpdatedAt: null });
    expect((await set('dave', forB, 'White Label B')).status).toBe(200);
    // Partner A's admin, through its own account or Partner B's, never reaches Tenant B.
    expect(
      (await set('carol', `${acc(partnerA)}/customers/${tenantB}/brand`, 'Taken')).body.error,
    ).toBe('customer_forbidden');
    expect((await set('carol', forB, 'Taken')).body.error).toBe('commercial_account_forbidden');
    expect((await call('carol', 'GET', forB)).status).toBe(403);
    // Nor its support person, nor Tenant A's owner, nor Tenant B's owner through the partner path.
    expect((await set('frank', forA, 'Support')).status).toBe(403);
    expect((await set('bob', forB, 'Owner')).status).toBe(403);
    expect((await set('carol', forA, 'White Label A')).status).toBe(200);
    expect((await brandOf('alice', tenantA)).brand).toMatchObject({ brandName: 'White Label A' });
    expect((await brandOf('bob', tenantB)).brand).toMatchObject({ brandName: 'White Label B' });
    expect(
      (await stores.auditEvents()).filter(
        (e) => e.action === 'commercial.access' && e.permission === 'customer.manage_brand',
      ),
    ).not.toHaveLength(0);
  });

  it("changes a customer's brand only when it is white label and grants branding", async () => {
    const { call, acc, partnerA, relate, tenantA, tenantB, brandOf } = await setup();
    await relate('carol', partnerA, 'alice', tenantA, 'white_label', ['summary']);
    await relate('carol', partnerA, 'bob', tenantB, 'reseller', ['branding']);
    const set = (tenant: string, config: unknown) =>
      call('carol', 'PUT', `${acc(partnerA)}/customers/${tenant}/brand`, {
        config,
        expectedUpdatedAt: null,
      });
    expect((await set(tenantA, { brandName: 'X' })).body.error).toBe('customer_forbidden');
    expect((await set(tenantB, { brandName: 'X' })).body.error).toBe('customer_forbidden');
    expect(await brandOf('bob', tenantB)).toMatchObject({ brand: { brandName: 'MelonOffice' } });
    // The owner grants branding: the partner sets presentation, never the customer's facts.
    const rel = `/v1/organizations/${tenantA}/commercial-relationships`;
    const current = (await call('alice', 'GET', rel)).body.relationships as {
      updatedAt: string;
    }[];
    expect(
      (
        await call('alice', 'POST', `${rel}/${partnerA}/end`, {
          expectedUpdatedAt: current[0]?.updatedAt,
        })
      ).status,
    ).toBe(200);
    expect((await set(tenantA, { brandName: 'X' })).status).toBe(403);
  });

  it('11. Domain A cannot resolve to Tenant B', async () => {
    const { call, publicBrand, tenantA, tenantB, stores } = await setup();
    await call('alice', 'PUT', `/v1/organizations/${tenantA}/brand`, {
      config: { brandName: 'Brand A', company: { legalName: 'A S.A.C.' } },
      expectedUpdatedAt: null,
    });
    await call('bob', 'PUT', `/v1/organizations/${tenantB}/brand`, {
      config: { brandName: 'Brand B' },
      expectedUpdatedAt: null,
    });
    const created = await call('alice', 'POST', '/v1/platform/domain-bindings', {
      hostname: 'App.A-Customer.example',
      target: { type: 'organization', organizationId: tenantA },
    });
    expect(created.status).toBe(201);
    const host = 'app.a-customer.example';
    const status = async (to: string) => {
      const list = (await call('alice', 'GET', '/v1/platform/domain-bindings')).body.domains as {
        hostname: string;
        updatedAt: string;
      }[];
      const current = list.find((d) => d.hostname === host);
      return call('alice', 'POST', `/v1/platform/domain-bindings/${host}/status`, {
        status: to,
        expectedUpdatedAt: current?.updatedAt,
      });
    };
    // Nothing resolves until the domain is active, and it cannot skip verification.
    expect((await publicBrand(host)).context).toBe('platform');
    expect((await status('active')).body.error).toBe('invalid_domain_transition');
    expect((await status('verified')).status).toBe(200);
    expect((await publicBrand(host)).context).toBe('platform');
    expect((await status('active')).status).toBe(200);
    const resolved = await publicBrand('APP.a-customer.example');
    expect(resolved).toMatchObject({ context: 'organization', brand: { brandName: 'Brand A' } });
    // The public answer carries no id and no company fact.
    expect(JSON.stringify(resolved)).not.toContain(tenantA);
    expect(JSON.stringify(resolved)).not.toContain('A S.A.C.');
    // The hostname is taken: nobody binds it to Tenant B, and a lookalike resolves to nothing.
    expect(
      (
        await call('alice', 'POST', '/v1/platform/domain-bindings', {
          hostname: host,
          target: { type: 'organization', organizationId: tenantB },
        })
      ).body.error,
    ).toBe('domain_exists');
    for (const other of ['a-customer.example', 'app.a-customer.example.evil.example', '1.2.3.4']) {
      expect((await publicBrand(other)).brand).toMatchObject({ brandName: 'MelonOffice' });
    }
    // A resolved domain grants nothing: Tenant B's owner still cannot reach Tenant A.
    expect((await call('bob', 'GET', `/v1/organizations/${tenantA}`)).status).toBe(403);
    expect((await call('bob', 'GET', `/v1/organizations/${tenantA}/brand`)).status).toBe(403);
    // Disabled, it resolves to nothing again.
    expect((await status('disabled')).status).toBe(200);
    expect((await publicBrand(host)).context).toBe('platform');
    const events = (await stores.auditEvents()).filter((e) =>
      e.action.startsWith('domain_binding.'),
    );
    expect(events.map((e) => [e.action, e.transition?.to ?? null])).toEqual([
      ['domain_binding.created', null],
      ['domain_binding.status_changed', 'verified'],
      ['domain_binding.status_changed', 'active'],
      ['domain_binding.status_changed', 'disabled'],
    ]);
  });

  it('lets only the platform administrator register domains, audited, for an active target', async () => {
    const { call, tenantA, partnerA, stores } = await setup();
    const request = {
      hostname: 'partner-a.example',
      target: { type: 'commercial_account', commercialAccountId: partnerA },
    };
    expect(await call('carol', 'POST', '/v1/platform/domain-bindings', request)).toEqual({
      status: 403,
      body: { error: 'platform_forbidden' },
    });
    expect((await call('bob', 'GET', '/v1/platform/domain-bindings')).status).toBe(403);
    for (const bad of [
      { ...request, hostname: 'localhost' },
      { ...request, hostname: 'a..example' },
      { ...request, hostname: 'x.example:8080' },
      {
        ...request,
        target: { type: 'organization', organizationId: tenantA, commercialAccountId: partnerA },
      },
      {
        ...request,
        target: { type: 'organization', organizationId: '00000000-0000-4000-8000-000000000000' },
      },
    ]) {
      expect((await call('alice', 'POST', '/v1/platform/domain-bindings', bad)).status).toBe(400);
    }
    expect((await call('alice', 'POST', '/v1/platform/domain-bindings', request)).status).toBe(201);
    expect(
      (await stores.auditEvents())
        .filter((e) => e.action === 'domain_binding.created')
        .map((e) => e.result),
    ).toEqual(['denied', 'success']);
  });
});
