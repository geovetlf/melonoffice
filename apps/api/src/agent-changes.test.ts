import { createAuthorizationService, ROLES } from '@melonoffice/rbac';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * Changing an agent's skills and department as one version (AC-2, ADR-0141): the browser names
 * skills and a department, never tools, permissions, policies or configuration, and the server
 * derives the rest, as a new version, audited, leaving the earlier version as it was.
 */
type Body = Record<string, unknown> & { error?: string; field?: string };

describe.each(STORES)('agent changes with storage in %s', (_name, createStores) => {
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

  const KEYS = (c: object) => Object.keys(c);
  const changes = (path: string) => `${path}/changes`;

  it('adds and removes several skills at once, the server deriving tools and permissions (A, B, D, J)', async () => {
    const { stores, call, orgA, id, path } = await withAgent();
    const changed = await call('token-alice', 'POST', changes(path), {
      fromVersion: 1,
      add: [
        { skillId: 'finance_review', version: 1 },
        { skillId: 'market_research', version: 1 },
      ],
      remove: ['customer_follow_up'],
    });
    expect(changed.status).toBe(200);
    expect(changed.body).toMatchObject({ version: 2 });
    const stored = await stores.specialists.find(orgA as never, id as never);
    expect(stored?.configuration.skills.map((s) => s.id)).toEqual([
      'company_knowledge',
      'pipeline_analysis',
      'finance_review',
      'market_research',
    ]);
    // Derived on the server: no follow-up tool any more, and what the new skills read.
    expect(stored?.configuration.tools).toEqual([]);
    expect(stored?.configuration.permissions).toEqual([
      'credits.read',
      'knowledge.read',
      'opportunity.read',
      'report.read',
    ]);
  });

  it('moves an agent to another department, audited, keeping the earlier version (C, L, M)', async () => {
    const { stores, call, orgA, id, path } = await withAgent();
    const before = await stores.specialists.find(orgA as never, id as never);
    const caps = await call('token-alice', 'GET', `${path}/capabilities`);
    const moves = caps.body.moves as { departmentId: string; blockedBy: string[] }[];
    expect(moves).toContainEqual({ departmentId: `${orgA}_marketing`, blockedBy: [] });
    expect(moves.map((m) => m.departmentId)).not.toContain(`${orgA}_sales`);

    const moved = await call('token-alice', 'POST', changes(path), {
      fromVersion: 1,
      departmentId: `${orgA}_marketing`,
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ version: 2, departmentId: `${orgA}_marketing` });

    const events = (await stores.auditEvents()).filter((e) => e.target?.id === id);
    expect(events.map((e) => e.action)).toEqual(
      expect.arrayContaining(['specialist.version_created', 'specialist.department_changed']),
    );
    expect(events.find((e) => e.action === 'specialist.department_changed')).toMatchObject({
      targetVersion: 2,
      reference: `department:${orgA}_marketing`,
    });
    const first = await stores.specialists.findVersion(orgA as never, id as never, 1);
    expect(first?.configuration).toEqual(before?.configuration);
    expect(first?.configuration.departmentId).toBe(`${orgA}_sales`);
  });

  it('moves only where every skill it keeps is allowed, or with that skill removed at once', async () => {
    const { call, orgA, path } = await withAgent();
    const up = await call('token-alice', 'POST', `${path}/skills/upgrade`, {
      fromVersion: 1,
      skillId: 'customer_follow_up',
      version: 3,
    });
    expect(up.status).toBe(200);
    const caps = await call('token-alice', 'GET', `${path}/capabilities`);
    expect(caps.body.moves).toContainEqual({
      departmentId: `${orgA}_finance`,
      blockedBy: ['customer_follow_up'],
    });
    const refused = await call('token-alice', 'POST', changes(path), {
      fromVersion: 2,
      departmentId: `${orgA}_finance`,
    });
    expect(refused.body).toEqual({ error: 'invalid_specialist', field: 'skills.department' });
    const moved = await call('token-alice', 'POST', changes(path), {
      fromVersion: 2,
      departmentId: `${orgA}_finance`,
      remove: ['customer_follow_up'],
    });
    expect(moved.status).toBe(200);
  });

  it('refuses an unknown skill and an invalid department (E, F)', async () => {
    const { call, orgA, orgB, path } = await withAgent();
    const send = async (body: object) =>
      (await call('token-alice', 'POST', changes(path), { fromVersion: 1, ...body })).body;
    expect(await send({ add: [{ skillId: 'nope', version: 1 }] })).toMatchObject({
      field: 'skillId',
    });
    expect(await send({ remove: ['market_research'] })).toMatchObject({ field: 'skillId' });
    expect(await send({ departmentId: 'anything' })).toMatchObject({ field: 'departmentId' });
    expect(await send({ departmentId: `${orgB}_marketing` })).toMatchObject({
      field: 'departmentId',
    });
    expect(await send({ departmentId: `${orgA}_nope` })).toMatchObject({
      field: 'departmentId',
    });
    expect(await send({ departmentId: `${orgA}_sales` })).toMatchObject({
      field: 'departmentId',
    });
    expect(await send({})).toMatchObject({ field: 'change' });
  });

  it('never accepts tools, permissions, policies or configuration from the browser (K)', async () => {
    const { stores, call, orgA, id, path } = await withAgent();
    const before = await stores.specialists.find(orgA as never, id as never);
    for (const [key, value] of [
      ['tools', [{ id: 'message_send', version: 3 }]],
      ['permissions', ['knowledge.read_restricted']],
      ['policies', {}],
      ['configuration', {}],
      ['capabilities', ['x']],
    ] as const) {
      const sent = await call('token-alice', 'POST', changes(path), {
        fromVersion: 1,
        add: [{ skillId: 'finance_review', version: 1 }],
        [key]: value,
      });
      expect(sent.body, key).toEqual({ error: 'invalid_specialist', field: key });
    }
    const smuggled = await call('token-alice', 'POST', changes(path), {
      fromVersion: 1,
      add: [{ skillId: 'finance_review', version: 1, tools: [] }],
    });
    expect(smuggled.body).toMatchObject({ field: 'tools' });
    const after = await stores.specialists.find(orgA as never, id as never);
    expect(after).toEqual(before);
    expect(KEYS(after ?? {})).toEqual(KEYS(before ?? {}));
  });

  it('refuses an older version, another organization and a person without specialist.manage (G, H, I)', async () => {
    const { call, orgA, orgB, base, id, path } = await withAgent();
    const ok = await call('token-alice', 'POST', changes(path), {
      fromVersion: 1,
      departmentId: `${orgA}_marketing`,
    });
    expect(ok.status).toBe(200);
    const stale = await call('token-alice', 'POST', changes(path), {
      fromVersion: 1,
      add: [{ skillId: 'finance_review', version: 1 }],
    });
    expect(stale).toEqual({ status: 409, body: { error: 'specialist_concurrency_conflict' } });

    const viaB = await call('token-bob', 'POST', changes(`${base(orgB)}/specialists/${id}`), {
      fromVersion: 2,
      departmentId: `${orgB}_finance`,
    });
    expect(viaB).toEqual({ status: 404, body: { error: 'specialist_not_found' } });

    const denied = await withAgent('commercial', true);
    const refused = await denied.call('token-alice', 'POST', changes(denied.path), {
      fromVersion: 1,
      departmentId: `${denied.orgA}_marketing`,
    });
    expect(refused.status).toBe(403);
  });
});
