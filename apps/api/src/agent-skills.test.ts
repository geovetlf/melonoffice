import { createAuthorizationService, ROLES } from '@melonoffice/rbac';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * Adding and removing an agent's skills (ADR-0141): a person with `specialist.manage` names a
 * skill, and the server derives the tools and permissions from the skills, as a new version,
 * audited. It never makes a choice between tool versions, never gives a skill its department
 * does not allow, and never removes the last one.
 */
type Body = Record<string, unknown> & { error?: string; field?: string };

describe.each(STORES)('agent skills with storage in %s', (_name, createStores) => {
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

  it('offers the skills it may add and what removing each takes away', async () => {
    const { call, path } = await withAgent();
    const got = await call('token-alice', 'GET', `${path}/capabilities`);
    const addable = got.body.addable as { skillId: string; version: number }[];
    expect(addable).toContainEqual({ skillId: 'finance_review', version: 1 });
    expect(addable.map((a) => a.skillId)).not.toContain('customer_follow_up');
    // A choice between a supervised or autonomous reply is never offered here.
    expect(addable.map((a) => a.skillId)).not.toContain('conversation_reply');
    expect(got.body.removals).toContainEqual({
      skillId: 'customer_follow_up',
      removes: ['follow_up_schedule@2'],
      breaks: [],
    });
  });

  it('adds a skill with what it reads, as a new version, audited', async () => {
    const { stores, call, orgA, id, path } = await withAgent();
    const added = await call('token-alice', 'POST', `${path}/skills/add`, {
      fromVersion: 1,
      skillId: 'finance_review',
      version: 1,
    });
    expect(added.status).toBe(200);
    expect(added.body).toMatchObject({ version: 2 });
    expect(added.body.skills).toContainEqual({ id: 'finance_review', version: 1 });
    const stored = await stores.specialists.find(orgA as never, id as never);
    expect(stored?.configuration.permissions).toContain('credits.read');
    expect(
      (await stores.auditEvents()).filter((e) => e.action === 'specialist.version_created'),
    ).toHaveLength(1);
  });

  it('removes a skill with the tools and permissions only it needed', async () => {
    const { stores, call, orgA, id, path } = await withAgent();
    const removed = await call('token-alice', 'POST', `${path}/skills/remove`, {
      fromVersion: 1,
      skillId: 'customer_follow_up',
    });
    expect(removed.status).toBe(200);
    const stored = await stores.specialists.find(orgA as never, id as never);
    expect(stored?.configuration.skills.map((s) => s.id)).toEqual([
      'company_knowledge',
      'pipeline_analysis',
    ]);
    expect(stored?.configuration.tools).toEqual([]);
    expect(stored?.configuration.permissions).toEqual([
      'knowledge.read',
      'opportunity.read',
      'report.read',
    ]);
  });

  it('refuses a version choice, a skill its department does not allow, one it has, and its last', async () => {
    const { call, path } = await withAgent('finance');
    const add = async (skillId: string, version: number, fromVersion = 1) =>
      (await call('token-alice', 'POST', `${path}/skills/add`, { fromVersion, skillId, version }))
        .body;
    expect(await add('conversation_reply', 1)).toEqual({
      error: 'invalid_specialist',
      field: 'skills.choice',
    });
    expect(await add('customer_follow_up', 3)).toMatchObject({ field: 'skills.department' });
    expect(await add('finance_review', 1)).toMatchObject({ field: 'skillId' });
    expect(await add('nope', 1)).toMatchObject({ field: 'skillId' });

    const remove = async (skillId: string, fromVersion: number) =>
      call('token-alice', 'POST', `${path}/skills/remove`, { fromVersion, skillId });
    expect((await remove('company_knowledge', 1)).status).toBe(200);
    expect((await remove('finance_review', 2)).body).toMatchObject({ field: 'skills.last' });
    // A change made from an older version than the stored one changes nothing.
    expect(await add('market_research', 1, 1)).toEqual({
      error: 'specialist_concurrency_conflict',
    });
  });

  it("never reaches another organization's agent, nor without specialist.manage", async () => {
    const { call, orgB, base, id } = await withAgent();
    const viaB = await call('token-bob', 'POST', `${base(orgB)}/specialists/${id}/skills/add`, {
      fromVersion: 1,
      skillId: 'finance_review',
      version: 1,
    });
    expect(viaB).toEqual({ status: 404, body: { error: 'specialist_not_found' } });

    const denied = await withAgent('commercial', true);
    const refused = await denied.call('token-alice', 'POST', `${denied.path}/skills/remove`, {
      fromVersion: 1,
      skillId: 'pipeline_analysis',
    });
    expect(refused.status).toBe(403);
  });
});
