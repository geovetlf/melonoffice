import { createAuditService, InMemoryAuditStore } from '@melonoffice/audit';
import { InMemoryUserDirectory } from '@melonoffice/auth';
import type { OrganizationId } from '@melonoffice/domain';
import { createLogger } from '@melonoffice/observability';
import { InMemoryTenancyStore } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { createApp } from './app.js';
import { setupApp, STORES, verifier, type Stores } from './test-api.js';

const MISSING_ORG = '99999999-9999-4999-8999-999999999999';

describe.each(STORES)('office activity with storage in %s', (_name, createStores) => {
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
    const activity = (token: string, org: string, period = 'today') =>
      call(token, `/v1/organizations/${org}/activity?period=${period}`);
    return { ...ctx, orgA, orgB, call, activity };
  }

  it('shows what really happened today, in Lima until the business says its zone', async () => {
    const { activity, orgA } = await setup();
    const { status, body } = await activity('token-alice', orgA);
    expect(status).toBe(200);
    expect(body.timeZone).toBe('America/Lima');
    expect(body.timeZoneSource).toBe('default');
    const items = body.items as { action: string; actor: string }[];
    expect(items.map((i) => i.action)).toEqual(
      expect.arrayContaining(['organization.create', 'membership.create']),
    );
    expect(items.every((i) => i.actor === 'you')).toBe(true);
    // Sign-ins and tenant checks are recorded, never shown.
    expect(items.some((i) => i.action.startsWith('auth.') || i.action === 'tenancy.resolve')).toBe(
      false,
    );
  });

  it('uses the business time zone once the profile has one, and shows the profile change', async () => {
    const { activity, call, orgA } = await setup();
    await call('token-alice', `/v1/organizations/${orgA}/business-profile`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        businessType: 'restaurant',
        country: 'MX',
        currency: 'MXN',
        timeZone: 'America/Mexico_City',
        city: 'Monterrey',
      }),
    });
    const { body } = await activity('token-alice', orgA, 'week');
    expect(body.timeZone).toBe('America/Mexico_City');
    expect(body.timeZoneSource).toBe('business');
    const items = body.items as { action: string }[];
    expect(items[0]?.action).toBe('organization.profile_updated');
    // What the owner wrote is not in the activity.
    expect(JSON.stringify(body)).not.toContain('Monterrey');
  });

  it("keeps each organization's activity to itself", async () => {
    const { activity, orgA, orgB } = await setup();
    expect((await activity('token-bob', orgA)).status).toBe(403);
    const b = await activity('token-bob', orgB);
    expect((b.body.items as unknown[]).length).toBeGreaterThan(0);
    expect(JSON.stringify(b.body)).not.toContain(orgA);
  });

  it.each([
    ['an unknown period', 'year', 400],
    ['a missing organization', 'today', 403],
  ])('refuses %s', async (label, period, status) => {
    const { activity, orgA } = await setup();
    const org = label === 'a missing organization' ? MISSING_ORG : orgA;
    expect((await activity('token-alice', org, period)).status).toBe(status);
  });
});

describe('activity without its reader', () => {
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
    const response = await app.request(`/v1/organizations/${MISSING_ORG}/activity`, { headers });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'activity_not_configured' });
  });
});
