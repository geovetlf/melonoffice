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
import { createWorkflowService } from './service.js';

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

async function setup(options: WorldOptions = {}) {
  const w = await world(options);
  const owner = await w.seed(w.orgA, ALICE, { type: 'leadership', role: 'chief_of_staff' });
  const researcher = await w.seed(w.orgA, ALICE, { toolIds: ['lookup'] });
  const marketer = await w.seed(w.orgA, ALICE, { type: 'marketing', role: 'campaign_manager' });
  const repository = new InMemoryWorkflowRepository();
  const workflows = createWorkflowService({
    repository,
    plans: w.plans,
    specialists: w.specialists,
    departments: w.departments,
    organizations: w.tenancy,
    authorization: createAuthorizationService((options.roles ?? ROLES) as never),
  });
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
  return { ...w, owner, researcher, marketer, repository, workflows, planningFor };
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
