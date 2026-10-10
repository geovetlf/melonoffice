import type { IsoTimestamp, Plan, WorkflowId } from '@melonoffice/domain';
import { ExecutionError, type ExecutionService } from '@melonoffice/execution';
import { describe, expect, it } from 'vitest';
import { createDelegation, type Delegation } from './delegation.js';
import { isPlanningError } from './errors.js';
import { failDelegation } from './model.js';
import type { AbandonScheduled } from './service.js';
import { ALICE, must, proposal, specialistStep, world, type World } from './testkit.js';

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
