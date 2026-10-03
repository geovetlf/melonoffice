import { ROLES, createAuthorizationService, type Permission } from '@melonoffice/rbac';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * Agent Engine phase 1 over HTTP (ADR-0062): the catalogue, creating an agent from a template,
 * a new configuration version, a status change and what the agent may do. Owner only, per
 * organization, audited with each change.
 */
/** The answers these tests read, loosely: each test checks the exact shape it cares about. */
interface Body {
  readonly [key: string]: unknown;
  readonly id?: string;
  readonly status?: string;
  readonly ready?: boolean;
  readonly organization?: { readonly id: string };
  readonly templates?: readonly { readonly id: string }[];
  readonly skills?: readonly { readonly id: string }[];
  readonly specialists?: readonly { readonly id: string; readonly status: string }[];
}

describe.each(STORES)('agents with storage in %s', (_name, createStores) => {
  async function setup(options: { readonly permissions?: readonly Permission[] } = {}) {
    const stores: Stores = createStores();
    const ctx = setupApp(
      stores,
      options.permissions === undefined
        ? undefined
        : createAuthorizationService({ owner: [...options.permissions] }),
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
    return { stores, call, orgA, orgB, base };
  }

  it('shows the catalogue of templates and skills', async () => {
    const { call, orgA, base } = await setup();
    const got = await call('token-alice', 'GET', `${base(orgA)}/agents/catalogue`);
    expect(got.status).toBe(200);
    expect(got.body.templates?.map((t) => t.id)).toEqual([
      'commercial',
      'marketing',
      'creative',
      'operations',
      'finance',
      'research',
    ]);
    expect(got.body.templates?.[0]).toMatchObject({
      departmentTypeId: 'sales',
      role: { id: 'commercial_agent', version: 1 },
    });
    expect(got.body.skills?.find((s) => s.id === 'conversation_reply')).toEqual({
      id: 'conversation_reply',
      version: 1,
      nameKey: 'agents.skill.conversation_reply.name',
      descriptionKey: 'agents.skill.conversation_reply.description',
      tools: [
        { id: 'message_send', versions: [2, 3] },
        { id: 'conversation_handoff', versions: [1] },
      ],
      actions: [],
      reads: ['conversation.read'],
    });
  });

  it('creates, revises and activates an agent, audited, and says what it may do', async () => {
    const { stores, call, orgA, base } = await setup();
    const created = await call('token-alice', 'POST', `${base(orgA)}/specialists`, {
      templateId: 'commercial',
      displayName: 'Lucía',
    });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      displayName: 'Lucía',
      status: 'draft',
      version: 1,
      role: { id: 'commercial_agent', version: 1 },
    });
    const id = created.body.id as string;
    // The view never shows tools or permissions.
    expect(created.body).not.toHaveProperty('tools');

    const current = await stores.specialists.find(orgA as never, id as never);
    if (current === undefined) throw new Error('agent not stored');
    const revised = await call('token-alice', 'PATCH', `${base(orgA)}/specialists/${id}`, {
      fromVersion: 1,
      configuration: { ...current.configuration, purpose: 'Vender más pollo a la brasa' },
    });
    expect(revised.status).toBe(200);
    expect(revised.body).toMatchObject({ version: 2, purpose: 'Vender más pollo a la brasa' });

    const draft = await call('token-alice', 'GET', `${base(orgA)}/specialists/${id}/capabilities`);
    expect(draft.status).toBe(200);
    expect(draft.body.ready).toBe(false);
    expect(draft.body.problems).toEqual([{ kind: 'not_active', status: 'draft' }]);

    const active = await call('token-alice', 'POST', `${base(orgA)}/specialists/${id}/status`, {
      from: 'draft',
      to: 'active',
    });
    expect(active.status).toBe(200);
    expect(active.body.status).toBe('active');
    const ready = await call('token-alice', 'GET', `${base(orgA)}/specialists/${id}/capabilities`);
    expect(ready.body).toMatchObject({
      id,
      version: 2,
      ready: true,
      permissions: {
        required: [
          'contact.read',
          'follow_up.manage',
          'follow_up.read',
          'knowledge.read',
          'opportunity.read',
          'report.read',
        ],
        missing: [],
      },
      // The commercial template stays at company_knowledge@2 and customer_follow_up@2: their
      // versions 3 (ADR-0130, ADR-0104), the tools the agent asks for mid-task, are offered, and a
      // person decides whether to move to them.
      upgrades: [
        { skillId: 'company_knowledge', from: 2, to: 3 },
        { skillId: 'customer_follow_up', from: 2, to: 3 },
      ],
    });

    const events = (await stores.auditEvents()).filter((e) => e.action.startsWith('specialist.'));
    expect(events.map((e) => [e.action, e.targetVersion])).toEqual([
      ['specialist.created', 1],
      ['specialist.version_created', 2],
      ['specialist.status_changed', 2],
    ]);
    expect(events.every((e) => e.organizationId === orgA)).toBe(true);
    expect(JSON.stringify(events)).not.toContain('Lucía');
    expect(JSON.stringify(events)).not.toContain('pollo');
  });

  it('moves an agent to a newer skill version only when a person asks (ADR-0084)', async () => {
    const { stores, call, orgA, base } = await setup();
    const id = (
      await call('token-alice', 'POST', `${base(orgA)}/specialists`, {
        templateId: 'research',
        displayName: 'Iris',
      })
    ).body.id as string;
    // As an agent made before version 2 was: company_knowledge@1.
    const current = await stores.specialists.find(orgA as never, id as never);
    if (current === undefined) throw new Error('agent not stored');
    await call('token-alice', 'PATCH', `${base(orgA)}/specialists/${id}`, {
      fromVersion: 1,
      configuration: {
        ...current.configuration,
        skills: current.configuration.skills.map((s) =>
          s.id === 'company_knowledge' ? { ...s, version: 1 } : s,
        ),
      },
    });
    const before = await call('token-alice', 'GET', `${base(orgA)}/specialists/${id}/capabilities`);
    // The newest version is offered (RT-1 added version 3, ADR-0130); any may be chosen.
    expect(before.body.upgrades).toEqual([{ skillId: 'company_knowledge', from: 1, to: 3 }]);
    const upgrade = (body: Record<string, unknown>) =>
      call('token-alice', 'POST', `${base(orgA)}/specialists/${id}/skills/upgrade`, body);
    expect(await upgrade({ fromVersion: 2, skillId: 'company_knowledge', version: 4 })).toEqual({
      status: 400,
      body: { error: 'invalid_specialist', field: 'version' },
    });
    const moved = await upgrade({ fromVersion: 2, skillId: 'company_knowledge', version: 2 });
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ version: 3 });
    expect(moved.body.skills).toContainEqual({ id: 'company_knowledge', version: 2 });
    const after = await call('token-alice', 'GET', `${base(orgA)}/specialists/${id}/capabilities`);
    expect(after.body.upgrades).toEqual([{ skillId: 'company_knowledge', from: 2, to: 3 }]);
    expect(await upgrade({ fromVersion: 3, skillId: 'company_knowledge', version: 2 })).toEqual({
      status: 400,
      body: { error: 'invalid_specialist', field: 'version' },
    });
  });

  it('answers bad requests and conflicts with stable codes', async () => {
    const { call, orgA, base } = await setup();
    const bad = await call('token-alice', 'POST', `${base(orgA)}/specialists`, {
      templateId: 'gia',
      displayName: 'GIA',
    });
    expect(bad).toEqual({
      status: 400,
      body: { error: 'invalid_specialist', field: 'templateId' },
    });
    const id = (
      await call('token-alice', 'POST', `${base(orgA)}/specialists`, {
        templateId: 'research',
        displayName: 'Iris',
      })
    ).body.id as string;
    const stale = await call('token-alice', 'POST', `${base(orgA)}/specialists/${id}/status`, {
      from: 'active',
      to: 'paused',
    });
    expect(stale.status).toBe(409);
    const missing = await call(
      'token-alice',
      'POST',
      `${base(orgA)}/specialists/99999999-9999-4999-8999-999999999999/status`,
      { from: 'draft', to: 'active' },
    );
    expect(missing).toEqual({ status: 404, body: { error: 'specialist_not_found' } });
  });

  it("never reaches another organization's agents", async () => {
    const { call, orgA, orgB, base } = await setup();
    const id = (
      await call('token-alice', 'POST', `${base(orgA)}/specialists`, {
        templateId: 'finance',
        displayName: 'Fabia',
      })
    ).body.id as string;
    // Bob, through his own organization: the agent does not exist there.
    const viaB = await call('token-bob', 'POST', `${base(orgB)}/specialists/${id}/status`, {
      from: 'draft',
      to: 'active',
    });
    expect(viaB).toEqual({ status: 404, body: { error: 'specialist_not_found' } });
    const capsB = await call('token-bob', 'GET', `${base(orgB)}/specialists/${id}/capabilities`);
    expect(capsB.status).toBe(404);
    // Bob, naming Alice's organization: tenancy refuses before anything is read.
    const intoA = await call('token-bob', 'POST', `${base(orgA)}/specialists`, {
      templateId: 'finance',
      displayName: 'Intruso',
    });
    expect(intoA.status).toBe(403);
    const list = await call('token-alice', 'GET', `${base(orgA)}/specialists`);
    expect(list.body.specialists?.map((s) => s.id)).toEqual([id]);
    expect(list.body.specialists?.[0]?.status).toBe('draft');
  });

  it('needs specialist.manage to change agents and specialist.read to see them', async () => {
    const { call, orgA, base } = await setup({
      permissions: ROLES.owner.filter((p) => p !== 'specialist.manage'),
    });
    const denied = await call('token-alice', 'POST', `${base(orgA)}/specialists`, {
      templateId: 'finance',
      displayName: 'Fabia',
    });
    expect(denied.status).toBe(403);
    expect((await call('token-alice', 'GET', `${base(orgA)}/agents/catalogue`)).status).toBe(200);

    const blind = await setup({
      permissions: ROLES.owner.filter((p) => p !== 'specialist.read'),
    });
    expect(
      (await blind.call('token-alice', 'GET', `${blind.base(blind.orgA)}/agents/catalogue`)).status,
    ).toBe(403);
  });
});
