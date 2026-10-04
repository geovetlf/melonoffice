import { createAuthorizationService, ROLES } from '@melonoffice/rbac';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * Editing what an agent is for (ADR-0140): a person with `specialist.manage` rewrites its
 * purpose and description, and the server keeps the rest of its configuration exactly as it is,
 * as a new version, audited. The browser never sends tools, permissions, policies or the
 * conversation profile, and an older version, another organization or a missing permission
 * changes nothing.
 */
type Body = Record<string, unknown> & { error?: string; field?: string };

describe.each(STORES)('agent profile editing with storage in %s', (_name, createStores) => {
  async function setup(withoutManage = false) {
    const stores: Stores = createStores();
    const ctx = setupApp(
      stores,
      withoutManage
        ? createAuthorizationService({
            owner: ROLES.owner.filter((p) => p !== 'specialist.manage'),
          })
        : undefined,
    );
    await ctx.register('token-alice');
    await ctx.register('token-bob');
    const call = async (token: string, method: string, path: string, body?: unknown) => {
      const response = await ctx.app.request(
        path,
        ctx.as(token, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        }),
      );
      return { status: response.status, body: (await response.json()) as Body };
    };
    const orgOf = async (token: string, name: string) =>
      (
        (await call(token, 'POST', '/v1/organizations', { name })).body.organization as {
          id: string;
        }
      ).id;
    const orgA = await orgOf('token-alice', 'A');
    const orgB = await orgOf('token-bob', 'B');
    const base = (org: string) => `/v1/organizations/${org}`;
    return { stores, call, orgA, orgB, base };
  }

  async function withAgent(withoutManage = false) {
    const t = await setup(withoutManage);
    const created = await t.call('token-alice', 'POST', `${t.base(t.orgA)}/specialists`, {
      templateId: 'commercial',
      displayName: 'Lucía',
    });
    const id = created.body.id as string;
    return { ...t, id, path: `${t.base(t.orgA)}/specialists/${id}` };
  }

  it('rewrites the purpose and description as a new version, keeping everything else', async () => {
    const { stores, call, orgA, id, path } = await withAgent();
    const before = await stores.specialists.find(orgA as never, id as never);
    if (before === undefined) throw new Error('agent not stored');

    const edited = await call('token-alice', 'POST', `${path}/profile`, {
      fromVersion: 1,
      purpose: 'Vender más pollo a la brasa',
      description: 'Atiende pedidos por WhatsApp',
    });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({
      version: 2,
      purpose: 'Vender más pollo a la brasa',
      description: 'Atiende pedidos por WhatsApp',
    });
    expect(edited.body).not.toHaveProperty('tools');

    const after = await stores.specialists.find(orgA as never, id as never);
    // Everything but the profile is exactly as it was.
    const rest = (c: object) =>
      Object.fromEntries(
        Object.entries(c).filter(([key]) => key !== 'purpose' && key !== 'description'),
      );
    expect(rest(after?.configuration ?? {})).toEqual(rest(before.configuration));

    const capabilities = await call('token-alice', 'GET', `${path}/capabilities`);
    expect(capabilities.body).toMatchObject({
      version: 2,
      purpose: 'Vender más pollo a la brasa',
      description: 'Atiende pedidos por WhatsApp',
    });
    const audited = (await stores.auditEvents()).filter(
      (e) => e.action === 'specialist.version_created',
    );
    expect(audited).toHaveLength(1);

    // An empty text or null clears a field.
    const cleared = await call('token-alice', 'POST', `${path}/profile`, {
      fromVersion: 2,
      description: null,
      purpose: '  ',
    });
    expect(cleared.status).toBe(200);
    expect(cleared.body).toMatchObject({ version: 3, purpose: null, description: null });
  });

  it('refuses what is not the profile, an old version, nothing new and a text too long', async () => {
    const { call, path } = await withAgent();
    const refuse = async (body: unknown) =>
      (await call('token-alice', 'POST', `${path}/profile`, body)).body;

    expect(await refuse({ fromVersion: 1, tools: [] })).toEqual({
      error: 'invalid_specialist',
      field: 'tools',
    });
    expect(await refuse({ fromVersion: 1, purpose: 7 })).toMatchObject({ field: 'purpose' });
    expect(await refuse({ fromVersion: 1 })).toMatchObject({ field: 'profile' });
    expect(await refuse({ purpose: 'x' })).toMatchObject({ field: 'fromVersion' });
    expect(await refuse({ fromVersion: 1, purpose: 'x'.repeat(501) })).toMatchObject({
      field: 'purpose',
    });

    expect(
      (await call('token-alice', 'POST', `${path}/profile`, { fromVersion: 1, purpose: 'A' }))
        .status,
    ).toBe(200);
    const stale = await call('token-alice', 'POST', `${path}/profile`, {
      fromVersion: 1,
      purpose: 'B',
    });
    expect(stale).toEqual({ status: 409, body: { error: 'specialist_concurrency_conflict' } });
    const same = await call('token-alice', 'POST', `${path}/profile`, {
      fromVersion: 2,
      purpose: 'A',
    });
    expect(same.status).toBe(400);
  });

  it("never reaches another organization's agent, nor without specialist.manage", async () => {
    const { call, orgB, base, id } = await withAgent();
    const viaB = await call('token-bob', 'POST', `${base(orgB)}/specialists/${id}/profile`, {
      fromVersion: 1,
      purpose: 'Intruso',
    });
    expect(viaB).toEqual({ status: 404, body: { error: 'specialist_not_found' } });

    const denied = await withAgent(true);
    const refused = await denied.call('token-alice', 'POST', `${denied.path}/profile`, {
      fromVersion: 1,
      purpose: 'Sin permiso',
    });
    expect(refused.status).toBe(403);
  });
});
