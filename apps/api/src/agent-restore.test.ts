import { createAuthorizationService, ROLES } from '@melonoffice/rbac';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * Restoring an earlier version (AC-4, ADR-0143): a person with `specialist.manage` brings back
 * an earlier version's department, purpose, description and skills as a new version, checked
 * again by the server, audited, with every version kept. Autonomy, work settings and the
 * conversation profile stay as they are now.
 */
type Body = Record<string, unknown> & { error?: string; field?: string };

describe.each(STORES)('agent restore with storage in %s', (_name, createStores) => {
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

  async function withAgent(templateId = 'commercial', withoutManage = false) {
    const t = await setup(withoutManage);
    const created = await t.call('token-alice', 'POST', `${t.base(t.orgA)}/specialists`, {
      templateId,
      displayName: 'Lucía',
    });
    const id = created.body.id as string;
    return { ...t, id, path: `${t.base(t.orgA)}/specialists/${id}` };
  }

  it('brings back an earlier version as a new one, keeping every version (A)', async () => {
    const { stores, call, orgA, id, path } = await withAgent();
    const v1 = await stores.specialists.find(orgA as never, id as never);
    const post = async (route: string, body: object) =>
      expect((await call('token-alice', 'POST', `${path}/${route}`, body)).status).toBe(200);
    await post('profile', { fromVersion: 1, purpose: 'Vender' });
    await post('changes', {
      fromVersion: 2,
      departmentId: `${orgA}_marketing`,
      add: [{ skillId: 'content_drafting', version: 1 }],
      remove: ['customer_follow_up'],
    });

    const restored = await call('token-alice', 'POST', `${path}/restore`, {
      fromVersion: 3,
      version: 1,
    });
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ version: 4, departmentId: `${orgA}_sales` });
    const now = await stores.specialists.find(orgA as never, id as never);
    expect(now?.configuration).toEqual(v1?.configuration);
    for (const v of [1, 2, 3]) {
      expect(await stores.specialists.findVersion(orgA as never, id as never, v)).toBeDefined();
    }
    const stored = await stores.specialists.findVersion(orgA as never, id as never, 4);
    expect(stored?.restoredFrom).toBe(1);

    const history = await call('token-alice', 'GET', `${path}/versions?limit=1`);
    const [entry] = history.body.entries as { restoredFrom: number; changes: { kind: string }[] }[];
    expect(entry?.restoredFrom).toBe(1);
    expect(entry?.changes.map((c) => c.kind)).toEqual(['department', 'purpose', 'skills']);

    const events = (await stores.auditEvents()).filter(
      (e) => e.target?.id === id && e.targetVersion === 4,
    );
    expect(events).toHaveLength(2);
    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: 'specialist.version_created',
          reference: 'restored_from:1',
        }),
        expect.objectContaining({
          action: 'specialist.department_changed',
          reference: `department:${orgA}_sales`,
        }),
      ]),
    );
  });

  it('keeps how far it acts on its own and its work settings as they are now (B)', async () => {
    const { call, path } = await withAgent();
    await call('token-alice', 'POST', `${path}/autonomy`, { fromVersion: 1, autonomy: 'propose' });
    await call('token-alice', 'POST', `${path}/settings`, { fromVersion: 2, memory: true });
    await call('token-alice', 'POST', `${path}/profile`, { fromVersion: 3, purpose: 'Vender' });
    const restored = await call('token-alice', 'POST', `${path}/restore`, {
      fromVersion: 4,
      version: 1,
    });
    expect(restored.status).toBe(200);
    expect(restored.body).toMatchObject({ version: 5, autonomy: 'propose' });
    const caps = await call('token-alice', 'GET', `${path}/capabilities`);
    expect(caps.body).toMatchObject({ autonomy: 'propose', work: { memory: true } });
    // Version 3 says what version 5 says now: restoring it would change nothing.
    expect(
      (await call('token-alice', 'POST', `${path}/restore`, { fromVersion: 5, version: 3 })).body,
    ).toEqual({ error: 'invalid_specialist', field: 'configuration.unchanged' });
  });

  it('refuses the current version, an unknown one, an older fromVersion and anything else (C)', async () => {
    const { call, path } = await withAgent();
    await call('token-alice', 'POST', `${path}/profile`, { fromVersion: 1, purpose: 'Vender' });
    const restore = async (body: object) => call('token-alice', 'POST', `${path}/restore`, body);
    expect((await restore({ fromVersion: 2, version: 2 })).body).toMatchObject({
      field: 'version',
    });
    expect((await restore({ fromVersion: 2, version: 9 })).body).toMatchObject({
      field: 'version',
    });
    expect((await restore({ fromVersion: 2, version: 0 })).body).toMatchObject({
      field: 'version',
    });
    expect((await restore({ fromVersion: 2, version: 1, tools: [] })).body).toMatchObject({
      field: 'tools',
    });
    expect(await restore({ fromVersion: 1, version: 1 })).toEqual({
      status: 409,
      body: { error: 'specialist_concurrency_conflict' },
    });
  });

  it("never reaches another organization's agent, nor without specialist.manage (D)", async () => {
    const { call, orgB, base, id, path } = await withAgent();
    await call('token-alice', 'POST', `${path}/profile`, { fromVersion: 1, purpose: 'Vender' });
    expect(
      await call('token-bob', 'POST', `${base(orgB)}/specialists/${id}/restore`, {
        fromVersion: 2,
        version: 1,
      }),
    ).toEqual({ status: 404, body: { error: 'specialist_not_found' } });
    const denied = await withAgent('commercial', true);
    expect(
      (
        await denied.call('token-alice', 'POST', `${denied.path}/restore`, {
          fromVersion: 1,
          version: 1,
        })
      ).status,
    ).toBe(403);
  });
});
