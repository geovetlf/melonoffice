import { createProviderRegistry } from '@melonoffice/ai-gateway';
import { AGENT_TASK_NODE, classifyOpenWork, notificationOfTaskEnd } from '@melonoffice/agents';
import { InMemoryApprovalRepository } from '@melonoffice/approvals';
import { createAuditService, InMemoryAuditStore } from '@melonoffice/audit';
import { createServiceIdentityVerifier, type AuthenticatedContext } from '@melonoffice/auth';
import { TURN_CONTROL_KIND } from '@melonoffice/conversations';
import { openWallet } from '@melonoffice/credits';
import {
  DEFAULT_DEPARTMENT_CATALOGUE,
  departmentIdOf,
  InMemoryDepartmentRepository,
  provisionDepartments,
} from '@melonoffice/departments';
import type {
  DepartmentTypeId,
  Execution,
  InitialBilling,
  IsoTimestamp,
  JobId,
  Organization,
  Plan,
  PlanId,
  SubscriptionId,
  ToolDefinition,
  ToolVersion,
  UserId,
} from '@melonoffice/domain';
import {
  createExecutionService,
  executionIdFor,
  InMemoryExecutionRepository,
  InMemorySweepLedger,
} from '@melonoffice/execution';
import { InMemoryJobRepository, jobIdFor } from '@melonoffice/jobs';
import { createAuthorizationService } from '@melonoffice/rbac';
import {
  applySpecialistStatus,
  createSkillCatalogue,
  createSpecialistService,
  InMemorySpecialistRepository,
  newSpecialist,
} from '@melonoffice/specialists';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveRuntimeTenant,
  resolveTenant,
} from '@melonoffice/tenancy';
import { createToolRegistry } from '@melonoffice/tools';
import { describe, expect, it } from 'vitest';
import { createLogger } from '@melonoffice/observability';
import { createApp } from './app.js';
import { createWorkerRuntime } from './runtime.js';
import {
  createExecutionSweeper,
  nextSweepSlot,
  RUN_SWEEP_PATH,
  slotStartOf,
  sweepSlotOf,
  SWEEP_EVERY_MS,
} from './sweeps.js';

/**
 * The automatic sweep of abandoned agent work (ADR-0121), on the worker's real runtime in memory:
 * it closes only what nothing moved for 24 hours and nobody holds, never another organization's
 * work beyond its own, never twice, and it starts nothing.
 */

const T0 = new Date('2026-10-01T00:00:00Z');
const HOUR = 3_600_000;
const LEASE_MS = 60_000;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const STRANGER = '33333333-3333-4333-8333-333333333333' as UserId;

const BILLING = (organization: Organization): InitialBilling => {
  const subscriptionId = `sub-${organization.id}` as SubscriptionId;
  const at = organization.createdAt;
  return {
    account: { organizationId: organization.id, subscriptionId, createdAt: at, updatedAt: at },
    subscription: {
      id: subscriptionId,
      organizationId: organization.id,
      plan: { id: 'test-plan', version: 1 },
      status: 'active',
      createdAt: at,
      updatedAt: at,
    },
  };
};

const as = (userId: UserId): AuthenticatedContext =>
  Object.freeze({ actor: 'user', userId, emailVerified: true });

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing value');
  return value;
};

// Test only: MelonOffice's real tool catalogue is empty (ADR-0026).
const tool = (id: string, overrides: Partial<ToolVersion> = {}): ToolDefinition => ({
  id: id as ToolDefinition['id'],
  status: 'active',
  versions: [
    {
      toolId: id as ToolVersion['toolId'],
      version: 1,
      nameKey: `tools.${id}.name` as ToolVersion['nameKey'],
      descriptionKey: `tools.${id}.description` as ToolVersion['descriptionKey'],
      category: 'test',
      action: 'run',
      mutating: false,
      inputSchema: {
        type: 'object',
        properties: { subject: { type: 'string', maxLength: 200, minLength: 1 } },
        required: ['subject'],
      },
      outputSchema: {
        type: 'object',
        properties: { count: { type: 'integer', minimum: 0 } },
        required: ['count'],
      },
      permissions: ['organization.read'],
      credentials: [],
      riskLevel: 'low',
      approvalPolicy: 'auto',
      approvalTtlSeconds: 600,
      timeoutMs: 1000,
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      provider: { kind: 'internal', id: 'fixture' },
      environments: ['dev'],
      ...overrides,
    },
  ],
});
const TOOLS: readonly ToolDefinition[] = [
  tool('lookup'),
  // A person decides it, and has 30 days to.
  tool('send_email', {
    riskLevel: 'high',
    mutating: true,
    action: 'send',
    approvalTtlSeconds: 30 * 86_400,
  }),
];

async function world() {
  let clock = new Date(T0);
  const now = () => {
    clock = new Date(clock.getTime() + 1);
    return clock;
  };
  const audit = new InMemoryAuditStore();
  const departments = new InMemoryDepartmentRepository();
  const stores = {
    tenancy: new InMemoryTenancyStore(now, audit, undefined, departments),
    departments,
    specialists: new InMemorySpecialistRepository(),
    executions: new InMemoryExecutionRepository(audit),
    approvals: new InMemoryApprovalRepository(audit),
    jobs: new InMemoryJobRepository(audit),
    audit,
  };
  const provision = (organization: Organization) =>
    provisionDepartments(organization, DEFAULT_DEPARTMENT_CATALOGUE);
  const a = await createOrganization(as(ALICE), { name: 'A' }, stores.tenancy, {
    billing: BILLING,
    credits: openWallet,
    departments: provision,
  });
  const b = await createOrganization(as(BOB), { name: 'B' }, stores.tenancy, {
    billing: BILLING,
    credits: openWallet,
    departments: provision,
  });
  const authorization = createAuthorizationService();
  const specialists = createSpecialistService({
    repository: stores.specialists,
    departments: stores.departments,
    organizations: stores.tenancy,
    authorization,
  });
  const toolCalls: unknown[] = [];
  const modelCalls: unknown[] = [];
  const ended: { id: string; status: string; failure?: string }[] = [];
  const dispatched: JobId[] = [];
  const { jobs, runtime } = createWorkerRuntime({
    stores,
    environment: 'dev',
    leaseMs: LEASE_MS,
    tools: {
      registry: createToolRegistry(TOOLS),
      executors: {
        fixture: {
          async execute(context) {
            toolCalls.push(context);
            return { status: 'success', output: { count: 3 } };
          },
        },
      },
      skills: createSkillCatalogue([
        {
          id: 'fixture_work',
          version: 1,
          nameKey: 'fixture',
          descriptionKey: 'fixture',
          tools: TOOLS.map((t) => ({ id: t.id, versions: [1] })),
          actions: [],
          reads: [],
        } as never,
      ]),
    },
    ai: createProviderRegistry({ providers: [], models: [], adapters: [] }),
    work: {
      toolInput: async () => ({ subject: 'Weekly summary' }),
      agentWork: async (...args: unknown[]) => {
        modelCalls.push(args);
        return undefined;
      },
    },
    onEnded: {
      async ended(_tenant, execution, status) {
        ended.push({
          id: execution.id,
          status,
          ...(execution.failure === undefined ? {} : { failure: execution.failure.code }),
        });
      },
    },
    dispatcher: { dispatch: async (id) => void dispatched.push(id) },
    now,
  });

  const orgs = {
    a: { id: a.organization.id, owner: ALICE },
    b: { id: b.organization.id, owner: BOB },
  };
  let n = 0;

  /** An agent's task in `org`, started, its first job queued: what the task service makes. */
  async function task(
    org: keyof typeof orgs,
    nodes: readonly { id: string; tool?: string; dependsOn?: string[] }[],
  ) {
    const { id: organizationId, owner } = orgs[org];
    const tenant = await resolveTenant(as(owner), organizationId, stores.tenancy);
    const departmentId = departmentIdOf(organizationId, 'research' as DepartmentTypeId);
    const write = newSpecialist(
      {
        organizationId,
        displayName: 'María',
        configuration: {
          departmentId,
          mainRoleId: 'operations_assistant',
          roleVersion: 1,
          capabilities: [],
          skills: [{ id: 'fixture_work', version: 1 }],
          tools: TOOLS.map((t) => ({ id: t.id, version: 1 })),
          permissions: ['organization.read'],
          policies: {},
        } as never,
      },
      must(await stores.departments.find(organizationId, departmentId)),
      owner,
      now().toISOString() as IsoTimestamp,
    );
    await stores.specialists.create(write);
    const specialist = await stores.specialists.update(
      organizationId,
      write.specialist.identity.id,
      (s) =>
        applySpecialistStatus(
          s,
          { from: s.status, to: 'active' },
          now().toISOString() as IsoTimestamp,
        ),
    );
    const executions = createExecutionService({
      repository: stores.executions,
      organizations: stores.tenancy,
      assignments: specialists.assignments,
      authorization,
      audit: createAuditService(stores.audit, now),
      now,
      requestId: 'req-owner',
    });
    n += 1;
    const key = `agent-task-${String(n)}`;
    const ref = { type: 'agent_task', id: executionIdFor(organizationId, key) };
    const created = await executions.create(tenant, {
      mode: 'execute',
      input: ref,
      specialistId: specialist.identity.id,
      specialistVersion: specialist.version,
      departmentId,
      versionSnapshot: {
        schemaVersion: 1,
        components: [{ kind: 'specialist', id: specialist.identity.id, version: '1' }],
      },
      nodes: nodes.map((node) => ({
        id: node.id,
        type: node.tool === undefined ? 'agent' : 'tool',
        label: node.id,
        ...(node.tool === undefined ? {} : { tool: { id: node.tool, version: 1 } }),
        ...(node.dependsOn === undefined ? {} : { dependsOn: node.dependsOn }),
      })),
      idempotencyKey: key,
    });
    const started = await executions.start(tenant, created.id);
    const job = await runtime.kickoff(tenant, started.id);
    return { execution: started, jobId: job.id, tenant };
  }

  const ledger = new InMemorySweepLedger();
  const scheduled: { body: object; at: Date }[] = [];
  const sweeper = createExecutionSweeper({
    executions: stores.executions,
    jobs: stores.jobs,
    approvals: stores.approvals,
    tenancy: stores.tenancy,
    runtime,
    ledger,
    scheduler: { schedule: async (body, at) => void scheduled.push({ body, at }) },
    now,
  });
  const find = async (e: Execution) => must(await stores.executions.find(e.organizationId, e.id));
  const actions = (id: string) =>
    audit
      .events()
      .filter((e) => e.target?.id === id)
      .map((e) => e.action);
  return {
    stores,
    jobs,
    runtime,
    task,
    sweeper,
    ledger,
    scheduled,
    find,
    actions,
    toolCalls,
    modelCalls,
    ended,
    dispatched,
    advance: (ms: number) => {
      clock = new Date(clock.getTime() + ms);
    },
    at: () => new Date(clock),
  };
}

const AGENT = [{ id: AGENT_TASK_NODE }];

describe('the automatic sweep of abandoned agent work (ADR-0121)', () => {
  it('closes a task nothing moved for 24 hours: failed, stale, audited, told, nothing started', async () => {
    const w = await world();
    const { execution } = await w.task('a', AGENT);
    w.advance(25 * HOUR);
    const slot = sweepSlotOf(w.at()).id;
    const record = await w.sweeper.sweep(slot);

    const stored = await w.find(execution);
    expect(stored.status).toBe('failed');
    expect(stored.failure).toEqual({
      code: 'stale_execution',
      ref: { type: 'execution_sweep', id: slot },
    });
    // Kept, with every earlier record: nothing is deleted.
    expect(stored.nodes).toHaveLength(1);
    expect(w.actions(execution.id)).toEqual(
      expect.arrayContaining([
        'execution.created',
        'execution.job_enqueued',
        'execution.state_changed',
        'execution.abandoned',
        'execution.job_cancelled',
      ]),
    );
    const abandoned = must(w.stores.audit.events().find((e) => e.action === 'execution.abandoned'));
    expect(abandoned).toMatchObject({
      organizationId: execution.organizationId,
      actor: { type: 'system' },
      reason: 'no_progress',
    });
    // What was found and when, and when it was closed.
    expect(record.counts).toEqual({ closed: 1 });
    expect(record.closed).toEqual([
      expect.objectContaining({
        executionId: execution.id,
        organizationId: execution.organizationId,
        from: 'running',
        why: 'no_progress',
        detectedAt: expect.any(String),
        closedAt: expect.any(String),
      }),
    ]);
    const closed = must(record.closed[0]);
    expect(closed.closedAt >= closed.detectedAt).toBe(true);
    // Its job is cancelled, the end hook told its person, and nothing ran or started.
    expect(
      (
        await w.stores.jobs.find(
          jobIdFor(execution.organizationId, execution.id, AGENT_TASK_NODE, 1),
        )
      )?.state,
    ).toBe('cancelled');
    expect(w.ended).toEqual([{ id: execution.id, status: 'failed', failure: 'stale_execution' }]);
    expect(w.toolCalls).toHaveLength(0);
    expect(w.modelCalls).toHaveLength(0);
    expect(w.dispatched).toHaveLength(1); // the kickoff only
  });

  it('tells its person "abandoned" from the task end it publishes', () => {
    expect(
      notificationOfTaskEnd({ outcome: 'failed', handoff: null, code: 'stale_execution' }),
    ).toEqual({ kind: 'task_abandoned', code: 'stale_execution' });
  });

  it('never closes a long task a worker still holds', async () => {
    const w = await world();
    const { execution, jobId } = await w.task('a', AGENT);
    w.advance(25 * HOUR);
    // A worker leased it a moment ago: it is running, however old the execution looks.
    await w.jobs.acquire(jobId, 'worker-1');
    const record = await w.sweeper.sweep(sweepSlotOf(w.at()).id);
    expect(record.counts).toEqual({ active: 1 });
    expect((await w.find(execution)).status).toBe('running');
  });

  it('never closes a task with a recent heartbeat', async () => {
    const w = await world();
    const { execution, jobId } = await w.task('a', AGENT);
    w.advance(25 * HOUR);
    // Its job moved two hours ago (a lease taken and given back): progress.
    w.advance(-2 * HOUR);
    const claim = await w.jobs.acquire(jobId, 'worker-1');
    await w.jobs.release(claim, 'retry_later');
    w.advance(2 * HOUR);
    const record = await w.sweeper.sweep(sweepSlotOf(w.at()).id);
    expect(record.counts).toEqual({ active: 1 });
    expect((await w.find(execution)).status).toBe('running');
  });

  it('never closes a task waiting for a person’s approval', async () => {
    const w = await world();
    const { execution, jobId } = await w.task('a', [
      { id: 'send', tool: 'send_email' },
      { id: AGENT_TASK_NODE, dependsOn: ['send'] },
    ]);
    const claim = await w.jobs.acquire(jobId, 'worker-1');
    expect(await w.runtime.advance(claim.lease)).toMatchObject({ outcome: 'waiting_approval' });
    // Ten days later the person still has twenty to decide.
    w.advance(10 * 24 * HOUR);
    const record = await w.sweeper.sweep(sweepSlotOf(w.at()).id);
    expect(record.counts).toEqual({ awaiting_approval: 1 });
    expect((await w.find(execution)).status).toBe('waiting_approval');
    // Once the approval expired and nothing moved for a day, it is abandoned.
    w.advance(21 * 24 * HOUR);
    const later = await w.sweeper.sweep(sweepSlotOf(w.at()).id);
    expect(later.closed).toEqual([expect.objectContaining({ why: 'approval_expired' })]);
    expect((await w.find(execution)).status).toBe('failed');
  });

  it('never closes a task held on something outside the runtime', async () => {
    const w = await world();
    const { execution } = await w.task('a', AGENT);
    const stored = await w.find(execution);
    w.stores.executions.put({ ...stored, status: 'paused' });
    w.advance(30 * 24 * HOUR);
    const record = await w.sweeper.sweep(sweepSlotOf(w.at()).id);
    expect(record.counts).toEqual({});
    expect((await w.find(execution)).status).toBe('paused');
    expect(
      classifyOpenWork({
        execution: { ...stored, status: 'paused' },
        jobs: [],
        approvals: [],
        now: w.at(),
      }).state,
    ).toBe('awaiting_external');
  });

  it('shows a task idle for 12 hours as stuck but does not close it', async () => {
    const w = await world();
    const { execution } = await w.task('a', AGENT);
    w.advance(12 * HOUR);
    const record = await w.sweeper.sweep(sweepSlotOf(w.at()).id);
    // Not even read: the query only asks for 24 hours without an update.
    expect(record.counts).toEqual({});
    const stored = await w.find(execution);
    expect(
      classifyOpenWork({ execution: stored, jobs: [], approvals: [], now: w.at() }).state,
    ).toBe('no_progress');
    expect(stored.status).toBe('running');
  });

  it('closes each organization’s work as its own, and never touches another’s', async () => {
    const w = await world();
    const mine = await w.task('a', AGENT);
    w.advance(25 * HOUR);
    const theirs = await w.task('b', AGENT);
    const theirsBefore = await w.find(theirs.execution);
    const record = await w.sweeper.sweep(sweepSlotOf(w.at()).id);
    expect(record.closed.map((c) => c.executionId)).toEqual([mine.execution.id]);
    expect(await w.find(theirs.execution)).toEqual(theirsBefore);
    // Every record of the close is in the closed execution's own organization.
    const events = w.stores.audit
      .events()
      .filter((e) => e.action === 'execution.abandoned' || e.target?.id === mine.execution.id);
    expect(events.every((e) => e.organizationId === mine.execution.organizationId)).toBe(true);
    // An execution read from another organization is absent to the runtime that closes.
    const tenantB = await resolveRuntimeTenant(
      BOB,
      theirs.execution.organizationId,
      w.stores.tenancy,
    );
    await expect(
      w.runtime.abandon(tenantB, mine.execution.id, {
        from: 'running',
        revision: 1,
        sweepId: 'sweep-20261002t00',
        why: 'no_progress',
      }),
    ).rejects.toMatchObject({ code: 'execution_not_found' });
  });

  it('never processes an execution that already ended', async () => {
    const w = await world();
    const { execution } = await w.task('a', AGENT);
    w.advance(25 * HOUR);
    await w.sweeper.sweep(sweepSlotOf(w.at()).id);
    const closed = await w.find(execution);
    w.advance(SWEEP_EVERY_MS);
    const again = await w.sweeper.sweep(sweepSlotOf(w.at()).id);
    expect(again.counts).toEqual({});
    expect(await w.find(execution)).toEqual(closed);
    expect(w.ended).toHaveLength(1);
  });

  it('takes no action on work without a valid person or organization', async () => {
    const w = await world();
    const { execution } = await w.task('a', AGENT);
    // Its person is no member of the organization any more (or never was).
    const stored = await w.find(execution);
    w.stores.executions.put({ ...stored, userId: STRANGER });
    w.advance(25 * HOUR);
    const record = await w.sweeper.sweep(sweepSlotOf(w.at()).id);
    expect(record.counts).toEqual({ no_context: 1 });
    expect((await w.find(execution)).status).toBe('running');
    expect(w.actions(execution.id)).not.toContain('execution.abandoned');
    expect(w.ended).toHaveLength(0);
  });

  it('closes an abandoned conversation turn, so its stop hook can hand the conversation over (ADR-0122)', async () => {
    const w = await world();
    const { execution } = await w.task('a', AGENT);
    const stored = await w.find(execution);
    w.stores.executions.put({
      ...stored,
      input: { type: 'message', id: 'msg-1' },
      versionSnapshot: {
        ...stored.versionSnapshot,
        components: [
          ...stored.versionSnapshot.components,
          { kind: TURN_CONTROL_KIND, id: 'conv-1', version: '0' },
        ],
      },
    });
    w.advance(25 * HOUR);
    const record = await w.sweeper.sweep(sweepSlotOf(w.at()).id);
    expect(record.counts).toEqual({ closed: 1 });
    expect((await w.find(execution)).failure?.code).toBe('stale_execution');
  });

  it('never closes a plan step that has not started while its plan runs; one waiting for a person advances its plan (ADR-0146)', async () => {
    const w = await world();
    const { execution } = await w.task('a', AGENT);
    const stored = await w.find(execution);
    const planId = '00000000-0000-4000-8000-000000000146' as PlanId;
    // A step's child that never started, its plan waiting on a person to approve it.
    const unstarted: { -readonly [K in keyof Execution]?: Execution[K] } = { ...stored };
    delete unstarted.startedAt;
    w.stores.executions.put({
      ...unstarted,
      status: 'pending',
      input: { type: 'plan_step', id: `${planId}:campaign` },
      parentExecutionId: stored.id,
    } as Execution);
    let plan = {
      id: planId,
      status: 'executing',
      stepApprovals: [{ stepId: 'campaign', approvalId: 'x', requestedAt: T0 }],
    } as unknown as Plan;
    const advanced: { actor: string; organizationId: string; planId: string }[] = [];
    const sweeper = createExecutionSweeper({
      executions: w.stores.executions,
      jobs: w.stores.jobs,
      approvals: w.stores.approvals,
      tenancy: w.stores.tenancy,
      runtime: w.runtime,
      ledger: w.ledger,
      plans: {
        find: async (organizationId, id) =>
          organizationId === stored.organizationId && id === planId ? plan : undefined,
        advance: async (tenant, id) =>
          void advanced.push({
            actor: tenant.actor,
            organizationId: tenant.organizationId,
            planId: id,
          }),
      },
      now: w.at,
    });
    w.advance(25 * HOUR);
    const record = await sweeper.sweep(sweepSlotOf(w.at()).id);
    expect(record.counts).toEqual({ awaiting_approval: 1 });
    expect(record.closed).toEqual([]);
    // Its plan was advanced as its person's runtime, in its own organization only.
    expect(advanced).toEqual([{ actor: 'runtime', organizationId: stored.organizationId, planId }]);
    expect((await w.find(execution)).status).toBe('pending');

    // A step that only waits for the steps before it is left alone too, with nothing advanced.
    plan = { ...plan, stepApprovals: [] } as unknown as Plan;
    w.advance(25 * HOUR);
    expect((await sweeper.sweep(sweepSlotOf(w.at()).id)).counts).toEqual({ waiting_in_plan: 1 });
    expect(advanced).toHaveLength(1);

    // A wait still running leaves it alone; one that is over advances its plan, in case its
    // wake-up was lost (ADR-0152).
    const until = new Date(w.at().getTime() + 26 * HOUR).toISOString();
    plan = { ...plan, waits: [{ stepId: 'pause', startedAt: T0, until }] } as unknown as Plan;
    w.advance(25 * HOUR);
    expect((await sweeper.sweep(sweepSlotOf(w.at()).id)).counts).toEqual({ waiting_in_plan: 1 });
    w.advance(2 * HOUR);
    expect((await sweeper.sweep(sweepSlotOf(w.at()).id)).counts).toEqual({ wait_over: 1 });
    expect(advanced).toHaveLength(2);
    plan = { ...plan, waits: [] } as unknown as Plan;

    // This child is a step's next attempt (ADR-0153): its plan is advanced once its backoff is
    // over, so a lost wake-up never leaves it unstarted.
    const notBefore = new Date(w.at().getTime() + 26 * HOUR).toISOString();
    plan = {
      ...plan,
      attempts: [{ stepId: 'pause', executionId: execution.id, notBefore }],
    } as unknown as Plan;
    w.advance(25 * HOUR);
    expect((await sweeper.sweep(sweepSlotOf(w.at()).id)).counts).toEqual({ waiting_in_plan: 1 });
    w.advance(2 * HOUR);
    expect((await sweeper.sweep(sweepSlotOf(w.at()).id)).counts).toEqual({ wait_over: 1 });
    expect(advanced).toHaveLength(3);
    plan = { ...plan, attempts: [] } as unknown as Plan;

    // Once the plan ended, a child left behind is swept as before.
    plan = { ...plan, status: 'completed' } as Plan;
    w.advance(25 * HOUR);
    const later = await sweeper.sweep(sweepSlotOf(w.at()).id);
    expect(later.closed).toEqual([expect.objectContaining({ executionId: execution.id })]);
    expect(advanced).toHaveLength(3);
  });

  it('ADR-0183: work rightly waiting never hides abandoned work or a stalled plan behind it', async () => {
    const w = await world();
    const { execution } = await w.task('a', AGENT);
    const stored = await w.find(execution);
    const minutes = (n: number) =>
      new Date(Date.parse(stored.updatedAt) + n * 60_000).toISOString() as IsoTimestamp;
    // 60 running plans, each rightly waiting with one unstarted step, all older than the task:
    // more than one page of candidates, ahead of it and of the stalled plan.
    const waiting = new Set<string>();
    const unstarted: { -readonly [K in keyof Execution]?: Execution[K] } = { ...stored };
    delete unstarted.startedAt;
    for (let i = 0; i < 60; i += 1) {
      const planId = crypto.randomUUID();
      waiting.add(planId);
      w.stores.executions.put({
        ...unstarted,
        id: planId,
        mode: 'plan',
        input: { type: 'task', id: `task-${i}` },
        updatedAt: minutes(-120 - i),
      } as Execution);
      w.stores.executions.put({
        ...unstarted,
        id: crypto.randomUUID(),
        input: { type: 'plan_step', id: `${planId}:research` },
        parentExecutionId: planId,
        updatedAt: minutes(-60 - i),
      } as Execution);
    }
    // The one plan that is stuck: its steps ended and nothing moved it. The newest of all.
    const stalled = crypto.randomUUID();
    w.stores.executions.put({
      ...unstarted,
      id: stalled,
      mode: 'plan',
      input: { type: 'task', id: 'task-stalled' },
      updatedAt: minutes(1),
    } as Execution);
    const advanced: string[] = [];
    const sweeper = createExecutionSweeper({
      executions: w.stores.executions,
      jobs: w.stores.jobs,
      approvals: w.stores.approvals,
      tenancy: w.stores.tenancy,
      runtime: w.runtime,
      ledger: w.ledger,
      plans: {
        find: async (organizationId, id) => {
          if (organizationId !== stored.organizationId) return undefined;
          if (id === stalled) {
            return { id, status: 'executing', delegationState: 'completed' } as unknown as Plan;
          }
          return waiting.has(id)
            ? ({ id, status: 'executing', delegationState: 'running' } as unknown as Plan)
            : undefined;
        },
        advance: async (_tenant, id) => void advanced.push(id),
      },
      now: w.at,
    });
    w.advance(25 * HOUR);
    const record = await sweeper.sweep(sweepSlotOf(w.at()).id);
    // Every waiting step and plan was read and left alone; the task behind them was closed and
    // the stalled plan advanced, once.
    expect(record.counts).toMatchObject({
      waiting_in_plan: 60,
      moved: 60,
      closed: 1,
      plan_advanced: 1,
    });
    expect(record.closed).toEqual([expect.objectContaining({ executionId: execution.id })]);
    expect(advanced).toEqual([stalled]);
    expect((await w.find(execution)).status).toBe('failed');
  });

  it('never closes work that is not an agent’s task or a plan’s step', async () => {
    const w = await world();
    const { execution } = await w.task('a', AGENT);
    const stored = await w.find(execution);
    w.stores.executions.put({ ...stored, input: { type: 'conversation', id: 'c-1' } });
    w.advance(25 * HOUR);
    const record = await w.sweeper.sweep(sweepSlotOf(w.at()).id);
    expect(record.counts).toEqual({ out_of_scope: 1 });
    expect((await w.find(execution)).status).toBe('running');
  });

  it('runs each slot once, however often its task arrives, and queues the next one once', async () => {
    const w = await world();
    const { execution } = await w.task('a', AGENT);
    w.advance(25 * HOUR);
    const slot = sweepSlotOf(w.at()).id;
    expect(await w.sweeper.run({ slot })).toEqual({ status: 200, body: { result: 'swept' } });
    expect(await w.sweeper.run({ slot })).toEqual({
      status: 200,
      body: { result: 'already_swept' },
    });
    expect(w.ledger.slot(slot)).toMatchObject({ state: 'done', record: { counts: { closed: 1 } } });
    expect(w.ended).toHaveLength(1);
    expect(w.actions(execution.id).filter((a) => a === 'execution.abandoned')).toHaveLength(1);
    // The next slot is queued once, 3 hours on, whatever else asks for it.
    await w.sweeper.ensureNext();
    await w.sweeper.ensureNext();
    expect(w.scheduled).toEqual([
      { body: { slot: nextSweepSlot(w.at()).id }, at: nextSweepSlot(w.at()).at },
    ]);
    // A close that races a change is refused by the revision and changes nothing.
    const stale = await w.task('a', AGENT);
    const runtimeA = await resolveRuntimeTenant(
      ALICE,
      stale.execution.organizationId,
      w.stores.tenancy,
    );
    await expect(
      w.runtime.abandon(runtimeA, stale.execution.id, {
        from: 'running',
        revision: 0,
        sweepId: slot,
        why: 'no_progress',
      }),
    ).rejects.toMatchObject({ code: 'execution_concurrency_conflict' });
    expect((await w.find(stale.execution)).status).toBe('running');
  });

  it('refuses a slot that is not one, or not due, and a close asked by a person', async () => {
    const w = await world();
    expect((await w.sweeper.run({ slot: 'sweep-20261001t01' })).status).toBe(400);
    expect((await w.sweeper.run({ slot: 'x', more: 1 })).status).toBe(400);
    expect((await w.sweeper.run({ slot: nextSweepSlot(w.at()).id })).status).toBe(503);
    expect(slotStartOf('sweep-20261001t03')?.toISOString()).toBe('2026-10-01T03:00:00.000Z');
    const { execution, tenant } = await w.task('a', AGENT);
    await expect(
      w.runtime.abandon(tenant, execution.id, {
        from: 'running',
        revision: execution.revision,
        sweepId: 'sweep-20261001t00',
        why: 'no_progress',
      }),
    ).rejects.toMatchObject({ code: 'invalid_request' });
  });
});

describe('classifyOpenWork (ADR-0121)', () => {
  const now = new Date('2026-10-02T00:00:00Z');
  const ago = (ms: number) => new Date(now.getTime() - ms).toISOString() as IsoTimestamp;
  const execution = (status: Execution['status'], updated: number) =>
    ({ status, updatedAt: ago(updated), nodes: [] }) as Pick<
      Execution,
      'status' | 'updatedAt' | 'nodes'
    >;

  it('reads every case apart', () => {
    const at = (input: Partial<Parameters<typeof classifyOpenWork>[0]>) =>
      classifyOpenWork({
        execution: execution('running', 30 * HOUR),
        jobs: [],
        approvals: [],
        now,
        ...input,
      }).state;
    expect(at({ execution: execution('completed', 30 * HOUR) })).toBe('closed');
    // A live lease taken long ago: a long task, running.
    expect(
      at({
        jobs: [
          {
            state: 'leased',
            updatedAt: ago(30 * HOUR),
            lease: { acquiredAt: ago(30 * HOUR), expiresAt: ago(-HOUR) },
          },
        ],
      }),
    ).toBe('active');
    expect(
      at({
        execution: execution('waiting_approval', 30 * HOUR),
        approvals: [{ status: 'pending', expiresAt: ago(-HOUR) }],
      }),
    ).toBe('awaiting_approval');
    expect(at({ execution: execution('paused', 300 * HOUR) })).toBe('awaiting_external');
    expect(at({ execution: execution('running', HOUR) })).toBe('active');
    expect(at({ execution: execution('running', 12 * HOUR) })).toBe('no_progress');
    expect(at({ jobs: [{ state: 'queued', updatedAt: ago(HOUR) }] })).toBe('active');
    expect(at({})).toBe('stuck');
    // An expired lease, or an expired approval, holds nothing.
    expect(
      at({
        jobs: [
          {
            state: 'leased',
            updatedAt: ago(30 * HOUR),
            lease: { acquiredAt: ago(30 * HOUR), expiresAt: ago(29 * HOUR) },
          },
        ],
      }),
    ).toBe('stuck');
    expect(
      at({
        execution: execution('waiting_approval', 30 * HOUR),
        approvals: [{ status: 'pending', expiresAt: ago(HOUR) }],
      }),
    ).toBe('stuck');
    // No time to read at all: never abandoned.
    expect(
      at({
        execution: { status: 'running', updatedAt: 'not a time', nodes: [] } as never,
      }),
    ).toBe('active');
  });
});

describe('the sweep route (ADR-0121)', () => {
  const WORKER_URL = 'https://worker-123456789012.us-central1.run.app';
  const app = (sweeps?: { run: () => Promise<never> }) =>
    createApp({
      logger: createLogger({ service: 'worker', sink: () => undefined }),
      version: 'test',
      jobs: {
        handler: { run: async () => ({ status: 200, body: {} }) } as never,
        invoker: createServiceIdentityVerifier({
          audience: WORKER_URL,
          allowedEmails: ['job-dispatch@melonoffice-test.iam.gserviceaccount.com'],
        }),
        ...(sweeps === undefined ? {} : { sweeps }),
      },
    });

  it('is refused where sweeps are not configured, and without the invoker’s token', async () => {
    const off = await app().request(RUN_SWEEP_PATH, { method: 'POST' });
    expect(off.status).toBe(503);
    expect(await off.json()).toEqual({ error: 'sweeps_not_configured' });
    let ran = false;
    const on = await app({
      run: async () => {
        ran = true;
        throw new Error('never');
      },
    }).request(RUN_SWEEP_PATH, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slot: 'sweep-20261001t00' }),
    });
    expect(on.status).toBe(401);
    expect(ran).toBe(false);
  });
});
