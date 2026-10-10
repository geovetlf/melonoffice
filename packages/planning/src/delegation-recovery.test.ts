import type {
  IsoTimestamp,
  OrganizationId,
  Plan,
  PlanId,
  UserId,
  WorkflowId,
} from '@melonoffice/domain';
import { ExecutionError, type ExecutionService } from '@melonoffice/execution';
import { ROLES } from '@melonoffice/rbac';
import {
  membershipIdOf,
  resolveRuntimeTenant,
  resolveTenant,
  type TenantContext,
} from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { createAbandonedRecovery } from './abandoned-recovery.js';
import { createDelegation, type Delegation } from './delegation.js';
import { isPlanningError } from './errors.js';
import { failDelegation } from './model.js';
import { createPermissionRecovery } from './permission-recovery.js';
import type { AbandonScheduled } from './service.js';
import { ALICE, BOB, as, must, proposal, specialistStep, world, type World } from './testkit.js';

/**
 * Recovery of delegations (ADR-0186). A `creating` delegation of a schedule's plan is failed by
 * the runtime only when nothing can finish it, a failed delegation whose cleanup an interrupted
 * attempt left open is finished, and neither ever starts or reactivates work. Each change is
 * guarded in the plan's own transaction and audited once, with its reason and its occurrence.
 */

class Injected extends Error {}

const WORKFLOW = '11111111-1111-4111-8111-111111111111' as WorkflowId;
const FIRST = '2026-10-05T14:00:00.000Z' as IsoTimestamp;
const SECOND = '2026-10-06T14:00:00.000Z' as IsoTimestamp;

/** The roles of a test: `member` is an owner without `plan.create`, the role a person keeps once planning is withdrawn. */
const WITHOUT_PLANNING = {
  owner: ROLES.owner,
  member: ROLES.owner.filter((permission) => permission !== 'plan.create'),
};

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    if (isPlanningError(error)) return error.code;
    if (error instanceof Injected) return 'injected';
    throw error;
  }
  return 'accepted';
};

/** An approved plan of a schedule: its occurrence is FIRST, its approval is the schedule's. */
async function scheduledPlan(w: World, chain = false): Promise<Plan> {
  const owner = await w.seed(w.orgA, ALICE, { type: 'leadership', role: 'chief_of_staff' });
  const researcher = await w.seed(w.orgA, ALICE, {});
  const execution = await w.executions.create(w.tenantA, {
    mode: 'plan',
    input: { type: 'task', id: 'task-1' },
    specialistId: owner.identity.id,
    specialistVersion: owner.version,
    departmentId: owner.configuration.departmentId,
    workflowId: WORKFLOW,
    versionSnapshot: {
      schemaVersion: 1,
      components: [
        { kind: 'specialist', id: owner.identity.id, version: String(owner.version) },
        { kind: 'workflow', id: WORKFLOW, version: '1' },
      ],
    },
  });
  await w.executions.changeStatus(w.tenantA, execution.id, { from: 'pending', to: 'planning' });
  const outcome = await w.plans.propose(w.tenantA, {
    executionId: execution.id,
    proposal: proposal(
      chain
        ? [
            specialistStep('research', researcher),
            specialistStep('review', researcher, { dependsOn: ['research'] }),
          ]
        : [specialistStep('research', researcher)],
    ),
    source: { kind: 'workflow', workflowId: WORKFLOW, workflowVersion: 1, occurrence: FIRST },
  });
  if (outcome.status !== 'planned') throw new Error(outcome.status);
  return w.plans.approveScheduled(w.runtimeA, outcome.plan.id, {
    workflowId: WORKFLOW,
    workflowVersion: 1,
  });
}

/** A person's approved plan, made by hand: the schedule has no say in it. */
async function personalPlan(w: World): Promise<Plan> {
  const owner = await w.seed(w.orgA, ALICE, { type: 'leadership', role: 'chief_of_staff' });
  const researcher = await w.seed(w.orgA, ALICE, {});
  const execution = await w.planning(w.tenantA, owner);
  const outcome = await w.plans.propose(w.tenantA, {
    executionId: execution.id,
    proposal: proposal([specialistStep('research', researcher, { approvalRequired: true })]),
    source: {
      kind: 'planner',
      model: { provider: 'alpha', id: 'alpha-large', version: 'v' },
      policy: { id: 'default_model', version: 1 },
    },
  });
  if (outcome.status !== 'planned') throw new Error(outcome.status);
  const seen = {
    version: 1,
    digest: (await w.plans.getVersion(w.tenantA, outcome.plan.id, 1)).digest,
  };
  return w.plans.approve(w.tenantA, outcome.plan.id, seen);
}

/** A delegation whose child creation stops after `allowed` children: the attempt ends `creating`. */
function stoppedAfter(w: World, allowed: number): Delegation {
  let made = 0;
  const executions = {
    ...w.executions,
    create: async (
      tenant: Parameters<ExecutionService['create']>[0],
      request: Parameters<ExecutionService['create']>[1],
    ) => {
      if (request.mode === 'execute') {
        if (made >= allowed) throw new Injected('create');
        made += 1;
      }
      return w.executions.create(tenant, request);
    },
  };
  return createDelegation({
    plans: w.planRepository,
    executions,
    specialists: w.specialists,
    organizations: w.tenancy,
    authorization: w.authorization,
  });
}

/** The plan as stored now: the instant of its last write is what a lease is measured from. */
const stored = (w: World, plan: Plan): Promise<Plan> => w.plans.get(w.tenantA, plan.id);

/** Alice keeps her membership and takes the role `role`: the permissions she holds now are that role's. */
async function setRole(w: World, role: string): Promise<void> {
  const membership = must(await w.tenancy.findMembership(w.orgA, ALICE));
  w.tenancy.put({ ...membership, role });
}

/** The runner's input once the next occurrence moved past a plan untouched since its last write. */
async function movedPast(w: World, plan: Plan): Promise<AbandonScheduled> {
  return {
    workflowId: WORKFLOW,
    supersededBy: SECOND,
    untouchedBefore: (await stored(w, plan)).updatedAt,
  };
}

/** The `plan.state_changed` events of one plan: reason, reference and the status it moved to. */
/** A delegation whose first child cannot be created: the attempt stops with the delegation `creating`. */
const stoppedAtCreate = (w: World): Delegation => stoppedAfter(w, 0);

const closed = (w: World, planId: string) =>
  w
    .events('plan.state_changed')
    .filter((e) => e.target?.id === planId)
    .map((e) => [e.reason, e.reference, e.transition?.to]);

describe('Delegation recovery (ADR-0186)', () => {
  it('a creating delegation of a schedule’s plan is failed by the runtime once its occurrence is superseded and the plan is untouched', async () => {
    const w = await world();
    const plan = await scheduledPlan(w);
    expect(await codeOf(stoppedAtCreate(w).delegate(w.runtimeA, plan.id))).toBe('injected');
    const creating = await stored(w, plan);
    expect(creating.delegationState).toBe('creating');

    // Written after the instant the lease is measured from: a live attempt may still finish it.
    const touched = {
      ...(await movedPast(w, plan)),
      untouchedBefore: new Date(Date.parse(creating.updatedAt) - 1).toISOString() as IsoTimestamp,
    };
    expect(await codeOf(w.delegation.abandon(w.runtimeA, plan.id, touched))).toBe(
      'plan_not_abandonable',
    );
    expect((await stored(w, plan)).delegationState).toBe('creating');

    const failed = await w.delegation.abandon(w.runtimeA, plan.id, await movedPast(w, plan));
    expect(failed).toMatchObject({
      status: 'failed',
      delegationState: 'failed',
      delegationFailure: 'delegation_abandoned',
    });
    // Its planning execution is closed with it, and nothing it made ever ran.
    expect((await w.executions.get(w.tenantA, plan.executionId)).status).toBe('failed');
    expect(w.events('delegation.created')).toEqual([]);
    // Closed once, with its reason and the occurrence it belonged to.
    expect(closed(w, plan.id)).toEqual([['schedule_abandoned', `occurrence:${FIRST}`, 'failed']]);
  });

  it('a creating delegation of a schedule that is switched off is failed with that reason, and never by an occurrence', async () => {
    const w = await world();
    const plan = await scheduledPlan(w);
    await codeOf(stoppedAtCreate(w).delegate(w.runtimeA, plan.id));
    const { updatedAt } = await stored(w, plan);
    const failed = await w.delegation.abandon(w.runtimeA, plan.id, {
      workflowId: WORKFLOW,
      reason: 'schedule_off',
      untouchedBefore: updatedAt,
    });
    expect(failed.delegationFailure).toBe('delegation_abandoned');
    expect(closed(w, plan.id)).toEqual([['schedule_off', `occurrence:${FIRST}`, 'failed']]);
  });

  it('a creating delegation is not failed unless it is superseded, the schedule’s, and of the right kind', async () => {
    const w = await world();
    const plan = await scheduledPlan(w);
    await codeOf(stoppedAtCreate(w).delegate(w.runtimeA, plan.id));
    const { updatedAt } = await stored(w, plan);
    for (const input of [
      // Not superseded: the occurrence is not earlier than the one that moved past it.
      { workflowId: WORKFLOW, supersededBy: FIRST, untouchedBefore: updatedAt },
      // A schedule that is off supersedes nothing: an occurrence is not the reason for it.
      {
        workflowId: WORKFLOW,
        reason: 'schedule_off' as const,
        supersededBy: SECOND,
        untouchedBefore: updatedAt,
      },
      // Superseded by an occurrence, but none given.
      { workflowId: WORKFLOW, untouchedBefore: updatedAt },
      // Another workflow’s schedule.
      {
        workflowId: '22222222-2222-4222-8222-222222222222' as WorkflowId,
        supersededBy: SECOND,
        untouchedBefore: updatedAt,
      },
    ]) {
      expect(await codeOf(w.delegation.abandon(w.runtimeA, plan.id, input))).toBe(
        'plan_not_abandonable',
      );
    }
    expect((await stored(w, plan)).delegationState).toBe('creating');
    expect(closed(w, plan.id)).toEqual([]);
  });

  it('the runtime never fails a person’s own delegation, and a person never fails a schedule’s through the runtime', async () => {
    const w = await world();
    const plan = await personalPlan(w);
    expect(await codeOf(stoppedAtCreate(w).delegate(w.tenantA, plan.id))).toBe('injected');
    expect(await codeOf(w.delegation.abandon(w.runtimeA, plan.id, await movedPast(w, plan)))).toBe(
      'plan_not_abandonable',
    );
    expect(await codeOf(w.delegation.abandon(w.tenantA, plan.id, await movedPast(w, plan)))).toBe(
      'permission_denied',
    );
    expect((await stored(w, plan)).delegationState).toBe('creating');
  });

  it('concurrent abandons fail the delegation once, and a later one only finishes the cleanup', async () => {
    const w = await world();
    const plan = await scheduledPlan(w);
    await codeOf(stoppedAtCreate(w).delegate(w.runtimeA, plan.id));
    const input = await movedPast(w, plan);
    const results = await Promise.all(
      [1, 2, 3].map(() => codeOf(w.delegation.abandon(w.runtimeA, plan.id, input))),
    );
    expect(results).toEqual(['accepted', 'accepted', 'accepted']);
    expect(await codeOf(w.delegation.abandon(w.runtimeA, plan.id, input))).toBe('accepted');
    expect(closed(w, plan.id)).toEqual([['schedule_abandoned', `occurrence:${FIRST}`, 'failed']]);
    expect((await w.plans.get(w.tenantA, plan.id)).status).toBe('failed');
  });

  it('a cleanup another attempt finished first is accepted, and nothing is written twice', async () => {
    const w = await world();
    const plan = await scheduledPlan(w);
    await codeOf(stoppedAtCreate(w).delegate(w.runtimeA, plan.id));
    // The planning execution's change is refused against the state this attempt read: another
    // attempt already closed it, and it is terminal now.
    const raced: ExecutionService = {
      ...w.executions,
      runtimePlanChangeStatus: async (tenant, id, change) => {
        await w.executions.runtimePlanChangeStatus(tenant, id, change);
        throw new ExecutionError('execution_concurrency_conflict');
      },
    } as ExecutionService;
    const delegation = createDelegation({
      plans: w.planRepository,
      executions: raced,
      specialists: w.specialists,
      organizations: w.tenancy,
      authorization: w.authorization,
    });
    expect(await codeOf(delegation.abandon(w.runtimeA, plan.id, await movedPast(w, plan)))).toBe(
      'accepted',
    );
    expect((await w.executions.get(w.tenantA, plan.executionId)).status).toBe('failed');
    expect(closed(w, plan.id)).toEqual([['schedule_abandoned', `occurrence:${FIRST}`, 'failed']]);
  });

  it('a delegation that was created or completed is never abandoned', async () => {
    const w = await world();
    const plan = await scheduledPlan(w);
    await w.delegation.delegate(w.runtimeA, plan.id);
    expect(await codeOf(w.delegation.abandon(w.runtimeA, plan.id, await movedPast(w, plan)))).toBe(
      'plan_not_abandonable',
    );
    expect((await w.plans.get(w.tenantA, plan.id)).status).toBe('executing');
  });

  it('a delegation that failed for another cause is not abandoned: its cleanup stays with closeFailed', async () => {
    const w = await world();
    const plan = await scheduledPlan(w);
    await codeOf(stoppedAtCreate(w).delegate(w.runtimeA, plan.id));
    const input = await movedPast(w, plan);
    await w.planRepository.update(w.orgA, plan.id, (current) => ({
      plan: failDelegation(
        current,
        'delegation_conflict',
        new Date().toISOString() as IsoTimestamp,
      ),
      events: [],
    }));
    expect(await codeOf(w.delegation.abandon(w.runtimeA, plan.id, input))).toBe(
      'plan_not_abandonable',
    );
    expect((await w.executions.get(w.tenantA, plan.executionId)).status).toBe('waiting_approval');
    expect(closed(w, plan.id)).toEqual([]);

    await w.delegation.closeFailed(w.runtimeA, plan.id);
    expect((await w.executions.get(w.tenantA, plan.executionId)).status).toBe('failed');
    expect(closed(w, plan.id)).toEqual([]);
  });

  it('closeFailed finishes a failed delegation whose cleanup was interrupted, and never reactivates it', async () => {
    const w = await world();
    const plan = await scheduledPlan(w);
    await codeOf(stoppedAtCreate(w).delegate(w.runtimeA, plan.id));
    // The plan’s failure was written, and the attempt stopped before it cleaned up.
    await w.planRepository.update(w.orgA, plan.id, (current) => ({
      plan: failDelegation(
        current,
        'delegation_abandoned',
        new Date().toISOString() as IsoTimestamp,
      ),
      events: [],
    }));
    expect((await w.executions.get(w.tenantA, plan.executionId)).status).toBe('waiting_approval');

    const finished = await w.delegation.closeFailed(w.runtimeA, plan.id);
    expect(finished.status).toBe('failed');
    expect((await w.executions.get(w.tenantA, plan.executionId)).status).toBe('failed');
    // Again: a finished cleanup changes nothing.
    await w.delegation.closeFailed(w.runtimeA, plan.id);
    expect((await w.plans.get(w.tenantA, plan.id)).status).toBe('failed');
    // Never reactivated: delegating again only reports the failure, and creates no child.
    expect(await codeOf(w.delegation.delegate(w.tenantA, plan.id))).toBe('delegation_failed');
    expect(w.events('delegation.created')).toEqual([]);
    expect((await w.plans.get(w.tenantA, plan.id)).status).toBe('failed');
  });

  it('closeFailed closes only what a schedule made for the runtime, and another organization finds no plan', async () => {
    const w = await world();
    const plan = await personalPlan(w);
    await codeOf(stoppedAtCreate(w).delegate(w.tenantA, plan.id));
    await w.planRepository.update(w.orgA, plan.id, (current) => ({
      plan: failDelegation(
        current,
        'delegation_abandoned',
        new Date().toISOString() as IsoTimestamp,
      ),
      events: [],
    }));
    expect(await codeOf(w.delegation.closeFailed(w.runtimeA, plan.id))).toBe('permission_denied');
    expect(await codeOf(w.delegation.closeFailed(w.tenantB, plan.id))).toBe('plan_not_found');
    expect((await w.executions.get(w.tenantA, plan.executionId)).status).toBe('waiting_approval');
    // The person who made it may close it.
    await w.delegation.closeFailed(w.tenantA, plan.id);
    expect((await w.executions.get(w.tenantA, plan.executionId)).status).toBe('failed');
    expect(must(await w.plans.get(w.tenantA, plan.id)).status).toBe('failed');
  });

  it('the runtime leaves the child it made pending, and a person’s cleanup is what cancels it', async () => {
    const w = await world();
    const plan = await scheduledPlan(w, true);
    expect(await codeOf(stoppedAfter(w, 1).delegate(w.runtimeA, plan.id))).toBe('injected');
    const made = must(
      (await stored(w, plan)).delegations.find((d) => d.stepId === 'research'),
    ).executionId;
    expect(await codeOf(w.delegation.abandon(w.runtimeA, plan.id, await movedPast(w, plan)))).toBe(
      'accepted',
    );
    // The schedule never cancels (ADR-0029): its child stays pending under the failed parent.
    expect((await w.executions.get(w.tenantA, made)).status).toBe('pending');
    // A person who closes the failed delegation cancels what it made.
    await w.delegation.closeFailed(w.tenantA, plan.id);
    expect((await w.executions.get(w.tenantA, made)).status).toBe('cancelled');
  });
});

describe('Release of a schedule’s plan once its person may no longer plan (ADR-0187)', () => {
  it('a person who loses plan.create releases the creating delegation of a schedule’s plan, audited as permission_lost', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const plan = await scheduledPlan(w);
    expect(await codeOf(stoppedAtCreate(w).delegate(w.runtimeA, plan.id))).toBe('injected');
    await setRole(w, 'member');

    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    expect(await codeOf(w.delegation.abandon(runtime, plan.id, await movedPast(w, plan)))).toBe(
      'accepted',
    );
    expect(await stored(w, plan)).toMatchObject({
      status: 'failed',
      delegationState: 'failed',
      delegationFailure: 'delegation_abandoned',
    });
    // Its planning execution is closed with it, and nothing it made ever ran.
    expect((await w.executions.get(w.tenantA, plan.executionId)).status).toBe('failed');
    expect(w.events('delegation.created')).toEqual([]);
    // The release names the withdrawn permission, with the occurrence the plan belonged to.
    expect(closed(w, plan.id)).toEqual([['permission_lost', `occurrence:${FIRST}`, 'failed']]);
  });

  it('a person who loses plan.create releases an approved plan that never started, audited as permission_lost', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const plan = await scheduledPlan(w);
    await setRole(w, 'member');

    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    const { updatedAt } = await stored(w, plan);
    expect(
      await codeOf(
        w.plans.abandonScheduled(runtime, plan.id, {
          workflowId: WORKFLOW,
          reason: 'schedule_off',
          untouchedBefore: updatedAt,
        }),
      ),
    ).toBe('accepted');
    expect((await stored(w, plan)).status).toBe('cancelled');
    expect(closed(w, plan.id)).toEqual([['permission_lost', `occurrence:${FIRST}`, 'cancelled']]);
  });

  it('concurrent releases after the permission is lost change the plan once, and a later one or a cleanup changes nothing', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const plan = await scheduledPlan(w);
    await codeOf(stoppedAtCreate(w).delegate(w.runtimeA, plan.id));
    await setRole(w, 'member');

    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    const input = await movedPast(w, plan);
    const results = await Promise.all(
      [1, 2, 3].map(() => codeOf(w.delegation.abandon(runtime, plan.id, input))),
    );
    expect(results).toEqual(['accepted', 'accepted', 'accepted']);
    expect(await codeOf(w.delegation.abandon(runtime, plan.id, input))).toBe('accepted');
    expect(await codeOf(w.delegation.closeFailed(runtime, plan.id))).toBe('accepted');
    expect(closed(w, plan.id)).toEqual([['permission_lost', `occurrence:${FIRST}`, 'failed']]);
    expect((await stored(w, plan)).status).toBe('failed');
  });

  it('the audit names the schedule’s own reason once the person may plan again', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const plan = await scheduledPlan(w);
    await codeOf(stoppedAtCreate(w).delegate(w.runtimeA, plan.id));
    await setRole(w, 'member');
    await setRole(w, 'owner');

    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    const { updatedAt } = await stored(w, plan);
    expect(
      await codeOf(
        w.delegation.abandon(runtime, plan.id, {
          workflowId: WORKFLOW,
          reason: 'schedule_off',
          untouchedBefore: updatedAt,
        }),
      ),
    ).toBe('accepted');
    expect(closed(w, plan.id)).toEqual([['schedule_off', `occurrence:${FIRST}`, 'failed']]);
  });

  it('a delegation that was created is never released, and a release reaches only its own organization’s plans', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const plan = await scheduledPlan(w);
    await w.delegation.delegate(w.runtimeA, plan.id);
    const planned = await scheduledPlan(w);
    await codeOf(stoppedAtCreate(w).delegate(w.runtimeA, planned.id));
    await setRole(w, 'member');

    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    const other = await resolveRuntimeTenant(BOB, w.orgB, w.tenancy);
    expect(await codeOf(w.delegation.abandon(runtime, plan.id, await movedPast(w, plan)))).toBe(
      'plan_not_abandonable',
    );
    expect((await w.plans.get(w.tenantA, plan.id)).status).toBe('executing');
    // Another organization’s runtime finds none of this organization’s plans.
    expect(await codeOf(w.delegation.abandon(other, planned.id, await movedPast(w, planned)))).toBe(
      'plan_not_found',
    );
    expect((await stored(w, planned)).delegationState).toBe('creating');
    expect(closed(w, planned.id)).toEqual([]);
  });

  it('a person who lost plan.create closes none of her plans by hand, and the runtime closes none of them', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const personal = await personalPlan(w);
    await codeOf(stoppedAtCreate(w).delegate(w.tenantA, personal.id));
    await setRole(w, 'member');

    const alice = await resolveTenant(as(ALICE), w.orgA, w.tenancy);
    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    expect(
      await codeOf(w.delegation.abandon(runtime, personal.id, await movedPast(w, personal))),
    ).toBe('plan_not_abandonable');
    expect(await codeOf(w.delegation.closeFailed(alice, personal.id))).toBe('permission_denied');
    expect((await stored(w, personal)).delegationState).toBe('creating');
    expect(closed(w, personal.id)).toEqual([]);
  });
});

/** A plan made by `user` in `organization`, approved by hand: the tenant `tenant` acts for them there. */
async function handMadePlanIn(
  w: World,
  tenant: TenantContext,
  organization: OrganizationId,
  user: UserId,
): Promise<Plan> {
  const owner = await w.seed(organization, user, { type: 'leadership', role: 'chief_of_staff' });
  const researcher = await w.seed(organization, user, {});
  const execution = await w.planning(tenant, owner);
  const outcome = await w.plans.propose(tenant, {
    executionId: execution.id,
    proposal: proposal([specialistStep('research', researcher, { approvalRequired: true })]),
    source: {
      kind: 'planner',
      model: { provider: 'alpha', id: 'alpha-large', version: 'v' },
      policy: { id: 'default_model', version: 1 },
    },
  });
  if (outcome.status !== 'planned') throw new Error(outcome.status);
  const seen = {
    version: 1,
    digest: (await w.plans.getVersion(tenant, outcome.plan.id, 1)).digest,
  };
  return w.plans.approve(tenant, outcome.plan.id, seen);
}

/** Alice leaves the organization: her membership is no longer active, so no runtime acts for her. */
async function leave(w: World): Promise<void> {
  const membership = must(await w.tenancy.findMembership(w.orgA, ALICE));
  w.tenancy.put({ ...membership, status: 'revoked' });
}

/** The plan as the repository holds it, without any tenant: a sweep reads it that way too. */
const held = (w: World, organization: OrganizationId, plan: Plan): Promise<Plan | undefined> =>
  w.planRepository.find(organization, plan.id);

/** One lease, as the schedules' sweep measures it (ADR-0185). */
const LEASE_MS = 20 * 60_000;

/** A sweep run an hour after the plans were written: every lease has lapsed by then. */
const LATER = (): Date => new Date(Date.now() + 60 * 60_000);

describe('Release of a hand-made plan once its creator may no longer plan (ADR-0187, decision 6)', () => {
  it('the creator’s runtime releases a hand-made plan whose delegation is creating, audited as permission_lost once', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const plan = await personalPlan(w);
    expect(await codeOf(stoppedAtCreate(w).delegate(w.tenantA, plan.id))).toBe('injected');
    await setRole(w, 'member');

    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    const { updatedAt } = await stored(w, plan);
    const release = () =>
      codeOf(w.delegation.releaseManual(runtime, plan.id, { untouchedBefore: updatedAt }));
    expect(await release()).toBe('accepted');
    expect(await stored(w, plan)).toMatchObject({
      status: 'failed',
      delegationState: 'failed',
      delegationFailure: 'delegation_abandoned',
    });
    // Its planning execution is closed with it, and nothing it made was started.
    expect((await w.executions.get(w.tenantA, plan.executionId)).status).toBe('failed');
    expect(w.events('delegation.created')).toEqual([]);
    // The release names the withdrawn permission, and no schedule occurrence: none made the plan.
    expect(closed(w, plan.id)).toEqual([['permission_lost', undefined, 'failed']]);
    // Repeated, it reads the release back and writes nothing: one audit event, no more.
    expect(await release()).toBe('accepted');
    expect(closed(w, plan.id)).toHaveLength(1);
  });

  it('while the creator may still plan, the runtime releases nothing', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const plan = await personalPlan(w);
    await codeOf(stoppedAtCreate(w).delegate(w.tenantA, plan.id));
    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    const { updatedAt } = await stored(w, plan);
    expect(
      await codeOf(w.delegation.releaseManual(runtime, plan.id, { untouchedBefore: updatedAt })),
    ).toBe('plan_not_abandonable');
    expect((await stored(w, plan)).delegationState).toBe('creating');
    expect(closed(w, plan.id)).toEqual([]);
  });

  it('a schedule’s plan is never released this way, even once its creator lost plan.create', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const plan = await scheduledPlan(w);
    await codeOf(stoppedAtCreate(w).delegate(w.runtimeA, plan.id));
    await setRole(w, 'member');
    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    const { updatedAt } = await stored(w, plan);
    expect(
      await codeOf(w.delegation.releaseManual(runtime, plan.id, { untouchedBefore: updatedAt })),
    ).toBe('plan_not_abandonable');
    expect((await stored(w, plan)).delegationState).toBe('creating');
    expect(closed(w, plan.id)).toEqual([]);
  });

  it('a plan changed within its lease is left to the attempt that changed it', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const plan = await personalPlan(w);
    await codeOf(stoppedAtCreate(w).delegate(w.tenantA, plan.id));
    await setRole(w, 'member');
    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    const { updatedAt } = await stored(w, plan);
    const touched = new Date(Date.parse(updatedAt) - 1).toISOString() as IsoTimestamp;
    expect(
      await codeOf(w.delegation.releaseManual(runtime, plan.id, { untouchedBefore: touched })),
    ).toBe('plan_not_abandonable');
    expect((await stored(w, plan)).delegationState).toBe('creating');
  });

  it('concurrent releases change the plan once, and every one after the first reads it back', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const plan = await personalPlan(w);
    await codeOf(stoppedAtCreate(w).delegate(w.tenantA, plan.id));
    await setRole(w, 'member');
    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    const { updatedAt } = await stored(w, plan);
    const input = { untouchedBefore: updatedAt };
    const results = await Promise.all(
      [1, 2, 3].map(() => codeOf(w.delegation.releaseManual(runtime, plan.id, input))),
    );
    expect(results).toEqual(['accepted', 'accepted', 'accepted']);
    expect(closed(w, plan.id)).toEqual([['permission_lost', undefined, 'failed']]);
    expect((await stored(w, plan)).status).toBe('failed');
  });

  it('a delegation that was created is never released', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const plan = await personalPlan(w);
    await w.delegation.delegate(w.tenantA, plan.id);
    const before = await stored(w, plan);
    expect(before.delegationState).not.toBe('creating');
    const audited = closed(w, plan.id);
    await setRole(w, 'member');
    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    expect(
      await codeOf(
        w.delegation.releaseManual(runtime, plan.id, { untouchedBefore: before.updatedAt }),
      ),
    ).toBe('plan_not_abandonable');
    expect(await stored(w, plan)).toMatchObject({
      status: before.status,
      delegationState: before.delegationState,
    });
    expect(closed(w, plan.id)).toEqual(audited);
  });

  it('another member who may not plan releases none of her colleague’s plans: only the creator’s own runtime does', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const plan = await personalPlan(w);
    await codeOf(stoppedAtCreate(w).delegate(w.tenantA, plan.id));
    // Bob joins Alice's organization as a member who may not plan either.
    const bobs = must(await w.tenancy.findMembership(w.orgB, BOB));
    w.tenancy.put({
      ...bobs,
      id: membershipIdOf(w.orgA, BOB),
      organizationId: w.orgA,
      role: 'member',
    });
    await setRole(w, 'member');
    const bob = await resolveRuntimeTenant(BOB, w.orgA, w.tenancy);
    const { updatedAt } = await stored(w, plan);
    expect(
      await codeOf(w.delegation.releaseManual(bob, plan.id, { untouchedBefore: updatedAt })),
    ).toBe('plan_not_abandonable');
    expect((await stored(w, plan)).delegationState).toBe('creating');
    expect(closed(w, plan.id)).toEqual([]);
  });

  it('only a runtime releases, and another organization’s runtime finds none of the plans', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const plan = await personalPlan(w);
    await codeOf(stoppedAtCreate(w).delegate(w.tenantA, plan.id));
    await setRole(w, 'member');
    const { updatedAt } = await stored(w, plan);
    const input = { untouchedBefore: updatedAt };
    const alice = await resolveTenant(as(ALICE), w.orgA, w.tenancy);
    expect(await codeOf(w.delegation.releaseManual(alice, plan.id, input))).toBe(
      'permission_denied',
    );
    const other = await resolveRuntimeTenant(BOB, w.orgB, w.tenancy);
    expect(await codeOf(w.delegation.releaseManual(other, plan.id, input))).toBe('plan_not_found');
    expect((await stored(w, plan)).delegationState).toBe('creating');
    expect(closed(w, plan.id)).toEqual([]);
  });
});

describe('Permission recovery sweep (ADR-0187, decision 6)', () => {
  // `offered` records each plan the sweep asks the conductor to release: a plan it holds is never offered.
  const sweep = (
    w: World,
    options: {
      readonly limit?: number;
      readonly pages?: number;
      readonly now?: () => Date;
      readonly offered?: string[];
    } = {},
  ) =>
    createPermissionRecovery({
      plans: w.planRepository,
      conductor: {
        releaseManual: (tenant, planId, input) => {
          options.offered?.push(planId);
          return w.delegation.releaseManual(tenant, planId, input);
        },
      },
      tenancy: w.tenancy,
      authorization: w.authorization,
      leaseMs: LEASE_MS,
      now: options.now ?? LATER,
      ...(options.limit === undefined ? {} : { limit: options.limit }),
      ...(options.pages === undefined ? {} : { pages: options.pages }),
    });

  it('releases the hand-made plans of a creator who lost plan.create, and leaves a schedule’s plan to its own sweep', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const lost = await personalPlan(w);
    await codeOf(stoppedAtCreate(w).delegate(w.tenantA, lost.id));
    const scheduled = await scheduledPlan(w);
    await codeOf(stoppedAtCreate(w).delegate(w.runtimeA, scheduled.id));
    await setRole(w, 'member');

    expect(await sweep(w).recover()).toBe(1);
    expect((await held(w, w.orgA, lost))?.delegationFailure).toBe('delegation_abandoned');
    expect(closed(w, lost.id)).toEqual([['permission_lost', undefined, 'failed']]);
    expect((await held(w, w.orgA, scheduled))?.delegationState).toBe('creating');
    expect(closed(w, scheduled.id)).toEqual([]);
    // A second run finds nothing left to release.
    expect(await sweep(w).recover()).toBe(0);
  });

  it('leaves a creator who still may plan, and a creator who left the organization, as they are', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const plan = await personalPlan(w);
    await codeOf(stoppedAtCreate(w).delegate(w.tenantA, plan.id));
    const offered: string[] = [];
    // Still an owner: nothing is lost, so nothing is released, and nothing is even offered.
    expect(await sweep(w, { offered }).recover()).toBe(0);
    expect((await held(w, w.orgA, plan))?.delegationState).toBe('creating');
    // Gone from the organization: no active membership, no runtime, and no change (ADR-0187, decision 7).
    await leave(w);
    expect(await sweep(w, { offered }).recover()).toBe(0);
    expect((await held(w, w.orgA, plan))?.delegationState).toBe('creating');
    expect(offered).toEqual([]);
    expect(closed(w, plan.id)).toEqual([]);
  });

  it('walks every page a run reads, and reaches each plan once', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const first = await personalPlan(w);
    const second = await personalPlan(w);
    for (const plan of [first, second]) {
      await codeOf(stoppedAtCreate(w).delegate(w.tenantA, plan.id));
    }
    await setRole(w, 'member');

    // One plan per page, and enough pages for both: each is read once and released once.
    expect(await sweep(w, { limit: 1, pages: 10 }).recover()).toBe(2);
    expect(closed(w, first.id)).toEqual([['permission_lost', undefined, 'failed']]);
    expect(closed(w, second.id)).toEqual([['permission_lost', undefined, 'failed']]);
    expect(await sweep(w, { limit: 1, pages: 10 }).recover()).toBe(0);
  });

  it('the store reads the creating plans a page at a time, by id, strictly after its cursor', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const first = await personalPlan(w);
    const second = await personalPlan(w);
    for (const plan of [first, second]) {
      await codeOf(stoppedAtCreate(w).delegate(w.tenantA, plan.id));
    }
    // Whatever order the ids come in, each page starts after the last id of the one before.
    const low = first.id < second.id ? first.id : second.id;
    const high = first.id < second.id ? second.id : first.id;
    const page = await w.planRepository.creatingPage({ limit: 1 });
    expect(page.plans.map((p) => p.id)).toEqual([low]);
    expect(page.next).toBe(low);
    const after = await w.planRepository.creatingPage({ limit: 1, after: low });
    expect(after.plans.map((p) => p.id)).toEqual([high]);
    expect(after.next).toBe(high);
    expect(await w.planRepository.creatingPage({ limit: 1, after: high })).toEqual({ plans: [] });
  });

  it('leaves a plan changed within its lease to the attempt that changed it', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const plan = await personalPlan(w);
    await codeOf(stoppedAtCreate(w).delegate(w.tenantA, plan.id));
    await setRole(w, 'member');
    const { updatedAt } = await stored(w, plan);
    // Half a lease after its last write: not yet lapsed.
    const midLease = () => new Date(Date.parse(updatedAt) + LEASE_MS / 2);
    const offered: string[] = [];
    expect(await sweep(w, { now: midLease, offered }).recover()).toBe(0);
    expect(offered).toEqual([]);
    expect((await held(w, w.orgA, plan))?.delegationState).toBe('creating');
  });

  it('judges each plan by its own organization, and never releases another organization’s', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const lost = await personalPlan(w);
    await codeOf(stoppedAtCreate(w).delegate(w.tenantA, lost.id));
    // Bob keeps his permission in his own organization, and his plan is still creating there.
    const bobs = await handMadePlanIn(w, w.tenantB, w.orgB, BOB);
    await codeOf(stoppedAtCreate(w).delegate(w.tenantB, bobs.id));
    await setRole(w, 'member');

    // One plan per page: a page can hold Bob's plan first, and the walk must still reach Alice's.
    expect(await sweep(w, { limit: 1 }).recover()).toBe(1);
    expect((await held(w, w.orgA, lost))?.delegationFailure).toBe('delegation_abandoned');
    expect((await held(w, w.orgB, bobs))?.delegationState).toBe('creating');
    expect(closed(w, bobs.id)).toEqual([]);
  });
});

/** A delegation whose cleanup stops at its planning execution: the plan is failed and the execution stays open, as a crash leaves them (ADR-0187, decision 8). */
function crashingCleanup(w: World): Delegation {
  const executions = {
    ...w.executions,
    runtimePlanChangeStatus: (
      tenant: Parameters<ExecutionService['runtimePlanChangeStatus']>[0],
      id: Parameters<ExecutionService['runtimePlanChangeStatus']>[1],
      change: Parameters<ExecutionService['runtimePlanChangeStatus']>[2],
    ) => {
      if (change.to === 'failed') return Promise.reject(new Injected('cleanup'));
      return w.executions.runtimePlanChangeStatus(tenant, id, change);
    },
  };
  return createDelegation({
    plans: w.planRepository,
    executions,
    specialists: w.specialists,
    organizations: w.tenancy,
    authorization: w.authorization,
  });
}

/** Plans a person made while she may still plan, their delegations stopped while they were `creating`. */
async function stoppedPlans(w: World, count: number, children = 0): Promise<Plan[]> {
  const plans: Plan[] = [];
  for (let i = 0; i < count; i += 1) {
    const plan = await personalPlan(w);
    await codeOf(stoppedAfter(w, children).delegate(w.tenantA, plan.id));
    plans.push(plan);
  }
  return plans;
}

/** One plan a person made while she may still plan, stopped while `creating`: see `stoppedPlans`. */
async function stoppedPlan(w: World, children = 0): Promise<Plan> {
  return must((await stoppedPlans(w, 1, children))[0]);
}

/** Alice’s release of `plan` once she lost plan.create, which crashes after the plan failed (ADR-0187, decision 8). */
async function crashedRelease(w: World, plan: Plan): Promise<void> {
  const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
  const { updatedAt } = await stored(w, plan);
  expect(
    await codeOf(
      crashingCleanup(w).releaseManual(runtime, plan.id, { untouchedBefore: updatedAt }),
    ),
  ).toBe('injected');
}

/**
 * A plan failed as an abandonment whose cleanup never ran, as a crash before the cleanup leaves it
 * (ADR-0187, decision 8).
 */
async function failedAsAbandoned(w: World, plan: Plan): Promise<void> {
  await w.planRepository.update(w.orgA, plan.id, (current) => ({
    plan: failDelegation(
      { ...current, delegationState: 'creating' },
      'delegation_abandoned',
      new Date().toISOString() as IsoTimestamp,
    ),
    events: [],
  }));
}

/** The reasons of the execution changes that carry one, audited for a planning execution: a closure's is its failure code. */
const executionClosed = (w: World, executionId: string): string[] =>
  w
    .events('execution.state_changed')
    .filter((e) => e.target?.id === executionId && e.reason !== undefined)
    .map((e) => e.reason as string);

/** The sweep that closes the executions a crash left open, with the clock of a run an hour later by default. */
const abandonedSweep = (
  w: World,
  options: { readonly now?: () => Date; readonly limit?: number } = {},
) =>
  createAbandonedRecovery({
    plans: w.planRepository,
    conductor: {
      closeAbandoned: (tenant, planId, input) => w.delegation.closeAbandoned(tenant, planId, input),
    },
    tenancy: w.tenancy,
    leaseMs: LEASE_MS,
    now: options.now ?? LATER,
    ...(options.limit === undefined ? {} : { limit: options.limit }),
  });

describe('Recovery of an abandoned plan’s execution after a crash (ADR-0187, decision 8)', () => {
  it('a release that crashed after failing the plan leaves its execution open: the runtime closes it once a lease has passed, audited once', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const plan = await stoppedPlan(w);
    await setRole(w, 'member');
    await crashedRelease(w, plan);
    const failed = await stored(w, plan);
    expect(failed).toMatchObject({
      delegationState: 'failed',
      delegationFailure: 'delegation_abandoned',
    });
    expect((await w.executions.get(w.tenantA, plan.executionId)).status).not.toBe('failed');

    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    // Within its lease the attempt that failed the plan still owns its cleanup: nothing closes.
    const within = new Date(Date.parse(failed.updatedAt) - 1).toISOString() as IsoTimestamp;
    expect(await w.delegation.closeAbandoned(runtime, plan.id, { untouchedBefore: within })).toBe(
      false,
    );
    expect((await w.executions.get(w.tenantA, plan.executionId)).status).not.toBe('failed');

    // Once it has passed, the runtime closes the execution, and a second attempt writes nothing.
    const input = { untouchedBefore: failed.updatedAt };
    expect(await w.delegation.closeAbandoned(runtime, plan.id, input)).toBe(true);
    expect((await w.executions.get(w.tenantA, plan.executionId)).status).toBe('failed');
    expect(await w.delegation.closeAbandoned(runtime, plan.id, input)).toBe(false);
    expect(executionClosed(w, plan.executionId)).toEqual(['delegation_abandoned']);
    // The plan’s audit is the release’s alone: the recovery writes no plan event.
    expect(closed(w, plan.id)).toEqual([['permission_lost', undefined, 'failed']]);
  });

  it('the recovery closes nothing while a child of the plan has started, and the execution stays open', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const plan = await stoppedPlan(w, 1);
    await failedAsAbandoned(w, plan);
    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    const child = must((await stored(w, plan)).delegations[0]);
    await w.executions.start(w.tenantA, child.executionId);
    const input = { untouchedBefore: LATER().toISOString() as IsoTimestamp };
    expect(await w.delegation.closeAbandoned(runtime, plan.id, input)).toBe(false);
    expect((await w.executions.get(w.tenantA, plan.executionId)).status).not.toBe('failed');
    expect((await w.executions.get(w.tenantA, child.executionId)).status).toBe('running');
    expect(executionClosed(w, plan.executionId)).toEqual([]);
  });

  it('a child that never started does not hold the recovery: the execution closes, and the child stays pending', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const plan = await stoppedPlan(w, 1);
    await failedAsAbandoned(w, plan);
    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    const child = must((await stored(w, plan)).delegations[0]);
    const input = { untouchedBefore: LATER().toISOString() as IsoTimestamp };
    expect(await w.delegation.closeAbandoned(runtime, plan.id, input)).toBe(true);
    expect((await w.executions.get(w.tenantA, plan.executionId)).status).toBe('failed');
    expect((await w.executions.get(w.tenantA, child.executionId)).status).toBe('pending');
  });

  it('a child waiting for approval holds the recovery too, as it may resume from running', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const plan = await stoppedPlan(w, 1);
    await failedAsAbandoned(w, plan);
    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    const child = must((await stored(w, plan)).delegations[0]);
    await w.executions.start(w.tenantA, child.executionId);
    await w.executions.runtimeChangeStatus(runtime, child.executionId, {
      from: 'running',
      to: 'waiting_approval',
    });
    const input = { untouchedBefore: LATER().toISOString() as IsoTimestamp };
    expect(await w.delegation.closeAbandoned(runtime, plan.id, input)).toBe(false);
    expect((await w.executions.get(w.tenantA, plan.executionId)).status).not.toBe('failed');
    expect((await w.executions.get(w.tenantA, child.executionId)).status).toBe('waiting_approval');
  });

  it('a plan that failed for another cause is never closed by the runtime: its cleanup stays with closeFailed', async () => {
    const w = await world();
    const plan = await stoppedPlan(w);
    await w.planRepository.update(w.orgA, plan.id, (current) => ({
      plan: failDelegation(
        current,
        'delegation_conflict',
        new Date().toISOString() as IsoTimestamp,
      ),
      events: [],
    }));
    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    const input = { untouchedBefore: LATER().toISOString() as IsoTimestamp };
    expect(await w.delegation.closeAbandoned(runtime, plan.id, input)).toBe(false);
    expect((await w.executions.get(w.tenantA, plan.executionId)).status).not.toBe('failed');

    await w.delegation.closeFailed(w.tenantA, plan.id);
    expect((await w.executions.get(w.tenantA, plan.executionId)).status).toBe('failed');
  });

  it('a person never closes an abandoned plan through this path, and another member’s runtime finds none of it', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const plan = await stoppedPlan(w);
    await setRole(w, 'member');
    await crashedRelease(w, plan);
    const input = { untouchedBefore: (await stored(w, plan)).updatedAt };
    expect(await codeOf(w.delegation.closeAbandoned(w.tenantA, plan.id, input))).toBe(
      'permission_denied',
    );
    // Bob is a member of Alice’s organization, and may not plan either: the plan is not his to close.
    const bobs = must(await w.tenancy.findMembership(w.orgB, BOB));
    w.tenancy.put({
      ...bobs,
      id: membershipIdOf(w.orgA, BOB),
      organizationId: w.orgA,
      role: 'member',
    });
    const bob = await resolveRuntimeTenant(BOB, w.orgA, w.tenancy);
    expect(await w.delegation.closeAbandoned(bob, plan.id, input)).toBe(false);
    // Another organization’s runtime finds none of the plans.
    const other = await resolveRuntimeTenant(BOB, w.orgB, w.tenancy);
    expect(await codeOf(w.delegation.closeAbandoned(other, plan.id, input))).toBe('plan_not_found');
    expect((await w.executions.get(w.tenantA, plan.executionId)).status).not.toBe('failed');
    expect(executionClosed(w, plan.executionId)).toEqual([]);
  });

  it('concurrent recoveries close the execution once: one writes, and the others find it closed', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const plan = await stoppedPlan(w);
    await setRole(w, 'member');
    await crashedRelease(w, plan);
    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    const input = { untouchedBefore: (await stored(w, plan)).updatedAt };
    const results = await Promise.all(
      [1, 2, 3].map(() => w.delegation.closeAbandoned(runtime, plan.id, input)),
    );
    expect(results.filter((closedNow) => closedNow)).toHaveLength(1);
    expect(executionClosed(w, plan.executionId)).toEqual(['delegation_abandoned']);
  });

  it('the store reads the abandoned plans a page at a time, by id, and no plan of another kind', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const plans = await stoppedPlans(w, 3);
    const [creating, first, second] = [must(plans[0]), must(plans[1]), must(plans[2])];
    await setRole(w, 'member');
    await crashedRelease(w, first);
    await crashedRelease(w, second);
    const ids: string[] = [];
    let after: PlanId | undefined;
    do {
      const page = await w.planRepository.abandonedPage(
        after === undefined ? { limit: 1 } : { limit: 1, after },
      );
      ids.push(...page.plans.map((p) => p.id));
      after = page.next;
    } while (after !== undefined);
    expect(ids).toEqual([first.id, second.id].sort());
    expect(ids).not.toContain(creating.id);
  });
});

describe('Sweep of abandoned plans’ executions (ADR-0187, decision 8)', () => {
  it('the sweep closes the open execution of every plan a crashed release left, page by page, and a second run closes nothing', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const plans = await stoppedPlans(w, 3);
    await setRole(w, 'member');
    for (const plan of plans) await crashedRelease(w, plan);
    const sweep = abandonedSweep(w, { limit: 1 });
    expect(await sweep.recover()).toBe(3);
    for (const plan of plans) {
      expect((await w.executions.get(w.tenantA, plan.executionId)).status).toBe('failed');
      expect(executionClosed(w, plan.executionId)).toEqual(['delegation_abandoned']);
    }
    expect(await sweep.recover()).toBe(0);
  });

  it('the sweep leaves a plan failed within its lease, and a plan whose creator left, as they are', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const recent = await stoppedPlan(w);
    await setRole(w, 'member');
    await crashedRelease(w, recent);
    expect(await abandonedSweep(w, { now: () => new Date() }).recover()).toBe(0);
    expect((await w.executions.get(w.tenantA, recent.executionId)).status).not.toBe('failed');

    await leave(w);
    expect(await abandonedSweep(w).recover()).toBe(0);
    expect((await w.executions.get(w.tenantA, recent.executionId)).status).not.toBe('failed');
  });

  it('the sweep does not offer a plan within its lease to the conductor at all', async () => {
    const w = await world({ roles: WITHOUT_PLANNING });
    const recent = await stoppedPlan(w);
    await setRole(w, 'member');
    await crashedRelease(w, recent);
    const offered: string[] = [];
    const sweep = createAbandonedRecovery({
      plans: w.planRepository,
      conductor: {
        closeAbandoned: (tenant, planId, input) => {
          offered.push(planId);
          return w.delegation.closeAbandoned(tenant, planId, input);
        },
      },
      tenancy: w.tenancy,
      leaseMs: LEASE_MS,
      now: () => new Date(),
    });
    expect(await sweep.recover()).toBe(0);
    expect(offered).toEqual([]);
    expect((await w.executions.get(w.tenantA, recent.executionId)).status).not.toBe('failed');
  });
});
