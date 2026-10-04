import { departmentIdOf } from '@melonoffice/departments';
import type {
  DepartmentTypeId,
  ExecutionId,
  IsoTimestamp,
  OrganizationId,
  Plan,
  PlanId,
  Specialist,
  UserId,
} from '@melonoffice/domain';
import { createApprovalService, createPlanStepApprovals } from '@melonoffice/approvals';
import {
  createExecutionService,
  executionIdFor,
  type ExecutionService,
} from '@melonoffice/execution';
import {
  createDelegation,
  createPlanConductor,
  createPlanService,
  createPlanStepAttempts,
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
import { resolveRuntimeTenant, resolveTenant, type TenantContext } from '@melonoffice/tenancy';
import { defaultToolRegistry, digestOf } from '@melonoffice/tools';
import { createWorkflowService } from '@melonoffice/workflows';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

const AT = '2026-09-27T12:00:00.000Z' as IsoTimestamp;

/** A passing check, as the runtime's verifier records one. */
const PASSED = {
  code: 'report_ready',
  result: 'passed',
  evidence: { type: 'x', id: 'y' },
} as const;

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

    async function seed(
      type: string,
      role: string,
      tools: readonly { id: string; version: number }[] = [],
    ): Promise<Specialist> {
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
            tools,
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
    // ADR-0151: the marketer may search the Company Brain, the one runtime tool there is.
    const marketer = await seed('marketing', 'campaign_manager', [
      { id: 'knowledge_search', version: 1 },
    ]);
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
      options: {
        readonly approvalRequired?: boolean;
        readonly gate?: boolean;
        /** ADR-0146: `campaign` asks a person before it runs; `brief` runs beside it. */
        readonly askBeforeCampaign?: boolean;
        /** ADR-0151: `campaign` searches the Company Brain, with the person's approval. */
        readonly searchInCampaign?: boolean;
        /** ADR-0152: an hour's wait between `research` and `campaign`. */
        readonly pauseBeforeCampaign?: boolean;
        /** ADR-0153: `research` runs again once, a minute after a passing failure. */
        readonly retryResearch?: boolean;
      } = {},
    ) {
      const execution = await planning(tenant);
      const step = (id: string, s: Specialist, dependsOn: string[] = []) => ({
        id,
        kind: 'specialist',
        label: `Work ${id}`,
        dependsOn,
        specialistId: s.identity.id,
        verification: { policy: 'checks', expectedOutput: 'report', requiredChecks: [] },
        ...((options.approvalRequired === true && id === 'research') ||
        (options.askBeforeCampaign === true && id === 'campaign')
          ? { approvalRequired: true }
          : {}),
        ...(options.retryResearch === true && id === 'research'
          ? { retry: { maxAttempts: 2, backoffMs: 60_000 } }
          : {}),
      });
      const outcome = await plans.propose(tenant, {
        executionId: execution.id,
        proposal: {
          summary: 'Market study',
          objective: 'Study the melon market.',
          steps: [
            step('research', researcher),
            step('campaign', marketer, [
              options.pauseBeforeCampaign === true ? 'pause' : 'research',
            ]),
            ...(options.pauseBeforeCampaign === true
              ? [
                  {
                    id: 'pause',
                    kind: 'wait',
                    label: 'Wait an hour',
                    dependsOn: ['research'],
                    wait: { seconds: 3_600 },
                  },
                ]
              : []),
            ...(options.askBeforeCampaign === true
              ? [step('brief', researcher, ['research']), step('launch', marketer, ['campaign'])]
              : []),
            ...(options.gate === true
              ? [{ id: 'sign_off', kind: 'approval', label: 'Sign off', dependsOn: ['campaign'] }]
              : []),
            ...(options.searchInCampaign === true
              ? [
                  step('brief', researcher, ['research']),
                  {
                    id: 'search',
                    kind: 'tool',
                    label: 'Search the Company Brain',
                    dependsOn: ['campaign'],
                    performedBy: 'campaign',
                    tool: { id: 'knowledge_search', version: 1 },
                    input: { query: 'melon prices' },
                    approvalRequired: true,
                  },
                ]
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
      specialists,
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
          kind: 'specialist',
          label: 'Work research',
          state: 'running',
          executionId: research,
          status: 'running',
          approvalId: null,
          failure: null,
          outcome: null,
          answer: null,
          missing: [],
          until: null,
          attempt: 1,
        },
        {
          stepId: 'campaign',
          kind: 'specialist',
          label: 'Work campaign',
          state: 'waiting',
          executionId: campaign,
          status: 'pending',
          approvalId: null,
          failure: null,
          outcome: null,
          answer: null,
          missing: [],
          until: null,
          attempt: 1,
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

    it('ADR-0158: a workflow’s wait is shown with its length for the editor', async () => {
      const t = await setup(ROLES, { runPlans: true });
      const pause = {
        id: 'pause',
        kind: 'wait',
        label: 'Give the client time',
        dependsOn: ['research'],
        wait: { seconds: 7_200 },
      };
      const after = { ...campaignStep, dependsOn: ['pause'] };
      const id = await activeWorkflow(t, [researchStep, pause, after]);
      const detail = (await (await t.get('token-alice', `/workflows/${id}`)).json()) as {
        current: { steps: Record<string, unknown>[] };
      };
      expect(detail.current.steps[1]).toMatchObject({
        id: 'pause',
        kind: 'wait',
        assignee: null,
        wait: { seconds: 7_200 },
      });
      expect(detail.current.steps[0]).toMatchObject({ wait: null });
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

      // The plan shows the check's decision as it was fixed.
      const detailed = (await (await t.get('token-alice', `/plans/${plan.id}`)).json()) as {
        current: { steps: { id: string; decision: unknown }[] };
      };
      expect(detailed.current.steps.find((s) => s.id === 'policy')?.decision).toEqual(
        check.decision,
      );

      // ADR-0145: the check said the discount needs approval, so its branch stops. The steps
      // show it: the check stopped, the step after it skipped, the other branch still waiting.
      await t.stores.plans.update(t.orgA, plan.id as never, (current) => ({
        plan: {
          ...current,
          revision: current.revision + 1,
          conditions: [
            {
              stepId: 'policy',
              result: 'stop',
              decision: {
                id: `dec_${'a'.repeat(32)}`,
                type: 'action.policy_check',
                version: 1,
                outcome: 'approval_required',
              },
              evaluatedAt: '2026-10-04T00:00:00.000Z' as never,
            },
          ],
        },
        events: [],
      }));
      const read = await t.get('token-alice', `/plans/${plan.id}/steps`);
      const progress = (await read.json()) as {
        steps: Record<string, unknown>[];
      };
      expect(read.status, JSON.stringify(progress)).toBe(200);
      expect(progress.steps.map((s) => [s.stepId, s.kind, s.state, s.outcome])).toEqual([
        ['research', 'specialist', 'running', null],
        ['policy', 'condition', 'stopped', 'approval_required'],
        ['campaign', 'specialist', 'skipped', null],
        ['branch', 'specialist', 'waiting', null],
      ]);
      expect(progress.steps[1]).toMatchObject({ executionId: null, status: null, answer: null });

      // Another organization reads none of it.
      const other = await t.app.request(
        `/v1/organizations/${t.orgB}/plans/${plan.id}/steps`,
        t.as('token-alice'),
      );
      expect(other.status).toBe(403);
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

    it('ADR-0164: plans a workflow’s read-only tool step where this server runs tools', async () => {
      const steps = [
        researchStep,
        campaignStep,
        {
          id: 'search',
          kind: 'tool',
          label: 'Search the Company Brain',
          dependsOn: ['campaign'],
          performedBy: 'campaign',
          tool: { id: 'knowledge_search', version: 1 },
          input: { query: 'melon prices' },
        },
      ];
      const t = await setup();
      const id = await activeWorkflow(t, steps);
      const planned = await t.post('token-alice', `/workflows/${id}/plans`, { requestKey: 'r' });
      const plan = (await planned.json()) as PlanDetail;
      expect(planned.status, JSON.stringify(plan)).toBe(201);
      expect(
        (plan.current.steps as unknown as Record<string, unknown>[]).find((s) => s.id === 'search'),
      ).toMatchObject({
        kind: 'tool',
        performedBy: 'campaign',
        tool: { id: 'knowledge_search', version: 1 },
        input: { query: 'melon prices' },
        inputFrom: null,
      });
    });

    it('ADR-0165: a workflow’s tool step is shown with its input and references for the editor', async () => {
      const search = {
        id: 'search',
        kind: 'tool',
        label: 'Search the Company Brain',
        dependsOn: ['campaign'],
        performedBy: 'campaign',
        tool: { id: 'knowledge_search', version: 1 },
        inputFrom: { query: { step: 'research' } },
      };
      const t = await setup();
      const id = await activeWorkflow(t, [researchStep, campaignStep, search]);
      const detail = (await (await t.get('token-alice', `/workflows/${id}`)).json()) as {
        current: { steps: Record<string, unknown>[] };
      };
      expect(detail.current.steps[2]).toMatchObject({
        kind: 'tool',
        performedBy: 'campaign',
        tool: { id: 'knowledge_search', version: 1 },
        input: null,
        inputFrom: { query: { step: 'research' } },
      });
      expect(detail.current.steps[0]).toMatchObject({ input: null, inputFrom: null });
      const planned = await t.post('token-alice', `/workflows/${id}/plans`, { requestKey: 'r' });
      const plan = (await planned.json()) as PlanDetail;
      expect(planned.status, JSON.stringify(plan)).toBe(201);
      expect(
        (plan.current.steps as unknown as Record<string, unknown>[]).find((s) => s.id === 'search'),
      ).toMatchObject({ inputFrom: { query: { step: 'research' } } });
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

  describe('ADR-0146: a step that asks a person before it runs', () => {
    /**
     * A running plan: research done, so `brief` started and `campaign` asks for its approval,
     * with `launch` after it. The worker's side (its conductor) is played here.
     */
    async function waitingPlan(roles: Record<string, readonly string[]> = ROLES) {
      const t = await setup(roles, { runPlans: true });
      const authorization = createAuthorizationService(roles as never);
      const approvals = createApprovalService({
        repository: t.stores.approvals,
        organizations: t.stores.tenancy,
        authorization,
        audit: t.stores.audit,
      });
      // The runtime's own execution service, as the worker has it.
      const executions = createExecutionService({
        repository: t.stores.executions,
        organizations: t.stores.tenancy,
        authorization,
        audit: t.stores.audit,
      });
      const { plan, ids } = await t.proposeWork({
        approvalRequired: true,
        askBeforeCampaign: true,
      });
      const [research, campaign] = ids as [ExecutionId, ExecutionId];
      const version = must(await t.stores.plans.findVersion(t.orgA, plan.id, plan.version));
      const approved = await t.post('token-alice', `/plans/${plan.id}/approve`, {
        version: 1,
        digest: version.digest,
      });
      expect(approved.status).toBe(200);
      // The first step is covered by the plan's own approval: it starts at once.
      expect(t.kicked).toEqual([research]);

      const runtime = await resolveRuntimeTenant(t.tenant.userId, t.orgA, t.stores.tenancy);
      await executions.runtimeChangeNode(runtime, research, {
        nodeId: 'research',
        from: 'pending',
        to: 'running',
      });
      await executions.runtimeChangeNode(runtime, research, {
        nodeId: 'research',
        from: 'running',
        to: 'completed',
        output: { type: 'agent_output', id: `${research}:research` },
      });
      await executions.runtimeChangeStatus(runtime, research, {
        from: 'running',
        to: 'verifying',
      });
      await executions.recordVerification(runtime, research, {
        correlationId: 'v',
        nodes: [{ nodeId: 'research', policy: 'checks', checks: [PASSED] }],
      });
      await executions.runtimeChangeStatus(runtime, research, {
        from: 'verifying',
        to: 'completed',
      });
      const worker = createPlanConductor({
        plans: t.stores.plans,
        executions,
        starter: {
          async start(tenant, executionId) {
            await executions.runtimeStart(tenant, executionId);
            t.kicked.push(executionId);
          },
        },
        approvals: createPlanStepApprovals(approvals),
      });
      await worker.advance(runtime, plan.id);
      const stored = must(await t.stores.plans.find(t.orgA, plan.id));
      const approvalId = must(
        stored.stepApprovals?.find((a) => a.stepId === 'campaign'),
      ).approvalId;
      const brief = must(stored.delegations.find((d) => d.stepId === 'brief')).executionId;
      const launch = must(stored.delegations.find((d) => d.stepId === 'launch')).executionId;
      const states = async () => {
        const response = await t.get('token-alice', `/plans/${plan.id}/steps`);
        expect(response.status).toBe(200);
        const view = (await response.json()) as {
          status: string;
          steps: {
            stepId: string;
            state: string;
            approvalId: string | null;
            failure: string | null;
          }[];
        };
        return {
          status: view.status,
          steps: Object.fromEntries(view.steps.map((s) => [s.stepId, s.state])),
          of: (id: string) => must(view.steps.find((s) => s.stepId === id)),
        };
      };
      return {
        t,
        executions,
        plan,
        approvals,
        runtime,
        worker,
        research,
        campaign,
        brief,
        launch,
        approvalId,
        states,
      };
    }

    it('waits for a person, asks once, and shows it in the plan and the approvals inbox', async () => {
      const w = await waitingPlan();
      // The independent branch went on; the step that asked did not start.
      expect(w.t.kicked).toEqual([w.research, w.brief]);
      const seen = await w.states();
      expect(seen.steps).toEqual({
        research: 'completed',
        campaign: 'awaiting_approval',
        brief: 'running',
        launch: 'waiting',
      });
      expect(seen.of('campaign').approvalId).toBe(w.approvalId);

      const inbox = await w.t.get('token-alice', '/approvals');
      const listed = ((await inbox.json()) as { approvals: Record<string, unknown>[] }).approvals;
      expect(listed).toEqual([
        expect.objectContaining({
          id: w.approvalId,
          status: 'pending',
          reason: 'plan_step_approval',
          impact: 'starts_step',
          executionId: w.campaign,
          nodeId: 'campaign',
          tool: { id: 'plan_step', version: 1 },
          action: 'start_step',
        }),
      ]);
      // A second look asks nothing new.
      await w.worker.advance(w.runtime, w.plan.id);
      expect((await w.t.stores.approvals.list(w.t.orgA, 10)).length).toBe(1);
    });

    it('approval: the step starts at once and the plan goes on to the end', async () => {
      const w = await waitingPlan();
      const decided = await w.t.post('token-alice', `/approvals/${w.approvalId}/approve`);
      expect(decided.status).toBe(200);
      expect(w.t.kicked).toEqual([w.research, w.brief, w.campaign]);
      expect((await w.states()).steps).toMatchObject({
        campaign: 'running',
        launch: 'waiting',
      });
      const events = (await w.t.stores.auditEvents()).map((e) => e.action);
      expect(events).toEqual(
        expect.arrayContaining([
          'plan.step_approval_requested',
          'tool.approval_requested',
          'tool.approval_approved',
        ]),
      );
      expect(events).not.toContain('plan.step_declined');
    });

    it('rejection: the step and the ones after it are skipped, the rest finish, the plan does not fail', async () => {
      const w = await waitingPlan();
      const decided = await w.t.post('token-alice', `/approvals/${w.approvalId}/reject`);
      expect(decided.status).toBe(200);
      // Nothing more starts; the brief is still running.
      expect(w.t.kicked).toEqual([w.research, w.brief]);
      let seen = await w.states();
      expect(seen.status).toBe('executing');
      expect(seen.steps).toEqual({
        research: 'completed',
        campaign: 'declined',
        brief: 'running',
        launch: 'skipped',
      });
      expect(seen.of('campaign').failure).toBe('rejected');
      const declined = (await w.t.stores.auditEvents()).filter(
        (e) => e.action === 'plan.step_declined',
      );
      expect(declined).toHaveLength(1);
      expect(declined[0]).toMatchObject({
        organizationId: w.t.orgA,
        target: { type: 'plan', id: w.plan.id },
        nodeId: 'campaign',
        reason: 'rejected',
      });

      // The independent branch ends; the plan completes, recording what was skipped.
      await finish(w, w.brief, 'brief');
      await w.worker.advance(w.runtime, w.plan.id);
      seen = await w.states();
      expect(seen.status).toBe('completed');
      expect(seen.steps).toEqual({
        research: 'completed',
        campaign: 'declined',
        brief: 'completed',
        launch: 'skipped',
      });
    });

    it('expiry counts as a rejection for that branch', async () => {
      const w = await waitingPlan();
      const later = new Date(Date.now() + 2 * 86_400_000);
      const worker = createPlanConductor({
        plans: w.t.stores.plans,
        executions: w.executions,
        starter: { start: async (_t, id) => void w.t.kicked.push(id) },
        approvals: createPlanStepApprovals(
          createApprovalService({
            repository: w.t.stores.approvals,
            organizations: w.t.stores.tenancy,
            authorization: createAuthorizationService(ROLES as never),
            audit: w.t.stores.audit,
            now: () => later,
          }),
          () => later,
        ),
        now: () => later,
      });
      await worker.advance(w.runtime, w.plan.id);
      expect((await w.t.stores.approvals.find(w.t.orgA, w.approvalId as never))?.status).toBe(
        'expired',
      );
      const seen = await w.states();
      expect(seen.steps).toMatchObject({ campaign: 'declined', launch: 'skipped' });
      expect(seen.of('campaign').failure).toBe('expired');
      expect(w.t.kicked).toEqual([w.research, w.brief]);
      // A person deciding afterwards changes nothing.
      expect((await w.t.post('token-alice', `/approvals/${w.approvalId}/approve`)).status).toBe(
        409,
      );
      expect(w.t.kicked).toEqual([w.research, w.brief]);
    });

    it('only a person with approval.approve decides: never the runtime, never without the permission', async () => {
      const w = await waitingPlan();
      // The runtime acts for Alice but is never Alice.
      await expect(w.approvals.approve(w.runtime, w.approvalId)).rejects.toMatchObject({
        code: 'approval_forbidden',
      });
      const withoutApprove = createApprovalService({
        repository: w.t.stores.approvals,
        organizations: w.t.stores.tenancy,
        authorization: createAuthorizationService({
          ...ROLES,
          owner: ROLES.owner.filter((p) => p !== 'approval.approve'),
        } as never),
        audit: w.t.stores.audit,
      });
      await expect(withoutApprove.approve(w.t.tenant, w.approvalId)).rejects.toMatchObject({
        code: 'approval_forbidden',
      });
      expect((await w.t.stores.approvals.find(w.t.orgA, w.approvalId as never))?.status).toBe(
        'pending',
      );
      expect(w.t.kicked).toEqual([w.research, w.brief]);
      expect((await w.states()).steps['campaign']).toBe('awaiting_approval');
    });

    it('keeps other organizations out: another org can neither see nor decide it', async () => {
      const w = await waitingPlan();
      const asBob = (path: string, method = 'GET') =>
        w.t.app.request(`/v1/organizations/${w.t.orgB}${path}`, w.t.as('token-bob', { method }));
      expect((await asBob(`/approvals/${w.approvalId}`)).status).toBe(404);
      expect((await asBob(`/approvals/${w.approvalId}/approve`, 'POST')).status).toBe(404);
      expect((await asBob(`/approvals/${w.approvalId}/reject`, 'POST')).status).toBe(404);
      // Bob is not a member of Alice's organization at all.
      const intrude = await w.t.app.request(
        `/v1/organizations/${w.t.orgA}/approvals/${w.approvalId}/approve`,
        w.t.as('token-bob', { method: 'POST' }),
      );
      expect([403, 404]).toContain(intrude.status);
      expect((await w.t.stores.approvals.find(w.t.orgA, w.approvalId as never))?.status).toBe(
        'pending',
      );
      expect(w.t.kicked).toEqual([w.research, w.brief]);
    });

    describe('ADR-0149: plan steps in the list of every agent’s work', () => {
      interface Item {
        readonly id: string;
        readonly origin: string;
        readonly agent: { readonly id: string | null };
        readonly request: string;
        readonly status: string;
        readonly failure: string | null;
        readonly createdAt: string;
        readonly plan: {
          readonly id: string;
          readonly status: string;
          readonly step: { readonly state: string };
        } | null;
        readonly dependsOn: readonly { readonly label: string; readonly state: string }[];
        readonly approval: { readonly state: string } | null;
        readonly result: { readonly summary: string } | null;
      }
      interface Body {
        readonly tasks: readonly Item[];
        readonly nextCursor: string | null;
        readonly sources: { readonly task: string; readonly plan_step: string };
        readonly origins: readonly string[];
        readonly error?: string;
        readonly field?: string;
      }
      const list = async (
        w: Awaited<ReturnType<typeof waitingPlan>>,
        query = '',
        token = 'token-alice',
        org = w.t.orgA,
      ) => {
        const response = await w.t.app.request(
          `/v1/organizations/${org}/agent-tasks${query}`,
          w.t.as(token),
        );
        return { status: response.status, body: (await response.json()) as Body };
      };
      const byRequest = (body: Body) =>
        Object.fromEntries(
          body.tasks.filter((i) => i.origin === 'plan_step').map((i) => [i.request, i]),
        );

      it('lists the plan’s agent steps, each with the plan engine’s own state, branch and dependencies', async () => {
        const w = await waitingPlan();
        const { status, body } = await list(w);
        expect(status).toBe(200);
        expect(body.sources).toEqual({ task: 'read', plan_step: 'read' });
        expect(body.origins).toEqual(['all', 'task', 'plan_step']);
        const steps = byRequest(body);
        expect(Object.keys(steps).sort()).toEqual([
          'Work brief',
          'Work campaign',
          'Work launch',
          'Work research',
        ]);
        expect(steps['Work research']).toMatchObject({
          id: w.research,
          origin: 'plan_step',
          status: 'completed',
          plan: { id: w.plan.id, status: 'executing', step: { state: 'completed' } },
          dependsOn: [],
          // The first step ran on the plan's own approval: no step approval of its own.
          approval: null,
        });
        // Two branches after research: one running, one waiting for a person.
        expect(steps['Work brief']).toMatchObject({
          status: 'running',
          plan: { step: { state: 'running' } },
          dependsOn: [{ label: 'Work research', state: 'completed' }],
          approval: null,
        });
        expect(steps['Work campaign']).toMatchObject({
          id: w.campaign,
          plan: { step: { state: 'awaiting_approval' } },
          approval: { state: 'pending' },
        });
        expect(steps['Work launch']).toMatchObject({
          plan: { step: { state: 'waiting' } },
          dependsOn: [{ label: 'Work campaign', state: 'awaiting_approval' }],
        });
        // The same states the plan's own page gives: one reading of the plan, not a second one.
        const own = await w.states();
        for (const [label, item] of Object.entries(steps)) {
          expect([label, item.plan?.step.state]).toEqual([
            label,
            own.steps[label.replace('Work ', '')],
          ]);
        }
      });

      it('merges a task people asked for with the steps, newest first, and filters by origin', async () => {
        const w = await waitingPlan();
        // A task asked of an agent now: newer than the plan's steps.
        const agentId = (await list(w)).body.tasks.find((i) => i.request === 'Work research')?.agent
          .id as string;
        const asked = await w.t.app.request(
          `/v1/organizations/${w.t.orgA}/specialists/${agentId}/tasks`,
          w.t.as('token-alice', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ request: 'Resume las ventas' }),
          }),
        );
        expect(asked.status).toBe(202);
        const all = (await list(w)).body;
        expect(all.tasks[0]).toMatchObject({ origin: 'task', request: 'Resume las ventas' });
        expect(all.tasks.filter((i) => i.origin === 'plan_step')).toHaveLength(4);
        const keys = all.tasks.map((i) => `${i.createdAt}|${i.id}`);
        expect([...keys].sort().reverse()).toEqual(keys);
        expect((await list(w, '?origin=task')).body.tasks.map((i) => i.origin)).toEqual(['task']);
        const onlySteps = (await list(w, '?origin=plan_step')).body;
        expect(new Set(onlySteps.tasks.map((i) => i.origin))).toEqual(new Set(['plan_step']));
        expect(onlySteps.sources.task).toBe('not_asked');
        const bad = await list(w, '?origin=everything');
        expect([bad.status, bad.body.field]).toEqual([400, 'origin']);
      });

      it('pages through both sources with one cursor, without repeating or skipping', async () => {
        const w = await waitingPlan();
        const agentId = (await list(w)).body.tasks.find((i) => i.request === 'Work brief')?.agent
          .id as string;
        for (const request of ['uno', 'dos']) {
          await w.t.app.request(
            `/v1/organizations/${w.t.orgA}/specialists/${agentId}/tasks`,
            w.t.as('token-alice', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ request }),
            }),
          );
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        const whole = (await list(w)).body.tasks.map((i) => i.id);
        expect(whole).toHaveLength(6);
        const seen: string[] = [];
        let cursor: string | null = null;
        for (let page = 0; page < 10; page += 1) {
          const got: Body = (
            await list(
              w,
              `?limit=2${cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`}`,
            )
          ).body;
          seen.push(...got.tasks.map((i) => i.id));
          cursor = got.nextCursor;
          if (cursor === null) break;
        }
        expect(seen).toEqual(whole);
      });

      it('narrows steps by agent and state on the server', async () => {
        const w = await waitingPlan();
        const steps = byRequest((await list(w)).body);
        const marketer = steps['Work campaign']?.agent.id as string;
        const ofMarketer = (await list(w, `?origin=plan_step&agent=${marketer}`)).body.tasks;
        expect(ofMarketer.map((i) => i.request).sort()).toEqual(['Work campaign', 'Work launch']);
        const running = (await list(w, '?origin=plan_step&status=running')).body.tasks;
        expect(running.map((i) => i.request)).toEqual(['Work brief']);
        const past = (await list(w, '?from=2020-01-01&to=2020-01-31')).body.tasks;
        expect(past).toEqual([]);
      });

      it('a rejected step is declined and the step after it skipped; the other branch goes on', async () => {
        const w = await waitingPlan();
        await w.t.post('token-alice', `/approvals/${w.approvalId}/reject`);
        const steps = byRequest((await list(w)).body);
        expect(steps['Work campaign']).toMatchObject({
          plan: { step: { state: 'declined' } },
          approval: { state: 'rejected' },
          failure: 'rejected',
        });
        expect(steps['Work launch']?.plan?.step.state).toBe('skipped');
        expect(steps['Work brief']?.plan?.step.state).toBe('running');
      });

      it('an approved step shows as approved and running', async () => {
        const w = await waitingPlan();
        await w.t.post('token-alice', `/approvals/${w.approvalId}/approve`);
        expect(byRequest((await list(w)).body)['Work campaign']).toMatchObject({
          status: 'running',
          plan: { step: { state: 'running' } },
          approval: { state: 'approved' },
        });
      });

      it('an approval nobody decided in time shows as expired', async () => {
        const w = await waitingPlan();
        const later = new Date(Date.now() + 2 * 86_400_000);
        await createPlanConductor({
          plans: w.t.stores.plans,
          executions: w.executions,
          starter: { start: async (_t, id) => void w.t.kicked.push(id) },
          approvals: createPlanStepApprovals(
            createApprovalService({
              repository: w.t.stores.approvals,
              organizations: w.t.stores.tenancy,
              authorization: createAuthorizationService(ROLES as never),
              audit: w.t.stores.audit,
              now: () => later,
            }),
            () => later,
          ),
          now: () => later,
        }).advance(w.runtime, w.plan.id);
        expect(byRequest((await list(w)).body)['Work campaign']).toMatchObject({
          plan: { step: { state: 'declined' } },
          approval: { state: 'expired' },
        });
      });

      it('shows a completed step’s verified answer as a summary, and nothing internal', async () => {
        const w = await waitingPlan();
        await w.t.agentOutputs.save({
          organizationId: w.t.orgA as never,
          executionId: w.research as never,
          nodeId: 'research' as never,
          requestId: 'req-hidden-77',
          output: { structured: { answer: 'El melón crece 4% al año.', missing: [] } },
          createdAt: new Date().toISOString() as never,
        });
        const { body } = await list(w);
        const research = byRequest(body)['Work research'];
        expect(research?.result).toMatchObject({ summary: 'El melón crece 4% al año.' });
        const text = JSON.stringify(body);
        for (const hidden of [
          'req-hidden-77',
          'alpha-large',
          w.approvalId,
          'digest',
          'requestedBy',
          'decidedBy',
        ]) {
          expect(text).not.toContain(hidden);
        }
        expect(Object.keys(research ?? {}).sort()).toEqual([
          'agent',
          'approval',
          'completedAt',
          'createdAt',
          'dependsOn',
          'failure',
          'handedFrom',
          'id',
          'origin',
          'plan',
          'progress',
          'request',
          'result',
          'startedAt',
          'status',
          'steps',
          'updatedAt',
        ]);
      });

      it('without plan.read, the list shows tasks only and plan steps alone are refused', async () => {
        const w = await waitingPlan({
          ...ROLES,
          owner: ROLES.owner.filter((p) => p !== 'plan.read'),
        });
        const { status, body } = await list(w);
        expect(status).toBe(200);
        expect(body.sources.plan_step).toBe('not_permitted');
        expect(body.tasks.some((i) => i.origin === 'plan_step')).toBe(false);
        expect((await list(w, '?origin=plan_step')).status).toBe(403);
      });

      it('keeps another organization’s steps out', async () => {
        const w = await waitingPlan();
        const theirs = await list(w, '', 'token-bob', w.t.orgB);
        expect(theirs.body.tasks).toEqual([]);
        expect((await list(w, '', 'token-bob', w.t.orgA)).status).toBe(403);
      });

      it('reaches the steps of plans older than the newest 100, a page of plans at a time (ADR-0150)', async () => {
        const w = await waitingPlan();
        const current = must(await w.t.stores.plans.find(w.t.orgA, w.plan.id));
        const version = must(await w.t.stores.plans.findVersion(w.t.orgA, w.plan.id, 1));
        // A plan with no steps, nothing decided and nothing run.
        const omitted = new Set([
          'delegationState',
          'delegationFailure',
          'decision',
          'stepApprovals',
          'conditions',
        ]);
        const bare = Object.fromEntries(Object.entries(current).filter(([k]) => !omitted.has(k)));
        // 105 newer plans with no steps: before ADR-0150 they pushed this plan out of the list.
        const start = Date.parse(current.createdAt);
        for (let i = 1; i <= 105; i += 1) {
          const id = crypto.randomUUID() as Plan['id'];
          await w.t.stores.plans.create({
            plan: {
              ...bare,
              id,
              executionId: crypto.randomUUID() as Plan['executionId'],
              status: 'ready',
              delegations: [],
              revision: 1,
              createdAt: new Date(start + i * 1000).toISOString() as Plan['createdAt'],
            } as unknown as Plan,
            version: {
              ...version,
              planId: id,
              // A version's digest covers its plan's id.
              digest: digestOf({
                planId: id,
                organizationId: version.organizationId,
                version: version.version,
                request: version.request,
                steps: version.steps,
                riskLevel: version.riskLevel,
                approvalRequired: version.approvalRequired,
                estimate: version.estimate,
                source: version.source,
              }),
            },
            events: [],
          });
        }
        // Plans page newest first, each once, and only the organization's own.
        const seen: string[] = [];
        let after: { at: string; id: string } | undefined;
        for (;;) {
          const page = await w.t.stores.plans.page(w.t.orgA, {
            ...(after === undefined ? {} : { after }),
            limit: 40,
          });
          seen.push(...page.items.map((p) => `${p.createdAt}|${p.id}`));
          const last = page.items.at(-1);
          if (!page.hasMore || last === undefined) break;
          after = { at: last.createdAt, id: last.id };
        }
        expect(seen).toHaveLength(106);
        expect(new Set(seen).size).toBe(106);
        expect([...seen].sort().reverse()).toEqual(seen);
        expect((await w.t.stores.plans.page(w.t.orgB, { limit: 200 })).items).toEqual([]);

        // The plan's four steps are still listed, one page at a time, none repeated.
        const ids: string[] = [];
        let cursor: string | null = null;
        do {
          const { status, body } = await list(
            w,
            `?origin=plan_step&limit=3${cursor === null ? '' : `&cursor=${cursor}`}`,
          );
          expect(status).toBe(200);
          ids.push(...body.tasks.map((i) => i.id));
          cursor = body.nextCursor;
        } while (cursor !== null);
        expect(ids).toHaveLength(4);
        expect(new Set(ids)).toEqual(new Set(current.delegations.map((d) => d.executionId)));
      });

      it('when plan steps cannot be read, tasks still show and the list says steps are missing', async () => {
        const w = await waitingPlan();
        w.t.stores.plans.page = async () => {
          throw new Error('store down');
        };
        const { status, body } = await list(w);
        expect(status).toBe(200);
        expect(body.sources.plan_step).toBe('unavailable');
        expect(body.tasks.some((i) => i.origin === 'plan_step')).toBe(false);
      });
    });
  });

  describe('ADR-0151: a tool step that asks a person before its step runs', () => {
    /** A running plan: research done, `brief` started, `campaign` waits for its search's approval. */
    async function waitingTool() {
      const t = await setup(ROLES, { runPlans: true });
      const authorization = createAuthorizationService(ROLES as never);
      const approvals = createApprovalService({
        repository: t.stores.approvals,
        organizations: t.stores.tenancy,
        authorization,
        audit: t.stores.audit,
      });
      const executions = createExecutionService({
        repository: t.stores.executions,
        organizations: t.stores.tenancy,
        authorization,
        audit: t.stores.audit,
      });
      const { plan, ids } = await t.proposeWork({ approvalRequired: true, searchInCampaign: true });
      const [research, campaign] = ids as [ExecutionId, ExecutionId];
      const version = must(await t.stores.plans.findVersion(t.orgA, plan.id, plan.version));
      expect(must(version.steps.find((s) => s.id === 'search')).input).toEqual({
        query: 'melon prices',
      });
      const approved = await t.post('token-alice', `/plans/${plan.id}/approve`, {
        version: 1,
        digest: version.digest,
      });
      expect(approved.status).toBe(200);
      const runtime = await resolveRuntimeTenant(t.tenant.userId, t.orgA, t.stores.tenancy);
      const w = { executions, runtime };
      await finish(w, research, 'research');
      const worker = createPlanConductor({
        plans: t.stores.plans,
        executions,
        starter: {
          async start(tenant, executionId) {
            await executions.runtimeStart(tenant, executionId);
            t.kicked.push(executionId);
          },
        },
        approvals: createPlanStepApprovals(approvals, undefined, defaultToolRegistry()),
      });
      await worker.advance(runtime, plan.id);
      const stored = must(await t.stores.plans.find(t.orgA, plan.id));
      const entry = must(stored.stepApprovals?.find((a) => a.stepId === 'search'));
      const brief = must(stored.delegations.find((d) => d.stepId === 'brief')).executionId;
      return { t, plan, executions, runtime, research, campaign, brief, entry };
    }

    it('asks the Tool Gate’s own approval, and once approved attaches it and starts the step', async () => {
      const w = await waitingTool();
      expect(w.entry.performedBy).toBe('campaign');
      expect(w.t.kicked).toEqual([w.research, w.brief]);
      const pending = must(await w.t.stores.approvals.find(w.t.orgA, w.entry.approvalId as never));
      // Exactly the call the gate will check: this child's tool node, version, action and input.
      expect(pending.operation).toEqual({
        organizationId: w.t.orgA,
        executionId: w.campaign,
        nodeId: 'search',
        specialistId: expect.any(String),
        specialistVersion: 1,
        toolId: 'knowledge_search',
        toolVersion: 1,
        action: 'search',
        inputDigest: digestOf({ query: 'melon prices' }),
      });
      expect(pending).toMatchObject({ reason: 'approval_required', impact: 'reads_data' });
      const steps = async () =>
        (
          (await (await w.t.get('token-alice', `/plans/${w.plan.id}/steps`)).json()) as {
            steps: {
              stepId: string;
              state: string;
              approvalId: string | null;
              failure: string | null;
            }[];
          }
        ).steps;
      expect(must((await steps()).find((s) => s.stepId === 'campaign'))).toMatchObject({
        state: 'awaiting_approval',
        approvalId: w.entry.approvalId,
      });

      const decided = await w.t.post('token-alice', `/approvals/${w.entry.approvalId}/approve`);
      expect(decided.status).toBe(200);
      expect(w.t.kicked).toEqual([w.research, w.brief, w.campaign]);
      const child = await w.executions.get(w.runtime, w.campaign);
      expect(child.nodes.find((n) => n.id === 'search')?.approvalId).toBe(w.entry.approvalId);
      expect((await w.t.stores.auditEvents()).map((e) => e.action)).toContain(
        'execution.approval_attached',
      );
    });

    it('rejection skips that step’s branch and never fails the plan', async () => {
      const w = await waitingTool();
      const decided = await w.t.post('token-alice', `/approvals/${w.entry.approvalId}/reject`);
      expect(decided.status).toBe(200);
      expect(w.t.kicked).toEqual([w.research, w.brief]);
      const declined = (await w.t.stores.auditEvents()).filter(
        (e) => e.action === 'plan.step_declined',
      );
      expect(declined).toEqual([expect.objectContaining({ nodeId: 'search', reason: 'rejected' })]);
      await finish(w, w.brief, 'brief');
      const worker = createPlanConductor({
        plans: w.t.stores.plans,
        executions: w.executions,
        starter: { start: async (_t, id) => void w.t.kicked.push(id) },
      });
      const closed = await worker.advance(w.runtime, w.plan.id);
      expect(closed.status).toBe('completed');
      expect(w.t.kicked).toEqual([w.research, w.brief]);
    });
  });

  it('ADR-0152: shows a wait step that started, and until when, and the steps after it waiting', async () => {
    const t = await setup(ROLES, { runPlans: true });
    const executions = createExecutionService({
      repository: t.stores.executions,
      organizations: t.stores.tenancy,
      authorization: createAuthorizationService(ROLES as never),
      audit: t.stores.audit,
    });
    const { plan, ids } = await t.proposeWork({
      approvalRequired: true,
      pauseBeforeCampaign: true,
    });
    const [research] = ids as [ExecutionId];
    const version = must(await t.stores.plans.findVersion(t.orgA, plan.id, plan.version));
    const detail = (await (await t.get('token-alice', `/plans/${plan.id}`)).json()) as {
      current: { steps: { id: string; kind: string; wait: unknown }[] };
    };
    expect(detail.current.steps.find((s) => s.id === 'pause')).toMatchObject({
      kind: 'wait',
      wait: { seconds: 3_600 },
    });
    expect(
      (
        await t.post('token-alice', `/plans/${plan.id}/approve`, {
          version: 1,
          digest: version.digest,
        })
      ).status,
    ).toBe(200);
    const runtime = await resolveRuntimeTenant(t.tenant.userId, t.orgA, t.stores.tenancy);
    await finish({ executions, runtime }, research, 'research');
    const woken: Date[] = [];
    await createPlanConductor({
      plans: t.stores.plans,
      executions,
      starter: { start: async (_t, id) => void t.kicked.push(id) },
      wakeups: { wake: async (_t, _p, at) => void woken.push(at) },
    }).advance(runtime, plan.id);
    expect(woken).toHaveLength(1);
    const view = (await (await t.get('token-alice', `/plans/${plan.id}/steps`)).json()) as {
      steps: { stepId: string; kind: string; state: string; until: string | null }[];
    };
    const until = must((await t.stores.plans.find(t.orgA, plan.id))?.waits?.[0]).until;
    expect(view.steps.find((s) => s.stepId === 'pause')).toMatchObject({
      kind: 'wait',
      state: 'delayed',
      until,
    });
    expect(view.steps.find((s) => s.stepId === 'campaign')?.state).toBe('waiting');
    expect(t.kicked).toEqual([research]);
  });

  it('ADR-0153: shows a failed step waiting to run again, its attempt and when', async () => {
    const t = await setup(ROLES, { runPlans: true });
    const { plan, ids } = await t.proposeWork({ approvalRequired: true, retryResearch: true });
    const [first] = ids as [ExecutionId];
    const version = must(await t.stores.plans.findVersion(t.orgA, plan.id, plan.version));
    expect(
      (
        await t.post('token-alice', `/plans/${plan.id}/approve`, {
          version: 1,
          digest: version.digest,
        })
      ).status,
    ).toBe(200);
    const runtime = await resolveRuntimeTenant(t.tenant.userId, t.orgA, t.stores.tenancy);
    // The provider did not answer research's agent.
    await t.executions.runtimeChangeNode(runtime, first, {
      nodeId: 'research',
      from: 'pending',
      to: 'running',
    });
    await t.executions.runtimeChangeNode(runtime, first, {
      nodeId: 'research',
      from: 'running',
      to: 'failed',
      error: { code: 'unavailable' },
    });
    await t.executions.runtimeChangeStatus(runtime, first, {
      from: 'running',
      to: 'failed',
      failure: { code: 'unavailable' },
    });
    const woken: Date[] = [];
    const advanced = await createPlanConductor({
      plans: t.stores.plans,
      executions: t.executions,
      starter: { start: async (_t, id) => void t.kicked.push(id) },
      wakeups: { wake: async (_t, _p, at) => void woken.push(at) },
      attempts: createPlanStepAttempts({ executions: t.executions, specialists: t.specialists }),
    }).advance(runtime, plan.id);
    expect(advanced.status).toBe('executing');
    expect(woken).toHaveLength(1);
    const attempt = must((await t.stores.plans.find(t.orgA, plan.id))?.attempts?.[0]);
    expect(attempt).toMatchObject({ stepId: 'research', attempt: 2, after: first });
    const view = (await (await t.get('token-alice', `/plans/${plan.id}/steps`)).json()) as {
      steps: {
        stepId: string;
        state: string;
        executionId: string;
        attempt: number | null;
        until: string | null;
      }[];
    };
    expect(view.steps.find((s) => s.stepId === 'research')).toMatchObject({
      state: 'delayed',
      executionId: attempt.executionId,
      attempt: 2,
      until: attempt.notBefore,
    });
    expect(view.steps.find((s) => s.stepId === 'campaign')).toMatchObject({
      state: 'waiting',
      attempt: 1,
    });
    expect(t.kicked).toEqual([first]);

    // ADR-0157: the plan's trace shows both runs of the step, and the audit trail says why.
    const trace = (await (await t.get('token-alice', `/plans/${plan.id}/trace`)).json()) as {
      planId: string;
      status: string;
      failure: unknown;
      steps: {
        stepId: string;
        state: string | null;
        attempts: { attempt: number; executionId: string; status: string; failure: string }[];
        approvals: unknown[];
      }[];
      credits: { total: number };
      history: { action: string; nodeId: string | null; reference: string | null }[];
    };
    expect(trace).toMatchObject({ planId: plan.id, status: 'executing', failure: null });
    const research = must(trace.steps.find((s) => s.stepId === 'research'));
    expect(research.state).toBe('delayed');
    expect(research.attempts).toMatchObject([
      { attempt: 1, executionId: first, status: 'failed', failure: 'unavailable' },
      { attempt: 2, executionId: attempt.executionId, status: 'pending', failure: null },
    ]);
    expect(trace.credits.total).toBe(0);
    expect(trace.history).toContainEqual(
      expect.objectContaining({
        action: 'plan.step_retried',
        nodeId: 'research',
        reference: 'attempt:2',
      }),
    );
    // Nothing of it for anyone the plan is not theirs to read.
    expect((await t.get('token-bob', `/plans/${plan.id}/trace`)).status).not.toBe(200);
    // Nothing internal, nothing written: codes, ids, times and numbers only.
    expect(JSON.stringify(trace)).not.toMatch(/answer|prompt|input/i);
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
        page: (org, request) => t.stores.plans.page(org, request),
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

/** The runtime finishes a started step: its node, verification and completion. */
async function finish(
  w: { readonly executions: ExecutionService; readonly runtime: TenantContext },
  id: ExecutionId,
  nodeId: string,
): Promise<void> {
  const { executions } = w;
  await executions.runtimeChangeNode(w.runtime, id, { nodeId, from: 'pending', to: 'running' });
  await executions.runtimeChangeNode(w.runtime, id, {
    nodeId,
    from: 'running',
    to: 'completed',
    output: { type: 'agent_output', id: `${id}:${nodeId}` },
  });
  await executions.runtimeChangeStatus(w.runtime, id, { from: 'running', to: 'verifying' });
  await executions.recordVerification(w.runtime, id, {
    correlationId: 'v',
    nodes: [{ nodeId, policy: 'checks', checks: [PASSED] }],
  });
  await executions.runtimeChangeStatus(w.runtime, id, { from: 'verifying', to: 'completed' });
}
