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
  WorkflowId,
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
  newPlan,
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
import { toolResultSummary, toolStepState } from './plans.js';
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
      if (options.gate === true) {
        // No plan proposes an approval step since ADR-0168; one saved before it can still exist.
        const version = must(
          await stores.plans.findVersion(orgA, outcome.plan.id, outcome.plan.version),
        );
        const legacy = await planning(tenant);
        const write = newPlan(
          {
            organizationId: orgA,
            executionId: legacy.id,
            validated: {
              request: version.request,
              steps: [
                ...version.steps,
                {
                  id: 'sign_off',
                  kind: 'approval',
                  label: 'Sign off',
                  dependsOn: ['campaign'],
                  approvalRequired: true,
                },
              ],
              riskLevel: version.riskLevel,
              approvalRequired: true,
              estimate: version.estimate,
            },
            source: version.source,
          },
          aliceId,
          version.createdAt,
        );
        await stores.plans.create({ ...write, events: [] });
        return { execution: legacy, plan: write.plan, ids: [] };
      }
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
      plans,
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
    expect(await empty.json()).toEqual({ plans: [], nextCursor: null });
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
    expect(await listB.json()).toEqual({ plans: [], nextCursor: null });
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
          endedAt: null,
          result: null,
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
          endedAt: null,
          result: null,
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

  it('ADR-0179: a plan approved but cut short before it started starts when approved again, once', async () => {
    const t = await setup(ROLES, { runPlans: true });
    const { plan } = await t.proposeWork({ approvalRequired: true });
    const version = must(await t.stores.plans.findVersion(t.orgA, plan.id, plan.version));
    const seen = { version: 1, digest: version.digest };
    // The decision was stored, and the request ended before anything started.
    await t.plans.approve(t.tenant, plan.id, seen);
    expect((await t.stores.plans.find(t.orgA, plan.id))?.status).toBe('approved');
    expect(t.kicked).toEqual([]);

    // Approved again, the same version: it starts, without a second decision.
    const started = await t.post('token-alice', `/plans/${plan.id}/approve`, seen);
    expect(started.status).toBe(200);
    const view = (await started.json()) as {
      status: string;
      delegations: { executionId: string }[];
    };
    expect(view.status).toBe('executing');
    expect(t.kicked).toEqual([view.delegations[0]?.executionId]);
    const decisions = (await t.stores.auditEvents()).filter(
      (e) => e.action === 'plan.approved' && e.target?.id === plan.id && e.result === 'success',
    );
    expect(decisions).toHaveLength(1);

    // Once started, approving again starts nothing; another version starts nothing either.
    expect((await t.post('token-alice', `/plans/${plan.id}/approve`, seen)).status).toBe(409);
    expect(t.kicked).toHaveLength(1);
  });

  it('ADR-0179: approving again what was approved never starts a version the person did not see', async () => {
    const t = await setup(ROLES, { runPlans: true });
    const { plan } = await t.proposeWork({ approvalRequired: true });
    const version = must(await t.stores.plans.findVersion(t.orgA, plan.id, plan.version));
    await t.plans.approve(t.tenant, plan.id, { version: 1, digest: version.digest });
    const other = await t.post('token-alice', `/plans/${plan.id}/approve`, {
      version: 1,
      digest: 'f'.repeat(64),
    });
    expect(other.status).toBe(409);
    expect(t.kicked).toEqual([]);
    expect((await t.stores.plans.find(t.orgA, plan.id))?.status).toBe('approved');
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

    it('ADR-0180: lists one workflow’s plans, each naming its workflow and version, and nothing of another', async () => {
      const t = await setup(ROLES, { runPlans: true });
      const id = await activeWorkflow(t, [researchStep]);
      const other = await activeWorkflow(t, [researchStep]);
      const first = (await (
        await t.post('token-alice', `/workflows/${id}/plans`, { requestKey: 'r-1' })
      ).json()) as { id: string };
      await t.post('token-alice', `/workflows/${id}/versions`, {
        steps: [researchStep, campaignStep],
      });
      const second = (await (
        await t.post('token-alice', `/workflows/${id}/plans`, { requestKey: 'r-2' })
      ).json()) as { id: string };
      const elsewhere = (await (
        await t.post('token-alice', `/workflows/${other}/plans`, { requestKey: 'r-3' })
      ).json()) as { id: string };
      const { plan: planned } = await t.proposeWork();

      const listed = await t.get('token-alice', `/plans?workflowId=${id}`);
      expect(listed.status).toBe(200);
      const { plans } = (await listed.json()) as {
        plans: { id: string; workflow: { id: string; version: number } | null }[];
      };
      // Only this workflow's, newest first, each with the version that made it.
      expect(plans.map((p) => p.id).sort()).toEqual([first.id, second.id].sort());
      expect(plans.find((p) => p.id === first.id)?.workflow).toEqual({ id, version: 1 });
      expect(plans.find((p) => p.id === second.id)?.workflow).toEqual({ id, version: 2 });

      // The organization's list names the workflow too; a plan from the planner names none.
      const all = (await (await t.get('token-alice', '/plans')).json()) as {
        plans: { id: string; workflow: { id: string } | null }[];
      };
      expect(all.plans.find((p) => p.id === elsewhere.id)?.workflow?.id).toBe(other);
      expect(all.plans.find((p) => p.id === planned.id)?.workflow).toBeNull();

      // A malformed id is refused; an unknown one has no plans.
      expect((await t.get('token-alice', '/plans?workflowId=not-an-id')).status).toBe(400);
      const unknown = await t.get(
        'token-alice',
        '/plans?workflowId=00000000-0000-4000-8000-000000000000',
      );
      expect(((await unknown.json()) as { plans: unknown[] }).plans).toEqual([]);

      // Another organization never sees them, by route or by store.
      expect((await t.get('token-bob', `/plans?workflowId=${id}`)).status).not.toBe(200);
      expect(await t.stores.plans.listForWorkflow(t.orgB, id as WorkflowId, 10)).toEqual([]);
      expect(await t.stores.plans.listForWorkflow(t.orgA, id as WorkflowId, 10)).toHaveLength(2);

      // The record is kept as the plan moves: approved and started, it still names its workflow.
      const version = must(await t.stores.plans.findVersion(t.orgA, first.id as never, 1));
      await t.post('token-alice', `/plans/${first.id}/approve`, {
        version: 1,
        digest: version.digest,
      });
      expect((await t.stores.plans.find(t.orgA, first.id as never))?.workflow).toEqual({
        id,
        version: 1,
      });
    });

    it('ADR-0182: pages the organization’s plans and one workflow’s, each once, newest first, and keeps cursors to their list', async () => {
      const t = await setup(ROLES, { runPlans: true });
      const id = await activeWorkflow(t, [researchStep]);
      const first = (await (
        await t.post('token-alice', `/workflows/${id}/plans`, { requestKey: 'r-1' })
      ).json()) as { id: string };
      const current = must(await t.stores.plans.find(t.orgA, first.id as never));
      const version = must(await t.stores.plans.findVersion(t.orgA, first.id as never, 1));
      // Just planned: nothing decided or run yet, so it can be copied as it is.
      const bare = current;
      // 130 more plans: four in five from this workflow, the rest from no workflow.
      const start = Date.parse(current.createdAt);
      for (let i = 1; i <= 130; i += 1) {
        const planId = crypto.randomUUID() as Plan['id'];
        const { workflow, ...rest } = bare;
        await t.stores.plans.create({
          plan: {
            ...rest,
            ...(i % 5 === 0 ? {} : { workflow }),
            id: planId,
            executionId: crypto.randomUUID() as Plan['executionId'],
            status: 'ready',
            delegations: [],
            revision: 1,
            createdAt: new Date(start + i * 1000).toISOString() as Plan['createdAt'],
          } as unknown as Plan,
          version: {
            ...version,
            planId,
            digest: digestOf({
              planId,
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

      type Page = { plans: { id: string; createdAt: string }[]; nextCursor: string | null };
      const pages = async (query: string) => {
        const seen: string[] = [];
        const sizes: number[] = [];
        let cursor: string | null = null;
        do {
          const sep: string = query === '' ? '?' : '&';
          const path: string =
            cursor === null ? `/plans${query}` : `/plans${query}${sep}cursor=${cursor}`;
          const response = await t.get('token-alice', path);
          expect(response.status).toBe(200);
          const page = (await response.json()) as Page;
          sizes.push(page.plans.length);
          seen.push(...page.plans.map((p) => `${p.createdAt}|${p.id}`));
          cursor = page.nextCursor;
        } while (cursor !== null);
        return { seen, sizes };
      };
      const all = await pages('');
      expect(all.sizes).toEqual([100, 31]);
      expect(new Set(all.seen).size).toBe(131);
      expect([...all.seen].sort().reverse()).toEqual(all.seen);
      const mine = await pages(`?workflowId=${id}`);
      expect(mine.sizes).toEqual([100, 5]);
      expect(new Set(mine.seen).size).toBe(105);
      expect([...mine.seen].sort().reverse()).toEqual(mine.seen);
      expect(mine.seen.at(-1)?.endsWith(first.id)).toBe(true);

      // A cursor is kept to its list and its organization; a malformed one is refused.
      const orgCursor = must(
        ((await (await t.get('token-alice', '/plans')).json()) as Page).nextCursor,
      );
      const wfCursor = must(
        ((await (await t.get('token-alice', `/plans?workflowId=${id}`)).json()) as Page).nextCursor,
      );
      const refused = async (path: string) => {
        const response = await t.get('token-alice', path);
        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'invalid_cursor' });
      };
      await refused(`/plans?workflowId=${id}&cursor=${orgCursor}`);
      await refused(`/plans?cursor=${wfCursor}`);
      await refused('/plans?cursor=not-a-cursor');
      // Bob, in his own organization, cannot use Alice's cursor and sees none of her plans.
      const bobs = await t.app.request(
        `/v1/organizations/${t.orgB}/plans?cursor=${orgCursor}`,
        t.as('token-bob'),
      );
      expect(bobs.status).toBe(400);
      const bobsOwn = await t.app.request(`/v1/organizations/${t.orgB}/plans`, t.as('token-bob'));
      expect(await bobsOwn.json()).toEqual({ plans: [], nextCursor: null });
    });

    it('ADR-0180: one workflow’s plans need plan.read', async () => {
      const t = await setup({
        ...ROLES,
        owner: ROLES.owner.filter((p) => p !== 'plan.read'),
      });
      expect(
        (await t.get('token-alice', '/plans?workflowId=00000000-0000-4000-8000-000000000000'))
          .status,
      ).toBe(403);
    });

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

    it('ADR-0179: the trace route names the workflow version that made the plan, after later edits too', async () => {
      const t = await setup(ROLES, { runPlans: true });
      const id = await activeWorkflow(t, [researchStep]);
      await t.post('token-alice', `/workflows/${id}/versions`, {
        steps: [researchStep, campaignStep],
      });
      const plan = (await (
        await t.post('token-alice', `/workflows/${id}/plans`, { requestKey: 'trace-1' })
      ).json()) as PlanDetail;
      await t.post('token-alice', `/plans/${plan.id}/approve`, {
        version: plan.current.version,
        digest: plan.current.digest,
      });
      // The workflow changes after the plan was made: the plan and its trace keep version 2.
      const edited = await t.post('token-alice', `/workflows/${id}/versions`, {
        steps: [researchStep],
      });
      expect(((await edited.json()) as { version: number }).version).toBe(3);
      const response = await t.get('token-alice', `/plans/${plan.id}/trace`);
      expect(response.status).toBe(200);
      const trace = (await response.json()) as {
        workflow: unknown;
        steps: { stepId: string }[];
        history: { action: string; actor: string; actorId: string | null }[];
      };
      expect(trace.workflow).toEqual({ id, version: 2 });
      expect(trace.steps.map((s) => s.stepId)).toEqual(['research', 'campaign']);
      expect(trace.history).toContainEqual(
        expect.objectContaining({
          action: 'plan.approved',
          actor: 'user',
          actorId: t.tenant.userId,
        }),
      );
      // Another organization reads nothing of it.
      const fromB = await t.app.request(
        `/v1/organizations/${t.orgB}/plans/${plan.id}/trace`,
        t.as('token-bob'),
      );
      expect(fromB.status).toBe(404);
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

    it('ADR-0167: names who would do each role and the tools its skills grant, as planning binds', async () => {
      const t = await setup();
      const read = await t.get('token-alice', '/workflows/assignees');
      expect(read.status).toBe(200);
      const { assignees } = (await read.json()) as {
        assignees: {
          departmentTypeId: string;
          roleId: string;
          agent: { id: string; displayName: string };
          tools: { id: string; version: number }[];
        }[];
      };
      const marketing = must(assignees.find((a) => a.roleId === 'campaign_manager'));
      expect(Object.keys(marketing).sort()).toEqual([
        'agent',
        'departmentTypeId',
        'roleId',
        'tools',
      ]);
      expect(Object.keys(marketing.agent).sort()).toEqual(['displayName', 'id']);
      // The same specialist a plan of this role's step is bound to.
      const id = await activeWorkflow(t, [researchStep, campaignStep]);
      const planned = await t.post('token-alice', `/workflows/${id}/plans`, { requestKey: 'r' });
      const plan = (await planned.json()) as PlanDetail;
      expect(planned.status, JSON.stringify(plan)).toBe(201);
      for (const step of plan.current.steps as unknown as {
        id: string;
        specialist?: { id: string };
      }[]) {
        const role = step.id === 'campaign' ? 'campaign_manager' : 'market_researcher';
        expect(must(assignees.find((a) => a.roleId === role)).agent.id).toBe(step.specialist?.id);
      }
      // Another organization's agents are never named.
      const path = `/v1/organizations/${t.orgB}/workflows/assignees`;
      expect((await t.app.request(path, t.as('token-alice'))).status).toBe(403);
      const fromB = await t.app.request(path, t.as('token-bob'));
      const named = ((await fromB.json()) as { assignees?: { agent: { id: string } }[] }).assignees;
      for (const a of assignees) {
        expect(named?.some((b) => b.agent.id === a.agent.id) ?? false).toBe(false);
      }
    });

    it('ADR-0168: says whether a plan takes each tool as a step, and dry-runs a draft', async () => {
      const t = await setup();
      const read = await t.get('token-alice', '/workflows/assignees');
      const { assignees } = (await read.json()) as {
        assignees: {
          roleId: string;
          agent: { id: string };
          tools: { id: string; version: number; step: Record<string, unknown> }[];
        }[];
      };
      const marketing = must(assignees.find((a) => a.roleId === 'campaign_manager'));
      const search = must(marketing.tools.find((x) => x.id === 'knowledge_search'));
      expect(search.step).toEqual({ usable: true, riskLevel: 'low', approvalRequired: false });
      for (const tool of marketing.tools) expect(typeof tool.step.usable).toBe('boolean');

      // A dry run: the same agents and decisions a plan would get, and nothing stored.
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
      const checked = await t.post('token-alice', '/workflows/check', { name: 'Study', steps });
      const body = (await checked.json()) as {
        ok: boolean;
        steps: { id: string; agent?: { id: string }; approvalRequired: boolean }[];
      };
      expect(checked.status, JSON.stringify(body)).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.steps.map((s) => [s.id, s.agent?.id ?? null, s.approvalRequired])).toEqual([
        ['research', must(assignees.find((a) => a.roleId === 'market_researcher')).agent.id, false],
        ['campaign', marketing.agent.id, false],
        ['search', null, false],
      ]);
      const listed = (await (await t.get('token-alice', '/workflows')).json()) as {
        workflows: unknown[];
      };
      expect(listed.workflows).toEqual([]);

      // A refusal is an answer with its codes.
      const refused = await t.post('token-alice', '/workflows/check', {
        name: 'Study',
        steps: [researchStep, { ...steps[2], performedBy: 'research', dependsOn: ['research'] }],
      });
      expect(refused.status).toBe(200);
      expect(await refused.json()).toEqual({
        ok: false,
        stage: 'permission',
        reason: 'tool_not_assigned',
        detail: 'steps.1',
      });
      // An exact body, and another organization's route is refused.
      expect((await t.post('token-alice', '/workflows/check', { steps })).status).toBe(400);
      const other = await t.app.request(
        `/v1/organizations/${t.orgB}/workflows/check`,
        t.as('token-alice', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name: 'Study', steps }),
        }),
      );
      expect(other.status).toBe(403);
    });

    it('answers a refused plan with 422 and why, and keeps the answer for a repeat', async () => {
      const t = await setup();
      const created = await t.post('token-alice', '/workflows', {
        name: 'Market study',
        steps: [
          researchStep,
          {
            id: 'search',
            kind: 'tool',
            label: 'Search',
            dependsOn: ['research'],
            performedBy: 'research',
            tool: { id: 'unknown_tool', version: 1 },
          },
        ],
      });
      const { id } = (await created.json()) as { id: string };
      // ADR-0179: it is never switched on, and the person is told why, in codes.
      const activation = await t.post('token-alice', `/workflows/${id}/status`, {
        from: 'draft',
        to: 'active',
      });
      expect(activation.status).toBe(409);
      expect(await activation.json()).toEqual({
        error: 'workflow_not_valid',
        detail: 'policy:tool_not_found:steps.1',
      });
      // One switched on before that check still plans, and its plan is refused.
      await t.stores.workflows.update(t.orgA, id as WorkflowId, (current) => ({
        workflow: { ...current, status: 'active', revision: current.revision + 1 },
        events: [
          buildAuditEvent(
            {
              action: 'workflow.state_changed',
              result: 'success',
              actor: { type: 'user', userId: t.tenant.userId, via: 'direct' },
              organizationId: t.orgA,
              target: { type: 'workflow', id },
              transition: { from: 'draft', to: 'active' },
              source: 'api',
            },
            new Date(),
          ),
        ],
      }));
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

    it('ADR-0185: a person schedules a workflow, sees it, and switches it off; nobody else can', async () => {
      const t = await setup();
      const id = await activeWorkflow(t, [researchStep]);
      const put = (token: string, org: string, body: unknown) =>
        t.app.request(
          `/v1/organizations/${org}/workflows/${id}/schedule`,
          t.as(token, {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          }),
        );
      expect(await (await t.get('token-alice', `/workflows/${id}/schedule`)).json()).toEqual({
        schedule: null,
      });
      const daily = { frequency: 'daily', time: '09:00' };
      const saved = await put('token-alice', t.orgA, { recurrence: daily });
      expect(saved.status).toBe(200);
      const { schedule } = (await saved.json()) as { schedule: Record<string, unknown> };
      expect(schedule).toMatchObject({
        workflowId: id,
        status: 'on',
        recurrence: daily,
        timeZone: 'America/Lima',
        workflowVersion: 1,
        last: null,
        revision: 1,
      });
      expect(typeof schedule.nextRunAt).toBe('string');
      // Its first occurrence was queued for the worker.
      expect(t.occurrences.map((o) => o.task)).toEqual([
        { organizationId: t.orgA, workflowId: id, occurrence: schedule.nextRunAt },
      ]);
      expect(
        (
          (await (await t.get('token-alice', `/workflows/${id}/schedule`)).json()) as {
            schedule: unknown;
          }
        ).schedule,
      ).toEqual(schedule);

      // Exact bodies and recurrences only.
      for (const body of [
        {},
        { recurrence: daily, extra: true },
        { recurrence: { frequency: 'hourly', time: '09:00' } },
      ]) {
        expect((await put('token-alice', t.orgA, body)).status).toBe(400);
      }
      expect(
        await (
          await put('token-alice', t.orgA, { recurrence: { frequency: 'daily', time: '9' } })
        ).json(),
      ).toEqual({ error: 'invalid_schedule', detail: 'time' });
      // Another organization sees nothing and changes nothing.
      expect((await put('token-bob', t.orgB, { recurrence: daily })).status).toBe(404);
      const fromB = await t.app.request(
        `/v1/organizations/${t.orgB}/workflows/${id}/schedule/off`,
        t.as('token-bob', { method: 'POST' }),
      );
      expect(fromB.status).toBe(404);

      const off = await t.post('token-alice', `/workflows/${id}/schedule/off`);
      expect(off.status).toBe(200);
      expect(((await off.json()) as { schedule: unknown }).schedule).toMatchObject({
        status: 'off',
        nextRunAt: null,
        revision: 2,
      });
    });

    it('ADR-0185: scheduling needs workflow.manage, plan.create and approval.approve', async () => {
      for (const missing of ['workflow.manage', 'plan.create', 'approval.approve']) {
        const t = await setup({ ...ROLES, owner: ROLES.owner.filter((p) => p !== missing) });
        // Without workflow.manage the route refuses before reading any workflow.
        let workflowId = '33333333-3333-4333-8333-333333333333';
        if (missing !== 'workflow.manage') {
          const created = await t.workflows.create(t.tenant, {
            name: 'Study',
            steps: [researchStep],
          });
          // A draft is enough: the permission is checked before the workflow's status.
          workflowId = created.id;
        }
        const response = await t.app.request(
          `/v1/organizations/${t.orgA}/workflows/${workflowId}/schedule`,
          t.as('token-alice', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ recurrence: { frequency: 'daily', time: '09:00' } }),
          }),
        );
        expect(response.status).toBe(403);
        expect(t.occurrences).toEqual([]);
      }
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

    it('ADR-0181: a stopped plan says who stopped it, and its withdrawn approval says why', async () => {
      const w = await waitingPlan();
      // Running: nobody stopped it.
      const running = await w.t.get('token-alice', `/plans/${w.plan.id}`);
      expect(((await running.json()) as { stopped: unknown }).stopped).toBeNull();

      const stop = await w.t.post('token-alice', `/executions/${w.plan.executionId}/cancel`, {
        reason: 'director_request',
      });
      expect(stop.status).toBe(200);

      const detail = (await (await w.t.get('token-alice', `/plans/${w.plan.id}`)).json()) as {
        status: string;
        createdBy: string;
        stopped: { at: string; by: string; reason: string } | null;
      };
      expect(detail.status).toBe('cancelled');
      expect(detail.stopped).toEqual({
        at: expect.any(String),
        by: detail.createdBy,
        reason: 'director_request',
      });

      const withdrawn = await w.t.get('token-alice', `/approvals/${w.approvalId}`);
      expect(await withdrawn.json()).toMatchObject({
        id: w.approvalId,
        status: 'cancelled',
        cancelReason: 'plan_cancelled',
      });

      // Another organization sees neither.
      const asBob = (path: string) =>
        w.t.app.request(`/v1/organizations/${w.t.orgB}${path}`, w.t.as('token-bob'));
      expect((await asBob(`/plans/${w.plan.id}`)).status).toBe(404);
      expect((await asBob(`/approvals/${w.approvalId}`)).status).toBe(404);
    });

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

    it('ADR-0179: cancelling the plan over HTTP withdraws its step approval, and nothing starts after', async () => {
      const w = await waitingPlan();
      const cancelled = await w.t.post('token-alice', `/executions/${w.plan.executionId}/cancel`, {
        reason: 'director_request',
      });
      expect(cancelled.status).toBe(200);
      expect(((await cancelled.json()) as { status: string }).status).toBe('cancelled');

      // The approval left the inbox: still listed, as cancelled, and nobody is asked any more.
      const inbox = (await (await w.t.get('token-alice', '/approvals')).json()) as {
        approvals: { id: string; status: string }[];
      };
      expect(inbox.approvals.filter((a) => a.status === 'pending')).toEqual([]);
      expect(inbox.approvals).toEqual([
        expect.objectContaining({ id: w.approvalId, status: 'cancelled' }),
      ]);
      const shown = await w.t.get('token-alice', `/approvals/${w.approvalId}`);
      expect(((await shown.json()) as { status: string }).status).toBe('cancelled');

      // Deciding it afterwards changes nothing and starts nothing.
      for (const action of ['approve', 'reject']) {
        expect((await w.t.post('token-alice', `/approvals/${w.approvalId}/${action}`)).status).toBe(
          409,
        );
      }
      const seen = await w.states();
      expect(seen.status).toBe('cancelled');
      expect(seen.steps['campaign']).not.toBe('awaiting_approval');
      expect(w.t.kicked).toEqual([w.research, w.brief]);
      // A later look by the conductor (a wake, a sweep) asks nothing new and starts nothing.
      await w.worker.advance(w.runtime, w.plan.id);
      expect((await w.t.stores.approvals.list(w.t.orgA, 10)).map((a) => a.status)).toEqual([
        'cancelled',
      ]);
      expect(w.t.kicked).toEqual([w.research, w.brief]);

      // Its children were cancelled with it. Cancelling again (a retried request) answers the
      // same and withdraws nothing twice.
      for (const id of [w.brief, w.campaign, w.launch]) {
        const child = (await (await w.t.get('token-alice', `/executions/${id}`)).json()) as {
          status: string;
        };
        expect(child.status).toBe('cancelled');
      }
      const again = await w.t.post('token-alice', `/executions/${w.plan.executionId}/cancel`, {
        reason: 'director_request',
      });
      expect(again.status).toBe(200);
      expect(((await again.json()) as { status: string }).status).toBe('cancelled');
      const withdrawn = (await w.t.stores.auditEvents()).filter(
        (e) => e.action === 'tool.approval_cancelled' && e.target?.id === w.approvalId,
      );
      expect(withdrawn).toEqual([
        expect.objectContaining({
          reason: 'plan_cancelled',
          actor: expect.objectContaining({ type: 'user', userId: w.t.tenant.userId }),
        }),
      ]);
    });

    it('ADR-0179: the trace route names each step approval and who decided it', async () => {
      const w = await waitingPlan();
      expect((await w.t.post('token-alice', `/approvals/${w.approvalId}/approve`)).status).toBe(
        200,
      );
      const response = await w.t.get('token-alice', `/plans/${w.plan.id}/trace`);
      expect(response.status).toBe(200);
      const trace = (await response.json()) as {
        workflow: unknown;
        steps: { stepId: string; approvals: { approvalId: string; declined: string | null }[] }[];
        history: { action: string; actor: string; actorId: string | null }[];
      };
      // A plan the planner wrote names no workflow.
      expect(trace.workflow).toBeNull();
      expect(trace.steps.find((s) => s.stepId === 'campaign')?.approvals).toEqual([
        expect.objectContaining({ approvalId: w.approvalId, declined: null }),
      ]);
      expect(trace.history).toContainEqual(
        expect.objectContaining({
          action: 'tool.approval_approved',
          actor: 'user',
          actorId: w.t.tenant.userId,
        }),
      );
      // The runtime's requests name the person it acted for, never as the decider.
      expect(trace.history).toContainEqual(
        expect.objectContaining({
          action: 'plan.step_approval_requested',
          actor: 'system',
          actorId: w.t.tenant.userId,
        }),
      );
    });

    it('ADR-0179: another organization can neither read the trace nor cancel the plan, nor decide its approval', async () => {
      const w = await waitingPlan();
      const asBob = (org: string, path: string, method = 'GET', body?: unknown) =>
        w.t.app.request(
          `/v1/organizations/${org}${path}`,
          w.t.as('token-bob', {
            method,
            headers: { 'content-type': 'application/json' },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          }),
        );
      const cancel = `/executions/${w.plan.executionId}/cancel`;
      const stop = { reason: 'director_request' };
      // From Bob's own organization, Alice's plan does not exist.
      expect((await asBob(w.t.orgB, `/plans/${w.plan.id}/trace`)).status).toBe(404);
      expect((await asBob(w.t.orgB, cancel, 'POST', stop)).status).toBe(404);
      // Through Alice's organization, Bob is not a member.
      expect((await asBob(w.t.orgA, `/plans/${w.plan.id}/trace`)).status).toBe(403);
      expect((await asBob(w.t.orgA, cancel, 'POST', stop)).status).toBe(403);
      expect((await asBob(w.t.orgA, `/approvals/${w.approvalId}/approve`, 'POST')).status).toBe(
        403,
      );
      expect((await w.states()).status).toBe('executing');
      expect((await w.t.stores.approvals.find(w.t.orgA, w.approvalId as never))?.status).toBe(
        'pending',
      );

      // Once Alice cancels, neither of them can bring the withdrawn approval back.
      await w.t.post('token-alice', cancel, stop);
      expect((await asBob(w.t.orgB, `/approvals/${w.approvalId}/approve`, 'POST')).status).toBe(
        404,
      );
      expect((await w.t.post('token-alice', `/approvals/${w.approvalId}/approve`)).status).toBe(
        409,
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
      // The tool step itself is listed (ADR-0167), waiting in that agent step's child.
      expect(must((await steps()).find((s) => s.stepId === 'search'))).toMatchObject({
        kind: 'tool',
        state: 'waiting',
        executionId: w.campaign,
        approvalId: null,
        result: null,
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
        listForWorkflow: (org, workflowId, limit) =>
          t.stores.plans.listForWorkflow(org, workflowId, limit),
        page: (org, request) => t.stores.plans.page(org, request),
        creatingPage: (request) => t.stores.plans.creatingPage(request),
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

describe('a tool step on the plan page (ADR-0167)', () => {
  it('sums up a result as counts and short values, never its content or anything secret', () => {
    expect(
      toolResultSummary({
        available: true,
        facts: ['a', 'b', 'c'],
        total: 4,
        topic: 'melons',
        apiKey: 'x',
        note: 'Bearer abcdefghijklmnop1234',
        long: 'x'.repeat(81),
        nested: { a: 1 },
        nan: Number.NaN,
      }),
    ).toEqual([
      { name: 'available', type: 'boolean', value: true },
      { name: 'facts', type: 'count', value: 3 },
      { name: 'total', type: 'number', value: 4 },
      { name: 'topic', type: 'text', value: 'melons' },
    ]);
    expect(toolResultSummary(null)).toBeNull();
    expect(toolResultSummary(['a'])).toBeNull();
    const many = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`f${i}`, i]));
    expect(toolResultSummary(many)).toHaveLength(12);
  });

  it('reads its state from its node, and is skipped when its agent step ended its branch', () => {
    const node = (status: string, approvalId?: string) =>
      ({ id: 'search', type: 'tool', status, approvalId }) as never;
    expect(toolStepState(node('completed'), undefined, 'completed')).toBe('completed');
    expect(toolStepState(node('failed'), undefined, 'failed')).toBe('failed');
    expect(toolStepState(node('cancelled'), undefined, 'stopped')).toBe('failed');
    expect(toolStepState(node('skipped'), undefined, 'completed')).toBe('skipped');
    expect(toolStepState(node('running'), undefined, 'running')).toBe('running');
    expect(
      toolStepState(node('pending', 'appr-1'), { status: 'waiting_approval' }, 'running'),
    ).toBe('awaiting_approval');
    expect(toolStepState(undefined, undefined, 'waiting')).toBe('waiting');
    for (const ended of ['skipped', 'declined', 'stopped', 'failed'] as const) {
      expect(toolStepState(undefined, undefined, ended)).toBe('skipped');
    }
  });
});
