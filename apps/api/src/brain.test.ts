import type { OrganizationId } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

describe.each(STORES)('Company Brain with storage in %s (ADR-0051)', (_name, createStores) => {
  async function setup() {
    const stores: Stores = createStores();
    const ctx = setupApp(stores);
    await ctx.register('token-alice');
    await ctx.register('token-bob');
    const call = async (token: string, path: string, init: RequestInit = {}) => {
      const response = await ctx.app.request(path, ctx.as(token, init));
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const post = (token: string, path: string, body: unknown) =>
      call(token, path, {
        method: path.endsWith('business-profile') ? 'PUT' : 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const create = async (token: string, name: string) =>
      ((await post(token, '/v1/organizations', { name })).body.organization as { id: string })
        .id as OrganizationId;
    const orgA = await create('token-alice', 'Pollería X');
    const orgB = await create('token-bob', 'Tienda B');
    const brain = (org: string) => `/v1/organizations/${org}/brain`;
    return { ...ctx, stores, orgA, orgB, call, post, brain };
  }

  const price = (soles: number) => ({
    domain: 'products',
    key: 'price',
    subject: { type: 'product', id: 'combo_familiar' },
    label: 'Combo Familiar',
    value: { type: 'money', amountMinor: soles * 100, currency: 'PEN' },
  });

  it('starts every new organization with its name, as its owner gave it', async () => {
    const { call, brain, orgA } = await setup();
    const { status, body } = await call('token-alice', brain(orgA));
    expect(status).toBe(200);
    expect(body).toMatchObject({ initialized: true, items: 1, byDomain: { identity: 1 } });
    const list = await call('token-alice', `${brain(orgA)}/knowledge`);
    expect(list.body.items).toEqual([
      expect.objectContaining({
        key: 'commercial_name',
        value: { type: 'text', text: 'Pollería X' },
        verification: 'confirmed',
        source: expect.objectContaining({ type: 'user', recordedBy: 'you' }),
      }),
    ]);
  });

  it('feeds the business profile in as confirmed facts, and syncs what MelonOffice knows', async () => {
    const { call, post, brain, orgA } = await setup();
    await post('token-alice', `/v1/organizations/${orgA}/business-profile`, {
      businessType: 'restaurant',
      country: 'PE',
      currency: 'PEN',
      timeZone: 'America/Lima',
      city: 'Lima',
      offering: 'Pollo a la brasa',
    });
    const identity = await call('token-alice', `${brain(orgA)}/knowledge?domain=identity`);
    const keys = (identity.body.items as { key: string }[]).map((i) => i.key).sort();
    expect(keys).toEqual(['business_type', 'city', 'commercial_name', 'country', 'time_zone']);
    const sync = await post('token-alice', `${brain(orgA)}/sync`, {});
    expect(sync.status).toBe(200);
    const team = await call('token-alice', `${brain(orgA)}/knowledge?domain=team`);
    expect(team.body.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'departments', verification: 'calculated' }),
        expect.objectContaining({ key: 'agents', value: { type: 'number', number: 0 } }),
      ]),
    );
    // Syncing again changes nothing.
    expect((await post('token-alice', `${brain(orgA)}/sync`, {})).body).toEqual({ changed: 0 });
  });

  it('versions a change, keeps the old price and audits without the value', async () => {
    const { call, post, brain, orgA, stores } = await setup();
    const created = await post('token-alice', `${brain(orgA)}/knowledge`, price(25));
    expect(created).toMatchObject({ status: 200, body: { outcome: 'created', revision: 1 } });
    const itemId = created.body.itemId as string;
    await post('token-alice', `${brain(orgA)}/knowledge`, price(28));
    const { body } = await call('token-alice', `${brain(orgA)}/knowledge/${itemId}`);
    expect(body.item).toMatchObject({ value: { amountMinor: 2800 }, revision: 2 });
    expect(
      (body.versions as { value: { amountMinor: number } }[]).map((v) => v.value.amountMinor),
    ).toEqual([2500, 2800]);
    const events = await stores.auditReader.query({
      organizationId: orgA,
      actions: ['knowledge.created', 'knowledge.updated'],
      from: new Date(0),
      to: new Date(Date.now() + 60_000),
      limit: 50,
    });
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(['knowledge.created', 'knowledge.updated']),
    );
    expect(JSON.stringify(events)).not.toContain('2800');
    // Invalidating needs the current revision.
    expect(
      (await post('token-alice', `${brain(orgA)}/knowledge/${itemId}/invalidate`, { revision: 1 }))
        .status,
    ).toBe(409);
    const invalidated = await post('token-alice', `${brain(orgA)}/knowledge/${itemId}/invalidate`, {
      revision: 2,
      reason: 'price_withdrawn',
    });
    expect(invalidated.status).toBe(200);
  });

  it('refuses bad input with the field, and unknown items with 404', async () => {
    const { call, post, brain, orgA } = await setup();
    const bad = await post('token-alice', `${brain(orgA)}/knowledge`, { ...price(1), domain: 'x' });
    expect(bad).toEqual({ status: 400, body: { error: 'invalid_knowledge', field: 'domain' } });
    expect((await call('token-alice', `${brain(orgA)}/knowledge/nope`)).status).toBe(404);
  });

  it('shows a conflict, and a person decides it', async () => {
    const { call, post, brain, orgA, stores } = await setup();
    const { body } = await post('token-alice', `${brain(orgA)}/knowledge`, price(30));
    // A CRM says otherwise (through the service, as an integration would).
    const tenantFacts = await stores.knowledge.findItem(orgA, body.itemId as string);
    expect(tenantFacts?.verification).toBe('confirmed');
    const { createCompanyBrain } = await import('@melonoffice/brain');
    const { resolveTenant } = await import('@melonoffice/tenancy');
    const { createAuthorizationService } = await import('@melonoffice/rbac');
    const service = createCompanyBrain({
      repository: stores.knowledge,
      organizations: stores.tenancy,
      authorization: createAuthorizationService(),
    });
    const owner = (await call('token-alice', '/v1/me')).body as { userId: string };
    const tenant = await resolveTenant(
      { actor: 'user', userId: owner.userId as never, emailVerified: true },
      orgA,
      stores.tenancy,
    );
    await service.ingest(tenant, { type: 'crm', id: 'conn_1' }, [price(28)]);
    const conflicts = await call('token-alice', `${brain(orgA)}/conflicts`);
    const [conflict] = conflicts.body.conflicts as {
      id: string;
      current: { source: string };
      candidate: { source: string; value: { amountMinor: number } };
    }[];
    expect(conflict).toMatchObject({
      label: 'Combo Familiar',
      current: { source: 'user' },
      candidate: { source: 'crm', value: { amountMinor: 2800 } },
    });
    expect((await call('token-alice', `${brain(orgA)}/gaps`)).body.openConflicts).toBe(1);
    const resolved = await post('token-alice', `${brain(orgA)}/conflicts/${conflict?.id}/resolve`, {
      choice: 'kept_current',
    });
    expect(resolved.status).toBe(200);
    expect((await call('token-alice', `${brain(orgA)}/conflicts`)).body.conflicts).toEqual([]);
  });

  it('retrieves only what a department may see and what matches', async () => {
    const { post, brain, orgA } = await setup();
    await post('token-alice', `${brain(orgA)}/knowledge`, price(28));
    await post('token-alice', `${brain(orgA)}/knowledge`, { ...price(12), key: 'cost' });
    await post('token-alice', `${brain(orgA)}/knowledge`, {
      domain: 'brand',
      key: 'tone_of_voice',
      value: { type: 'text', text: 'cercano' },
    });
    const marketing = await post('token-alice', `${brain(orgA)}/context`, {
      purpose: 'marketing',
      query: 'combo familiar',
    });
    expect(
      (marketing.body.facts as { key: string; value: string }[]).map((f) => [f.key, f.value]),
    ).toEqual([['price', '28.00 PEN']]);
    const gia = await post('token-alice', `${brain(orgA)}/context`, {
      purpose: 'gia',
      domains: ['brand'],
    });
    expect((gia.body.facts as { key: string }[]).map((f) => f.key)).toEqual(['tone_of_voice']);
  });

  it("keeps each organization's brain to itself", async () => {
    const { call, post, brain, orgA, orgB } = await setup();
    const { body } = await post('token-alice', `${brain(orgA)}/knowledge`, price(28));
    expect((await call('token-bob', brain(orgA))).status).toBe(403);
    expect(
      (await call('token-bob', `${brain(orgB)}/knowledge/${body.itemId as string}`)).status,
    ).toBe(404);
    const bobs = await call('token-bob', `${brain(orgB)}/knowledge`);
    expect((bobs.body.items as { key: string }[]).map((i) => i.key)).toEqual(['commercial_name']);
  });

  it('keeps a document and says when extraction is not available', async () => {
    const { post, brain, orgA } = await setup();
    const result = await post('token-alice', `${brain(orgA)}/documents`, {
      name: 'Carta.txt',
      text: 'Combo Familiar S/45',
    });
    expect(result.status).toBe(200);
    expect(result.body).toMatchObject({
      extraction: 'unavailable',
      document: { name: 'Carta.txt', status: 'stored', characters: 19 },
    });
    expect(result.body.document).not.toHaveProperty('text');
    const capture = await post('token-alice', `${brain(orgA)}/capture`, {
      text: 'Tenemos una pollería',
    });
    expect(capture.status).toBe(200);
    expect(capture.body).toMatchObject({ extraction: 'unavailable', outcomes: [] });
  });
});
