import { openWallet } from '@melonoffice/credits';
import {
  createApprovalService,
  InMemoryApprovalRepository,
  type ApprovalRequestInput,
} from '@melonoffice/approvals';
import { createAuditService, InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import {
  DEFAULT_DEPARTMENT_CATALOGUE,
  departmentIdOf,
  InMemoryDepartmentRepository,
  provisionDepartments,
} from '@melonoffice/departments';
import type {
  ApprovalId,
  DeploymentEnvironment,
  DepartmentTypeId,
  Execution,
  ExecutionMode,
  InitialBilling,
  IsoTimestamp,
  Organization,
  OrganizationId,
  Specialist,
  SpecialistStatus,
  SubscriptionId,
  ToolDefinition,
  ToolVersion,
  UserId,
} from '@melonoffice/domain';
import {
  attachApproval,
  createExecutionService,
  InMemoryExecutionRepository,
} from '@melonoffice/execution';
import { createLogger } from '@melonoffice/observability';
import { createAuthorizationService } from '@melonoffice/rbac';
import {
  applySpecialistStatus,
  createSpecialistService,
  InMemorySpecialistRepository,
  newSpecialist,
} from '@melonoffice/specialists';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveRuntimeTenant,
  resolveTenant,
  type TenantContext,
} from '@melonoffice/tenancy';
import {
  createToolRegistry,
  digestOf,
  type ToolExecutionContext,
  type ToolExecutor,
  type ToolExecutorOutcome,
} from '@melonoffice/tools';
import { describe, expect, it } from 'vitest';
import { createToolGate } from './gate.js';
import {
  DEFAULT_RISK_POLICY,
  effectivePolicy,
  evaluateHumanPreExecution,
  evaluatePostExecution,
} from './rules.js';

const T0 = new Date('2026-09-27T12:00:00Z');
const AT = T0.toISOString() as IsoTimestamp;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const OWNER_ALL = [
  'organization.read',
  'execution.read',
  'specialist.read',
  'tool.read',
  'tool.execute',
  'approval.read',
  'approval.approve',
] as const;

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

const as = (userId: UserId, actor: 'user' | 'gia' = 'user'): AuthenticatedContext =>
  Object.freeze({ actor, userId, emailVerified: true });

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing value');
  return value;
};

const OBJECT_IN = {
  type: 'object',
  properties: { subject: { type: 'string', maxLength: 200, minLength: 1 } },
  required: ['subject'],
} as const;
const OBJECT_OUT = {
  type: 'object',
  properties: { count: { type: 'integer', minimum: 0 } },
  required: ['count'],
} as const;

/** Test fixtures only: MelonOffice's real catalogue is empty until tools arrive with their phase. */
const tool = (
  id: string,
  overrides: Partial<ToolVersion> = {},
  status: ToolDefinition['status'] = 'active',
): ToolDefinition => ({
  id: id as ToolDefinition['id'],
  status,
  versions: [
    {
      toolId: id as ToolVersion['toolId'],
      version: 1,
      nameKey: `tools.${id}.name` as ToolVersion['nameKey'],
      descriptionKey: `tools.${id}.description` as ToolVersion['descriptionKey'],
      category: 'test',
      action: 'run',
      mutating: false,
      inputSchema: OBJECT_IN,
      outputSchema: OBJECT_OUT,
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
  tool('send_email', { riskLevel: 'high', mutating: true, action: 'send' }),
  tool('post_note', { riskLevel: 'high', mutating: true, action: 'send' }),
  tool('wipe_data', { riskLevel: 'critical', mutating: true, approvalPolicy: 'approval_required' }),
  tool('finance_report', { departmentTypes: ['finance' as DepartmentTypeId] }),
  tool('billing_lookup', { permissions: ['billing.read'] }),
  tool('staging_only', { environments: ['staging'] }),
  tool('flaky', { retryPolicy: { maxAttempts: 3, backoffMs: 5 } }),
  tool('slow', { timeoutMs: 20 }),
  tool('update_record', { mutating: true }),
  tool('retired', {}, 'disabled'),
  // ADR-0034 fixtures: tools a person may invoke directly, and only because they say so.
  tool('human_note', {
    invocationModes: ['human'],
    mutating: true,
    action: 'send',
    riskLevel: 'medium',
  }),
  tool('shared_lookup', { invocationModes: ['runtime', 'human'] }),
  tool('human_risky', { invocationModes: ['human'], riskLevel: 'high' }),
  tool('human_slow', { invocationModes: ['human'], timeoutMs: 20 }),
  tool('human_retired', { invocationModes: ['human'] }, 'paused'),
];

const ASSIGNED = TOOLS.map((t) => ({ id: t.id, version: 1 }));

/** A fixture executor: answers per tool, and records every call it gets. */
function fixtureExecutor(answers: Record<string, () => Promise<ToolExecutorOutcome>> = {}) {
  const calls: { context: ToolExecutionContext; input: unknown }[] = [];
  const executor: ToolExecutor = {
    async execute(context, input) {
      calls.push({ context, input });
      const answer = answers[context.toolId];
      return answer === undefined ? { status: 'success', output: { count: 3 } } : answer();
    },
  };
  return { executor, calls };
}

interface WorldOptions {
  readonly roles?: Record<string, readonly string[]>;
  /** Roles as they are when the tool runs, when they changed after the execution was created. */
  readonly rolesAtRun?: Record<string, readonly string[]>;
  readonly environment?: DeploymentEnvironment | undefined;
  readonly answers?: Record<string, () => Promise<ToolExecutorOutcome>>;
}

async function world(options: WorldOptions = {}) {
  let clock = T0;
  const now = () => clock;
  const audit = new InMemoryAuditStore();
  const departments = new InMemoryDepartmentRepository();
  const tenancy = new InMemoryTenancyStore(now, audit, undefined, departments);
  const provision = (organization: Organization) =>
    provisionDepartments(organization, DEFAULT_DEPARTMENT_CATALOGUE);
  const a = await createOrganization(as(ALICE), { name: 'A' }, tenancy, {
    billing: BILLING,
    credits: openWallet,
    departments: provision,
  });
  const b = await createOrganization(as(BOB), { name: 'B' }, tenancy, {
    billing: BILLING,
    credits: openWallet,
    departments: provision,
  });
  const orgA = a.organization.id;
  const orgB = b.organization.id;
  const authorization = createAuthorizationService(
    (options.roles ?? { owner: OWNER_ALL }) as never,
  );
  const specialistRepository = new InMemorySpecialistRepository();
  const specialists = createSpecialistService({
    repository: specialistRepository,
    departments,
    organizations: tenancy,
    authorization,
  });
  const executionRepository = new InMemoryExecutionRepository(audit);
  const executions = createExecutionService({
    repository: executionRepository,
    organizations: tenancy,
    assignments: specialists.assignments,
    // Starting is the owner's (ADR-0029), whatever roles a test gives the gate.
    authorization: createAuthorizationService(),
    audit: createAuditService(audit, now),
    now,
  });
  const approvalRepository = new InMemoryApprovalRepository(audit);
  const auditService = createAuditService(audit, now);
  const approvals = createApprovalService({
    repository: approvalRepository,
    organizations: tenancy,
    authorization,
    audit: auditService,
    now,
  });
  const { executor, calls } = fixtureExecutor(options.answers);
  const authorizationAtRun =
    options.rolesAtRun === undefined
      ? authorization
      : createAuthorizationService(options.rolesAtRun as never);
  const specialistsAtRun =
    options.rolesAtRun === undefined
      ? specialists
      : createSpecialistService({
          repository: specialistRepository,
          departments,
          organizations: tenancy,
          authorization: authorizationAtRun,
        });
  const logLines: Record<string, unknown>[] = [];
  const gate = createToolGate({
    executions: executionRepository,
    organizations: tenancy,
    specialists: specialistsAtRun,
    departments,
    registry: createToolRegistry(TOOLS),
    approvals,
    executors: { fixture: executor },
    authorization: authorizationAtRun,
    audit: auditService,
    environment: 'environment' in options ? options.environment : 'dev',
    logger: createLogger({
      service: 'test',
      sink: (line) => logLines.push(JSON.parse(line) as Record<string, unknown>),
    }),
    now,
    sleep: async () => undefined,
  });
  const tenantA = await resolveTenant(as(ALICE), orgA, tenancy);
  const tenantB = await resolveTenant(as(BOB), orgB, tenancy);
  const giaA = await resolveTenant(as(ALICE, 'gia'), orgA, tenancy);
  const runtimeA = await resolveRuntimeTenant(ALICE, orgA, tenancy);
  const runtimeB = await resolveRuntimeTenant(BOB, orgB, tenancy);

  async function seed(
    org: OrganizationId,
    {
      status = 'active',
      permissions = ['organization.read'],
      department = 'research',
    }: { status?: SpecialistStatus; permissions?: string[]; department?: string } = {},
  ): Promise<Specialist> {
    const departmentId = departmentIdOf(org, department as DepartmentTypeId);
    const write = newSpecialist(
      {
        organizationId: org,
        displayName: 'María',
        configuration: {
          departmentId,
          mainRoleId: 'operations_assistant',
          roleVersion: 1,
          capabilities: [],
          skills: [],
          tools: ASSIGNED,
          permissions,
          policies: {},
        } as never,
      },
      must(await departments.find(org, departmentId)),
      ALICE,
      AT,
    );
    await specialistRepository.create(write);
    let current = write.specialist;
    for (const to of status === 'draft'
      ? []
      : ['active', ...(status === 'active' ? [] : [status])]) {
      current = await specialistRepository.update(org, current.identity.id, (s) =>
        applySpecialistStatus(s, { from: s.status, to: to as SpecialistStatus }, AT),
      );
    }
    return current;
  }

  /** An execution of an active specialist, running, with one tool node per tool given. */
  async function running(
    tenant: TenantContext,
    specialist: Specialist,
    tools: readonly string[],
    mode: ExecutionMode = 'execute',
  ): Promise<Execution> {
    const execution = await executions.create(tenant, {
      mode,
      input: { type: 'task', id: 'task-1' },
      specialistId: specialist.identity.id,
      specialistVersion: specialist.version,
      departmentId: specialist.configuration.departmentId,
      versionSnapshot: {
        schemaVersion: 1,
        components: [{ kind: 'specialist', id: specialist.identity.id, version: '1' }],
      },
      nodes: tools.map((id, i) => ({
        id: `n${i}`,
        type: 'tool' as const,
        label: id,
        tool: { id, version: 1 },
      })),
    });
    return executions.start(tenant, execution.id);
  }

  /** A person's own execution (ADR-0034): no specialist, one tool node per tool, started. */
  async function mine(tenant: TenantContext, tools: readonly string[], start = true) {
    const execution = await executions.create(tenant, {
      mode: 'execute',
      input: { type: 'message', id: 'message-1' },
      versionSnapshot: { schemaVersion: 1, components: [] },
      nodes: tools.map((id, i) => ({
        id: `n${i}`,
        type: 'tool' as const,
        label: id,
        tool: { id, version: 1 },
      })),
    });
    return start ? executions.start(tenant, execution.id) : execution;
  }

  const events = (action?: string) =>
    audit.events().filter((e) => action === undefined || e.action === action);

  return {
    audit,
    events,
    logLines,
    orgA,
    orgB,
    tenantA,
    tenantB,
    giaA,
    runtimeA,
    runtimeB,
    tenancy,
    a,
    gate,
    approvals,
    executions,
    executionRepository,
    specialistRepository,
    calls,
    seed,
    running,
    mine,
    advance: (seconds: number) => {
      clock = new Date(clock.getTime() + seconds * 1000);
    },
  };
}

type World = Awaited<ReturnType<typeof world>>;

const INPUT = { subject: 'Weekly summary' };

async function setup(tools: readonly string[], options: WorldOptions = {}) {
  const w = await world(options);
  const specialist = await w.seed(w.orgA);
  const execution = await w.running(w.tenantA, specialist, tools);
  const invoke = (tenant: TenantContext = w.runtimeA, input: unknown = INPUT, nodeId = 'n0') =>
    w.gate.invoke(tenant, { executionId: execution.id, nodeId, input });
  const node = async (nodeId = 'n0') =>
    must((await w.executions.get(w.tenantA, execution.id)).nodes.find((n) => n.id === nodeId));
  return { w, specialist, execution, invoke, node };
}

/**
 * Attaches an approval to a node the way a forged or reused approval would reach it, bypassing
 * the gate: the gate must still refuse it unless it covers exactly this call.
 */
async function attachForeign(w: World, execution: Execution, nodeId: string, id: ApprovalId) {
  await w.executionRepository.update(execution.organizationId, execution.id, (current) => ({
    execution: attachApproval(current, nodeId, id, AT),
    events: [],
  }));
}

async function approvedFor(
  w: World,
  tenant: TenantContext,
  operation: ApprovalRequestInput['operation'],
): Promise<ApprovalId> {
  const approval = await w.approvals.request(tenant, {
    operation,
    riskLevel: 'high',
    reason: 'approval_required',
    impact: 'changes_data',
    ttlSeconds: 600,
  });
  await w.approvals.approve(tenant, approval.id);
  return approval.id;
}

const operationOf = (execution: Execution, specialist: Specialist) => ({
  organizationId: execution.organizationId,
  executionId: execution.id,
  nodeId: 'n0' as never,
  specialistId: specialist.identity.id,
  specialistVersion: 1,
  toolId: 'send_email' as never,
  toolVersion: 1,
  action: 'send',
  inputDigest: digestOf(INPUT),
});

describe('guardrails: allow, deny, require approval', () => {
  it('ALLOW: runs a low-risk tool, completes the node, never the execution', async () => {
    const { w, execution, invoke, node } = await setup(['lookup']);
    const result = await invoke();
    expect(result).toMatchObject({ status: 'success', output: { count: 3 } });
    expect((await node()).status).toBe('completed');
    expect((await w.executions.get(w.tenantA, execution.id)).status).toBe('running');
    expect(w.events().map((e) => e.action)).toEqual(
      expect.arrayContaining([
        'tool.authorization_checked',
        'tool.execution_requested',
        'tool.execution_completed',
      ]),
    );
    expect(w.events('tool.execution_completed')[0]).toMatchObject({
      organizationId: w.orgA,
      target: { type: 'execution', id: execution.id },
      tool: { id: 'lookup', version: 1 },
    });
  });

  it('DENY: a critical tool never runs, whatever its own policy says', async () => {
    const { w, invoke, node } = await setup(['wipe_data']);
    expect(await invoke()).toEqual({ status: 'denied', code: 'tool_denied_by_policy' });
    expect(w.calls).toHaveLength(0);
    expect((await node()).status).toBe('pending');
    expect(w.events('tool.execution_denied')[0]).toMatchObject({
      result: 'denied',
      reason: 'tool_denied_by_policy',
    });
  });

  it('REQUIRE_APPROVAL: asks once, waits, and runs after a user approves', async () => {
    const { w, execution, invoke, node } = await setup(['send_email']);
    const first = await invoke();
    expect(first.status).toBe('requires_approval');
    const approvalId = first.status === 'requires_approval' ? first.approvalId : undefined;
    expect((await node()).approvalId).toBe(approvalId);
    expect((await w.executions.get(w.tenantA, execution.id)).status).toBe('waiting_approval');
    // Asking again does not create a second approval.
    expect(await invoke()).toEqual({ status: 'requires_approval', approvalId });
    expect(await w.approvals.list(w.tenantA)).toHaveLength(1);
    await w.approvals.approve(w.tenantA, must(approvalId));
    const result = await invoke();
    expect(result.status).toBe('success');
    expect(w.calls[0]?.context).toMatchObject({ approvalId, riskLevel: 'high' });
    expect((await w.executions.get(w.tenantA, execution.id)).status).toBe('running');
    expect((await node()).status).toBe('completed');
  });

  it('pre-execution denial: nothing runs where the tool is not allowed or unknown', async () => {
    const staging = await setup(['staging_only']);
    expect(await staging.invoke()).toEqual({ status: 'denied', code: 'environment_not_allowed' });
    const unknown = await setup(['lookup'], { environment: undefined });
    expect(await unknown.invoke()).toEqual({ status: 'denied', code: 'environment_not_allowed' });
    expect([...staging.w.calls, ...unknown.w.calls]).toHaveLength(0);
  });

  it('post-execution rejection: an output outside its schema fails the node', async () => {
    const bad: ToolExecutorOutcome[] = [
      { status: 'success', output: { count: 3, organizationId: 'x' } },
      { status: 'success', output: { count: -1 } },
      { status: 'success', output: 'Bearer abc.def.ghi' },
    ];
    for (const outcome of bad) {
      const { w, execution, invoke, node } = await setup(['lookup'], {
        answers: { lookup: async () => outcome },
      });
      expect(await invoke()).toMatchObject({ status: 'failure', code: 'output_rejected' });
      expect(await node()).toMatchObject({ status: 'failed', error: { code: 'output_rejected' } });
      expect((await w.executions.get(w.tenantA, execution.id)).status).toBe('running');
      expect(w.events('tool.execution_failed')[0]).toMatchObject({ reason: 'output_rejected' });
    }
    expect(
      evaluatePostExecution(must(createToolRegistry(TOOLS).resolve('lookup', 1)), { count: 1 }),
    ).toBeUndefined();
  });

  it('makes a tool policy only stricter than its risk level, never looser', () => {
    const registry = createToolRegistry(TOOLS);
    expect(effectivePolicy(must(registry.resolve('lookup', 1)), DEFAULT_RISK_POLICY)).toBe('auto');
    expect(effectivePolicy(must(registry.resolve('send_email', 1)), DEFAULT_RISK_POLICY)).toBe(
      'approval_required',
    );
    expect(effectivePolicy(must(registry.resolve('wipe_data', 1)), DEFAULT_RISK_POLICY)).toBe(
      'denied',
    );
  });
});

describe('security: the 22 cases of the X3 brief', () => {
  it('1. a user without tool.execute, or without a permission the tool needs, is denied', async () => {
    const withoutExecute = await setup(['lookup'], {
      roles: { owner: OWNER_ALL.filter((p) => p !== 'tool.execute') },
    });
    expect(await withoutExecute.invoke()).toEqual({
      status: 'denied',
      code: 'permission_not_held',
    });
    const withoutToolPermission = await setup(['billing_lookup']);
    expect(await withoutToolPermission.invoke()).toEqual({
      status: 'denied',
      code: 'permission_not_held',
    });
  });

  it('2. a specialist whose work needs a permission the user no longer holds is denied', async () => {
    const w = await world({
      roles: { owner: [...OWNER_ALL, 'billing.read'] },
      rolesAtRun: { owner: OWNER_ALL },
    });
    const specialist = await w.seed(w.orgA, { permissions: ['billing.read'] });
    const execution = await w.running(w.tenantA, specialist, ['lookup']);
    // Checked again when the tool runs, not only when the execution was created.
    expect(
      await w.gate.invoke(w.runtimeA, { executionId: execution.id, nodeId: 'n0', input: INPUT }),
    ).toEqual({ status: 'denied', code: 'specialist_not_eligible' });
    expect(w.calls).toHaveLength(0);
  });

  it('3. a tool limited to other department types is denied', async () => {
    const { invoke, w } = await setup(['finance_report']);
    expect(await invoke()).toEqual({ status: 'denied', code: 'department_not_allowed' });
    const finance = await w.seed(w.orgA, { department: 'finance' });
    const execution = await w.running(w.tenantA, finance, ['finance_report']);
    expect(
      (await w.gate.invoke(w.runtimeA, { executionId: execution.id, nodeId: 'n0', input: INPUT }))
        .status,
    ).toBe('success');
  });

  it('4. a disabled tool is denied', async () => {
    const { invoke } = await setup(['retired']);
    expect(await invoke()).toEqual({ status: 'denied', code: 'tool_not_active' });
  });

  it('5. a specialist disabled after the execution started is denied', async () => {
    const { w, specialist, invoke } = await setup(['lookup']);
    await w.specialistRepository.update(w.orgA, specialist.identity.id, (s) =>
      applySpecialistStatus(s, { from: 'active', to: 'disabled' }, AT),
    );
    expect(await invoke()).toEqual({ status: 'denied', code: 'specialist_not_eligible' });
    expect(w.calls).toHaveLength(0);
  });

  it("6. another tenant cannot run an organization's execution", async () => {
    const { w, invoke, node } = await setup(['lookup']);
    expect(await invoke(w.runtimeB)).toEqual({ status: 'denied', code: 'execution_not_found' });
    expect((await node()).status).toBe('pending');
  });

  it('7. a missing approval requires one; nothing runs', async () => {
    const { w, invoke } = await setup(['send_email']);
    expect((await invoke()).status).toBe('requires_approval');
    expect(w.calls).toHaveLength(0);
    expect(w.events('tool.approval_requested')).toHaveLength(1);
  });

  const reused: [string, (e: Execution, s: Specialist) => object][] = [
    [
      '8. an approval of another execution',
      () => ({ executionId: '9b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b' }),
    ],
    ['9. an approval of another tool', () => ({ toolId: 'post_note' })],
    ['10. an approval of another tool version', () => ({ toolVersion: 2 })],
    ['   an approval of another input', () => ({ inputDigest: digestOf({ subject: 'Other' }) })],
    ['   an approval of another specialist version', () => ({ specialistVersion: 2 })],
  ];
  for (const [name, change] of reused) {
    it(`${name.trim()} is denied`, async () => {
      const { w, execution, specialist, invoke, node } = await setup(['send_email']);
      const id = await approvedFor(w, w.tenantA, {
        ...operationOf(execution, specialist),
        ...change(execution, specialist),
      } as never);
      await attachForeign(w, execution, 'n0', id);
      expect(await invoke()).toEqual({ status: 'denied', code: 'approval_mismatch' });
      expect(w.calls).toHaveLength(0);
      expect((await node()).status).toBe('pending');
    });
  }

  it('11. an approval of another tenant is denied', async () => {
    const { w, execution, specialist, invoke } = await setup(['send_email']);
    const theirs = await w.seed(w.orgB);
    const id = await approvedFor(w, w.tenantB, {
      ...operationOf(execution, specialist),
      organizationId: w.orgB,
      specialistId: theirs.identity.id,
    });
    await attachForeign(w, execution, 'n0', id);
    expect(await invoke()).toEqual({ status: 'denied', code: 'approval_mismatch' });
    expect(w.calls).toHaveLength(0);
  });

  it('12. an expired approval is denied, and recorded as expired', async () => {
    const { w, invoke } = await setup(['send_email']);
    const first = await invoke();
    w.advance(601);
    expect(await invoke()).toEqual({ status: 'denied', code: 'approval_expired' });
    const id = first.status === 'requires_approval' ? first.approvalId : '';
    expect((await w.approvals.get(w.tenantA, id)).status).toBe('expired');
    // Approved in time, but used after it ran out: still expired.
    const again = await setup(['send_email']);
    const request = await again.invoke();
    await again.w.approvals.approve(
      again.w.tenantA,
      request.status === 'requires_approval' ? request.approvalId : '',
    );
    again.w.advance(601);
    expect(await again.invoke()).toEqual({ status: 'denied', code: 'approval_expired' });
    expect(again.w.calls).toHaveLength(0);
  });

  it('13. a rejected approval is denied, and cannot be asked for again', async () => {
    const { w, invoke } = await setup(['send_email']);
    const first = await invoke();
    await w.approvals.reject(
      w.tenantA,
      first.status === 'requires_approval' ? first.approvalId : '',
    );
    expect(await invoke()).toEqual({ status: 'denied', code: 'approval_rejected' });
    expect(await invoke()).toEqual({ status: 'denied', code: 'approval_rejected' });
    expect(await w.approvals.list(w.tenantA)).toHaveLength(1);
    expect(w.calls).toHaveLength(0);
  });

  it('14. a cancelled execution is denied', async () => {
    const { w, execution, invoke } = await setup(['lookup']);
    await w.executions.cancel(w.tenantA, execution.id, 'user_cancelled');
    expect(await invoke()).toEqual({ status: 'denied', code: 'execution_not_running' });
  });

  it('15. a terminal execution is denied', async () => {
    const { w, execution, invoke } = await setup(['lookup']);
    await w.executions.runtimeChangeStatus(w.runtimeA, execution.id, {
      from: 'running',
      to: 'failed',
      failure: { code: 'step_failed' },
    });
    expect(await invoke()).toEqual({ status: 'denied', code: 'execution_not_running' });
    expect(w.calls).toHaveLength(0);
  });

  it('16. invalid input is denied before anything runs', async () => {
    const { w, invoke } = await setup(['lookup']);
    for (const input of [{}, { subject: '' }, { subject: 3 }, { subject: 'x', extra: 1 }, null]) {
      expect(await invoke(w.runtimeA, input)).toEqual({ status: 'denied', code: 'invalid_input' });
    }
    expect(w.calls).toHaveLength(0);
  });

  it('17. a credential passed as input is denied, and never recorded', async () => {
    const { w, invoke } = await setup(['lookup']);
    // Built at run time so secret scanners do not flag a test value.
    const leaked = ['sk', '-abcdefghijklmnopqrstuvwxyz123456'].join('');
    expect(await invoke(w.runtimeA, { subject: leaked })).toEqual({
      status: 'denied',
      code: 'invalid_input',
    });
    expect(await invoke(w.runtimeA, { subject: 'x', apiKey: 'abc' })).toEqual({
      status: 'denied',
      code: 'invalid_input',
    });
    expect(JSON.stringify(w.events())).not.toContain(leaked);
    expect(JSON.stringify(w.logLines)).not.toContain(leaked);
  });

  it('18–20. tenant or authority in the input is refused; the organization comes from the tenant', async () => {
    // The gate takes no organization at all; the API routes are tested for body, query and
    // header injection in apps/api. Here: the tool input cannot carry one either.
    const { w, invoke } = await setup(['lookup']);
    for (const field of ['organizationId', 'tenantId', 'approvalId', 'approved', 'userId']) {
      expect(await invoke(w.runtimeA, { subject: 'x', [field]: w.orgB })).toEqual({
        status: 'denied',
        code: 'invalid_input',
      });
    }
    expect(w.calls).toHaveLength(0);
  });

  it('21. GIA gets no privilege: it cannot run a tool, and never approves (ADR-0031: runtime only)', async () => {
    const { w, invoke, execution } = await setup(['send_email']);
    // Only the runtime invokes the gate; GIA and a user acting directly are refused before anything.
    expect(await invoke(w.giaA)).toEqual({ status: 'denied', code: 'runtime_only' });
    expect(await invoke(w.tenantA)).toEqual({ status: 'denied', code: 'runtime_only' });
    expect(w.events('tool.execution_denied')).toEqual([
      expect.objectContaining({ result: 'denied', reason: 'runtime_only' }),
      expect.objectContaining({ result: 'denied', reason: 'runtime_only' }),
    ]);
    expect((await w.executions.get(w.tenantA, execution.id)).nodes[0]?.status).toBe('pending');
    const request = await invoke();
    expect(request.status).toBe('requires_approval');
    const id = request.status === 'requires_approval' ? request.approvalId : '';
    await expect(w.approvals.approve(w.giaA, id)).rejects.toThrow('approval_forbidden');
    await expect(w.approvals.approve(w.runtimeA, id)).rejects.toThrow();
    expect(await invoke()).toEqual({ status: 'requires_approval', approvalId: id });
    expect(w.calls).toHaveLength(0);
  });

  it('22. cross-tenant tool access is denied: ids from another organization resolve to nothing', async () => {
    const { w, execution } = await setup(['lookup']);
    const theirs = await w.seed(w.orgB);
    const their = await w.running(w.tenantB, theirs, ['lookup']);
    expect(
      await w.gate.invoke(w.runtimeA, { executionId: their.id, nodeId: 'n0', input: INPUT }),
    ).toEqual({ status: 'denied', code: 'execution_not_found' });
    expect(
      await w.gate.invoke(w.runtimeB, { executionId: execution.id, nodeId: 'n0', input: INPUT }),
    ).toEqual({ status: 'denied', code: 'execution_not_found' });
    expect(w.calls).toHaveLength(0);
  });
});

describe('tool gate: execution integration', () => {
  it('runs a node once: a concurrent second call is denied and the tool runs once', async () => {
    const { w, invoke } = await setup(['update_record']);
    const [one, two] = await Promise.all([invoke(), invoke()]);
    expect([one.status, two.status].sort()).toEqual(['denied', 'success']);
    expect(w.calls).toHaveLength(1);
    expect(await invoke()).toEqual({ status: 'denied', code: 'node_not_pending' });
    expect(w.calls).toHaveLength(1);
  });

  it('gives mutating tools a deterministic idempotency key, and a safe context', async () => {
    const { w, execution, specialist, invoke } = await setup(['update_record', 'lookup']);
    await invoke();
    await invoke(w.runtimeA, INPUT, 'n1');
    const [mutating, reading] = w.calls.map((c) => c.context);
    expect(mutating?.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(reading?.idempotencyKey).toBeUndefined();
    expect(mutating).toMatchObject({
      organizationId: w.orgA,
      executionId: execution.id,
      nodeId: 'n0',
      specialistId: specialist.identity.id,
      specialistVersion: 1,
      toolId: 'update_record',
      toolVersion: 1,
      actor: { userId: ALICE, via: 'runtime' },
      environment: 'dev',
    });
    expect(Object.isFrozen(w.calls[0]?.input)).toBe(true);
  });

  it('refuses a tool the specialist version does not list', async () => {
    const w = await world();
    const specialist = await w.seed(w.orgA);
    const execution = await w.executions.create(w.tenantA, {
      mode: 'execute',
      input: { type: 'task', id: 'task-1' },
      specialistId: specialist.identity.id,
      specialistVersion: 1,
      departmentId: specialist.configuration.departmentId,
      versionSnapshot: {
        schemaVersion: 1,
        components: [{ kind: 'specialist', id: specialist.identity.id, version: '1' }],
      },
      nodes: [{ id: 'n0', type: 'tool', label: 'x', tool: { id: 'lookup', version: 2 } }],
    });
    await w.executions.start(w.tenantA, execution.id);
    expect(
      await w.gate.invoke(w.runtimeA, { executionId: execution.id, nodeId: 'n0', input: INPUT }),
    ).toEqual({ status: 'denied', code: 'tool_not_found' });
  });

  it('refuses a tool that changes data in a read-only mode', async () => {
    const w = await world();
    const execution = await w.running(w.tenantA, await w.seed(w.orgA), ['update_record'], 'ask');
    expect(
      await w.gate.invoke(w.runtimeA, { executionId: execution.id, nodeId: 'n0', input: INPUT }),
    ).toEqual({ status: 'denied', code: 'mode_forbids_mutation' });
  });

  it('refuses an execution with no specialist, a node that is not a tool, and a pending execution', async () => {
    const w = await world();
    const bare = await w.executions.create(w.tenantA, {
      mode: 'execute',
      input: { type: 'task', id: 'task-1' },
      versionSnapshot: { schemaVersion: 1, components: [] },
      nodes: [
        { id: 'n0', type: 'tool', label: 'x', tool: { id: 'lookup', version: 1 } },
        { id: 'n1', type: 'agent', label: 'y' },
      ],
    });
    const call = (nodeId: string) =>
      w.gate.invoke(w.runtimeA, { executionId: bare.id, nodeId, input: INPUT });
    expect(await call('n0')).toEqual({ status: 'denied', code: 'execution_not_running' });
    await w.executions.start(w.tenantA, bare.id);
    expect(await call('n0')).toEqual({ status: 'denied', code: 'no_specialist' });
    expect(await call('n1')).toEqual({ status: 'denied', code: 'node_not_tool' });
    expect(await call('missing')).toEqual({ status: 'denied', code: 'node_not_found' });
  });

  it('retries a failing tool within its policy, and records a final failure', async () => {
    let attempts = 0;
    const recovering = await setup(['flaky'], {
      answers: {
        flaky: async () => {
          attempts += 1;
          return attempts < 3
            ? { status: 'failure', code: 'upstream_unavailable' }
            : { status: 'success', output: { count: 1 } };
        },
      },
    });
    expect((await recovering.invoke()).status).toBe('success');
    expect(recovering.w.calls).toHaveLength(3);
    const run = await setup(['flaky'], {
      answers: { flaky: async () => ({ status: 'failure', code: 'Upstream 503!' }) },
    });
    expect(await run.invoke()).toMatchObject({ status: 'failure', code: 'tool_failure' });
    expect(run.w.calls).toHaveLength(3);
    expect(await run.node()).toMatchObject({ status: 'failed', error: { code: 'tool_failure' } });
    expect(run.w.events('tool.execution_failed')[0]).toMatchObject({
      result: 'failure',
      reason: 'tool_failure',
    });
  });

  it('stops waiting at the timeout, and does not retry it', async () => {
    const { w, invoke, node } = await setup(['slow'], {
      answers: { slow: () => new Promise<ToolExecutorOutcome>(() => undefined) },
    });
    expect((await invoke()).status).toBe('timeout');
    expect(w.calls).toHaveLength(1);
    expect(await node()).toMatchObject({ status: 'failed', error: { code: 'timeout' } });
  });

  it('reports an executor that throws as a failure, without its message', async () => {
    const { invoke, w } = await setup(['lookup'], {
      answers: {
        lookup: async () => {
          throw new Error('connection to secret-host failed');
        },
      },
    });
    expect(await invoke()).toMatchObject({ status: 'failure', code: 'executor_error' });
    expect(JSON.stringify(w.events())).not.toContain('secret-host');
  });

  it('refuses an unresolved tenant and a suspended organization', async () => {
    const { w, invoke } = await setup(['lookup']);
    expect(await invoke({ ...w.runtimeA } as TenantContext)).toEqual({
      status: 'denied',
      code: 'unresolved_tenant',
    });
    w.tenancy.put({ ...w.a.organization, status: 'suspended' });
    expect(await invoke()).toEqual({ status: 'denied', code: 'organization_inactive' });
    expect(w.calls).toHaveLength(0);
  });

  it('logs with the correlation ids of the call', async () => {
    const { w, execution, specialist, invoke } = await setup(['lookup']);
    await invoke();
    expect(w.logLines.at(-1)).toMatchObject({
      organizationId: w.orgA,
      executionId: execution.id,
      nodeId: 'n0',
      specialistId: specialist.identity.id,
      toolId: 'lookup',
      toolVersion: 1,
    });
  });
});

describe('X6a: attempts through the tool gate (ADR-0029)', () => {
  it('17. a retried node repeats the same idempotency key, so its effect happens once', async () => {
    // A provider that applies each key once, and loses its answer the first time.
    const applied = new Map<string, number>();
    let calls = 0;
    const provider = async (): Promise<ToolExecutorOutcome> => {
      calls += 1;
      return calls === 1
        ? { status: 'failure', code: 'connection_reset' }
        : { status: 'success', output: { count: 1 } };
    };
    const { w, execution, invoke, node } = await setup(['update_record'], {
      answers: { update_record: provider },
    });
    const run = async () => {
      const result = await invoke(w.runtimeA);
      const key = w.calls.at(-1)?.context.idempotencyKey as string;
      applied.set(key, (applied.get(key) ?? 0) + 1);
      return result;
    };
    expect((await run()).status).toBe('failure');
    const failed = await node();
    expect(failed.status).toBe('failed');
    expect(failed.attempt).toBeUndefined();
    expect(failed.idempotencyKey).toBe(w.calls[0]?.context.idempotencyKey);
    const retried = await w.executions.retryNode(w.runtimeA, execution.id, 'n0');
    expect(retried.nodes[0]).toMatchObject({ status: 'pending', attempt: 2 });
    expect((await run()).status).toBe('success');
    // Two calls, one key: the provider changes the record once.
    expect(w.calls).toHaveLength(2);
    expect(applied.size).toBe(1);
    expect(w.calls.map((c) => c.context.actor)).toEqual([
      { userId: ALICE, via: 'runtime' },
      { userId: ALICE, via: 'runtime' },
    ]);
    expect(await node()).toMatchObject({ status: 'completed', attempt: 2 });
    // A node that completed is never re-run.
    await expect(w.executions.retryNode(w.runtimeA, execution.id, 'n0')).rejects.toMatchObject({
      code: 'retry_not_allowed',
      detail: 'not_failed',
    });
  });

  it('18. a timed-out tool call has an unknown outcome and is never re-run', async () => {
    const { w, execution, invoke, node } = await setup(['slow'], {
      answers: { slow: () => new Promise(() => undefined) },
    });
    expect((await invoke(w.runtimeA)).status).toBe('timeout');
    expect(await node()).toMatchObject({ status: 'failed', error: { code: 'timeout' } });
    await expect(w.executions.retryNode(w.runtimeA, execution.id, 'n0')).rejects.toMatchObject({
      code: 'retry_not_allowed',
      detail: 'outcome_unknown',
    });
    expect(w.calls).toHaveLength(1);
  });

  it('a read-only tool has no idempotency key and is not retried automatically', async () => {
    const { w, execution, invoke, node } = await setup(['lookup'], {
      answers: { lookup: async () => ({ status: 'failure', code: 'connection_reset' }) },
    });
    await invoke(w.runtimeA);
    expect((await node()).idempotencyKey).toBeUndefined();
    await expect(w.executions.retryNode(w.runtimeA, execution.id, 'n0')).rejects.toMatchObject({
      code: 'retry_not_allowed',
      detail: 'external_effect',
    });
  });
});

describe('ADR-0034: a person invoking a human tool through the same gate', () => {
  const human = async (tools: readonly string[], options: WorldOptions = {}) => {
    const w = await world(options);
    const execution = await w.mine(w.tenantA, tools);
    const invoke = (tenant: TenantContext = w.tenantA, input: unknown = INPUT, nodeId = 'n0') =>
      w.gate.invoke(tenant, { executionId: execution.id, nodeId, input });
    return { w, execution, invoke };
  };

  it('runs it for the person, with no specialist, and finishes the execution verified', async () => {
    const { w, execution, invoke } = await human(['human_note']);
    const result = await invoke();
    expect(result).toMatchObject({ status: 'success', output: { count: 3 } });
    const [call] = w.calls;
    expect(call?.context).toMatchObject({
      organizationId: w.orgA,
      executionId: execution.id,
      actor: { userId: ALICE, via: 'direct' },
      toolId: 'human_note',
    });
    // No specialist is invented: the context simply has none.
    expect(call?.context).not.toHaveProperty('specialistId');
    expect(call?.context).not.toHaveProperty('specialistVersion');
    expect(call?.context.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    const done = await w.executions.get(w.tenantA, execution.id);
    expect(done).toMatchObject({
      status: 'completed',
      verification: { result: 'passed', nodes: [{ nodeId: 'n0', policy: 'output_schema' }] },
    });
    expect(done.nodes[0]).toMatchObject({ status: 'completed' });
    expect(done.specialistId).toBeUndefined();
    const transitions = w
      .events('execution.state_changed')
      .map((e) => `${e.transition?.from}>${e.transition?.to}`);
    expect(transitions).toEqual(['pending>running', 'running>verifying', 'verifying>completed']);
    // The person is the actor, acting directly: no runtime, no specialist, no invented actor.
    for (const e of w.events().filter((e) => e.action.startsWith('tool.'))) {
      expect(e.actor).toEqual({ type: 'user', userId: ALICE, via: 'direct' });
    }
    expect(w.events('execution.verification_recorded')).toHaveLength(1);
  });

  it('ends a two-node execution only when its last node is done', async () => {
    const { w, execution, invoke } = await human(['human_note', 'shared_lookup']);
    expect((await invoke()).status).toBe('success');
    expect((await w.executions.get(w.tenantA, execution.id)).status).toBe('running');
    expect((await invoke(w.tenantA, INPUT, 'n1')).status).toBe('success');
    expect(await w.executions.get(w.tenantA, execution.id)).toMatchObject({
      status: 'completed',
      verification: { result: 'passed', nodes: [{ nodeId: 'n0' }, { nodeId: 'n1' }] },
    });
  });

  it('fails the execution when the tool fails, and never runs it twice', async () => {
    const { w, execution, invoke } = await human(['human_note'], {
      answers: { human_note: async () => ({ status: 'failure', code: 'provider_rejected' }) },
    });
    expect(await invoke()).toMatchObject({ status: 'failure', code: 'provider_rejected' });
    expect(await w.executions.get(w.tenantA, execution.id)).toMatchObject({
      status: 'failed',
      failure: { code: 'provider_rejected' },
    });
    expect(await invoke()).toEqual({ status: 'denied', code: 'execution_not_running' });
    expect(w.calls).toHaveLength(1);
  });

  it('a timeout fails it as an unknown outcome, and it is never re-run', async () => {
    const { w, execution, invoke } = await human(['human_slow'], {
      answers: { human_slow: () => new Promise(() => undefined) },
    });
    expect((await invoke()).status).toBe('timeout');
    expect(await w.executions.get(w.tenantA, execution.id)).toMatchObject({
      status: 'failed',
      failure: { code: 'timeout' },
    });
    expect(await invoke()).toEqual({ status: 'denied', code: 'execution_not_running' });
    expect(w.calls).toHaveLength(1);
  });

  it('refuses a person invoking a tool that does not say human: runtime_only, as before', async () => {
    const { w, invoke } = await human(['lookup']);
    expect(await invoke()).toEqual({ status: 'denied', code: 'runtime_only' });
    expect(await invoke(w.giaA)).toEqual({ status: 'denied', code: 'runtime_only' });
    expect(w.events('tool.execution_denied').map((e) => e.reason)).toEqual([
      'runtime_only',
      'runtime_only',
    ]);
    expect(w.calls).toHaveLength(0);
  });

  it('never lets GIA invoke a human tool: a person acting directly only', async () => {
    const { w, invoke } = await human(['human_note']);
    expect(await invoke(w.giaA)).toEqual({ status: 'denied', code: 'runtime_only' });
    expect(w.calls).toHaveLength(0);
  });

  it("refuses another person's execution and another organization's", async () => {
    const { w, invoke, execution } = await human(['human_note']);
    // Bob is not a member of A: his tenant is B, where the execution does not exist.
    expect(await invoke(w.tenantB)).toEqual({ status: 'denied', code: 'runtime_only' });
    expect(
      await w.gate.invoke(w.tenantB, { executionId: execution.id, nodeId: 'n0', input: INPUT }),
    ).toEqual({ status: 'denied', code: 'runtime_only' });
    expect(w.calls).toHaveLength(0);
    expect((await w.executions.get(w.tenantA, execution.id)).nodes[0]?.status).toBe('pending');
  });

  it('refuses an execution that belongs to a specialist: that work is the runtime’s', async () => {
    const w = await world();
    const specialist = await w.seed(w.orgA);
    const execution = await w.running(w.tenantA, specialist, ['shared_lookup']);
    expect(
      await w.gate.invoke(w.tenantA, { executionId: execution.id, nodeId: 'n0', input: INPUT }),
    ).toEqual({ status: 'denied', code: 'specialist_execution' });
    expect(w.calls).toHaveLength(0);
  });

  it('refuses a policy that needs an approval, a paused tool, a bad input and a pending execution', async () => {
    const risky = await human(['human_risky']);
    expect(await risky.invoke()).toEqual({ status: 'denied', code: 'approval_unavailable' });
    const paused = await human(['human_retired']);
    expect(await paused.invoke()).toEqual({ status: 'denied', code: 'tool_not_active' });
    const bad = await human(['human_note']);
    for (const input of [
      { subject: 'x', organizationId: bad.w.orgB },
      { subject: 'x', token: 'y' },
    ]) {
      expect(await bad.invoke(bad.w.tenantA, input)).toEqual({
        status: 'denied',
        code: 'invalid_input',
      });
    }
    const w = await world();
    const pending = await w.mine(w.tenantA, ['human_note'], false);
    expect(
      await w.gate.invoke(w.tenantA, { executionId: pending.id, nodeId: 'n0', input: INPUT }),
    ).toEqual({ status: 'denied', code: 'execution_not_running' });
    expect([risky, paused, bad].flatMap((h) => h.w.calls)).toHaveLength(0);
  });

  it("refuses a member invoking someone else's execution in the same organization", async () => {
    const w = await world();
    const execution = await w.mine(w.tenantA, ['human_note']);
    const facts = {
      execution,
      nodeId: 'n0',
      tool: createToolRegistry(TOOLS).resolve('human_note', 1),
      permissions: new Set(OWNER_ALL),
      environment: 'dev' as const,
      executors: { fixture: fixtureExecutor().executor },
      riskPolicy: DEFAULT_RISK_POLICY,
      input: INPUT,
    };
    expect(evaluateHumanPreExecution({ ...facts, userId: ALICE })).toEqual({ decision: 'allow' });
    expect(evaluateHumanPreExecution({ ...facts, userId: BOB })).toEqual({
      decision: 'deny',
      reason: 'execution_not_owned',
    });
  });

  it('refuses a person without the tool permissions, and an unknown environment', async () => {
    const noTool = await human(['human_note'], {
      roles: { owner: OWNER_ALL.filter((p) => p !== 'tool.execute') },
    });
    expect(await noTool.invoke()).toEqual({ status: 'denied', code: 'permission_not_held' });
    const nowhere = await human(['human_note'], { environment: undefined });
    expect(await nowhere.invoke()).toEqual({ status: 'denied', code: 'environment_not_allowed' });
    expect(noTool.w.calls).toHaveLength(0);
    expect(nowhere.w.calls).toHaveLength(0);
  });
});

describe('ADR-0034 non-regression: the runtime path is unchanged', () => {
  it('still runs a runtime tool for an eligible specialist, and completes nothing', async () => {
    const { w, execution, invoke } = await setup(['lookup']);
    expect(await invoke(w.runtimeA)).toMatchObject({ status: 'success' });
    expect((await w.executions.get(w.tenantA, execution.id)).status).toBe('running');
    expect(w.calls[0]?.context).toMatchObject({ specialistVersion: 1, actor: { via: 'runtime' } });
  });

  it('still requires a specialist on the runtime path: no specialist, no tool', async () => {
    const w = await world();
    const execution = await w.mine(w.tenantA, ['lookup']);
    expect(
      await w.gate.invoke(w.runtimeA, { executionId: execution.id, nodeId: 'n0', input: INPUT }),
    ).toEqual({ status: 'denied', code: 'no_specialist' });
    expect(w.calls).toHaveLength(0);
  });

  it('never runs a human-only tool on the runtime path, even when a specialist lists it', async () => {
    const { w, invoke } = await setup(['human_note']);
    expect(await invoke(w.runtimeA)).toEqual({
      status: 'denied',
      code: 'tool_not_runtime_invocable',
    });
    expect(w.calls).toHaveLength(0);
  });

  it('runs a tool that names both modes on the runtime path as any runtime tool', async () => {
    const { w, invoke } = await setup(['shared_lookup']);
    expect(await invoke(w.runtimeA)).toMatchObject({ status: 'success' });
  });

  it('keeps permissions, the policy and the audit actor on the runtime path', async () => {
    const noTool = await setup(['lookup'], {
      roles: { owner: OWNER_ALL.filter((p) => p !== 'tool.execute') },
    });
    expect(await noTool.invoke(noTool.w.runtimeA)).toEqual({
      status: 'denied',
      code: 'permission_not_held',
    });
    const critical = await setup(['wipe_data']);
    expect(await critical.invoke(critical.w.runtimeA)).toEqual({
      status: 'denied',
      code: 'tool_denied_by_policy',
    });
    const ok = await setup(['lookup']);
    await ok.invoke(ok.w.runtimeA);
    for (const e of ok.w.events().filter((e) => e.action.startsWith('tool.'))) {
      expect(e.actor).toEqual({
        type: 'system',
        id: 'runtime',
        initiatedBy: ALICE,
        via: 'runtime',
      });
    }
    expect([...noTool.w.calls, ...critical.w.calls]).toHaveLength(0);
  });

  it('keeps the tool allowlist: a specialist runs only the versions it lists', async () => {
    const w = await world();
    const specialist = await w.seed(w.orgA);
    const execution = await w.executions.create(w.tenantA, {
      mode: 'execute',
      input: { type: 'task', id: 'task-1' },
      specialistId: specialist.identity.id,
      specialistVersion: 1,
      departmentId: specialist.configuration.departmentId,
      versionSnapshot: {
        schemaVersion: 1,
        components: [{ kind: 'specialist', id: specialist.identity.id, version: '1' }],
      },
      nodes: [{ id: 'n0', type: 'tool', label: 'x', tool: { id: 'message_send', version: 1 } }],
    });
    await w.executions.start(w.tenantA, execution.id);
    // A tool the gate's registry does not hold is never run, by the runtime or a person.
    for (const tenant of [w.runtimeA, w.tenantA]) {
      expect(
        (await w.gate.invoke(tenant, { executionId: execution.id, nodeId: 'n0', input: INPUT }))
          .status,
      ).toBe('denied');
    }
    expect(w.calls).toHaveLength(0);
  });

  it('keeps tenant isolation and approvals on the runtime path', async () => {
    const { w, invoke } = await setup(['send_email']);
    expect(await invoke(w.runtimeB)).toEqual({ status: 'denied', code: 'execution_not_found' });
    expect((await invoke(w.runtimeA)).status).toBe('requires_approval');
    expect(w.calls).toHaveLength(0);
  });
});
