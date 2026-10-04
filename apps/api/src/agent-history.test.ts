import { createAuthorizationService, ROLES } from '@melonoffice/rbac';
import { AGENT_HISTORY_LIMIT } from '@melonoffice/specialists';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * An agent's version history (AC-3, ADR-0142), read only: who made each version, when, and what
 * it changed from the one before (department, purpose, skills, autonomy, work settings), told from
 * the stored versions, newest first and in pages. Never its tools, permissions, policies or
 * conversation profile. Read with `specialist.read`, only in its own organization.
 */
type Body = Record<string, unknown> & { error?: string; field?: string };

describe.each(STORES)('agent history with storage in %s', (_name, createStores) => {
  async function setup(withoutRead = false) {
    const stores: Stores = createStores();
    const ctx = setupApp(
      stores,
      withoutRead
        ? createAuthorizationService({
            owner: ROLES.owner.filter((p) => p !== 'specialist.read'),
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

  async function withAgent(templateId = 'commercial', withoutRead = false) {
    const t = await setup(withoutRead);
    const created = await t.call('token-alice', 'POST', `${t.base(t.orgA)}/specialists`, {
      templateId,
      displayName: 'Lucía',
    });
    const id = created.body.id as string;
    return { ...t, id, path: `${t.base(t.orgA)}/specialists/${id}` };
  }

  type Entry = {
    version: number;
    previousVersion: number | null;
    createdAt: string;
    actor: string;
    changes: { kind: string; [key: string]: unknown }[];
  };
  const history = async (
    call: Awaited<ReturnType<typeof setup>>['call'],
    path: string,
    query = '',
  ) => {
    const got = await call('token-alice', 'GET', `${path}/versions${query}`);
    return {
      status: got.status,
      entries: got.body.entries as Entry[],
      nextBefore: got.body.nextBefore as number | null,
    };
  };

  it('a new agent has only its creation (A, B)', async () => {
    const { call, path } = await withAgent();
    const { entries, nextBefore } = await history(call, path);
    expect(entries).toEqual([
      {
        version: 1,
        previousVersion: null,
        createdAt: expect.any(String),
        actor: 'you',
        changes: [{ kind: 'created' }],
      },
    ]);
    expect(nextBefore).toBeNull();
  });

  it('says what each version changed, newest first (C–I)', async () => {
    const { call, orgA, path } = await withAgent();
    const post = async (route: string, body: object) =>
      expect((await call('token-alice', 'POST', `${path}/${route}`, body)).status).toBe(200);
    await post('profile', { fromVersion: 1, purpose: 'Vender' });
    await post('changes', {
      fromVersion: 2,
      add: [{ skillId: 'finance_review', version: 1 }],
      remove: ['customer_follow_up'],
    });
    await post('changes', { fromVersion: 3, departmentId: `${orgA}_marketing` });
    await post('autonomy', { fromVersion: 4, autonomy: 'propose' });
    await post('changes', {
      fromVersion: 5,
      departmentId: `${orgA}_research`,
      add: [{ skillId: 'market_research', version: 1 }],
    });

    const { entries } = await history(call, path);
    expect(entries.map((e) => [e.version, e.previousVersion])).toEqual([
      [6, 5],
      [5, 4],
      [4, 3],
      [3, 2],
      [2, 1],
      [1, null],
    ]);
    const at = entries.map((e) => Date.parse(e.createdAt));
    expect([...at].sort((a, b) => b - a)).toEqual(at);
    const byVersion = (v: number) => entries.find((e) => e.version === v)?.changes;
    expect(byVersion(2)).toEqual([
      { kind: 'purpose', before: expect.any(String), after: 'Vender' },
    ]);
    expect(byVersion(3)).toEqual([
      {
        kind: 'skills',
        added: [{ id: 'finance_review', version: 1 }],
        removed: [{ id: 'customer_follow_up', version: 2 }],
        updated: [],
      },
    ]);
    expect(byVersion(4)).toEqual([
      { kind: 'department', before: `${orgA}_sales`, after: `${orgA}_marketing` },
    ]);
    expect(byVersion(5)).toEqual([{ kind: 'autonomy', before: 'controlled', after: 'propose' }]);
    expect(byVersion(6)?.map((c) => c.kind)).toEqual(['department', 'skills']);
  });

  it('pages through the history with before and limit (J)', async () => {
    const { call, path } = await withAgent();
    for (let v = 1; v <= 4; v++) {
      await call('token-alice', 'POST', `${path}/profile`, {
        fromVersion: v,
        purpose: `Propósito ${v}`,
      });
    }
    const first = await history(call, path, '?limit=2');
    expect(first.entries.map((e) => e.version)).toEqual([5, 4]);
    // The oldest of a page still says what it changed: the version before it is read too.
    expect(first.entries[1]).toMatchObject({ previousVersion: 3 });
    expect(first.entries[1]?.changes[0]).toMatchObject({ kind: 'purpose', after: 'Propósito 3' });
    expect(first.nextBefore).toBe(4);
    const second = await history(call, path, '?limit=2&before=4');
    expect(second.entries.map((e) => e.version)).toEqual([3, 2]);
    const last = await history(call, path, `?limit=2&before=${second.nextBefore}`);
    expect(last.entries.map((e) => e.version)).toEqual([1]);
    expect(last.nextBefore).toBeNull();
    expect((await history(call, path, '?limit=nope')).status).toBe(400);
    expect((await history(call, path, `?limit=${AGENT_HISTORY_LIMIT + 50}`)).entries).toHaveLength(
      5,
    );
  });

  it("never reads another organization's agent, nor without specialist.read (K, L)", async () => {
    const { call, orgB, base, id } = await withAgent();
    expect(await call('token-bob', 'GET', `${base(orgB)}/specialists/${id}/versions`)).toEqual({
      status: 404,
      body: { error: 'specialist_not_found' },
    });
    const denied = await withAgent('commercial', true);
    expect((await denied.call('token-alice', 'GET', `${denied.path}/versions`)).status).toBe(403);
  });

  it('shows no tools, permissions, policies or ids of people (M)', async () => {
    const { call, path } = await withAgent();
    await call('token-alice', 'POST', `${path}/skills/upgrade`, {
      fromVersion: 1,
      skillId: 'customer_follow_up',
      version: 3,
    });
    const got = await call('token-alice', 'GET', `${path}/versions`);
    const text = JSON.stringify(got.body);
    for (const hidden of [
      'tools',
      'permissions',
      'policies',
      'conversation',
      'createdBy',
      'follow_up_schedule',
      'user_',
    ]) {
      expect(text, hidden).not.toContain(hidden);
    }
    expect((got.body.entries as Entry[])[0]?.changes).toEqual([
      {
        kind: 'skills',
        added: [],
        removed: [],
        updated: [{ id: 'customer_follow_up', from: 2, to: 3 }],
      },
    ]);
  });

  it('matches the audit log: one version_created per version, and the move recorded (N)', async () => {
    const { stores, call, orgA, id, path } = await withAgent();
    await call('token-alice', 'POST', `${path}/profile`, { fromVersion: 1, purpose: 'Vender' });
    await call('token-alice', 'POST', `${path}/changes`, {
      fromVersion: 2,
      departmentId: `${orgA}_marketing`,
    });
    const { entries } = await history(call, path);
    const events = (await stores.auditEvents()).filter((e) => e.target?.id === id);
    const created = events
      .filter((e) => e.action === 'specialist.version_created')
      .map((e) => e.targetVersion)
      .sort();
    expect(created).toEqual(
      entries
        .filter((e) => e.version > 1)
        .map((e) => e.version)
        .sort(),
    );
    const moves = events.filter((e) => e.action === 'specialist.department_changed');
    expect(moves.map((e) => e.targetVersion)).toEqual(
      entries.filter((e) => e.changes.some((c) => c.kind === 'department')).map((e) => e.version),
    );
    expect(events.some((e) => e.action === 'specialist.created')).toBe(true);
  });
});
