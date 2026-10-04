import { departmentIdOf } from '@melonoffice/departments';
import type {
  DepartmentTypeId,
  IsoTimestamp,
  OrganizationId,
  PlanId,
  Specialist,
  UserId,
} from '@melonoffice/domain';
import { createExecutionService, executionIdFor } from '@melonoffice/execution';
import {
  createDelegation,
  createPlanService,
  createPlanValidator,
  delegationKey,
  type PlanRepository,
} from '@melonoffice/planning';
import { buildAuditEvent } from '@melonoffice/audit';
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
  async function setup(
    roles: Record<string, readonly string[]> = ROLES,
    options: { readonly runPlans?: boolean } = {},
  ) {
    const stores: Stores = createStores();
    const authorization = createAuthorizationService(roles as never);
    const ctx = setupApp(stores, authorization, undefined, undefined, undefined, options);
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
      executions,
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
    const marketer = await seed('marketing', 'campaign_manager');
    const delegationWith = (repository: PlanRepository = stores.plans) =>
      createDelegation({
        plans: repository,
        executions,
        specialists,
        organizations: stores.tenancy,
        authorization,
      });

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
    /**
     * A plan with two specialist steps, for delegation: ready, or waiting on a person's approval,
     * and with an approval step when asked.
     */
    async function proposeWork(
      options: { readonly approvalRequired?: boolean; readonly gate?: boolean } = {},
    ) {
      const execution = await planning(tenant);
      const step = (id: string, s: Specialist, dependsOn: string[] = []) => ({
        id,
        kind: 'specialist',
        label: `Work ${id}`,
        dependsOn,
        specialistId: s.identity.id,
        verification: { policy: 'checks', expectedOutput: 'report', requiredChecks: [] },
        ...(options.approvalRequired === true && id === 'research'
          ? { approvalRequired: true }
          : {}),
      });
      const outcome = await plans.propose(tenant, {
        executionId: execution.id,
        proposal: {
          summary: 'Market study',
          objective: 'Study the melon market.',
          steps: [
            step('research', researcher),
            step('campaign', marketer, ['research']),
            ...(options.gate === true
              ? [{ id: 'sign_off', kind: 'approval', label: 'Sign off', dependsOn: ['campaign'] }]
              : []),
          ],
        },
        source: {
          kind: 'planner',
          model: { provider: 'alpha', id: 'alpha-large', version: '2026-09-01' },
          policy: { id: 'default_model', version: 1 },
        },
      });
      if (outcome.status !== 'planned') throw new Error(outcome.reason);
      const ids = ['research', 'campaign'].map((stepId) =>
        executionIdFor(orgA, delegationKey(outcome.plan.id, stepId)),
      );
      return { execution, plan: outcome.plan, ids };
    }

    return {
      ...ctx,
      stores,
      orgA,
      orgB,
      tenant,
      workflows,
      executions,
      propose,
      proposeWork,
      delegationWith,
      get,
      post,
    };
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
        estimate: { status: 'unknown', credits: null },
      }),
    );
    expect(Object.keys(detail)).not.toContain('revision');
    expect(Object.keys(detail)).not.toContain('organizationId');
    // Which model wrote the plan, and its internal cost, are the platform's (ADR-0082).
    expect(detail.current).toEqual(expect.objectContaining({ source: { kind: 'planner' } }));
    expect(JSON.stringify(detail)).not.toMatch(/alpha|costMicroUsd|default_model/);
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

  it('WF-1: approving starts the plan: its first step is started and queued, the rest wait', async () => {
    const t = await setup(ROLES, { runPlans: true });
    const { plan } = await t.proposeWork({ approvalRequired: true });
    const version = must(await t.stores.plans.findVersion(t.orgA, plan.id, plan.version));
    const approved = await t.post('token-alice', `/plans/${plan.id}/approve`, {
      version: 1,
      digest: version.digest,
    });
    expect(approved.status).toBe(200);
    const view = (await approved.json()) as {
      status: string;
      delegations: { stepId: string; executionId: string }[];
    };
    expect(view.status).toBe('executing');
    const [research, campaign] = view.delegations.map((d) => d.executionId);
    expect(t.kicked).toEqual([research]);

    const steps = await t.get('token-alice', `/plans/${plan.id}/steps`);
    expect(steps.status).toBe(200);
    expect(await steps.json()).toEqual({
      planId: plan.id,
      status: 'executing',
      steps: [
        {
          stepId: 'research',
          label: 'Work research',
          executionId: research,
          status: 'running',
          failure: null,
          answer: null,
          missing: [],
        },
        {
          stepId: 'campaign',
          label: 'Work campaign',
          executionId: campaign,
          status: 'pending',
          failure: null,
          answer: null,
          missing: [],
        },
      ],
    });
    // Approving again changes nothing and starts nothing.
    expect(
      (
        await t.post('token-alice', `/plans/${plan.id}/approve`, {
          version: 1,
          digest: version.digest,
        })
      ).status,
    ).toBe(409);
    expect(t.kicked).toEqual([research]);
  });

  it('WF-1: a plan with a step it cannot run is not approved at all', async () => {
    const t = await setup(ROLES, { runPlans: true });
    // An approval step has no defined behaviour in a plan yet: the plan is refused before the
    // decision, so an approval never covers a plan that would stop halfway.
    const { plan } = await t.proposeWork({ approvalRequired: true, gate: true });
    const version = must(await t.stores.plans.findVersion(t.orgA, plan.id, plan.version));
    const refused = await t.post('token-alice', `/plans/${plan.id}/approve`, {
      version: 1,
      digest: version.digest,
    });
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: 'plan_not_runnable' });
    expect((await t.stores.plans.find(t.orgA, plan.id))?.status).toBe('approval_required');
    expect(t.kicked).toEqual([]);
  });

  it('WF-1: without the plan runtime, approving records the decision and runs nothing', async () => {
    const t = await setup();
    const { plan } = await t.proposeWork({ approvalRequired: true });
    const version = must(await t.stores.plans.findVersion(t.orgA, plan.id, plan.version));
    const approved = await t.post('token-alice', `/plans/${plan.id}/approve`, {
      version: 1,
      digest: version.digest,
    });
    expect(((await approved.json()) as { status: string }).status).toBe('approved');
    expect(t.kicked).toEqual([]);
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
    // Workflows are created by the owner (ADR-0071), but never from an empty body.
    expect((await t.post('token-alice', '/workflows', {})).status).toBe(400);
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

  describe('WF-2: the owner builds and plans a workflow', () => {
    const researchStep = {
      id: 'research',
      kind: 'specialist',
      label: 'Research',
      dependsOn: [],
      assignee: { departmentTypeId: 'research', roleId: 'market_researcher' },
      verification: { policy: 'checks', expectedOutput: 'report', requiredChecks: [] },
    };
    const campaignStep = {
      ...researchStep,
      id: 'campaign',
      label: 'Campaign',
      dependsOn: ['research'],
      assignee: { departmentTypeId: 'marketing', roleId: 'campaign_manager' },
    };

    async function activeWorkflow(t: Awaited<ReturnType<typeof setup>>, steps: unknown[]) {
      const created = await t.post('token-alice', '/workflows', { name: 'Market study', steps });
      expect(created.status).toBe(201);
      const { id } = (await created.json()) as { id: string };
      const active = await t.post('token-alice', `/workflows/${id}/status`, {
        from: 'draft',
        to: 'active',
      });
      expect(active.status).toBe(200);
      return id;
    }

    it('creates, versions and activates a workflow, then plans it and the approved plan runs', async () => {
      const t = await setup(ROLES, { runPlans: true });
      const id = await activeWorkflow(t, [researchStep]);
      const versioned = await t.post('token-alice', `/workflows/${id}/versions`, {
        steps: [researchStep, campaignStep],
      });
      expect(versioned.status).toBe(201);
      expect(await versioned.json()).toMatchObject({ id, version: 2, status: 'active' });

      const planned = await t.post('token-alice', `/workflows/${id}/plans`, { requestKey: 'r-1' });
      expect(planned.status).toBe(201);
      const plan = (await planned.json()) as PlanDetail & {
        current: { source: unknown; approvalRequired: boolean };
      };
      // Always waits for the person, even with no approval step.
      expect(plan.status).toBe('approval_required');
      expect(plan.current.approvalRequired).toBe(true);
      expect(plan.current.source).toEqual({ kind: 'workflow', workflowId: id, workflowVersion: 2 });
      expect(plan.current.steps.map((s) => s.id)).toEqual(['research', 'campaign']);
      // The same request again is the same plan.
      const again = await t.post('token-alice', `/workflows/${id}/plans`, { requestKey: 'r-1' });
      expect(((await again.json()) as PlanDetail).id).toBe(plan.id);
      expect(t.kicked).toEqual([]);

      const approved = await t.post('token-alice', `/plans/${plan.id}/approve`, {
        version: plan.current.version,
        digest: plan.current.digest,
      });
      expect(approved.status).toBe(200);
      const view = (await approved.json()) as {
        status: string;
        delegations: { stepId: string; executionId: string }[];
      };
      expect(view.status).toBe('executing');
      // The first step is started and queued for the worker; the second waits on it.
      const research = view.delegations.find((d) => d.stepId === 'research')?.executionId;
      expect(t.kicked).toEqual([research]);
    });

    it('ADR-0144: a workflow with a policy check and a branch is shown, planned and approved', async () => {
      const t = await setup(ROLES, { runPlans: true });
      const check = {
        id: 'policy',
        kind: 'condition',
        label: 'Discount within policy',
        dependsOn: ['research'],
        decision: {
          decision: 'action.policy_check',
          continueOn: ['allowed'],
          input: { action: 'opportunity.offer_discount', discountPercent: 15 },
        },
      };
      const after = { ...campaignStep, dependsOn: ['policy'] };
      const branch = { ...campaignStep, id: 'branch', label: 'Branch', dependsOn: ['research'] };
      const id = await activeWorkflow(t, [researchStep, check, after, branch]);

      const detail = (await (await t.get('token-alice', `/workflows/${id}`)).json()) as {
        current: { steps: Record<string, unknown>[] };
      };
      expect(detail.current.steps.map((s) => [s.id, s.kind, s.dependsOn])).toEqual([
        ['research', 'specialist', []],
        ['policy', 'condition', ['research']],
        ['campaign', 'specialist', ['policy']],
        ['branch', 'specialist', ['research']],
      ]);
      expect(detail.current.steps[1]).toMatchObject({ assignee: null, decision: check.decision });
      expect(detail.current.steps[0]).toMatchObject({ decision: null });

      const planned = await t.post('token-alice', `/workflows/${id}/plans`, { requestKey: 'r-c' });
      expect(planned.status).toBe(201);
      const plan = (await planned.json()) as PlanDetail;
      const approved = await t.post('token-alice', `/plans/${plan.id}/approve`, {
        version: plan.current.version,
        digest: plan.current.digest,
      });
      // A decided condition is a step the plan can run (WF-4), so the plan starts.
      expect(approved.status).toBe(200);
      expect(((await approved.json()) as { status: string }).status).toBe('executing');
    });

    it('answers a refused plan with 422 and why, and keeps the answer for a repeat', async () => {
      const t = await setup();
      const id = await activeWorkflow(t, [
        researchStep,
        {
          id: 'search',
          kind: 'tool',
          label: 'Search',
          dependsOn: ['research'],
          performedBy: 'research',
          tool: { id: 'unknown_tool', version: 1 },
        },
      ]);
      const refused = await t.post('token-alice', `/workflows/${id}/plans`, { requestKey: 'r' });
      expect(refused.status).toBe(422);
      const body = (await refused.json()) as { error: string; reason: string };
      expect(body.error).toBe('plan_refused');
      const again = await t.post('token-alice', `/workflows/${id}/plans`, { requestKey: 'r' });
      expect(again.status).toBe(422);
      expect(await again.json()).toEqual(body);
    });

    it('refuses bad bodies, wrong moves, inactive workflows and other organizations', async () => {
      const t = await setup();
      const bad = await t.post('token-alice', '/workflows', { name: 'X', steps: [], extra: 1 });
      expect(bad.status).toBe(400);
      const invalid = await t.post('token-alice', '/workflows', { name: 'X', steps: 'none' });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toEqual({ error: 'invalid_workflow', detail: 'steps' });
      const created = await t.post('token-alice', '/workflows', {
        name: 'Market study',
        steps: [researchStep],
      });
      const { id } = (await created.json()) as { id: string };
      // Not active yet: nothing to plan.
      const draft = await t.post('token-alice', `/workflows/${id}/plans`, { requestKey: 'r' });
      expect(draft.status).toBe(409);
      expect(await draft.json()).toEqual({ error: 'workflow_not_active' });
      const wrong = await t.post('token-alice', `/workflows/${id}/status`, {
        from: 'active',
        to: 'paused',
      });
      expect(wrong.status).toBe(409);
      const unknown = await t.post('token-alice', `/workflows/${id}/status`, {
        from: 'draft',
        to: 'running',
      });
      expect(unknown.status).toBe(400);
      expect(
        (await t.post('token-alice', `/workflows/${id}/plans`, { requestKey: 'bad key' })).status,
      ).toBe(400);
      // Another organization's workflow answers like a missing one.
      for (const path of ['plans', 'versions', 'status']) {
        const fromB = await t.app.request(
          `/v1/organizations/${t.orgB}/workflows/${id}/${path}`,
          t.as('token-bob', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(
              path === 'plans'
                ? { requestKey: 'r' }
                : path === 'status'
                  ? { from: 'draft', to: 'active' }
                  : { steps: [researchStep] },
            ),
          }),
        );
        expect(fromB.status).toBe(404);
      }
    });

    it('needs workflow.manage to change a workflow and plan.create to plan one', async () => {
      const t = await setup({
        owner: ROLES.owner.filter((p) => p !== 'workflow.manage' && p !== 'plan.create'),
      });
      const created = await t.post('token-alice', '/workflows', {
        name: 'Market study',
        steps: [researchStep],
      });
      expect(created.status).toBe(403);
      // The permission is checked before the workflow is looked up.
      const id = '00000000-0000-4000-8000-000000000000';
      const planned = await t.post('token-alice', `/workflows/${id}/plans`, { requestKey: 'r' });
      expect(planned.status).toBe(403);
    });
  });

  describe('delegation', () => {
    /** One plan, one delegation set, one child per specialist step, recorded once. */
    async function expectDelegated(
      t: Awaited<ReturnType<typeof setup>>,
      work: Awaited<ReturnType<Awaited<ReturnType<typeof setup>>['proposeWork']>>,
    ) {
      const plan = must(await t.stores.plans.find(t.orgA, work.plan.id));
      expect(plan.status).toBe('executing');
      expect(plan.delegationState).toBe('completed');
      expect(plan.delegations.map((d) => d.executionId)).toEqual(work.ids);
      const events = await t.stores.auditEvents();
      const created = events
        .filter((e) => e.action === 'execution.created')
        .map((e) => e.target?.id)
        .filter((id) => id !== work.execution.id);
      expect(created.sort()).toEqual([...work.ids].sort());
      // Events of one transaction share a time, so their stored order is not meaningful.
      expect(
        events
          .filter((e) => e.action === 'delegation.created')
          .map((e) => e.target?.id)
          .sort(),
      ).toEqual([...work.ids].sort());
      expect(
        events.filter((e) => e.action === 'plan.state_changed' && e.target?.id === plan.id),
      ).toHaveLength(1);
      for (const id of work.ids) {
        const child = await t.executions.get(t.tenant, must(id));
        expect(child.parentExecutionId).toBe(work.execution.id);
        expect(child.status).toBe('pending');
      }
      expect((await t.executions.get(t.tenant, work.execution.id)).status).toBe('running');
    }

    it('converges concurrent attempts on one child per step', async () => {
      const t = await setup();
      const work = await t.proposeWork();
      const delegation = t.delegationWith();
      const results = await Promise.all(
        Array.from({ length: 4 }, () => delegation.delegate(t.tenant, work.plan.id)),
      );
      for (const r of results) expect(r.children.map((c) => c.id)).toEqual(work.ids);
      await expectDelegated(t, work);
    });

    it('resumes a delegation that failed after its children, without duplicating them', async () => {
      const t = await setup();
      const work = await t.proposeWork();
      let updates = 0;
      const failing: PlanRepository = {
        find: (org, id) => t.stores.plans.find(org, id),
        findVersion: (org, id, v) => t.stores.plans.findVersion(org, id, v),
        list: (org, limit) => t.stores.plans.list(org, limit),
        create: (write) => t.stores.plans.create(write),
        async update(org, id, change) {
          updates += 1;
          // Update 1 claims the delegation; update 2 would mark the plan `executing`.
          if (updates === 2) throw new Error('storage unavailable');
          return t.stores.plans.update(org, id, change);
        },
      };
      await expect(t.delegationWith(failing).delegate(t.tenant, work.plan.id)).rejects.toThrow(
        'storage unavailable',
      );
      const halfway = must(await t.stores.plans.find(t.orgA, work.plan.id));
      expect(halfway.delegationState).toBe('creating');
      expect(halfway.status).toBe('ready');
      await Promise.all([
        t.delegationWith().delegate(t.tenant, work.plan.id),
        t.delegationWith().delegate(t.tenant, work.plan.id),
      ]);
      await expectDelegated(t, work);
    });
  });

  describe('workflow audit', () => {
    const steps = [
      {
        id: 'research',
        kind: 'specialist',
        label: 'Research',
        dependsOn: [],
        assignee: { departmentTypeId: 'research', roleId: 'market_researcher' },
        verification: { policy: 'checks', expectedOutput: 'report', requiredChecks: [] },
      },
    ];

    it('stores each workflow change with its audit event', async () => {
      const t = await setup();
      const workflow = await t.workflows.create(t.tenant, { name: 'Market study', steps });
      await t.workflows.publishVersion(t.tenant, workflow.id, { steps });
      await t.workflows.changeStatus(t.tenant, workflow.id, { from: 'draft', to: 'active' });
      const events = (await t.stores.auditEvents()).filter((e) => e.action.startsWith('workflow.'));
      expect(
        events.map((e) => [e.action, e.targetVersion, e.transition?.from, e.transition?.to]),
      ).toEqual([
        ['workflow.created', 1, undefined, undefined],
        ['workflow.version_created', 2, undefined, undefined],
        ['workflow.state_changed', 2, 'draft', 'active'],
      ]);
      for (const e of events) {
        expect(e.organizationId).toBe(t.orgA);
        expect(e.target).toEqual({ type: 'workflow', id: workflow.id });
        expect(e.actor).toEqual(expect.objectContaining({ type: 'user', via: 'direct' }));
      }
    });

    it('rolls a workflow change back when its audit event cannot be written', async () => {
      const t = await setup();
      const workflow = await t.workflows.create(t.tenant, { name: 'Market study', steps });
      const [recorded] = (await t.stores.auditEvents()).filter(
        (e) => e.action === 'workflow.created',
      );
      // An event whose id is already stored: the audit write fails inside the transaction.
      const clash = {
        ...buildAuditEvent(
          {
            action: 'workflow.state_changed',
            result: 'success',
            actor: { type: 'user', userId: workflow.createdBy, via: 'direct' },
            organizationId: t.orgA,
            target: { type: 'workflow', id: workflow.id },
            targetVersion: 1,
            transition: { from: 'draft', to: 'active' },
            source: 'api',
          },
          new Date(),
        ),
        id: must(recorded).id,
      };
      await expect(
        t.stores.workflows.update(t.orgA, workflow.id, (current) => ({
          workflow: { ...current, status: 'active', revision: current.revision + 1 },
          events: [clash],
        })),
      ).rejects.toThrow();
      expect(await t.workflows.get(t.tenant, workflow.id)).toEqual(workflow);
    });
  });
});
