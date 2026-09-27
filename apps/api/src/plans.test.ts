import { departmentIdOf } from '@melonoffice/departments';
import type {
  DepartmentTypeId,
  IsoTimestamp,
  OrganizationId,
  PlanId,
  Specialist,
  UserId,
} from '@melonoffice/domain';
import { createExecutionService } from '@melonoffice/execution';
import { createPlanService, createPlanValidator } from '@melonoffice/planning';
import { createAuthorizationService, ROLES } from '@melonoffice/rbac';
import {
  applySpecialistStatus,
  createSpecialistService,
  newSpecialist,
} from '@melonoffice/specialists';
import { resolveTenant, type TenantContext } from '@melonoffice/tenancy';
import { defaultToolRegistry } from '@melonoffice/tools';
import { createWorkflowService } from '@melonoffice/workflows';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

const AT = '2026-09-27T12:00:00.000Z' as IsoTimestamp;

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing value');
  return value;
};

interface PlanDetail {
  id: string;
  status: string;
  current: { version: number; digest: string; steps: { id: string }[] };
  [key: string]: unknown;
}

describe.each(STORES)('plans and workflows API with storage in %s', (_name, createStores) => {
  async function setup(roles: Record<string, readonly string[]> = ROLES) {
    const stores: Stores = createStores();
    const authorization = createAuthorizationService(roles as never);
    const ctx = setupApp(stores, authorization);
    const aliceId = (await ctx.register('token-alice')) as UserId;
    await ctx.register('token-bob');
    const createOrg = async (token: string, name: string) => {
      const response = await ctx.app.request(
        '/v1/organizations',
        ctx.as(token, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name }),
        }),
      );
      return ((await response.json()) as { organization: { id: string } }).organization
        .id as OrganizationId;
    };
    const orgA = await createOrg('token-alice', 'A');
    const orgB = await createOrg('token-bob', 'B');
    const tenant = await resolveTenant(
      { actor: 'user', userId: aliceId, emailVerified: true },
      orgA,
      stores.tenancy,
    );
    // The server-side services the planner and workflows use; no route reaches them.
    const specialists = createSpecialistService({
      repository: stores.specialists,
      departments: stores.departments,
      organizations: stores.tenancy,
      authorization,
    });
    const executions = createExecutionService({
      repository: stores.executions,
      organizations: stores.tenancy,
      assignments: specialists.assignments,
    });
    const plans = createPlanService({
      repository: stores.plans,
      executions,
      validator: createPlanValidator({
        specialists,
        departments: stores.departments,
        tools: defaultToolRegistry(),
        authorization,
        environment: 'dev',
      }),
      organizations: stores.tenancy,
      authorization,
      audit: stores.audit,
    });
    const workflows = createWorkflowService({
      repository: stores.workflows,
      plans,
      specialists,
      departments: stores.departments,
      organizations: stores.tenancy,
      authorization,
    });

    async function seed(type: string, role: string): Promise<Specialist> {
      const department = must(
        await stores.departments.find(orgA, departmentIdOf(orgA, type as DepartmentTypeId)),
      );
      const write = newSpecialist(
        {
          organizationId: orgA,
          displayName: 'Specialist',
          configuration: {
            departmentId: department.id,
            mainRoleId: role,
            roleVersion: 1,
            capabilities: [],
            skills: [],
            tools: [],
            permissions: ['organization.read'],
            policies: {},
          } as never,
        },
        department,
        aliceId,
        AT,
      );
      await stores.specialists.create(write);
      return stores.specialists.update(orgA, write.specialist.identity.id, (s) =>
        applySpecialistStatus(s, { from: 'draft', to: 'active' }, AT),
      );
    }
    const owner = await seed('leadership', 'chief_of_staff');
    const researcher = await seed('research', 'market_researcher');

    async function planning(t: TenantContext) {
      const created = await executions.create(t, {
        mode: 'plan',
        input: { type: 'task', id: 'task-1' },
        specialistId: owner.identity.id,
        specialistVersion: owner.version,
        departmentId: owner.configuration.departmentId,
        versionSnapshot: {
          schemaVersion: 1,
          components: [{ kind: 'specialist', id: owner.identity.id, version: '1' }],
        },
      });
      return executions.changeStatus(t, created.id, { from: 'pending', to: 'planning' });
    }

    async function propose(riskLevel: 'low' | 'high' = 'high') {
      const execution = await planning(tenant);
      const outcome = await plans.propose(tenant, {
        executionId: execution.id,
        proposal: {
          summary: 'Market study',
          objective: 'Study the melon market.',
          riskLevel,
          steps: [
            {
              id: 'research',
              kind: 'specialist',
              label: 'Research',
              dependsOn: [],
              specialistId: researcher.identity.id,
              verification: { policy: 'checks', expectedOutput: 'report', requiredChecks: [] },
              budget: { inputTokens: 1_000, outputTokens: 1_000 },
            },
          ],
        },
        source: {
          kind: 'planner',
          model: { provider: 'alpha', id: 'alpha-large', version: '2026-09-01' },
          policy: { id: 'default_model', version: 1 },
        },
      });
      if (outcome.status !== 'planned') throw new Error(outcome.reason);
      return { execution, plan: outcome.plan, version: outcome.version };
    }

    const get = (token: string, path: string) =>
      ctx.app.request(`/v1/organizations/${orgA}${path}`, ctx.as(token));
    const post = (token: string, path: string, body?: unknown) =>
      ctx.app.request(
        `/v1/organizations/${orgA}${path}`,
        ctx.as(token, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        }),
      );
    return { ...ctx, stores, orgA, orgB, tenant, workflows, propose, get, post };
  }

  it('lists and shows plans with the digest a user approves, and nothing internal', async () => {
    const t = await setup();
    const empty = await t.get('token-alice', '/plans');
    expect(await empty.json()).toEqual({ plans: [] });
    const { plan, version } = await t.propose();
    const listed = (await (await t.get('token-alice', '/plans')).json()) as { plans: unknown[] };
    expect(listed.plans).toEqual([
      expect.objectContaining({ id: plan.id, status: 'approval_required' }),
    ]);
    const response = await t.get('token-alice', `/plans/${plan.id}`);
    expect(response.status).toBe(200);
    const detail = (await response.json()) as PlanDetail;
    expect(detail.current).toEqual(
      expect.objectContaining({ version: 1, digest: version.digest, riskLevel: 'high' }),
    );
    // An estimate is only ever an estimate: unknown without a credit rate (D-12).
    expect(detail.current).toEqual(
      expect.objectContaining({
        estimate: { status: 'unknown', costMicroUsd: null, credits: null },
      }),
    );
    expect(Object.keys(detail)).not.toContain('revision');
    expect(Object.keys(detail)).not.toContain('organizationId');
  });

  it('keeps other organizations out', async () => {
    const t = await setup();
    const { plan } = await t.propose();
    const forbidden = await t.get('token-bob', `/plans/${plan.id}`);
    expect(forbidden.status).toBe(403);
    const fromB = await t.app.request(
      `/v1/organizations/${t.orgB}/plans/${plan.id}`,
      t.as('token-bob'),
    );
    expect(fromB.status).toBe(404);
    expect(await fromB.json()).toEqual({ error: 'plan_not_found' });
    const listB = await t.app.request(`/v1/organizations/${t.orgB}/plans`, t.as('token-bob'));
    expect(await listB.json()).toEqual({ plans: [] });
  });

  it('approves exactly the version the user saw, once', async () => {
    const t = await setup();
    const { plan, version } = await t.propose();
    const seen = { version: 1, digest: version.digest };
    expect((await t.post('token-alice', `/plans/${plan.id}/approve`)).status).toBe(400);
    expect(
      (await t.post('token-alice', `/plans/${plan.id}/approve`, { ...seen, approved: true }))
        .status,
    ).toBe(400);
    const stale = await t.post('token-alice', `/plans/${plan.id}/approve`, {
      ...seen,
      digest: '0'.repeat(64),
    });
    expect(stale.status).toBe(409);
    expect(await stale.json()).toEqual({ error: 'plan_version_mismatch' });
    const approved = await t.post('token-alice', `/plans/${plan.id}/approve`, seen);
    expect(approved.status).toBe(200);
    expect(await approved.json()).toEqual(
      expect.objectContaining({
        status: 'approved',
        decision: expect.objectContaining({ decision: 'approved', version: 1 }),
      }),
    );
    expect((await t.post('token-alice', `/plans/${plan.id}/approve`, seen)).status).toBe(409);
    const events = await t.stores.auditEvents();
    expect(events.filter((e) => e.action === 'plan.created')).toHaveLength(1);
    expect(events.filter((e) => e.action === 'plan.approved')).toEqual([
      expect.objectContaining({
        result: 'success',
        target: { type: 'plan', id: plan.id },
        transition: { from: 'approval_required', to: 'approved' },
      }),
    ]);
  });

  it('rejects a plan and ends its execution', async () => {
    const t = await setup();
    const { plan, version, execution } = await t.propose();
    const rejected = await t.post('token-alice', `/plans/${plan.id}/reject`, {
      version: 1,
      digest: version.digest,
    });
    expect(rejected.status).toBe(200);
    const view = (await (await t.get('token-alice', `/executions/${execution.id}`)).json()) as {
      status: string;
      cancellation: { reason: string };
    };
    expect(view.status).toBe('cancelled');
    expect(view.cancellation.reason).toBe('plan_rejected');
  });

  it('has no approval path for a plan that needs none', async () => {
    const t = await setup();
    const { plan, version } = await t.propose('low');
    const response = await t.post('token-alice', `/plans/${plan.id}/approve`, {
      version: 1,
      digest: version.digest,
    });
    expect(response.status).toBe(409);
  });

  it('offers no route that creates, runs or delegates a plan', async () => {
    const t = await setup();
    const { plan } = await t.propose();
    for (const path of ['/plans', `/plans/${plan.id}/delegate`, `/plans/${plan.id}/execute`]) {
      expect((await t.post('token-alice', path, {})).status).toBe(404);
    }
    expect((await t.post('token-alice', '/workflows', {})).status).toBe(404);
  });

  it('needs plan.read and approval.approve', async () => {
    const t = await setup({
      owner: ROLES.owner.filter((p) => p !== 'plan.read' && p !== 'approval.approve'),
    });
    const { plan, version } = await t.propose();
    expect((await t.get('token-alice', '/plans')).status).toBe(403);
    const approve = await t.post('token-alice', `/plans/${plan.id}/approve`, {
      version: 1,
      digest: version.digest,
    });
    expect(approve.status).toBe(403);
    expect(await approve.json()).toEqual({ error: 'permission_denied' });
  });

  it('refuses to show a plan version whose content no longer matches its digest', async () => {
    const t = await setup();
    const { plan } = await t.propose();
    await t.stores.tamperPlanVersion(t.orgA, plan.id as PlanId, 1);
    const response = await t.get('token-alice', `/plans/${plan.id}`);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: 'internal_error' });
  });

  it('lists and shows workflows and their current version', async () => {
    const t = await setup();
    const workflow = await t.workflows.create(t.tenant, {
      name: 'Market study',
      steps: [
        {
          id: 'research',
          kind: 'specialist',
          label: 'Research',
          dependsOn: [],
          assignee: { departmentTypeId: 'research', roleId: 'market_researcher' },
          verification: { policy: 'checks', expectedOutput: 'report', requiredChecks: [] },
        },
      ],
    });
    const list = (await (await t.get('token-alice', '/workflows')).json()) as {
      workflows: unknown[];
    };
    expect(list.workflows).toEqual([expect.objectContaining({ id: workflow.id, status: 'draft' })]);
    const detail = (await (await t.get('token-alice', `/workflows/${workflow.id}`)).json()) as {
      current: { steps: { assignee: unknown }[] };
    };
    expect(detail.current.steps[0]?.assignee).toEqual({
      departmentTypeId: 'research',
      roleId: 'market_researcher',
    });
    const fromB = await t.app.request(
      `/v1/organizations/${t.orgB}/workflows/${workflow.id}`,
      t.as('token-bob'),
    );
    expect(fromB.status).toBe(404);
  });
});
