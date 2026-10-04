import type { ExecutionId, Plan, PlanDecisionCondition } from '@melonoffice/domain';
import type { TenantContext } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import {
  CONDITION_CHECK,
  createPlanConductor,
  planStepOf,
  STEP_CHECK,
  unrunnableStepOf,
  WAIT_CHECK,
  type ConditionEvaluator,
  type PlanConductorOptions,
  type PlanWakeups,
  type StepApprovalAsk,
  type StepApprovals,
  type StepApprovalState,
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
  approvals?: StepApprovals,
  extra: Partial<PlanConductorOptions> = {},
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
    ...(approvals === undefined ? {} : { approvals }),
    requestId: 'plan-conductor-test',
    now: () => new Date('2026-09-27T12:00:00Z'),
    ...extra,
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
      { id: 'sign_off', kind: 'approval', label: 'Sign off', dependsOn: ['research'] },
    ]);
    const version = must(
      await t.w.planRepository.findVersion(t.w.orgA, t.planned.id, t.planned.version),
    );
    expect(unrunnableStepOf(version)).toBe('approval');
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

/** The approvals system stand-in: records what was asked, and answers what a test set. */
function stepApprovals() {
  const asked: { actor: string; ask: StepApprovalAsk; id: string }[] = [];
  const states = new Map<string, StepApprovalState>();
  const cancelled: { id: string; reason: string }[] = [];
  const port: StepApprovals = {
    async request(tenant, ask) {
      const id = `00000000-0000-4000-8000-${String(asked.length + 1).padStart(12, '0')}`;
      asked.push({ actor: tenant.actor, ask, id });
      states.set(id, { status: 'pending' });
      return id;
    },
    async state(_tenant, id) {
      const found = states.get(id);
      if (found === undefined) throw new Error('unknown approval');
      return found;
    },
    async cancel(_tenant, id, reason) {
      cancelled.push({ id, reason });
      states.set(id, { status: 'declined', reason: 'cancelled' });
    },
  };
  const idOf = (stepId: string): string =>
    must(asked.find((a) => (a.ask.tool?.stepId ?? a.ask.stepId) === stepId)).id;
  const set = (stepId: string, state: StepApprovalState) => states.set(idOf(stepId), state);
  return { port, asked, cancelled, set, idOf };
}

describe('step approvals inside a running plan (ADR-0146)', () => {
  // research → offer (waits for a person) → send; research → summary; final waits on both.
  const branches = (researcher: Awaited<ReturnType<World['seed']>>) => [
    specialistStep('research', researcher),
    specialistStep('offer', researcher, { dependsOn: ['research'], approvalRequired: true }),
    specialistStep('send', researcher, { dependsOn: ['offer'] }),
    specialistStep('summary', researcher, { dependsOn: ['research'] }),
    specialistStep('final', researcher, { dependsOn: ['send', 'summary'] }),
  ];

  async function ready(a = stepApprovals()) {
    const t = await setup(branches, undefined, a.port);
    await t.approve();
    await t.conductor.run(t.w.tenantA, t.planned.id);
    await t.complete('research');
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    return { ...t, a };
  }

  it('1. asks once when the step is ready, waits, and the branch goes on once approved', async () => {
    const t = await ready();
    // The step waits; the independent branch started.
    expect(await t.status(await t.childOf('offer'))).toBe('pending');
    expect(t.started.slice(1).map((s) => s.id)).toEqual([await t.childOf('summary')]);
    // Asked as the runtime of the plan's person, bound to this plan version, step and child.
    const version = must(
      await t.w.planRepository.findVersion(t.w.orgA, t.planned.id, t.planned.version),
    );
    expect(t.a.asked).toEqual([
      {
        actor: 'runtime',
        id: t.a.idOf('offer'),
        ask: expect.objectContaining({
          organizationId: t.w.orgA,
          planId: t.planned.id,
          planVersion: version.version,
          planDigest: version.digest,
          executionId: t.planned.executionId,
          stepId: 'offer',
          childExecutionId: await t.childOf('offer'),
          riskLevel: version.riskLevel,
        }),
      },
    ]);
    expect((await t.stored()).stepApprovals).toEqual([
      { stepId: 'offer', approvalId: t.a.idOf('offer'), requestedAt: expect.any(String) },
    ]);
    expect(t.w.events('plan.step_approval_requested')).toEqual([
      expect.objectContaining({
        result: 'success',
        nodeId: 'offer',
        reference: t.a.idOf('offer'),
        target: { type: 'plan', id: t.planned.id },
      }),
    ]);
    // Advancing while it waits asks nothing again and starts nothing.
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(t.a.asked).toHaveLength(1);
    expect(await t.status(await t.childOf('offer'))).toBe('pending');

    // 10. Once approved, the next advance resumes the plan where it waited.
    t.a.set('offer', { status: 'approved' });
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(await t.status(await t.childOf('offer'))).toBe('running');
    await t.complete('offer');
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    await t.complete('summary');
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    await t.complete('send');
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    await t.complete('final');
    const closed = await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(closed.status).toBe('completed');
    expect(t.w.events('plan.step_declined')).toEqual([]);
  });

  it('2–3, 6. a rejection skips the step and every step after it; the other branch finishes', async () => {
    const t = await ready();
    t.a.set('offer', { status: 'declined', reason: 'rejected' });
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    // The decline is recorded once on the plan and in the audit log.
    expect((await t.stored()).stepApprovals?.[0]?.declined).toEqual({
      reason: 'rejected',
      at: expect.any(String),
    });
    expect(t.w.events('plan.step_declined')).toEqual([
      expect.objectContaining({ nodeId: 'offer', reason: 'rejected', result: 'success' }),
    ]);
    const parent = await t.w.executions.get(t.w.tenantA, t.planned.executionId);
    // `final` depends on the declined branch and on `summary`: it is skipped too.
    for (const id of ['offer', 'send', 'final']) {
      expect(parent.nodes.find((n) => n.id === id)?.status, id).toBe('skipped');
      expect(await t.status(await t.childOf(id)), id).toBe('pending');
    }
    // The independent branch goes on and the plan completes, not failed.
    await t.complete('summary');
    const closed = await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(closed.status).toBe('completed');
    const done = await t.w.executions.get(t.w.tenantA, t.planned.executionId);
    expect(done.status).toBe('completed');
    expect(done.verification?.nodes.map((n) => n.nodeId)).toEqual(['research', 'summary']);
    // Recorded once: advancing again changes nothing.
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(t.w.events('plan.step_declined')).toHaveLength(1);
  });

  it('4. an expired approval is a decline: its branch is skipped, the rest goes on', async () => {
    const t = await ready();
    t.a.set('offer', { status: 'declined', reason: 'expired' });
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(t.w.events('plan.step_declined')[0]).toMatchObject({ reason: 'expired' });
    await t.complete('summary');
    expect((await t.conductor.advance(t.w.runtimeA, t.planned.id)).status).toBe('completed');
  });

  it('5. several branches each wait for their own approval, decided apart', async () => {
    const a = stepApprovals();
    const t = await setup(
      (r) => [
        specialistStep('research', r),
        specialistStep('left', r, { dependsOn: ['research'], approvalRequired: true }),
        specialistStep('right', r, { dependsOn: ['research'], approvalRequired: true }),
        specialistStep('after_left', r, { dependsOn: ['left'] }),
      ],
      undefined,
      a.port,
    );
    await t.approve();
    await t.conductor.run(t.w.tenantA, t.planned.id);
    await t.complete('research');
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(a.asked.map((x) => x.ask.stepId)).toEqual(['left', 'right']);
    a.set('left', { status: 'approved' });
    a.set('right', { status: 'declined', reason: 'rejected' });
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(await t.status(await t.childOf('left'))).toBe('running');
    expect(await t.status(await t.childOf('right'))).toBe('pending');
    await t.complete('left');
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    await t.complete('after_left');
    const closed = await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(closed.status).toBe('completed');
  });

  it('a first step is covered by the plan approval itself and asks nothing more', async () => {
    const a = stepApprovals();
    const t = await setup(undefined, undefined, a.port);
    await t.approve();
    await t.conductor.run(t.w.tenantA, t.planned.id);
    expect(t.started.map((s) => s.id)).toEqual([await t.childOf('research')]);
    expect(a.asked).toEqual([]);
  });

  it('never runs a step unapproved: without approvals it fails once ready, and a failed plan withdraws what waits', async () => {
    const t = await setup(branches);
    await t.approve();
    await t.conductor.run(t.w.tenantA, t.planned.id);
    await t.complete('research');
    const stopped = await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(stopped.status).toBe('failed');
    expect(await t.status(await t.childOf('offer'))).toBe('pending');
    expect(t.w.events('plan.state_changed').at(-1)).toMatchObject({
      reason: 'step_approval_not_configured',
    });

    const w = await ready();
    await w.fail('summary');
    expect((await w.conductor.advance(w.w.runtimeA, w.planned.id)).status).toBe('failed');
    expect(w.a.cancelled).toEqual([{ id: w.a.idOf('offer'), reason: 'plan_ended' }]);
  });
});

describe('tool steps inside a running plan (ADR-0151)', () => {
  const INPUT = { query: 'melon prices' };

  it('runs a tool step inside its specialist step, with the input fixed in the plan', async () => {
    const a = stepApprovals();
    const t = await setup(
      (researcher) => [
        // A first step asking for approval is covered by the plan's own approval (ADR-0146).
        specialistStep('research', researcher, { approvalRequired: true }),
        toolStep('search', 'research', 'lookup', { input: INPUT }),
      ],
      undefined,
      a.port,
    );
    const version = must(
      await t.w.planRepository.findVersion(t.w.orgA, t.planned.id, t.planned.version),
    );
    expect(unrunnableStepOf(version)).toBeUndefined();
    expect(must(version.steps.find((s) => s.id === 'search')).input).toEqual(INPUT);
    await t.approve();
    await t.conductor.run(t.w.tenantA, t.planned.id);
    // Its tool needs no approval: the step starts at once, and nobody is asked.
    const research = await t.childOf('research');
    expect(t.started).toEqual([{ actor: 'user', id: research }]);
    expect(a.asked).toEqual([]);
    const child = await t.w.executions.get(t.w.tenantA, research);
    expect(child.nodes.map((n) => [n.id, n.type])).toEqual([
      ['research', 'agent'],
      ['search', 'tool'],
    ]);
    expect(child.nodes.find((n) => n.id === 'search')?.approvalId).toBeUndefined();
  });

  it('asks for a tool step’s approval before its step starts, then attaches it and starts', async () => {
    const a = stepApprovals();
    const t = await setup(
      (researcher) => [
        specialistStep('research', researcher),
        toolStep('search', 'research', 'lookup', { input: INPUT, approvalRequired: true }),
      ],
      undefined,
      a.port,
    );
    await t.approve();
    await t.conductor.run(t.w.tenantA, t.planned.id);
    const research = await t.childOf('research');
    // Even a first step: the plan's approval never covers a tool call.
    expect(t.started).toEqual([]);
    expect(a.asked).toHaveLength(1);
    expect(a.asked[0]?.ask).toMatchObject({
      stepId: 'research',
      childExecutionId: research,
      tool: { stepId: 'search', id: 'lookup', version: 1, input: INPUT },
    });
    expect((await t.stored()).stepApprovals).toEqual([
      expect.objectContaining({
        stepId: 'search',
        performedBy: 'research',
        approvalId: a.idOf('search'),
      }),
    ]);
    // Asking again asks nothing new.
    await t.conductor.resume(t.w.runtimeA, t.planned.id);
    expect(a.asked).toHaveLength(1);

    a.set('search', { status: 'approved' });
    await t.conductor.resume(t.w.runtimeA, t.planned.id);
    expect(t.started).toEqual([{ actor: 'runtime', id: research }]);
    const child = await t.w.executions.get(t.w.tenantA, research);
    expect(child.nodes.find((n) => n.id === 'search')?.approvalId).toBe(a.idOf('search'));
    expect(t.w.events('execution.approval_attached')).toEqual([
      expect.objectContaining({ nodeId: 'search', reference: a.idOf('search') }),
    ]);
  });

  it('waits for every approval a step needs: its own and each of its tools', async () => {
    const a = stepApprovals();
    const t = await setup(
      (researcher) => [
        specialistStep('research', researcher),
        specialistStep('offer', researcher, { dependsOn: ['research'], approvalRequired: true }),
        toolStep('search', 'offer', 'lookup', { input: INPUT, approvalRequired: true }),
      ],
      undefined,
      a.port,
    );
    await t.approve();
    await t.conductor.run(t.w.tenantA, t.planned.id);
    await t.complete('research');
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(a.asked.map((x) => x.ask.tool?.stepId ?? x.ask.stepId)).toEqual(['offer', 'search']);
    a.set('offer', { status: 'approved' });
    await t.conductor.resume(t.w.runtimeA, t.planned.id);
    expect(t.started).toHaveLength(1);
    a.set('search', { status: 'approved' });
    await t.conductor.resume(t.w.runtimeA, t.planned.id);
    expect(t.started.at(-1)).toEqual({ actor: 'runtime', id: await t.childOf('offer') });
  });

  it('skips the branch of a step whose tool approval was declined; the plan still completes', async () => {
    const a = stepApprovals();
    const t = await setup(
      (researcher) => [
        specialistStep('research', researcher),
        toolStep('search', 'research', 'lookup', { input: INPUT, approvalRequired: true }),
        specialistStep('report', researcher, { dependsOn: ['research'] }),
        specialistStep('summary', researcher),
      ],
      undefined,
      a.port,
    );
    await t.approve();
    await t.conductor.run(t.w.tenantA, t.planned.id);
    // The independent branch runs; the one with the tool waits for a person.
    expect(t.started).toEqual([{ actor: 'user', id: await t.childOf('summary') }]);
    a.set('search', { status: 'declined', reason: 'rejected' });
    await t.conductor.resume(t.w.runtimeA, t.planned.id);
    const entry = must((await t.stored()).stepApprovals?.find((x) => x.stepId === 'search'));
    expect(entry.declined?.reason).toBe('rejected');
    expect(t.w.events('plan.step_declined')).toEqual([
      expect.objectContaining({ nodeId: 'search', reason: 'rejected' }),
    ]);
    expect(await t.status(await t.childOf('research'))).toBe('pending');
    await t.complete('summary');
    const closed = await t.conductor.advance(t.w.runtimeA, t.planned.id);
    // A declined branch is never a failure of the whole plan.
    expect(closed.status).toBe('completed');
    const parent = await t.w.executions.get(t.w.tenantA, t.planned.executionId);
    expect(parent.nodes.find((n) => n.id === 'research')?.status).toBe('skipped');
    expect(parent.nodes.find((n) => n.id === 'report')?.status).toBe('skipped');
    expect(t.started).toHaveLength(1);
  });
});

describe('wait steps inside a running plan (ADR-0152)', () => {
  const T0 = new Date('2026-09-27T12:00:00Z');
  const wait = (id: string, dependsOn: string[], seconds = 3_600) => ({
    id,
    kind: 'wait',
    label: `Wait ${id}`,
    dependsOn,
    wait: { seconds },
  });
  // research → pause (1 hour) → report; summary beside them.
  const paused = (researcher: Awaited<ReturnType<World['seed']>>) => [
    specialistStep('research', researcher, { approvalRequired: true }),
    wait('pause', ['research']),
    specialistStep('report', researcher, { dependsOn: ['pause'] }),
    specialistStep('summary', researcher),
  ];

  async function ready(withWakeups = true) {
    let clock = T0;
    const woken: { organizationId: string; planId: string; at: string; actor: string }[] = [];
    const wakeups: PlanWakeups = {
      async wake(tenant, plan, at) {
        woken.push({ ...plan, at: at.toISOString(), actor: tenant.actor });
      },
    };
    const t = await setup(paused, undefined, undefined, {
      now: () => clock,
      ...(withWakeups ? { wakeups } : {}),
    });
    await t.approve();
    await t.conductor.run(t.w.tenantA, t.planned.id);
    await t.complete('research');
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    return { ...t, woken, setClock: (at: Date) => void (clock = at) };
  }

  it('waits once the steps before it completed, then the steps after it start', async () => {
    const t = await ready();
    const recorded = (await t.stored()).waits;
    expect(recorded).toEqual([
      { stepId: 'pause', startedAt: T0.toISOString(), until: '2026-09-27T13:00:00.000Z' },
    ]);
    // Woken just after it ends, as the runtime of the plan's person.
    expect(t.woken).toEqual([
      {
        organizationId: t.w.orgA,
        planId: t.planned.id,
        at: '2026-09-27T13:00:01.000Z',
        actor: 'runtime',
      },
    ]);
    expect(t.w.events('plan.wait_started')).toEqual([
      expect.objectContaining({ nodeId: 'pause', reference: '3600s' }),
    ]);
    const report = await t.childOf('report');
    expect(await t.status(report)).toBe('pending');
    let parent = await t.w.executions.get(t.w.tenantA, t.planned.executionId);
    expect(parent.nodes.find((n) => n.id === 'pause')?.status).toBe('running');

    // Looked at again before its time (a step ending, a repeated or early wake-up): nothing.
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(t.woken).toHaveLength(1);
    expect(t.w.events('plan.wait_started')).toHaveLength(1);
    expect(await t.status(report)).toBe('pending');

    t.setClock(new Date('2026-09-27T13:00:01Z'));
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(await t.status(report)).toBe('running');
    parent = await t.w.executions.get(t.w.tenantA, t.planned.executionId);
    expect(parent.nodes.find((n) => n.id === 'pause')).toMatchObject({
      status: 'completed',
      output: { type: 'plan_wait', id: 'pause' },
    });

    await t.complete('report');
    await t.complete('summary');
    const closed = await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(closed.status).toBe('completed');
    const done = await t.w.executions.get(t.w.tenantA, t.planned.executionId);
    expect(done.verification?.nodes.find((n) => n.nodeId === 'pause')?.checks[0]).toMatchObject({
      code: WAIT_CHECK,
      result: 'passed',
    });
  });

  it('starts no wait without a way to wake the plan, and never skips it', async () => {
    const t = await ready(false);
    expect((await t.stored()).waits).toBeUndefined();
    t.setClock(new Date('2026-09-28T12:00:00Z'));
    await t.conductor.advance(t.w.runtimeA, t.planned.id);
    expect(await t.status(await t.childOf('report'))).toBe('pending');
  });

  it('refuses a wait that waits on nothing, too long or too short', async () => {
    const t = await setup((researcher) => [specialistStep('research', researcher)]);
    const refused = async (step: Record<string, unknown>) => {
      const execution = await t.w.planning(t.w.tenantA, await t.w.seed(t.w.orgA, ALICE));
      const outcome = await t.w.plans.propose(t.w.tenantA, {
        executionId: execution.id,
        proposal: proposal([specialistStep('research', await t.w.seed(t.w.orgA, ALICE)), step]),
        source: {
          kind: 'planner',
          model: { provider: 'alpha', id: 'alpha-large', version: 'v' },
          policy: { id: 'default_model', version: 1 },
        },
      });
      return outcome.status === 'planned' ? 'planned' : outcome.reason;
    };
    expect(await refused(wait('pause', []))).not.toBe('planned');
    expect(await refused(wait('pause', ['research'], 0))).not.toBe('planned');
    expect(await refused(wait('pause', ['research'], 7 * 86_400 + 1))).not.toBe('planned');
    expect(await refused({ ...wait('pause', ['research']), wait: undefined })).not.toBe('planned');
    expect(await refused(wait('pause', ['research'], 60))).toBe('planned');
  });
});
