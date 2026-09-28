import { createAuditService, InMemoryAuditStore } from '@melonoffice/audit';
import { InMemoryUserDirectory } from '@melonoffice/auth';
import type { OrganizationId } from '@melonoffice/domain';
import { createLogger } from '@melonoffice/observability';
import { InMemoryTenancyStore } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { setupApp, STORES, verifier, type Stores } from './test-api.js';

const MISSING_ORG = '99999999-9999-4999-8999-999999999999';

const VALID = {
  businessType: 'restaurant',
  country: 'PE',
  currency: 'PEN',
  timeZone: 'America/Lima',
  city: 'Lima',
  employees: '6_10',
  salesChannels: ['whatsapp', 'physical_store'],
  offering: 'Pollos a la brasa',
  needs: 'Más pedidos por WhatsApp',
  notes: 'Abrimos de martes a domingo',
};

describe.each(STORES)('business profile with storage in %s', (_name, createStores) => {
  async function setup() {
    const stores: Stores = createStores();
    const ctx = setupApp(stores);
    await ctx.register('token-alice');
    await ctx.register('token-bob');
    const create = async (token: string, name: string) =>
      (
        (await (
          await ctx.app.request(
            '/v1/organizations',
            ctx.as(token, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name }),
            }),
          )
        ).json()) as { organization: { id: string } }
      ).organization.id as OrganizationId;
    const orgA = await create('token-alice', 'Pollería A');
    const orgB = await create('token-bob', 'Tienda B');
    const call = async (token: string, path: string, init: RequestInit = {}) => {
      const response = await ctx.app.request(path, ctx.as(token, init));
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const put = (token: string, org: string, body: unknown) =>
      call(token, `/v1/organizations/${org}/business-profile`, {
        method: 'PUT',
        headers: { 'content-type': 'application/json' },
        body: typeof body === 'string' ? body : JSON.stringify(body),
      });
    const get = (token: string, org: string) =>
      call(token, `/v1/organizations/${org}/business-profile`);
    const profileEvents = async () =>
      (await ctx.auditEvents()).filter((e) => e.action === 'organization.profile_updated');
    return { ...ctx, orgA, orgB, call, put, get, profileEvents };
  }

  it('lists the kinds of business as data, to anyone signed in', async () => {
    const { call } = await setup();
    const { status, body } = await call('token-alice', '/v1/business-types');
    expect(status).toBe(200);
    const types = body.businessTypes as { id: string; nameKey: string }[];
    expect(types.map((t) => t.id)).toContain('restaurant');
    for (const type of types) expect(type.nameKey).toBe(`business.type.${type.id}`);
  });

  it('refuses the list without a sign-in', async () => {
    const { app } = await setup();
    expect((await app.request('/v1/business-types')).status).toBe(401);
  });

  it('answers with no profile, and the general order, before it is filled in', async () => {
    const { get, orgA } = await setup();
    const { status, body } = await get('token-alice', orgA);
    expect(status).toBe(200);
    expect(body.profile).toBeNull();
    expect(body.departmentPriority).toEqual([
      'sales',
      'marketing',
      'operations',
      'finance',
      'leadership',
      'research',
    ]);
  });

  it('stores a valid profile, returns it, and suggests the order of its kind', async () => {
    const { put, get, orgA } = await setup();
    const saved = await put('token-alice', orgA, VALID);
    expect(saved.status).toBe(200);
    expect(saved.body.profile).toMatchObject({
      businessType: 'restaurant',
      country: 'PE',
      currency: 'PEN',
      timeZone: 'America/Lima',
      city: 'Lima',
      employees: '6_10',
      // Stored in the catalogue's order, whatever order was sent.
      salesChannels: ['physical_store', 'whatsapp'],
    });
    expect(saved.body.departmentPriority).toEqual([
      'sales',
      'operations',
      'marketing',
      'finance',
      'leadership',
      'research',
    ]);
    const read = await get('token-alice', orgA);
    expect(read.body).toEqual(saved.body);
  });

  it('keeps only the required fields required', async () => {
    const { put, orgA } = await setup();
    const { status, body } = await put('token-alice', orgA, {
      businessType: 'other',
      country: 'MX',
      currency: 'MXN',
      timeZone: 'America/Mexico_City',
      city: 'Monterrey',
    });
    expect(status).toBe(200);
    expect(body.profile).toMatchObject({
      city: 'Monterrey',
      employees: null,
      salesChannels: [],
      offering: null,
      needs: null,
      notes: null,
    });
  });

  it.each([
    ['businessType', { businessType: 'bakery' }],
    ['country', { country: 'Peru' }],
    ['country', { country: 'EU' }],
    ['currency', { currency: 'SOL' }],
    ['timeZone', { timeZone: 'Lima' }],
    ['city', { city: 'Lima\nCallao' }],
    ['city', { city: undefined }],
    ['employees', { employees: '12' }],
    ['salesChannels', { salesChannels: ['fax'] }],
    ['notes', { notes: 'x'.repeat(501) }],
    ['organizationId', { organizationId: MISSING_ORG }],
  ])('refuses an invalid %s, storing nothing', async (field, change) => {
    const { put, get, orgA, profileEvents } = await setup();
    const { status, body } = await put('token-alice', orgA, { ...VALID, ...change });
    expect(status).toBe(400);
    expect(body).toEqual({ error: 'invalid_profile', field });
    expect((await get('token-alice', orgA)).body.profile).toBeNull();
    expect(await profileEvents()).toHaveLength(0);
  });

  it.each([
    ['a missing required field', { ...VALID, currency: undefined }],
    ['a body that is not an object', '[1,2]'],
    ['a body that is not JSON', 'not json'],
  ])('refuses %s', async (_label, body) => {
    const { put, orgA } = await setup();
    expect((await put('token-alice', orgA, body)).status).toBe(400);
  });

  it('records one audit event per change, never the content', async () => {
    const { put, orgA, profileEvents } = await setup();
    await put('token-alice', orgA, VALID);
    // The same content again changes nothing and records nothing.
    expect((await put('token-alice', orgA, VALID)).status).toBe(200);
    await put('token-alice', orgA, { ...VALID, businessType: 'ecommerce' });
    const events = await profileEvents();
    expect(events.map((e) => [e.reason, e.reference])).toEqual([
      ['created', 'business_type:restaurant'],
      ['updated', 'business_type:ecommerce'],
    ]);
    for (const event of events) {
      expect(event.organizationId).toBe(orgA);
      expect(event.target).toEqual({ type: 'organization', id: orgA });
      const raw = JSON.stringify(event);
      for (const secret of ['Lima', 'Pollos', 'WhatsApp', 'martes', 'PEN', 'America']) {
        expect(raw).not.toContain(secret);
      }
    }
  });

  it("keeps each organization's profile to itself", async () => {
    const { put, get, orgA, orgB } = await setup();
    await put('token-alice', orgA, VALID);
    // Bob is not a member of A: he can neither read nor write its profile.
    expect((await get('token-bob', orgA)).status).toBe(403);
    expect((await put('token-bob', orgA, { ...VALID, city: 'Cusco' })).status).toBe(403);
    expect((await get('token-bob', orgB)).body.profile).toBeNull();
    expect((await get('token-alice', orgA)).body.profile).toMatchObject({ city: 'Lima' });
  });

  it('refuses an organization that does not exist', async () => {
    const { get, put } = await setup();
    expect((await get('token-alice', MISSING_ORG)).status).toBe(403);
    expect((await put('token-alice', MISSING_ORG, VALID)).status).toBe(403);
  });
});

describe('business profile without its store', () => {
  it('fails closed', async () => {
    const logger = createLogger({ service: 'api', sink: () => undefined });
    const app = createApp({
      logger,
      version: 'test',
      auth: { verifier, users: new InMemoryUserDirectory() },
      tenancy: new InMemoryTenancyStore(),
      audit: createAuditService(new InMemoryAuditStore()),
    });
    const headers = { authorization: 'Bearer token-alice' };
    expect((await app.request('/v1/me', { method: 'POST', headers })).status).toBe(201);
    const response = await app.request(`/v1/organizations/${MISSING_ORG}/business-profile`, {
      headers,
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'business_not_configured' });
  });
});
