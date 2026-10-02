import { ROLES, createAuthorizationService, type Permission } from '@melonoffice/rbac';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * Agent Engine AE-4.4 over HTTP (ADR-0116): an agent's level of autonomy, chosen by a person as a
 * new version, and the organization's rules for its agents. Every case runs on memory and, in CI,
 * on the Firestore emulator.
 */

interface Body {
  readonly [key: string]: unknown;
  readonly id?: string;
  readonly error?: string;
  readonly field?: string | null;
  readonly version?: number;
  readonly autonomy?: string;
  readonly organization?: { readonly id: string };
  readonly specialists?: readonly { readonly id: string; readonly displayName: string }[];
}

describe.each(STORES)('agent autonomy with storage in %s', (_name, createStores) => {
  async function setup(options: { readonly without?: readonly Permission[] } = {}) {
    const stores: Stores = createStores();
    const ctx = setupApp(
      stores,
      options.without === undefined
        ? undefined
        : createAuthorizationService({
            ...ROLES,
            owner: ROLES.owner.filter((p) => !(options.without ?? []).includes(p)),
          }),
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
      (await call(token, 'POST', '/v1/organizations', { name })).body.organization?.id as string;
    const orgA = await orgOf('token-alice', 'A');
    const orgB = await orgOf('token-bob', 'B');
    const base = (org: string) => `/v1/organizations/${org}`;
    const create = async (displayName = 'Lucía', token = 'token-alice', org = orgA) =>
      (
        await call(token, 'POST', `${base(org)}/specialists`, {
          templateId: 'operations',
          displayName,
        })
      ).body;
    return { ...ctx, stores, call, orgA, orgB, base, create };
  }

  it('a person changes an agent’s level as a new version; the view shows it', async () => {
    const t = await setup();
    const agent = await t.create();
    expect(agent.autonomy).toBe('controlled');
    const path = `${t.base(t.orgA)}/specialists/${agent.id}/autonomy`;
    const changed = await t.call('token-alice', 'POST', path, {
      fromVersion: agent.version,
      autonomy: 'propose',
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ autonomy: 'propose', version: (agent.version ?? 0) + 1 });
    const read = await t.call('token-alice', 'GET', `${t.base(t.orgA)}/specialists/${agent.id}`);
    expect(read.body.autonomy).toBe('propose');
    const list = await t.call(
      'token-alice',
      'GET',
      `${t.base(t.orgA)}/specialists?autonomy=propose`,
    );
    expect(list.body.specialists?.map((s) => s.id)).toEqual([agent.id]);

    expect(await t.call('token-alice', 'POST', path, { fromVersion: 2, autonomy: 'free' })).toEqual(
      { status: 400, body: { error: 'invalid_specialist', field: 'autonomy' } },
    );
    expect(
      (await t.call('token-alice', 'POST', path, { fromVersion: 1, autonomy: 'within_policy' }))
        .status,
    ).toBe(409);
    // Another organization's agent does not exist for Bob.
    expect(
      (
        await t.call('token-bob', 'POST', `${t.base(t.orgB)}/specialists/${agent.id}/autonomy`, {
          fromVersion: 2,
          autonomy: 'within_policy',
        })
      ).status,
    ).toBe(404);
  });

  it('without specialist.manage, nobody changes a level or the rules', async () => {
    const t = await setup({ without: ['specialist.manage'] });
    const agent = await t.stores.specialists.list(t.orgA as never);
    expect(agent).toEqual([]);
    const refused = await t.call(
      'token-alice',
      'POST',
      `${t.base(t.orgA)}/specialists/00000000-0000-4000-8000-000000000000/autonomy`,
      { fromVersion: 1, autonomy: 'propose' },
    );
    expect(refused.status).toBe(403);
    const rules = await t.call('token-alice', 'PUT', `${t.base(t.orgA)}/agent-policy`, {
      revision: 0,
      maxAutonomy: 'propose',
    });
    expect(rules.status).toBe(403);
    // Reading them needs only specialist.read.
    expect((await t.call('token-alice', 'GET', `${t.base(t.orgA)}/agent-policy`)).status).toBe(200);
  });

  it('the organization’s rules: defaults, a change, a stale revision, malformed codes, isolation', async () => {
    const t = await setup();
    const path = `${t.base(t.orgA)}/agent-policy`;
    expect((await t.call('token-alice', 'GET', path)).body).toMatchObject({
      organizationId: t.orgA,
      sensitiveCategories: [],
      sensitiveActions: [],
      sensitiveTools: [],
      maxAutonomy: 'within_policy',
      revision: 0,
      updatedAt: null,
    });
    const changed = await t.call('token-alice', 'PUT', path, {
      revision: 0,
      sensitiveCategories: ['crm'],
      maxAutonomy: 'controlled',
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ sensitiveCategories: ['crm'], revision: 1 });
    expect((await t.call('token-alice', 'PUT', path, { revision: 0 })).status).toBe(409);
    expect(
      await t.call('token-alice', 'PUT', path, { revision: 1, sensitiveTools: ['Bad Code'] }),
    ).toEqual({ status: 400, body: { error: 'invalid_specialist', field: 'sensitiveTools' } });
    // Bob's organization keeps the defaults, and Bob cannot read or change Alice's.
    expect((await t.call('token-bob', 'GET', `${t.base(t.orgB)}/agent-policy`)).body.revision).toBe(
      0,
    );
    expect((await t.call('token-bob', 'GET', path)).status).toBe(403);
    expect((await t.call('token-bob', 'PUT', path, { revision: 1 })).status).toBe(403);
    // Each change is audited in the organization, with codes only.
    const events = await t.stores.auditReader.query({
      organizationId: t.orgA as never,
      actions: ['agent_policy.changed'],
      from: new Date(Date.now() - 60_000),
      to: new Date(Date.now() + 60_000),
      limit: 10,
    });
    expect(events).toEqual([
      expect.objectContaining({
        targetVersion: 1,
        transition: { from: 'within_policy', to: 'controlled' },
      }),
    ]);
  });
});
