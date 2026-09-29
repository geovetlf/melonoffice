import type { ExecutionId, Plan, PlanDecisionCondition } from '@melonoffice/domain';
import type { TenantContext } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import {
  CONDITION_CHECK,
  createPlanConductor,
  planStepOf,
  STEP_CHECK,
  unrunnableStepOf,
  type ConditionEvaluator,
} from './conductor.js';
import { isPlanningError } from './errors.js';
import { ALICE, must, proposal, specialistStep, toolStep, world, type World } from './testkit.js';

/**
 * The plan conductor (WF-1, ADR-0070): a plan a person approved runs its specialist steps in
 * order, each as its own child execution, and closes once every step completed or one stopped.
 */

const codeOf = async (work: Promise<unknown>): Promise<string> => {
  try {
    await work;
  } catch (error) {
    if (isPlanningError(error)) return error.code;
    throw error;
  }
  return 'accepted';
};

/** A condition step the Decision Engine decides (WF-4). */
const conditionStep = (
  id: string,
  dependsOn: string[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  kind: 'condition',
  label: `Check ${id}`,
  dependsOn,
  decision: {
    decision: 'action.policy_check',
    continueOn: ['allowed'],
    input: { action: 'opportunity.offer_discount', proposer: 'agent', discountPercent: 10 },
  },
  ...overrides,
});

type Outcome = Awaited<ReturnType<ConditionEvaluator['evaluate']>>;

/** A Decision Engine stand-in: answers in order, and records what it was asked and as whom. */
function evaluator(...answers: (Outcome | Error)[]) {
  const asked: { actor: string; condition: PlanDecisionCondition; requestId?: string }[] = [];
  const conditions: ConditionEvaluator = {
    async evaluate(tenant, condition, requestId) {
      asked.push({
        actor: tenant.actor,
        condition,
        ...(requestId === undefined ? {} : { requestId }),
      });
      const next = answers.length > 1 ? answers.shift() : answers[0];
      if (next === undefined) throw new Error('no answer');
      if (next instanceof Error) throw next;
      return next;
    },
  };
  return { asked, conditions };
}

const DECISION_ID = `dec_${'a'.repeat(32)}`;
const decided = (result: 'continue' | 'stop' | 'await_approval', outcome = 'allowed'): Outcome => ({
  result,
  decision: { id: DECISION_ID, type: 'action.policy_check', version: 1, outcome },
});

async function setup(
  steps?: (s: Awaited<ReturnType<World['seed']>>) => Record<string, unknown>[],
  conditions?: ConditionEvaluator,
) {
  const w = await world();
  const owner = await w.seed(w.orgA, ALICE, { type: 'leadership', role: 'chief_of_staff' });
  const researcher = await w.seed(w.orgA, ALICE, { toolIds: ['lookup'] });
  const execution = await w.planning(w.tenantA, owner);
  const outcome = await w.plans.propose(w.tenantA, {
    executionId: execution.id,
    proposal: proposal(
      steps?.(researcher) ?? [
        specialistStep('research', researcher, { approvalRequired: true }),
        specialistStep('report', researcher, { dependsOn: ['research'] }),
        specialistStep('summary', researcher, { dependsOn: ['research'] }),
      ],
    ),
    source: {
      kind: 'planner',
      model: { provider: 'alpha', id: 'alpha-large', version: 'v' },
      policy: { id: 'default_model', version: 1 },
    },
  });
  if (outcome.status !== 'planned') throw new Error(`refused: ${outcome.reason}`);
  const planned = outcome.plan;

  /** What the starter was asked to start, and as whom. */
  const started: { actor: string; id: ExecutionId }[] = [];
  const conductor = createPlanConductor({
    plans: w.planRepository,
    delegation: w.delegation,
    executions: w.executions,
    starter: {
      async start(tenant: TenantContext, id: ExecutionId) {
        started.push({ actor: tenant.actor, id });
        if (tenant.actor === 'runtime') await w.executions.runtimeStart(tenant, id);
        else await w.executions.start(tenant, id);
      },
    },
    ...(conditions === undefined ? {} : { conditions }),
    requestId: 'plan-conductor-test',
    now: () => new Date('2026-09-27T12:00:00Z'),
  });

  const stored = async (): Promise<Plan> => must(await w.planRepository.find(w.orgA, planned.id));
  const childOf = async (stepId: string): Promise<ExecutionId> =>
    must((await stored()).delegations.find((d) => d.stepId === stepId)).executionId;

  async function approve(): Promise<Plan> {
    const version = must(await w.planRepository.findVersion(w.orgA, planned.id, planned.version));
    return w.plans.approve(w.tenantA, planned.id, {
      version: version.version,
      digest: version.digest,
    });
  }

  /** The runtime finishes a started step: its agent node, verification, completion. */
  async function complete(stepId: string): Promise<void> {
    const id = await childOf(stepId);
    const t = w.runtimeA;
    await w.executions.runtimeChangeNode(t, id, { nodeId: stepId, from: 'pending', to: 'running' });
    await w.executions.runtimeChangeNode(t, id, {
      nodeId: stepId,
      from: 'running',
      to: 'completed',
      output: { type: 'agent_output', id: `${id}:${stepId}` },
    });
    await w.executions.runtimeChangeStatus(t, id, { from: 'running', to: 'verifying' });
    await w.executions.recordVerification(t, id, {
      correlationId: 'v',
      nodes: [
        {
          nodeId: stepId,
          policy: 'output_schema',
          checks: [
            { code: 'agent_answer_valid', result: 'passed', evidence: { type: 'x', id: 'y' } },
          ],
        },
      ],
    });
    await w.executions.runtimeChangeStatus(t, id, { from: 'verifying', to: 'completed' });
  }

  async function fail(stepId: string): Promise<void> {
    const id = await childOf(stepId);
    await w.executions.runtimeChangeStatus(w.runtimeA, id, {
      from: 'running',
      to: 'failed',
      failure: { code: 'input_unavailable' },
    });
  }

  const status = async (id: ExecutionId) => (await w.executions.get(w.tenantA, id)).status;

  return { w, planned, conductor, started, stored, childOf, approve, complete, fail, status };
}

describe('plan conductor (WF-1)', () => {
  it('runs an approved plan step by step and closes it once every step completed', async () => {
    const t = await setup();
    await t.approve();
    const running = await t.conductor.run(t.w.tenantA, t.planned.id);
    expect(running.status).toBe('executing');
    // Only the first step starts, as the person who approved.
    const research = await t.childOf('research');
    expect(t.started).toEqual([{ actor: 'user', id: research }]);
    expect(await t.status(research)).toBe('running');
    expect(await t.status(await t.childOf('report'))).toBe('pending');

    await t.complete('research');
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    // Both steps that waited on it start, as the runtime of the same person.
    expect(t.started.slice(1)).toEqual([
      { actor: 'runtime', id: await t.childOf('report') },
      { actor: 'runtime', id: await t.childOf('summary') },
    ]);
    const parent = await t.w.executions.get(t.w.tenantA, t.planned.executionId);
    expect(parent.nodes.find((n) => n.id === 'research')).toMatchObject({
      status: 'completed',
      output: { type: 'execution', id: research },
    });
    expect(parent.nodes.find((n) => n.id === 'report')?.status).toBe('running');

    await t.complete('report');
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect((await t.stored()).status).toBe('executing');
    await t.complete('summary');
    const closed = await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(closed.status).toBe('completed');

    const done = await t.w.executions.get(t.w.tenantA, t.planned.executionId);
    expect(done.status).toBe('completed');
    expect(done.verification?.result).toBe('passed');
    expect(done.verification?.nodes.map((n) => n.checks[0]?.code)).toEqual([
      STEP_CHECK,
      STEP_CHECK,
      STEP_CHECK,
    ]);
    const changes = t.w.events('plan.state_changed').map((e) => e.transition);
    expect(changes.at(-1)).toEqual({ from: 'executing', to: 'completed' });
    // Nothing more to do: advancing again changes nothing and starts nothing.
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(t.started).toHaveLength(3);
    expect(t.w.events('plan.state_changed')).toHaveLength(changes.length);
  });

  it('stops the plan when a step fails, and starts nothing after it', async () => {
    const t = await setup();
    await t.approve();
    await t.conductor.run(t.w.tenantA, t.planned.id);
    await t.fail('research');
    const stopped = await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(stopped.status).toBe('failed');
    expect(t.started).toHaveLength(1);
    const parent = await t.w.executions.get(t.w.tenantA, t.planned.executionId);
    expect(parent.status).toBe('failed');
    expect(parent.failure?.code).toBe('step_failed');
    expect(t.w.events('plan.state_changed').at(-1)).toMatchObject({
      transition: { from: 'executing', to: 'failed' },
      reason: 'step_failed',
    });
    // The steps that never started stay pending: nothing runs them.
    expect(await t.status(await t.childOf('report'))).toBe('pending');
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(t.started).toHaveLength(1);
  });

  it('starts nothing after the person cancelled the plan', async () => {
    const t = await setup();
    await t.approve();
    await t.conductor.run(t.w.tenantA, t.planned.id);
    await t.complete('research');
    await t.w.executions.cancel(t.w.tenantA, t.planned.executionId, 'director_request');
    const after = await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(after.status).toBe('cancelled');
    expect(t.started).toHaveLength(1);
    expect(await t.status(await t.childOf('report'))).toBe('cancelled');
  });

  it('is safe to call again: running twice starts each step once', async () => {
    const t = await setup();
    await t.approve();
    await t.conductor.run(t.w.tenantA, t.planned.id);
    await t.conductor.run(t.w.tenantA, t.planned.id);
    await t.complete('research');
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    const starts = t.w
      .events('execution.state_changed')
      .filter((e) => e.transition?.to === 'running' && e.target?.id !== t.planned.executionId);
    expect(starts).toHaveLength(3);
  });

  it('runs only what a person approved, only for that person, and only the runtime advances', async () => {
    const t = await setup();
    // Not approved yet: nothing is delegated.
    expect(await codeOf(t.conductor.run(t.w.tenantA, t.planned.id))).toBe(
      'invalid_plan_transition',
    );
    await t.approve();
    expect(await codeOf(t.conductor.run(t.w.giaA, t.planned.id))).toBe('permission_denied');
    expect(await codeOf(t.conductor.run(t.w.runtimeA, t.planned.id))).toBe('permission_denied');
    expect(await codeOf(t.conductor.advance(t.w.tenantA, t.planned.id))).toBe('permission_denied');
    // Another organization's plan is not found.
    expect(await codeOf(t.conductor.run(t.w.tenantB, t.planned.id))).toBe('plan_not_found');
    expect(t.started).toEqual([]);
    expect((await t.stored()).delegationState).toBeUndefined();
  });

  it('refuses a plan with any step it cannot run yet, before anything is delegated', async () => {
    const t = await setup((researcher) => [
      specialistStep('research', researcher, { approvalRequired: true }),
      toolStep('search', 'research', 'lookup'),
    ]);
    const version = must(
      await t.w.planRepository.findVersion(t.w.orgA, t.planned.id, t.planned.version),
    );
    expect(unrunnableStepOf(version)).toBe('tool');
    await t.approve();
    expect(await codeOf(t.conductor.run(t.w.tenantA, t.planned.id))).toBe('plan_not_runnable');
    expect((await t.stored()).delegationState).toBeUndefined();
    expect(t.started).toEqual([]);
  });

  it('names the plan step of a child execution, and nothing else', async () => {
    const t = await setup();
    await t.approve();
    await t.conductor.run(t.w.tenantA, t.planned.id);
    const child = await t.w.executions.get(t.w.tenantA, await t.childOf('report'));
    expect(planStepOf(child)).toEqual({ planId: t.planned.id, stepId: 'report' });
    const parent = await t.w.executions.get(t.w.tenantA, t.planned.executionId);
    expect(planStepOf(parent)).toBeUndefined();
    expect(planStepOf({ ...child, input: { type: 'plan_step', id: 'x:y:z' } })).toBeUndefined();
    const orphan: Record<string, unknown> = { ...child };
    delete orphan.parentExecutionId;
    expect(planStepOf(orphan as unknown as typeof child)).toBeUndefined();
  });
});

describe('plan conditions (WF-4)', () => {
  const gated = (researcher: Awaited<ReturnType<World['seed']>>) => [
    specialistStep('research', researcher, { approvalRequired: true }),
    conditionStep('gate', ['research']),
    specialistStep('offer', researcher, { dependsOn: ['gate'] }),
    specialistStep('summary', researcher, { dependsOn: ['research'] }),
  ];

  it('decides a condition once its steps completed, and runs what follows it', async () => {
    const e = evaluator(decided('continue'));
    const t = await setup(gated, e.conditions);
    await t.approve();
    await t.conductor.run(t.w.tenantA, t.planned.id);
    // Nothing is decided while the steps before the condition run.
    expect(e.asked).toEqual([]);
    await t.complete('research');
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    // Decided as the runtime of the person the plan runs for, with the plan's own input.
    expect(e.asked).toEqual([
      {
        actor: 'runtime',
        condition: {
          decision: 'action.policy_check',
          continueOn: ['allowed'],
          input: { action: 'opportunity.offer_discount', proposer: 'agent', discountPercent: 10 },
        },
        requestId: 'plan-conductor-test',
      },
    ]);
    expect((await t.stored()).conditions).toEqual([
      {
        stepId: 'gate',
        result: 'continue',
        decision: { id: DECISION_ID, type: 'action.policy_check', version: 1, outcome: 'allowed' },
        evaluatedAt: expect.any(String),
      },
    ]);
    expect(t.w.events('plan.condition_evaluated')).toEqual([
      expect.objectContaining({
        result: 'success',
        nodeId: 'gate',
        reason: 'continue',
        reference: DECISION_ID,
        target: { type: 'plan', id: t.planned.id },
      }),
    ]);
    expect(t.started.slice(1).map((s) => s.id)).toEqual([
      await t.childOf('summary'),
      await t.childOf('offer'),
    ]);
    const parent = await t.w.executions.get(t.w.tenantA, t.planned.executionId);
    expect(parent.nodes.find((n) => n.id === 'gate')).toMatchObject({
      status: 'completed',
      output: { type: 'decision', id: DECISION_ID },
    });

    await t.complete('offer');
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    await t.complete('summary');
    const closed = await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(closed.status).toBe('completed');
    const done = await t.w.executions.get(t.w.tenantA, t.planned.executionId);
    expect(done.verification?.nodes.map((n) => [n.nodeId, n.checks[0]?.code])).toEqual([
      ['research', STEP_CHECK],
      ['gate', CONDITION_CHECK],
      ['summary', STEP_CHECK],
      ['offer', STEP_CHECK],
    ]);
    // Decided once: advancing again asks nothing.
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(e.asked).toHaveLength(1);
  });

  it('skips what follows a condition that stops, and the rest of the plan goes on', async () => {
    const e = evaluator(decided('stop', 'not_allowed'));
    const t = await setup(gated, e.conditions);
    await t.approve();
    await t.conductor.run(t.w.tenantA, t.planned.id);
    await t.complete('research');
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(t.started.slice(1).map((s) => s.id)).toEqual([await t.childOf('summary')]);
    let parent = await t.w.executions.get(t.w.tenantA, t.planned.executionId);
    expect(parent.nodes.find((n) => n.id === 'gate')?.status).toBe('completed');
    expect(parent.nodes.find((n) => n.id === 'offer')?.status).toBe('skipped');
    // The skipped step's child never starts.
    expect(await t.status(await t.childOf('offer'))).toBe('pending');

    await t.complete('summary');
    const closed = await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(closed.status).toBe('completed');
    parent = await t.w.executions.get(t.w.tenantA, t.planned.executionId);
    expect(parent.status).toBe('completed');
    expect(parent.verification?.nodes.map((n) => n.nodeId)).toEqual([
      'research',
      'gate',
      'summary',
    ]);
    expect(await t.status(await t.childOf('offer'))).toBe('pending');
    expect(t.w.events('plan.condition_evaluated')[0]).toMatchObject({ reason: 'stop' });
  });

  it('skips every step after a skipped one, and completes a plan that stopped at its last condition', async () => {
    const e = evaluator(decided('stop', 'not_allowed'));
    const t = await setup(
      (researcher) => [
        specialistStep('research', researcher, { approvalRequired: true }),
        conditionStep('gate', ['research']),
        specialistStep('offer', researcher, { dependsOn: ['gate'] }),
        conditionStep('second', ['offer']),
        specialistStep('follow', researcher, { dependsOn: ['second'] }),
      ],
      e.conditions,
    );
    await t.approve();
    await t.conductor.run(t.w.tenantA, t.planned.id);
    await t.complete('research');
    const closed = await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(closed.status).toBe('completed');
    // Only the first condition was decided: the second one was skipped, never asked.
    expect(e.asked).toHaveLength(1);
    const parent = await t.w.executions.get(t.w.tenantA, t.planned.executionId);
    expect(parent.nodes.map((n) => [n.id, n.status])).toEqual([
      ['research', 'completed'],
      ['gate', 'completed'],
      ['offer', 'skipped'],
      ['second', 'skipped'],
      ['follow', 'skipped'],
    ]);
  });

  it('stops the plan when a decision needs an approval, and starts nothing after it', async () => {
    const e = evaluator(decided('await_approval', 'approval_required'));
    const t = await setup(gated, e.conditions);
    await t.approve();
    await t.conductor.run(t.w.tenantA, t.planned.id);
    await t.complete('research');
    const stopped = await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(stopped.status).toBe('failed');
    expect(t.started).toHaveLength(1);
    const parent = await t.w.executions.get(t.w.tenantA, t.planned.executionId);
    expect(parent.failure?.code).toBe('condition_needs_approval');
    expect(t.w.events('plan.state_changed').at(-1)).toMatchObject({
      reason: 'condition_needs_approval',
    });
    expect((await t.stored()).conditions?.[0]).toMatchObject({ result: 'await_approval' });
  });

  it('stops the plan when the decision cannot be made, and when nothing decides conditions', async () => {
    const refused = evaluator({ result: 'failed', failure: 'condition_permission_denied' });
    const t = await setup(gated, refused.conditions);
    await t.approve();
    await t.conductor.run(t.w.tenantA, t.planned.id);
    await t.complete('research');
    expect((await t.conductor.advance(t.w.runtimeA, t.planned.id)).status).toBe('failed');
    expect((await t.stored()).conditions?.[0]).toMatchObject({
      result: 'failed',
      failure: 'condition_permission_denied',
    });
    expect(t.w.events('plan.condition_evaluated')[0]).toMatchObject({
      reason: 'condition_permission_denied',
    });
    expect((await t.w.executions.get(t.w.tenantA, t.planned.executionId)).failure?.code).toBe(
      'condition_failed',
    );

    const none = await setup(gated);
    await none.approve();
    await none.conductor.run(none.w.tenantA, none.planned.id);
    await none.complete('research');
    expect((await none.conductor.advance(none.w.runtimeA, none.planned.id)).status).toBe('failed');
    expect((await none.stored()).conditions?.[0]).toMatchObject({
      failure: 'condition_not_configured',
    });
  });

  it('leaves a condition undecided when its decision could not be read, to decide it next time', async () => {
    const e = evaluator(new Error('unavailable'), decided('continue'));
    const t = await setup(gated, e.conditions);
    await t.approve();
    await t.conductor.run(t.w.tenantA, t.planned.id);
    await t.complete('research');
    await expect(t.conductor.advance(t.w.runtimeA, t.planned.id)).rejects.toThrow('unavailable');
    expect((await t.stored()).conditions).toBeUndefined();
    expect(t.started).toHaveLength(1);
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect((await t.stored()).conditions?.[0]?.result).toBe('continue');
    expect(t.started).toHaveLength(3);
  });

  it('refuses a condition on how a step ended, and one that waits on no step', async () => {
    const outcome = await setup((researcher) => [
      specialistStep('research', researcher, { approvalRequired: true }),
      {
        id: 'gate',
        kind: 'condition',
        label: 'Check gate',
        dependsOn: ['research'],
        condition: { step: 'research', outcome: 'completed' },
      },
    ]);
    const version = must(
      await outcome.w.planRepository.findVersion(
        outcome.w.orgA,
        outcome.planned.id,
        outcome.planned.version,
      ),
    );
    expect(unrunnableStepOf(version)).toBe('condition');
    await outcome.approve();
    expect(await codeOf(outcome.conductor.run(outcome.w.tenantA, outcome.planned.id))).toBe(
      'plan_not_runnable',
    );
    // A decision condition with no step before it is refused when the plan is made.
    await expect(
      setup((researcher) => [
        conditionStep('gate', []),
        specialistStep('research', researcher, { dependsOn: ['gate'] }),
      ]),
    ).rejects.toThrow('refused');
  });
});
