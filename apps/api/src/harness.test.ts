import { createCreditService } from '@melonoffice/credits';
import type { OrganizationId, UserId } from '@melonoffice/domain';
import { ROLES, createAuthorizationService, type Permission } from '@melonoffice/rbac';
import { resolveTenant } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * The Melon Agent Harness over HTTP (ADR-0099, block 1): a task in a person's words is routed to
 * an agent and started as that agent's task, or refused with why. Starting needs
 * `specialist.task`; the task is then read through the agent task routes.
 */
interface Body {
  readonly [key: string]: unknown;
  readonly error?: string;
  readonly field?: string;
  readonly id?: string;
  readonly organization?: { readonly id: string };
  readonly strategy?: Record<string, unknown>;
  readonly task?: { readonly id: string; readonly specialistId: string; readonly status: string };
}

describe.each(STORES)('the Harness with storage in %s', (_name, createStores) => {
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
    const aliceId = (await ctx.register('token-alice')) as UserId;
    const bobId = (await ctx.register('token-bob')) as UserId;
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
      (await call(token, 'POST', '/v1/organizations', { name })).body.organization
        ?.id as OrganizationId;
    const orgA = await orgOf('token-alice', 'A');
    const orgB = await orgOf('token-bob', 'B');
    const base = (org: string) => `/v1/organizations/${org}`;
    const credits = createCreditService({ store: stores.credits, organizations: stores.tenancy });
    const fund = async (userId: UserId, org: OrganizationId) =>
      credits.grant(
        await resolveTenant({ actor: 'user', userId, emailVerified: true }, org, stores.tenancy),
        { amount: 10, referenceId: `test-grant:${org}`, reason: 'test_grant' },
      );
    const agent = async (token = 'token-alice', org: string = orgA) => {
      const created = await call(token, 'POST', `${base(org)}/specialists`, {
        templateId: 'commercial',
        displayName: 'Lucía',
      });
      const id = created.body.id as string;
      await call(token, 'POST', `${base(org)}/specialists/${id}/status`, {
        from: 'draft',
        to: 'active',
      });
      return id;
    };
    return { ...ctx, call, orgA, orgB, base, agent, fund, aliceId, bobId };
  }

  it('routes a task to the agent, starts it and lets the person read it as the agent task', async () => {
    const { call, orgA, base, agent, fund, aliceId, kicked } = await setup();
    const id = await agent();
    await fund(aliceId, orgA);
    const started = await call('token-alice', 'POST', `${base(orgA)}/harness/tasks`, {
      request: 'Analiza estas ventas y dime qué clientes debería contactar.',
      idempotencyKey: 'h-1',
    });
    expect(started.status).toBe(202);
    expect(started.body.strategy).toMatchObject({
      verdict: 'ready',
      intent: 'analysis',
      complexity: 'complex',
      plan: 'single_step',
      context: ['company_brain', 'crm'],
      agent: { id, name: 'Lucía', department: 'sales' },
      model: { strategy: 'quality_first' },
      tools: [
        {
          id: 'follow_up_schedule',
          version: 2,
          authorization: 'sensitive',
          approvalRequired: true,
        },
      ],
      budget: 'available',
    });
    // No identity or balance is echoed back.
    expect(started.body.strategy).not.toHaveProperty('balance');
    expect(JSON.stringify(started.body.strategy)).not.toContain(aliceId);
    expect(started.body.task).toMatchObject({ specialistId: id, status: 'running' });
    expect(kicked).toEqual([started.body.task?.id]);
    const read = await call(
      'token-alice',
      'GET',
      `${base(orgA)}/agent-tasks/${started.body.task?.id}`,
    );
    expect(read.body).toMatchObject({
      request: 'Analiza estas ventas y dime qué clientes debería contactar.',
      status: 'running',
    });
  });

  it('prepares without starting on a dry run', async () => {
    const { call, orgA, base, agent, fund, aliceId, kicked } = await setup();
    await agent();
    await fund(aliceId, orgA);
    const dry = await call('token-alice', 'POST', `${base(orgA)}/harness/tasks`, {
      request: 'Clasifica este mensaje',
      dryRun: true,
    });
    expect(dry.status).toBe(200);
    expect(dry.body).toMatchObject({
      strategy: { verdict: 'ready', model: { strategy: 'cost_optimized' }, context: [] },
      task: null,
    });
    expect(kicked).toEqual([]);
  });

  it('starts nothing without credits, and says why', async () => {
    const { call, orgA, base, agent, kicked } = await setup();
    await agent();
    const refused = await call('token-alice', 'POST', `${base(orgA)}/harness/tasks`, {
      request: 'Redacta un saludo',
    });
    expect(refused.status).toBe(200);
    expect(refused.body).toMatchObject({
      strategy: { verdict: 'refused', reasons: ['insufficient_credits'], budget: 'insufficient' },
      task: null,
    });
    expect(kicked).toEqual([]);
  });

  it("keeps each organization to its own agents, and refuses another organization's route", async () => {
    const { call, orgA, orgB, base, agent, fund, bobId } = await setup();
    const lucia = await agent();
    await fund(bobId, orgB);
    const fromB = await call('token-bob', 'POST', `${base(orgB)}/harness/tasks`, {
      request: 'Redacta un saludo',
      specialistId: lucia,
    });
    expect(fromB.body).toMatchObject({
      strategy: { verdict: 'no_agent', reasons: ['named_agent_not_active'], agent: null },
      task: null,
    });
    const intoA = await call('token-bob', 'POST', `${base(orgA)}/harness/tasks`, {
      request: 'Redacta un saludo',
    });
    expect(intoA.status).toBe(403);
  });

  it('refuses a person without the permission, and a malformed task', async () => {
    const denied = await setup({ without: ['specialist.task'] });
    expect(
      (
        await denied.call('token-alice', 'POST', `${denied.base(denied.orgA)}/harness/tasks`, {
          request: 'Hola',
        })
      ).status,
    ).toBe(403);
    const { call, orgA, base } = await setup();
    const post = (body: unknown) =>
      call('token-alice', 'POST', `${base(orgA)}/harness/tasks`, body);
    expect(await post({ request: ' ' })).toEqual({
      status: 400,
      body: { error: 'invalid_task', field: 'request' },
    });
    expect(await post({ request: 'Hola', organizationId: orgA })).toEqual({
      status: 400,
      body: { error: 'invalid_task', field: 'organizationId' },
    });
    expect(await post({ request: 'Hola', dryRun: 'yes' })).toEqual({
      status: 400,
      body: { error: 'invalid_task', field: 'dryRun' },
    });
  });
});
