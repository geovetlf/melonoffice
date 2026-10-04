import { InMemoryAuditStore, type AuditEvent } from '@melonoffice/audit';
import type { Execution, Specialist, Workflow } from '@melonoffice/domain';
import { createAuthorizationService, ROLES } from '@melonoffice/rbac';
import type { TenantContext } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
// The planning package's own test world, reused rather than rebuilt.
import { ALICE, BOB, must, world, type WorldOptions } from '../../planning/src/testkit.js';
import { isWorkflowError } from './errors.js';
import { canChangeWorkflowStatus, WORKFLOW_STATUSES } from './lifecycle.js';
import { checkWorkflowSteps } from './model.js';
import { InMemoryWorkflowRepository } from './repository.js';
import { createWorkflowService, WORKFLOW_PLAN_INPUT, WORKFLOW_PLAN_REFUSED } from './service.js';

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    if (isWorkflowError(error)) return error.code;
    if (error instanceof Error && 'code' in error) return String(error.code);
    throw error;
  }
  return 'accepted';
};

const verification = { policy: 'checks', expectedOutput: 'report', requiredChecks: [] };

const STEPS = [
  {
    id: 'research',
    kind: 'specialist',
    label: 'Research the market',
    dependsOn: [],
    assignee: { departmentTypeId: 'research', roleId: 'market_researcher' },
    verification,
  },
  {
    id: 'search',
    kind: 'tool',
    label: 'Search',
    dependsOn: ['research'],
    performedBy: 'research',
    tool: { id: 'lookup', version: 1 },
  },
  { id: 'sign_off', kind: 'approval', label: 'Director signs off', dependsOn: ['research'] },
  {
    id: 'campaign',
    kind: 'specialist',
    label: 'Plan the campaign',
    dependsOn: ['sign_off'],
    assignee: { departmentTypeId: 'marketing', roleId: 'campaign_manager' },
    verification,
    retry: { maxAttempts: 2, backoffMs: 1000 },
  },
];

/** An audit store that can be made to fail, to prove a workflow change is stored with it or not at all. */
class BreakableAuditStore extends InMemoryAuditStore {
  broken = false;
  override appendNow(events: readonly AuditEvent[]): void {
    if (this.broken) throw new Error('audit store unavailable');
    super.appendNow(events);
  }
}

async function setup(options: WorldOptions = {}) {
  const w = await world(options);
  const workflowAudit = new BreakableAuditStore();
  const owner = await w.seed(w.orgA, ALICE, { type: 'leadership', role: 'chief_of_staff' });
  const researcher = await w.seed(w.orgA, ALICE, { toolIds: ['lookup'] });
  const marketer = await w.seed(w.orgA, ALICE, { type: 'marketing', role: 'campaign_manager' });
  const repository = new InMemoryWorkflowRepository(workflowAudit);
  const workflows = createWorkflowService({
    repository,
    plans: w.plans,
    executions: w.executions,
    specialists: w.specialists,
    departments: w.departments,
    organizations: w.tenancy,
    authorization: createAuthorizationService((options.roles ?? ROLES) as never),
    requestId: 'req-workflows-1',
  });
  const workflowEvents = () => workflowAudit.events();
  /** A planning execution that recorded this workflow version. */
  async function planningFor(
    tenant: TenantContext,
    by: Specialist,
    workflow: Workflow,
    version = workflow.version,
  ): Promise<Execution> {
    const execution = await w.executions.create(tenant, {
      mode: 'plan',
      input: { type: 'task', id: 'task-1' },
      workflowId: workflow.id,
      specialistId: by.identity.id,
      specialistVersion: by.version,
      departmentId: by.configuration.departmentId,
      versionSnapshot: {
        schemaVersion: 1,
        components: [
          { kind: 'specialist', id: by.identity.id, version: String(by.version) },
          { kind: 'workflow', id: workflow.id, version: String(version) },
        ],
      },
    });
    return w.executions.changeStatus(tenant, execution.id, { from: 'pending', to: 'planning' });
  }
  return {
    ...w,
    owner,
    researcher,
    marketer,
    repository,
    workflows,
    planningFor,
    workflowAudit,
    workflowEvents,
  };
}

describe('workflow lifecycle and versions', () => {
  it('allows only the listed moves', () => {
    expect(canChangeWorkflowStatus('draft', 'active')).toBe(true);
    expect(canChangeWorkflowStatus('active', 'draft')).toBe(false);
    expect(canChangeWorkflowStatus('archived', 'active')).toBe(false);
    expect(WORKFLOW_STATUSES).toHaveLength(4);
  });

  it('checks steps with the plan proposal schema, and assignees instead of specialists', () => {
    expect(checkWorkflowSteps('Launch', STEPS)).toHaveLength(4);
    const withSpecialist = [{ ...STEPS[0], specialistId: '33333333-3333-4333-8333-333333333333' }];
    const withAuthority = [{ ...STEPS[0], approved: true }];
    const noAssignee = [{ ...STEPS[0], assignee: undefined }];
    const badType = [{ ...STEPS[0], assignee: { departmentTypeId: 'Not A Type', roleId: 'x' } }];
    for (const bad of [withSpecialist, withAuthority, noAssignee, badType, 'steps']) {
      expect(() => checkWorkflowSteps('Launch', bad)).toThrow(/invalid_workflow/);
    }
  });

  it('refuses a template every plan of it would be refused for (ADR-0156)', async () => {
    const detailOf = (steps: unknown): string | undefined => {
      try {
        checkWorkflowSteps('Launch', steps);
      } catch (error) {
        if (isWorkflowError(error)) return error.detail;
        throw error;
      }
      return undefined;
    };
    const [research, search, signOff, campaign] = STEPS as unknown as [
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
      Record<string, unknown>,
    ];
    const pause = { id: 'pause', kind: 'wait', label: 'Wait', dependsOn: ['research'] };
    // A wait with no time, or that waits on nothing.
    expect(detailOf([research, pause])).toBe('steps.1.wait');
    expect(detailOf([research, { ...pause, dependsOn: [], wait: { seconds: 60 } }])).toBe(
      'steps.1.dependsOn',
    );
    // A tool step waits only on its own specialist's work; nothing waits on a tool step.
    expect(detailOf([research, search, { ...campaign, dependsOn: ['search'] }])).toBe(
      'invalid_dependency',
    );
    expect(detailOf([research, campaign, { ...search, dependsOn: ['campaign'] }])).toBe(
      'invalid_tool_dependency',
    );
    expect(
      detailOf([
        research,
        { ...search, performedBy: 'sign_off', dependsOn: ['sign_off'] },
        signOff,
      ]),
    ).toBe('invalid_performer');
    // The graph: no cycle, no step it does not have.
    expect(
      detailOf([
        { ...research, dependsOn: ['campaign'] },
        { ...campaign, dependsOn: ['research'] },
      ]),
    ).toBe('plan_cycle');
    expect(detailOf([research, { ...campaign, dependsOn: ['nowhere'] }])).toBe(
      'unknown_dependency',
    );
    // A whole, valid template is kept as it was.
    expect(detailOf(STEPS)).toBeUndefined();
    expect(detailOf([research, { ...pause, wait: { seconds: 60 } }])).toBeUndefined();
    const w = await setup();
    expect(
      await codeOf(w.workflows.create(w.tenantA, { name: 'Launch', steps: [research, pause] })),
    ).toBe('invalid_workflow');
  });

  it('writes each version once and keeps earlier versions unchanged', async () => {
    const w = await setup();
    const created = await w.workflows.create(w.tenantA, { name: 'Launch', steps: STEPS });
    expect(created).toEqual(
      expect.objectContaining({ status: 'draft', version: 1, name: 'Launch' }),
    );
    const first = await w.workflows.getVersion(w.tenantA, created.id, 1);
    const updated = await w.workflows.publishVersion(w.tenantA, created.id, {
      steps: STEPS.slice(0, 1),
    });
    expect(updated.version).toBe(2);
    expect(await w.workflows.getVersion(w.tenantA, created.id, 1)).toEqual(first);
    expect((await w.workflows.getVersion(w.tenantA, created.id, 2)).steps).toHaveLength(1);
    expect(await codeOf(w.workflows.getVersion(w.tenantA, created.id, 3))).toBe(
      'workflow_not_found',
    );
    w.repository.putVersion({ ...first, name: 'Changed' });
    expect(await codeOf(w.workflows.getVersion(w.tenantA, created.id, 1))).toBe('invalid_workflow');
    await w.workflows.changeStatus(w.tenantA, created.id, { from: 'draft', to: 'archived' });
    expect(await codeOf(w.workflows.publishVersion(w.tenantA, created.id, { steps: STEPS }))).toBe(
      'invalid_workflow_transition',
    );
  });

  it('keeps tenants apart and needs its permissions', async () => {
    const w = await setup();
    const created = await w.workflows.create(w.tenantA, { name: 'Launch', steps: STEPS });
    expect(await codeOf(w.workflows.get(w.tenantB, created.id))).toBe('workflow_not_found');
    expect(await w.workflows.list(w.tenantB)).toEqual([]);
    const readOnly = await setup({
      roles: { owner: ROLES.owner.filter((p) => p !== 'workflow.manage') },
    });
    expect(
      await codeOf(readOnly.workflows.create(readOnly.tenantA, { name: 'Launch', steps: STEPS })),
    ).toBe('permission_denied');
  });
});

describe('workflow audit', () => {
  const recorded = (e: AuditEvent) => ({
    action: e.action,
    result: e.result,
    actor: e.actor,
    organizationId: e.organizationId,
    target: e.target,
    targetVersion: e.targetVersion,
    transition: e.transition,
    requestId: e.requestId,
    source: e.source,
  });

  it('records create, new version, activate, pause and archive with actor, version and transition', async () => {
    const w = await setup();
    const created = await w.workflows.create(w.tenantA, { name: 'Launch', steps: STEPS });
    await w.workflows.publishVersion(w.tenantA, created.id, { steps: STEPS.slice(0, 1) });
    await w.workflows.changeStatus(w.tenantA, created.id, { from: 'draft', to: 'active' });
    await w.workflows.changeStatus(w.tenantA, created.id, { from: 'active', to: 'paused' });
    await w.workflows.changeStatus(w.tenantA, created.id, { from: 'paused', to: 'active' });
    await w.workflows.changeStatus(w.tenantA, created.id, { from: 'active', to: 'archived' });
    const base = {
      result: 'success',
      actor: { type: 'user', userId: ALICE, via: 'direct' },
      organizationId: w.orgA,
      target: { type: 'workflow', id: created.id },
      requestId: 'req-workflows-1',
      source: 'api',
    };
    expect(w.workflowEvents().map(recorded)).toEqual([
      { ...base, action: 'workflow.created', targetVersion: 1, transition: undefined },
      { ...base, action: 'workflow.version_created', targetVersion: 2, transition: undefined },
      {
        ...base,
        action: 'workflow.state_changed',
        targetVersion: 2,
        transition: { from: 'draft', to: 'active' },
      },
      {
        ...base,
        action: 'workflow.state_changed',
        targetVersion: 2,
        transition: { from: 'active', to: 'paused' },
      },
      {
        ...base,
        action: 'workflow.state_changed',
        targetVersion: 2,
        transition: { from: 'paused', to: 'active' },
      },
      {
        ...base,
        action: 'workflow.state_changed',
        targetVersion: 2,
        transition: { from: 'active', to: 'archived' },
      },
    ]);
    // Each event carries its own time, and nothing of the steps or the name.
    for (const e of w.workflowEvents()) expect(e.occurredAt).toBeTruthy();
    expect(JSON.stringify(w.workflowEvents())).not.toMatch(/Launch|Research the market/);
  });

  it('records GIA as the channel and the user as the actor', async () => {
    const w = await setup();
    await w.workflows.create(w.giaA, { name: 'Launch', steps: STEPS });
    expect(w.workflowEvents()[0]?.actor).toEqual({ type: 'user', userId: ALICE, via: 'gia' });
  });

  it('applies nothing when the audit event cannot be stored', async () => {
    const w = await setup();
    w.workflowAudit.broken = true;
    await expect(w.workflows.create(w.tenantA, { name: 'Launch', steps: STEPS })).rejects.toThrow(
      'audit store unavailable',
    );
    expect(await w.workflows.list(w.tenantA)).toEqual([]);

    w.workflowAudit.broken = false;
    const created = await w.workflows.create(w.tenantA, { name: 'Launch', steps: STEPS });
    w.workflowAudit.broken = true;
    await expect(
      w.workflows.publishVersion(w.tenantA, created.id, { steps: STEPS.slice(0, 1) }),
    ).rejects.toThrow('audit store unavailable');
    await expect(
      w.workflows.changeStatus(w.tenantA, created.id, { from: 'draft', to: 'active' }),
    ).rejects.toThrow('audit store unavailable');
    w.workflowAudit.broken = false;
    const after = await w.workflows.get(w.tenantA, created.id);
    expect(after).toEqual(created);
    expect(await codeOf(w.workflows.getVersion(w.tenantA, created.id, 2))).toBe(
      'workflow_not_found',
    );
    expect(w.workflowEvents().map((e) => e.action)).toEqual(['workflow.created']);
  });

  it('refuses a workflow change with no audit event, and keeps tenants apart', async () => {
    const w = await setup();
    const created = await w.workflows.create(w.tenantA, { name: 'Launch', steps: STEPS });
    await expect(
      w.repository.update(w.orgA, created.id, (current) => ({
        workflow: { ...current, revision: current.revision + 1 },
        events: [],
      })),
    ).rejects.toThrow('audit events');
    expect(
      await codeOf(
        w.workflows.changeStatus(w.tenantB, created.id, { from: 'draft', to: 'active' }),
      ),
    ).toBe('workflow_not_found');
    expect(w.workflowEvents().filter((e) => e.organizationId === w.orgB)).toEqual([]);
    expect(w.workflowEvents()).toHaveLength(1);
  });
});

describe('workflow instantiation', () => {
  it('binds roles to eligible specialists and produces a plan through the same validation', async () => {
    const w = await setup();
    const created = await w.workflows.create(w.tenantA, { name: 'Launch', steps: STEPS });
    const active = await w.workflows.changeStatus(w.tenantA, created.id, {
      from: 'draft',
      to: 'active',
    });
    const execution = await w.planningFor(w.tenantA, w.owner, active);
    const outcome = await w.workflows.instantiate(w.tenantA, active.id, {
      executionId: execution.id,
    });
    if (outcome.status !== 'planned') throw new Error(outcome.reason);
    // An approval step always needs a human.
    expect(outcome.plan.status).toBe('approval_required');
    expect(outcome.version.source).toEqual({
      kind: 'workflow',
      workflowId: active.id,
      workflowVersion: 1,
    });
    const step = (id: string) => must(outcome.version.steps.find((s) => s.id === id));
    expect(step('research').specialist?.id).toBe(w.researcher.identity.id);
    expect(step('campaign').specialist?.id).toBe(w.marketer.identity.id);
    expect(step('campaign').retry).toEqual({ maxAttempts: 2, backoffMs: 1000 });
    expect(w.events('plan.created')).toHaveLength(1);
    // Nothing ran: no model call and no child execution.
    expect(w.calls).toHaveLength(0);
    expect(w.events('execution.created')).toHaveLength(1);
  });

  it('delegates a workflow plan with the workflow version in every child', async () => {
    const w = await setup();
    const created = await w.workflows.create(w.tenantA, {
      name: 'Launch',
      steps: STEPS.slice(0, 2),
    });
    const active = await w.workflows.changeStatus(w.tenantA, created.id, {
      from: 'draft',
      to: 'active',
    });
    const execution = await w.planningFor(w.tenantA, w.owner, active);
    const outcome = await w.workflows.instantiate(w.tenantA, active.id, {
      executionId: execution.id,
    });
    if (outcome.status !== 'planned') throw new Error(outcome.reason);
    // A workflow's plan always waits for a person, even with no approval step (ADR-0071).
    expect(outcome.plan.status).toBe('approval_required');
    expect(outcome.version.approvalRequired).toBe(true);
    await w.plans.approve(w.tenantA, outcome.plan.id, {
      version: outcome.version.version,
      digest: outcome.version.digest,
    });
    const { children } = await w.delegation.delegate(w.tenantA, outcome.plan.id);
    const [child] = children;
    expect(child?.workflowId).toBe(active.id);
    expect(child?.versionSnapshot.components).toContainEqual({
      kind: 'workflow',
      id: active.id,
      version: '1',
    });
  });

  it('refuses inactive workflows, missing assignees and executions of another version', async () => {
    const w = await setup();
    const created = await w.workflows.create(w.tenantA, { name: 'Launch', steps: STEPS });
    const execution = await w.planningFor(w.tenantA, w.owner, created);
    expect(
      await codeOf(w.workflows.instantiate(w.tenantA, created.id, { executionId: execution.id })),
    ).toBe('workflow_not_active');
    const active = await w.workflows.changeStatus(w.tenantA, created.id, {
      from: 'draft',
      to: 'active',
    });
    await w.pause(w.orgA, w.marketer);
    expect(
      await codeOf(w.workflows.instantiate(w.tenantA, active.id, { executionId: execution.id })),
    ).toBe('assignee_unavailable');
    const other = await setup();
    const made = await other.workflows.create(other.tenantA, { name: 'Launch', steps: STEPS });
    await other.workflows.changeStatus(other.tenantA, made.id, { from: 'draft', to: 'active' });
    const v2 = await other.workflows.publishVersion(other.tenantA, made.id, { steps: STEPS });
    const stale = await other.planningFor(other.tenantA, other.owner, v2, 1);
    expect(
      await codeOf(other.workflows.instantiate(other.tenantA, made.id, { executionId: stale.id })),
    ).toBe('execution_not_plannable');
    expect(
      await codeOf(other.workflows.instantiate(other.tenantB, made.id, { executionId: stale.id })),
    ).toBe('workflow_not_found');
  });

  it('never lets a workflow reach a specialist of another organization', async () => {
    const w = await setup();
    await w.seed(w.orgB, BOB, { type: 'research', role: 'market_researcher' });
    await w.pause(w.orgA, w.researcher);
    const created = await w.workflows.create(w.tenantA, {
      name: 'Launch',
      steps: STEPS.slice(0, 1),
    });
    const active = await w.workflows.changeStatus(w.tenantA, created.id, {
      from: 'draft',
      to: 'active',
    });
    const execution = await w.planningFor(w.tenantA, w.owner, active);
    expect(
      await codeOf(w.workflows.instantiate(w.tenantA, active.id, { executionId: execution.id })),
    ).toBe('assignee_unavailable');
  });
});

describe('a person plans a workflow (WF-2)', () => {
  async function active(w: Awaited<ReturnType<typeof setup>>, steps: unknown = STEPS) {
    const created = await w.workflows.create(w.tenantA, { name: 'Launch', steps });
    return w.workflows.changeStatus(w.tenantA, created.id, { from: 'draft', to: 'active' });
  }

  it('creates the planning execution and a plan that waits for approval, once per key', async () => {
    const w = await setup();
    const workflow = await active(w, STEPS.slice(0, 2));
    const outcome = await w.workflows.plan(w.tenantA, workflow.id, { requestKey: 'k-1' });
    if (outcome.status !== 'planned') throw new Error(outcome.reason);
    expect(outcome.plan.status).toBe('approval_required');
    expect(outcome.plan.executionId).toBe(outcome.executionId);
    const execution = await w.executions.get(w.tenantA, outcome.executionId);
    expect(execution).toMatchObject({
      mode: 'plan',
      status: 'waiting_approval',
      workflowId: workflow.id,
      // The agent of the first assigned step owns the planning execution.
      specialistId: w.researcher.identity.id,
      input: { type: WORKFLOW_PLAN_INPUT, id: workflow.id },
    });
    expect(execution.versionSnapshot.components).toContainEqual({
      kind: 'workflow',
      id: workflow.id,
      version: '1',
    });

    // The same key: the same plan, nothing new.
    const again = await w.workflows.plan(w.tenantA, workflow.id, { requestKey: 'k-1' });
    expect(again).toMatchObject({ status: 'planned', executionId: outcome.executionId });
    expect(w.events('plan.created')).toHaveLength(1);
    expect(w.events('execution.created')).toHaveLength(1);
    // Another key: another plan.
    const other = await w.workflows.plan(w.tenantA, workflow.id, { requestKey: 'k-2' });
    expect(other.executionId).not.toBe(outcome.executionId);
    expect(w.events('plan.created')).toHaveLength(2);
    // Nothing ran.
    expect(w.calls).toHaveLength(0);
  });

  it('ends the planning execution of a refused plan, and a repeat gets the same refusal', async () => {
    // Only the tool step's performer may call its tool: without the tool, the plan is refused.
    const w = await setup();
    const workflow = await active(w, [
      STEPS[0],
      { ...STEPS[1], tool: { id: 'unknown_tool', version: 1 } },
    ]);
    const outcome = await w.workflows.plan(w.tenantA, workflow.id, { requestKey: 'k-1' });
    expect(outcome.status).toBe('refused');
    if (outcome.status !== 'refused') return;
    const execution = await w.executions.get(w.tenantA, outcome.executionId);
    expect(execution.status).toBe('failed');
    expect(execution.failure?.code).toBe(WORKFLOW_PLAN_REFUSED);
    const again = await w.workflows.plan(w.tenantA, workflow.id, { requestKey: 'k-1' });
    expect(again).toEqual(outcome);
    expect(w.events('plan.proposal_refused')).toHaveLength(1);
  });

  it('refuses GIA, the runtime, bad keys, inactive workflows and other organizations', async () => {
    const w = await setup();
    const workflow = await active(w);
    expect(await codeOf(w.workflows.plan(w.giaA, workflow.id, { requestKey: 'k' }))).toBe(
      'permission_denied',
    );
    expect(await codeOf(w.workflows.plan(w.runtimeA, workflow.id, { requestKey: 'k' }))).toBe(
      'permission_denied',
    );
    expect(await codeOf(w.workflows.plan(w.tenantA, workflow.id, { requestKey: 'a b' }))).toBe(
      'invalid_workflow',
    );
    expect(await codeOf(w.workflows.plan(w.tenantB, workflow.id, { requestKey: 'k' }))).toBe(
      'workflow_not_found',
    );
    const paused = await w.workflows.changeStatus(w.tenantA, workflow.id, {
      from: 'active',
      to: 'paused',
    });
    expect(await codeOf(w.workflows.plan(w.tenantA, paused.id, { requestKey: 'k' }))).toBe(
      'workflow_not_active',
    );
    await w.workflows.changeStatus(w.tenantA, workflow.id, { from: 'paused', to: 'active' });
    await w.pause(w.orgA, w.marketer);
    expect(await codeOf(w.workflows.plan(w.tenantA, workflow.id, { requestKey: 'k' }))).toBe(
      'assignee_unavailable',
    );
    // Nothing was created by any refusal.
    expect(w.events('execution.created')).toHaveLength(0);
  });

  it('reads back the plan of a request a person cancelled', async () => {
    const w = await setup();
    const workflow = await active(w, STEPS.slice(0, 2));
    const outcome = await w.workflows.plan(w.tenantA, workflow.id, { requestKey: 'k' });
    if (outcome.status !== 'planned') throw new Error(outcome.reason);
    await w.executions.cancel(w.tenantA, outcome.executionId, 'director_request');
    // The plan is still there (cancelled by the cascade): a repeat reads it back.
    const again = await w.workflows.plan(w.tenantA, workflow.id, { requestKey: 'k' });
    expect(again.status).toBe('planned');
  });
});
