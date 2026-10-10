import { actorOf, buildAuditEvent } from '@melonoffice/audit';
import type {
  Execution,
  ExecutionId,
  IsoTimestamp,
  OrganizationId,
  Plan,
  PlanConditionResult,
  PlanDecisionCondition,
  PlanId,
  PlanStep,
  PlanStepApproval,
  PlanToolInput,
  PlanVersion,
  PlanWait,
  ToolRiskLevel,
} from '@melonoffice/domain';
import {
  executionIdFor,
  isExecutionError,
  isTerminal,
  type ExecutionService,
} from '@melonoffice/execution';
import type { Logger } from '@melonoffice/observability';
import { isResolvedTenant, type TenantContext } from '@melonoffice/tenancy';
import {
  attemptKey,
  type Delegation,
  type PlanStepAttempts,
  type ReleaseManual,
} from './delegation.js';
import { isPlanningError, PlanningError } from './errors.js';
import {
  applyPlanStatus,
  isPlanId,
  recordAttempt,
  recordCondition,
  recordStepApproval,
  recordStepDeclined,
  recordBudgetBlock,
  recordWait,
  stepAttemptOf,
  stepExecutionOf,
} from './model.js';
import type { PlanRepository } from './repository.js';
import type { AbandonScheduled } from './service.js';

/**
 * The plan conductor (WF-1, ADR-0070): an approved plan runs. It adds no engine: each specialist
 * step is the child execution delegation already creates, run by the existing runtime (one node
 * at a time, models only through the AI Gateway, tools only through the gate). The conductor only
 * decides when each child starts and when the plan is over.
 *
 * - `run` (the person who approved, right after approving; or the runtime of a schedule's person,
 *   for a plan that person's standing approval approved, ADR-0185): delegates the plan and starts
 *   the steps that depend on no other step.
 * - `advance` (the runtime, after one of the plan's steps ended): decides every condition step
 *   whose steps before it completed (WF-4, through the Decision Engine), starts every specialist
 *   step whose steps before it completed, mirrors the children on the planning execution's
 *   graph, and closes the plan once no step is left to run. A step that failed (its child failed
 *   or was cancelled, or its condition could not go on) ends only its own branch: the steps after
 *   it are skipped and the other branches go on (BR-1, ADR-0162). The plan is `failed` when every
 *   branch ended in a failure, else `completed`, with its failed and skipped steps shown.
 *
 * Both are idempotent and safe to call again at any point: every change names the state it
 * expects, and a change another call already made is read back, never made twice.
 */
export interface PlanConductor {
  run(tenant: TenantContext, planId: string): Promise<Plan>;
  advance(tenant: TenantContext, planId: string): Promise<Plan>;
  /**
   * Runtime only, once a person decided a step's approval (ADR-0146): starts the approved step,
   * or records the declined one and skips its branch, and closes the plan when nothing is left.
   * It never decides a condition step: those stay with the worker's `advance`.
   */
  resume(tenant: TenantContext, planId: string): Promise<Plan>;
  /**
   * Runtime only, for a schedule's plan (ADR-0186): fails its `creating` delegation when it will
   * never finish, see `Delegation.abandon`. Refused with `plan_not_abandonable` otherwise.
   */
  abandon(tenant: TenantContext, planId: string, input: AbandonScheduled): Promise<Plan>;
  /**
   * Runtime only, for a hand-made plan whose creator may no longer plan (ADR-0187, decision 6):
   * releases its `creating` delegation, see `Delegation.releaseManual`.
   */
  releaseManual(tenant: TenantContext, planId: string, input: ReleaseManual): Promise<Plan>;
  /** Finishes the cleanup of a failed delegation an interrupted attempt left open (ADR-0186). */
  closeFailed(tenant: TenantContext, planId: string): Promise<Plan>;
}

/**
 * Starts one step's child execution and queues its first node: for a person, their own `start`;
 * for the runtime, the delegated start of that person's own execution. The app wires it to the
 * execution service and the runtime's `kickoff`.
 */
export interface StepStarter {
  start(tenant: TenantContext, executionId: ExecutionId): Promise<void>;
}

/** The step kinds a plan may have to run: specialist steps (WF-1) and condition steps (WF-4). */
export const RUNNABLE_STEP_KINDS: readonly PlanStep['kind'][] = ['specialist', 'condition', 'wait'];

/**
 * Why a plan version cannot run yet, or `undefined` when it can. Specialist steps run (WF-1),
 * condition steps the Decision Engine decides after at least one other step (WF-4), and tool
 * steps run inside the child execution of the specialist step that uses them, through the Tool
 * Gate, with the input fixed in the plan (ADR-0151). An approval, verification or parallel step,
 * or a condition on how another step ended, has no defined behaviour in a plan yet (ADR-0031), so
 * such a plan is refused whole, never run in part. A wait step (ADR-0152) waits on at least one
 * step, like a decision.
 */
export function unrunnableStepOf(version: PlanVersion): string | undefined {
  const performers = new Set(version.steps.filter((s) => s.kind === 'specialist').map((s) => s.id));
  const step = version.steps.find((s) =>
    s.kind === 'tool'
      ? s.tool === undefined || s.performedBy === undefined || !performers.has(s.performedBy)
      : !RUNNABLE_STEP_KINDS.includes(s.kind) ||
        (s.kind === 'condition' && (s.decision === undefined || s.dependsOn.length === 0)) ||
        (s.kind === 'wait' && (s.wait === undefined || s.dependsOn.length === 0)),
  );
  return step === undefined ? undefined : step.kind;
}

/**
 * Decides a plan's condition steps (WF-4, ADR-0075). The app wires it to the Decision Engine
 * (`planConditionEvaluator` in `@melonoffice/decisions`), which decides as the tenant it is given
 * and audits the decision: there is no second decision path. It never throws for a decision
 * that could not be made; that is a `failed` result with a stable code. Anything it throws
 * (storage unavailable) leaves the condition undecided, to be decided on the next advance.
 */
export interface ConditionEvaluator {
  evaluate(
    tenant: TenantContext,
    condition: PlanDecisionCondition,
    requestId?: string,
  ): Promise<Omit<PlanConditionResult, 'stepId' | 'evaluatedAt'>>;
}

/** The plan step a child execution is for (`plan_step` input `{planId}:{stepId}`), if it is one. */
export function planStepOf(
  execution: Execution,
): { readonly planId: PlanId; readonly stepId: string } | undefined {
  if (execution.input.type !== 'plan_step' || execution.parentExecutionId === undefined) {
    return undefined;
  }
  const [planId, stepId, ...rest] = execution.input.id.split(':');
  if (rest.length > 0 || stepId === undefined || stepId.length === 0 || !isPlanId(planId)) {
    return undefined;
  }
  return Object.freeze({ planId, stepId });
}

/**
 * The steps with every step after the ones it depends on. The plan's graph was checked acyclic
 * when it was validated; a graph that is not is refused here too, never run in part.
 */
function inOrder(steps: readonly PlanStep[]): readonly PlanStep[] {
  const out: PlanStep[] = [];
  const placed = new Set<string>();
  let rest = [...steps];
  while (rest.length > 0) {
    const ready = rest.filter((s) => s.dependsOn.every((d) => placed.has(d)));
    if (ready.length === 0) throw new PlanningError('invalid_plan', 'dependsOn');
    for (const s of ready) {
      out.push(s);
      placed.add(s.id);
    }
    rest = rest.filter((s) => !placed.has(s.id));
  }
  return out;
}

/**
 * What a step's approval is bound to (ADR-0146): this plan version, step and child execution,
 * exactly. Built by the conductor from the stored plan, never from a request.
 */
export interface StepApprovalAsk {
  readonly organizationId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly planDigest: string;
  readonly executionId: string;
  readonly stepId: string;
  readonly specialistId: string;
  readonly specialistVersion: number;
  readonly childExecutionId: string;
  readonly riskLevel: ToolRiskLevel;
  /**
   * On a tool step's approval (ADR-0151): the one tool call it covers, as the Tool Gate rebuilds
   * it when the step runs (the tool step is the child's tool node, the input is the plan's).
   */
  readonly tool?: {
    readonly stepId: string;
    readonly id: string;
    readonly version: number;
    readonly input: PlanToolInput;
  };
}

export type StepApprovalState =
  | { readonly status: 'pending' }
  | { readonly status: 'approved' }
  | { readonly status: 'declined'; readonly reason: string };

/**
 * Asks for and reads the approval a step waits for (ADR-0146). The app wires it to the approvals
 * system (`createPlanStepApprovals` in `@melonoffice/approvals`): there is no second approval
 * path, and only a person acting directly decides one.
 */
export interface StepApprovals {
  request(tenant: TenantContext, ask: StepApprovalAsk): Promise<string>;
  state(
    tenant: TenantContext,
    approvalId: string,
    ask: StepApprovalAsk,
  ): Promise<StepApprovalState>;
  cancel(tenant: TenantContext, approvalId: string, reason: string): Promise<void>;
}

/**
 * Whether a step waits for a person's approval once the steps before it are done (ADR-0146): a
 * specialist step marked `approvalRequired` that depends on another step. A first step starts
 * the moment the plan is approved, so that approval is already the one right before it.
 */
export const waitsForApproval = (step: PlanStep): boolean =>
  step.kind === 'specialist' && step.approvalRequired && step.dependsOn.length > 0;

/**
 * Whether a first step waits for a person under a standing approval (ADR-0185): its plan was
 * approved by a schedule, not by a person, so the step that asks for approval still needs one.
 */
export const waitsForStandingApproval = (plan: Plan, step: PlanStep): boolean =>
  plan.decision?.via === 'schedule' && step.kind === 'specialist' && step.approvalRequired;

/**
 * The tool steps a specialist step uses that need a person's approval (ADR-0151): their tool's
 * policy asks for one, or the plan does. Each is asked for once the specialist step is ready,
 * first steps included (the plan's approval never covers a tool call), and the step starts only
 * once all of them, and its own (ADR-0146), were given.
 */
export const approvedToolStepsOf = (version: PlanVersion, step: PlanStep): readonly PlanStep[] =>
  step.kind !== 'specialist'
    ? []
    : version.steps.filter(
        (s) =>
          s.kind === 'tool' &&
          s.performedBy === step.id &&
          s.approvalRequired &&
          s.tool !== undefined,
      );

/** Every approval a specialist step waits for, as recorded on the plan: its own and its tools'. */
export const stepApprovalEntriesOf = (
  plan: Pick<Plan, 'stepApprovals'>,
  stepId: string,
): readonly PlanStepApproval[] =>
  (plan.stepApprovals ?? []).filter((a) => a.stepId === stepId || a.performedBy === stepId);

/**
 * What the approvals a step waits for say, from the plan alone (for screens): `declined` once
 * one was recorded declined, `awaiting` while one was asked for, `none` otherwise.
 */
export function stepApprovalOf(
  plan: Pick<Plan, 'stepApprovals'>,
  stepId: string,
): 'none' | 'awaiting' | 'declined' {
  const entries = stepApprovalEntriesOf(plan, stepId);
  if (entries.some((a) => a.declined !== undefined)) return 'declined';
  return entries.length > 0 ? 'awaiting' : 'none';
}

/**
 * Wakes a plan when one of its waits ends (ADR-0152). The worker wires it to a Cloud Tasks task
 * on its own queue that advances the plan; a lost or early task changes nothing, since the plan
 * is read again and its wait decides, and the sweep advances a plan whose wait is over.
 */
export interface PlanWakeups {
  wake(
    tenant: TenantContext,
    plan: { readonly organizationId: string; readonly planId: string },
    at: Date,
  ): Promise<void>;
}

/** How long after a wait ends its plan is woken, so an early task never finds it still running. */
export const WAKE_MARGIN_MS = 1_000;

export interface PlanConductorOptions {
  readonly plans: PlanRepository;
  /** Needed by `run` only: the worker advances plans, it never delegates one. */
  readonly delegation?: Pick<Delegation, 'delegate' | 'abandon' | 'releaseManual' | 'closeFailed'>;
  readonly executions: Pick<
    ExecutionService,
    | 'get'
    | 'runtimePlanChangeStatus'
    | 'runtimePlanChangeNode'
    | 'recordVerification'
    | 'attachPlanStepApproval'
  >;
  readonly starter: StepStarter;
  /**
   * Decides condition steps (WF-4). Needed by `advance` only. Absent: a condition step fails with
   * `condition_not_configured` and the plan stops, never going on undecided.
   */
  readonly conditions?: ConditionEvaluator;
  /**
   * Asks for and reads step approvals (ADR-0146). Needed by `advance` only. Absent: a step that
   * waits for an approval fails with `step_approval_not_configured`, never running unapproved.
   */
  readonly approvals?: StepApprovals;
  /**
   * Wakes the plan when a wait ends (ADR-0152). Needed by `advance` only. Absent: a wait step
   * that became ready is left for the worker's next advance, never started without a wake-up.
   */
  readonly wakeups?: PlanWakeups;
  /**
   * Creates another run of a step that failed for a passing reason (ADR-0153). Needed by
   * `advance` only, with `wakeups`. Absent: a failed step stops the plan, as before.
   */
  readonly attempts?: PlanStepAttempts;
  /**
   * What the plan's runs used, in credits (ADR-0163). Needed wherever a step starts in a plan
   * whose approved estimate is known. Absent there: no step starts, never past the budget.
   */
  readonly spending?: PlanSpending;
  readonly now?: () => Date;
  readonly requestId?: string;
  readonly logger?: Logger;
}

/**
 * What a plan's runs used (ADR-0163): the credits the Credit Core charged for the AI calls of the
 * given child executions, as their own records say. Reads only.
 */
export interface PlanSpending {
  used(tenant: TenantContext, executionIds: readonly ExecutionId[]): Promise<number>;
}

/** Why a step never started: it would pass the plan's approved credit budget (ADR-0163). */
export const BUDGET_EXCEEDED = 'budget_exceeded';

/**
 * The most a plan's execution may use, in credits (D5, ADR-0163): the estimate a person approved
 * with this version. An unknown estimate sets no budget (ADR-0163: the plan says so instead).
 */
export const creditBudgetOf = (version: Pick<PlanVersion, 'estimate'>): number | undefined =>
  version.estimate.status === 'estimated' && version.estimate.credits !== null
    ? version.estimate.credits
    : undefined;

/** The planning execution's evidence that every step completed: its child execution. */
export const STEP_CHECK = 'step_execution_completed';
/** The evidence that a condition step was decided: its decision. */
export const CONDITION_CHECK = 'condition_decided';
/** What an audit event's `reference` may hold. */
const REFERENCE = /^[A-Za-z0-9._:-]{1,128}$/;

/** The evidence that a wait step ended: its recorded start and end (ADR-0152). */
export const WAIT_CHECK = 'wait_elapsed';

/**
 * Why a step's child may fail and still be run again (ADR-0153): the model's provider did not
 * answer this time (`network`, `rate_limited`, `server_error`, `unavailable`). Never a refusal,
 * a lack of credits, a policy, an invalid answer or an outcome nobody knows.
 */
export const RETRYABLE_STEP_FAILURES: readonly string[] = [
  'network',
  'rate_limited',
  'server_error',
  'unavailable',
];

/**
 * Whether a specialist step whose child failed runs again (ADR-0153): the plan asked for more
 * attempts than it had, the step waits for no person, and its child failed on its own agent's
 * call for a passing reason before anything else in it started, so no tool ran and nothing is
 * done twice.
 */
export function stepRetryable(
  plan: Pick<Plan, 'attempts'>,
  step: PlanStep,
  child: Pick<Execution, 'status' | 'failure' | 'nodes'>,
  gated: boolean,
): boolean {
  if (step.kind !== 'specialist' || gated || step.retry === undefined) return false;
  if (stepAttemptOf(plan, step.id) >= step.retry.maxAttempts) return false;
  const code = child.failure?.code;
  if (child.status !== 'failed' || code === undefined) return false;
  if (!RETRYABLE_STEP_FAILURES.includes(code)) return false;
  const agent = child.nodes.find((n) => n.id === step.id);
  if (agent?.status !== 'failed' || agent.error?.code !== code) return false;
  return child.nodes.every((n) => n.id === step.id || n.startedAt === undefined);
}

/**
 * Where one step is:
 * - `waiting`: not started or not decided yet;
 * - `running`: its child execution started;
 * - `completed`: its child completed, or its condition lets the plan go on;
 * - `stopped`: its condition was decided and the steps after it do not run;
 * - `awaiting_approval`: ready, waiting for a person to approve it (ADR-0146), or started and
 *   waiting for a person to approve one of its tool calls (ADR-0155);
 * - `declined`: its approval was rejected, expired or withdrawn: it never runs (ADR-0146);
 * - `delayed`: a wait step that started and has not ended yet (ADR-0152), or a step's next attempt
 *   that may not start yet (ADR-0153);
 * - `skipped`: a step it depends on was stopped, declined or skipped, so it never runs;
 * - `failed`: its child failed or was cancelled, or its condition could not go on.
 */
export type PlanStepState =
  | 'waiting'
  | 'awaiting_approval'
  | 'delayed'
  | 'running'
  | 'completed'
  | 'stopped'
  | 'declined'
  | 'skipped'
  | 'failed';
type StepState = PlanStepState;

interface StepView {
  readonly step: PlanStep;
  /** On specialist steps. */
  readonly child?: Execution;
  /** On condition steps, once decided. */
  readonly condition?: PlanConditionResult;
  /** On wait steps, once started (ADR-0152). */
  readonly wait?: PlanWait;
  /** On a step that waits for approvals, once all are given and it may start (ADR-0146). */
  readonly approved?: boolean;
  /** Approvals found declined and not recorded yet, for `advance` to record (ADR-0146). */
  readonly declines?: readonly { readonly entry: string; readonly reason: string }[];
  /** Why it failed without a child failing, e.g. `step_approval_not_configured`. */
  readonly failure?: string;
  /** On a specialist step that failed and runs again (ADR-0153). */
  readonly retry?: true;
  readonly state: StepState;
}

/**
 * A specialist step's state from its child execution. A started child that waits for a person
 * (a tool call the gate asked about, ADR-0026) is `awaiting_approval`, as a step that waits
 * before it starts (ADR-0155): one state for waiting on a person, whatever asked.
 */
export const specialistStepState = (
  child: Pick<Execution, 'status' | 'startedAt'>,
): PlanStepState =>
  child.status === 'completed'
    ? 'completed'
    : child.status === 'failed' || child.status === 'cancelled'
      ? 'failed'
      : child.startedAt === undefined
        ? 'waiting'
        : child.status === 'waiting_approval'
          ? 'awaiting_approval'
          : 'running';

/** A condition step's state from its recorded result, if it was decided. */
export const conditionStepState = (condition: PlanConditionResult | undefined): PlanStepState =>
  condition === undefined
    ? 'waiting'
    : condition.result === 'continue'
      ? 'completed'
      : condition.result === 'stop'
        ? 'stopped'
        : 'failed';

/** A wait step's state from its recorded start, if it started (ADR-0152). */
export const waitStepState = (wait: PlanWait | undefined, now: Date): PlanStepState =>
  wait === undefined ? 'waiting' : now.getTime() < Date.parse(wait.until) ? 'delayed' : 'completed';

/** Ends a branch: the steps after it never run. A failed step ends only its own (ADR-0162). */
const endsBranch = (state: PlanStepState | undefined): boolean =>
  state === 'stopped' || state === 'declined' || state === 'skipped' || state === 'failed';

/**
 * A step that has not started, after a stopped, declined, failed or skipped step, never runs: it
 * is skipped.
 */
const skippedAfter = (
  step: PlanStep,
  state: PlanStepState,
  states: ReadonlyMap<string, PlanStepState>,
): boolean =>
  (state === 'waiting' || state === 'awaiting_approval') &&
  step.dependsOn.some((d) => endsBranch(states.get(d)));

/**
 * Where a specialist step is, given its child and, when it waits for an approval, what was
 * recorded (ADR-0146): declined, still awaited, or nothing yet. A started child is never
 * held back by its approval.
 */
export function gatedStepState(
  child: Pick<Execution, 'status' | 'startedAt'>,
  approval: 'none' | 'awaiting' | 'approved' | 'declined',
): PlanStepState {
  const state = specialistStepState(child);
  if (state !== 'waiting') return state;
  return approval === 'declined'
    ? 'declined'
    : approval === 'awaiting'
      ? 'awaiting_approval'
      : 'waiting';
}

/**
 * Where every runnable step of a plan version is, by the conductor's own rule: each step's own
 * state (`own`), then skipped when a step it depends on was stopped or skipped. The plan screen
 * reads it the same way the conductor runs it.
 */
export function planStepStates(
  steps: readonly PlanStep[],
  own: (step: PlanStep) => PlanStepState,
): ReadonlyMap<string, PlanStepState> {
  const states = new Map<string, PlanStepState>();
  for (const step of inOrder(steps.filter((s) => RUNNABLE_STEP_KINDS.includes(s.kind)))) {
    const state = own(step);
    states.set(step.id, skippedAfter(step, state, states) ? 'skipped' : state);
  }
  return states;
}

/** One approval a specialist step waits for, and the plan entry it is recorded under. */
interface Gate {
  readonly entry: string;
  readonly ask: StepApprovalAsk;
}

/** Why a plan stops at a failed step, as the plan and its execution record it. */
const failureOf = (view: StepView): string =>
  view.failure !== undefined
    ? view.failure
    : view.step.kind === 'specialist'
      ? 'step_failed'
      : view.condition?.result === 'await_approval'
        ? 'condition_needs_approval'
        : 'condition_failed';

/** A step no longer runs: done, skipped, declined or failed for good. */
const over = (view: StepView): boolean =>
  decided(view) ||
  view.state === 'skipped' ||
  view.state === 'declined' ||
  (view.state === 'failed' && view.retry !== true);

/**
 * Whether every branch of a finished plan ended in a failure (ADR-0162): each last step (one no
 * other step waits on) failed, or was skipped because a step before it failed. Views are in
 * dependency order.
 */
export function everyBranchFailed(
  views: readonly { readonly step: PlanStep; readonly state: PlanStepState }[],
): boolean {
  const lost = new Set<string>();
  for (const { step, state } of views) {
    if (state === 'failed' || (state === 'skipped' && step.dependsOn.some((d) => lost.has(d)))) {
      lost.add(step.id);
    }
  }
  const waitedOn = new Set(views.flatMap((v) => v.step.dependsOn));
  return views.filter((v) => !waitedOn.has(v.step.id)).every((v) => lost.has(v.step.id));
}

/** Why a plan's execution failed while the plan completed: a branch failed, others did not. */
export const BRANCH_FAILED = 'branch_failed';

/** Every step of the plan was declined or skipped: it ran nothing (ADR-0185). */
export const NOTHING_RAN = 'nothing_ran';

/** A node of the planning execution that finished with work done: its evidence is checked. */
const decided = (view: StepView): boolean => view.state === 'completed' || view.state === 'stopped';

/** What a wait step's node points at once it ended: the step, whose start the plan records. */
const waitRef = (view: StepView): string => view.step.id;

export function createPlanConductor(options: PlanConductorOptions): PlanConductor {
  const {
    plans,
    delegation,
    executions,
    starter,
    conditions,
    approvals,
    wakeups,
    spending,
    attempts,
    requestId,
  } = options;
  const now = options.now ?? (() => new Date());
  const logger = options.logger;

  const iso = (at: Date): IsoTimestamp => at.toISOString() as IsoTimestamp;

  function organizationOf(tenant: TenantContext): OrganizationId {
    if (!isResolvedTenant(tenant)) throw new PlanningError('unresolved_tenant');
    return tenant.organizationId;
  }

  async function load(
    organizationId: OrganizationId,
    planId: string,
  ): Promise<{ plan: Plan; version: PlanVersion }> {
    if (!isPlanId(planId)) throw new PlanningError('plan_not_found');
    const plan = await plans.find(organizationId, planId);
    if (plan === undefined) throw new PlanningError('plan_not_found');
    const version = await plans.findVersion(organizationId, plan.id, plan.version);
    if (version === undefined) throw new PlanningError('plan_not_found');
    return { plan, version };
  }

  /**
   * Each step that runs, every step after the steps it depends on, with its child execution or
   * its condition's result and where it is. A step after a stopped or skipped one is skipped.
   */
  async function stepsOf(
    tenant: TenantContext,
    plan: Plan,
    version: PlanVersion,
  ): Promise<readonly StepView[]> {
    const out: StepView[] = [];
    const states = new Map<string, StepState>();
    for (const step of inOrder(version.steps.filter((s) => RUNNABLE_STEP_KINDS.includes(s.kind)))) {
      let view: StepView;
      if (step.kind === 'specialist') {
        view = await specialistView(tenant, plan, version, step, states);
      } else if (step.kind === 'wait') {
        const wait = plan.waits?.find((w) => w.stepId === step.id);
        view = { step, ...(wait === undefined ? {} : { wait }), state: waitStepState(wait, now()) };
      } else {
        const condition = plan.conditions?.find((c) => c.stepId === step.id);
        view = {
          step,
          ...(condition === undefined ? {} : { condition }),
          state: conditionStepState(condition),
        };
      }
      if (skippedAfter(step, view.state, states)) view = { ...view, state: 'skipped' };
      states.set(step.id, view.state);
      out.push(view);
    }
    return out;
  }

  /**
   * A specialist step from its current child (ADR-0153): the latest attempt's, else the one its
   * delegation gave it. An attempt whose child is not there yet is created now; one that may not
   * start yet is `delayed`; one that can no longer be created fails the step.
   */
  async function specialistView(
    tenant: TenantContext,
    plan: Plan,
    version: PlanVersion,
    step: PlanStep,
    states: ReadonlyMap<string, StepState>,
  ): Promise<StepView> {
    const childId = stepExecutionOf(plan, step.id);
    if (childId === undefined) throw new PlanningError('delegation_conflict');
    const attempt = (plan.attempts ?? []).filter((a) => a.stepId === step.id).at(-1);
    let child: Execution | undefined;
    if (attempt === undefined) {
      child = await executions.get(tenant, childId);
    } else {
      try {
        child = await executions.get(tenant, childId);
      } catch (error) {
        if (!isExecutionError(error) || error.code !== 'execution_not_found') throw error;
        if (attempts === undefined) return { step, state: 'waiting' };
        child = await attempts.ensure(tenant, plan, version, step, attempt.attempt);
        if (child === undefined)
          return { step, state: 'failed', failure: 'step_retry_unavailable' };
      }
    }
    // A step the approved budget could not cover never starts (ADR-0163).
    if (
      child.startedAt === undefined &&
      (plan.budgetBlocks ?? []).some((b) => b.stepId === step.id)
    ) {
      return { step, child, state: 'failed', failure: BUDGET_EXCEEDED };
    }
    const gates = gatesOf(plan, version, step, child.id);
    if (gates.length > 0) return gatedView(tenant, plan, step, child, states, gates);
    const state = specialistStepState(child);
    if (
      state === 'waiting' &&
      attempt !== undefined &&
      Date.parse(attempt.notBefore) > now().getTime()
    ) {
      return { step, child, state: 'delayed' };
    }
    if (state === 'failed' && stepRetryable(plan, step, child, false)) {
      return { step, child, state, retry: true };
    }
    return { step, child, state };
  }

  /**
   * Runs a failed step again (ADR-0153): the attempt is recorded on the plan first, in one
   * revision-checked write with `plan.step_retried`, so a cancellation reaches its child even
   * before it exists; then its child is created and, after the step's backoff, the plan is woken
   * to start it. A concurrent retry finds it recorded and changes nothing.
   */
  async function retryStep(
    tenant: TenantContext,
    organizationId: OrganizationId,
    plan: Plan,
    version: PlanVersion,
    view: StepView,
  ): Promise<Plan> {
    const { step, child } = view;
    if (attempts === undefined || child === undefined || step.retry === undefined) return plan;
    const attempt = stepAttemptOf(plan, step.id) + 1;
    const executionId = executionIdFor(organizationId, attemptKey(plan.id, step.id, attempt));
    const failure = child.failure?.code ?? 'step_failed';
    const at = now();
    let retried: Plan;
    try {
      retried = await plans.update(organizationId, plan.id, (current) => {
        const next = recordAttempt(
          current,
          {
            stepId: step.id,
            executionId,
            after: child.id,
            failure,
            backoffMs: step.retry?.backoffMs ?? 0,
          },
          iso(at),
        );
        return {
          plan: next,
          events: [
            buildAuditEvent(
              {
                action: 'plan.step_retried',
                result: 'success',
                actor: actorOf(tenant),
                organizationId,
                target: { type: 'execution', id: executionId },
                nodeId: step.id,
                reason: failure,
                reference: `attempt:${attempt}`,
                ...(requestId === undefined ? {} : { requestId }),
                source: 'api',
              },
              at,
            ),
          ],
        };
      });
    } catch (error) {
      if (!isPlanningError(error)) throw error;
      const fresh = await plans.find(organizationId, plan.id);
      if (fresh !== undefined && stepExecutionOf(fresh, step.id) !== child.id) return fresh;
      if (fresh !== undefined && fresh.status !== 'executing') return fresh;
      throw error;
    }
    await attempts.ensure(tenant, retried, version, step, attempt);
    const recorded = (retried.attempts ?? []).at(-1);
    if (
      wakeups !== undefined &&
      recorded !== undefined &&
      recorded.notBefore > recorded.recordedAt
    ) {
      try {
        await wakeups.wake(
          tenant,
          { organizationId, planId: retried.id },
          new Date(Date.parse(recorded.notBefore) + WAKE_MARGIN_MS),
        );
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        logger?.warn('plan wake-up not queued', {
          planId: retried.id,
          stepId: step.id,
          code: typeof code === 'string' ? code : 'error',
        });
      }
    }
    logger?.info('plan step retried', {
      planId: retried.id,
      stepId: step.id,
      attempt,
      code: failure,
    });
    return retried;
  }

  /** What a step's approval is bound to, from the stored plan and version only. */
  function askOf(
    plan: Plan,
    version: PlanVersion,
    step: PlanStep,
    childId: ExecutionId,
  ): StepApprovalAsk {
    if (step.specialist === undefined) throw new PlanningError('delegation_conflict');
    return {
      organizationId: plan.organizationId,
      planId: plan.id,
      planVersion: version.version,
      planDigest: version.digest,
      executionId: plan.executionId,
      stepId: step.id,
      specialistId: step.specialist.id,
      specialistVersion: step.specialist.version,
      childExecutionId: childId,
      riskLevel: version.riskLevel,
    };
  }

  /**
   * Every approval a specialist step waits for: its own (ADR-0146) and one per tool step it uses
   * that needs one (ADR-0151), each keyed by the step it is recorded under.
   */
  function gatesOf(
    plan: Plan,
    version: PlanVersion,
    step: PlanStep,
    childId: ExecutionId,
  ): readonly Gate[] {
    const gates: Gate[] = [];
    if (waitsForApproval(step) || waitsForStandingApproval(plan, step))
      gates.push({ entry: step.id, ask: askOf(plan, version, step, childId) });
    for (const tool of approvedToolStepsOf(version, step)) {
      const ref = tool.tool as NonNullable<PlanStep['tool']>;
      gates.push({
        entry: tool.id,
        ask: {
          ...askOf(plan, version, step, childId),
          tool: { stepId: tool.id, id: ref.id, version: ref.version, input: tool.input ?? {} },
        },
      });
    }
    return gates;
  }

  /**
   * A step that waits for people (ADR-0146, ADR-0151): declined once one of its approvals was
   * recorded so; otherwise what its approvals say now. One not asked for yet leaves it `waiting`,
   * so it is asked; a decline not recorded yet carries its reason, for `advance` to record. It
   * may start only once every one was given. Without the approvals port, a step that became
   * ready fails rather than run unapproved.
   */
  async function gatedView(
    tenant: TenantContext,
    plan: Plan,
    step: PlanStep,
    child: Execution,
    states: ReadonlyMap<string, StepState>,
    gates: readonly Gate[],
  ): Promise<StepView> {
    if (specialistStepState(child) !== 'waiting') {
      return { step, child, state: specialistStepState(child) };
    }
    const entries = gates.map((gate) => ({
      gate,
      entry: plan.stepApprovals?.find((a) => a.stepId === gate.entry),
    }));
    if (entries.some(({ entry }) => entry?.declined !== undefined)) {
      return { step, child, state: 'declined' };
    }
    if (approvals === undefined) {
      const ready = step.dependsOn.every((d) => states.get(d) === 'completed');
      return ready
        ? { step, child, state: 'failed', failure: 'step_approval_not_configured' }
        : { step, child, state: 'waiting' };
    }
    if (entries.some(({ entry }) => entry === undefined)) return { step, child, state: 'waiting' };
    const declines: { entry: string; reason: string }[] = [];
    let pending = false;
    for (const { gate, entry } of entries) {
      const found = await approvals.state(tenant, (entry as PlanStepApproval).approvalId, gate.ask);
      if (found.status === 'pending') pending = true;
      if (found.status === 'declined') declines.push({ entry: gate.entry, reason: found.reason });
    }
    if (declines.length > 0) return { step, child, state: 'declined', declines };
    if (pending) return { step, child, state: 'awaiting_approval' };
    return { step, child, approved: true, state: 'waiting' };
  }

  /**
   * Asks for a ready step's approval and records which one it is on the plan, once, with its
   * audit event. A request that lost to a concurrent one is withdrawn: one approval per step.
   */
  async function askApproval(
    tenant: TenantContext,
    organizationId: OrganizationId,
    plan: Plan,
    gate: Gate,
  ): Promise<void> {
    if (approvals === undefined) return;
    const step = { id: gate.entry };
    const approvalId = await approvals.request(tenant, gate.ask);
    const performedBy = gate.ask.tool === undefined ? undefined : gate.ask.stepId;
    const at = now();
    try {
      await plans.update(organizationId, plan.id, (current) => ({
        plan: recordStepApproval(
          current,
          { stepId: step.id, approvalId, ...(performedBy === undefined ? {} : { performedBy }) },
          iso(at),
        ),
        events: [
          buildAuditEvent(
            {
              action: 'plan.step_approval_requested',
              result: 'success',
              actor: actorOf(tenant),
              organizationId,
              target: { type: 'plan', id: current.id },
              nodeId: step.id,
              reference: approvalId,
              ...(requestId === undefined ? {} : { requestId }),
              source: 'api',
            },
            at,
          ),
        ],
      }));
      logger?.info('plan step awaits approval', { planId: plan.id, stepId: step.id });
    } catch (error) {
      if (!isPlanningError(error)) throw error;
      await approvals.cancel(tenant, approvalId, 'duplicate_request');
    }
  }

  /**
   * Records each step whose approval was declined since the last look, once, with its audit
   * event: its branch is skipped and the other branches go on (ADR-0146).
   */
  async function recordDeclines(
    tenant: TenantContext,
    organizationId: OrganizationId,
    plan: Plan,
    views: readonly StepView[],
  ): Promise<Plan> {
    let current = plan;
    for (const view of views) {
      for (const { entry, reason } of view.declines ?? []) {
        current = await recordDecline(tenant, organizationId, current, entry, reason);
      }
      if ((view.declines ?? []).length === 0) continue;
      // The step never runs: the approvals it still waits for are withdrawn.
      for (const other of stepApprovalEntriesOf(current, view.step.id)) {
        if (other.declined !== undefined || approvals === undefined) continue;
        if (view.declines?.some((d) => d.entry === other.stepId) === true) continue;
        await approvals.cancel(tenant, other.approvalId, 'step_declined');
      }
    }
    return current;
  }

  /** Records one declined approval, once, with its audit event. */
  async function recordDecline(
    tenant: TenantContext,
    organizationId: OrganizationId,
    plan: Plan,
    entry: string,
    reason: string,
  ): Promise<Plan> {
    const at = now();
    try {
      const recorded = await plans.update(organizationId, plan.id, (stored) => ({
        plan: recordStepDeclined(stored, entry, reason, iso(at)),
        events: [
          buildAuditEvent(
            {
              action: 'plan.step_declined',
              result: 'success',
              actor: actorOf(tenant),
              organizationId,
              target: { type: 'plan', id: stored.id },
              nodeId: entry,
              reason,
              ...(requestId === undefined ? {} : { requestId }),
              source: 'api',
            },
            at,
          ),
        ],
      }));
      logger?.info('plan step declined', { planId: plan.id, stepId: entry, reason });
      return recorded;
    } catch (error) {
      if (!isPlanningError(error)) throw error;
      return (await plans.find(organizationId, plan.id)) ?? plan;
    }
  }

  /** Whether every step a step depends on completed. */
  function readyIn(views: readonly StepView[], view: StepView): boolean {
    const completed = new Set(views.filter((v) => v.state === 'completed').map((v) => v.step.id));
    return view.state === 'waiting' && view.step.dependsOn.every((d) => completed.has(d));
  }

  /**
   * Which ready steps the plan's approved credit budget covers (ADR-0163), in order. What it has
   * committed is what its runs used, plus the estimate of each step still running, plus each step
   * this pass lets start: the budget is never passed, whatever finishes first. A step that does
   * not fit waits while another runs, since a run may use less than its estimate; with nothing
   * running, what was used is final and the step is `blocked`. `allowed` is absent when the plan
   * has no budget (its estimate is unknown).
   */
  async function budgetFor(
    tenant: TenantContext,
    plan: Plan,
    version: PlanVersion,
    views: readonly StepView[],
  ): Promise<{
    readonly allowed?: ReadonlySet<string>;
    readonly blocked: readonly { stepId: string; used: number; needed: number; cap: number }[];
  }> {
    const cap = creditBudgetOf(version);
    if (cap === undefined) return { blocked: [] };
    const ready = views.filter(
      (v) => v.child?.status === 'pending' && v.child.startedAt === undefined && readyIn(views, v),
    );
    const allowed = new Set<string>();
    if (ready.length === 0) return { allowed, blocked: [] };
    if (spending === undefined) {
      logger?.warn('plan step not started: no credit meter', { planId: plan.id });
      return { allowed, blocked: [] };
    }
    const runs = [
      ...plan.delegations.map((d) => d.executionId),
      ...(plan.attempts ?? []).map((a) => a.executionId),
    ];
    const used = await spending.used(tenant, runs);
    const running = views.filter(
      (v) => v.child?.startedAt !== undefined && !isTerminal(v.child.status),
    );
    const estimateOf = (step: PlanStep) => step.estimate?.credits ?? undefined;
    let committed = used + running.reduce((total, v) => total + (estimateOf(v.step) ?? 0), 0);
    const blocked: { stepId: string; used: number; needed: number; cap: number }[] = [];
    for (const view of ready) {
      const needed = estimateOf(view.step);
      // A plan with a budget has an estimate for each agent step (`totalEstimate`). One without
      // cannot be measured: it never starts, and nothing is invented for it.
      if (needed === undefined) continue;
      if (committed + needed <= cap) {
        allowed.add(view.step.id);
        committed += needed;
      } else if (running.length === 0 && allowed.size === 0) {
        blocked.push({ stepId: view.step.id, used, needed, cap });
      }
    }
    return { allowed, blocked };
  }

  /** Records each step the budget could not cover (ADR-0163), once, with its audit event. */
  async function blockOverBudget(
    tenant: TenantContext,
    organizationId: OrganizationId,
    plan: Plan,
    blocks: readonly { stepId: string; used: number; needed: number; cap: number }[],
  ): Promise<Plan> {
    let current = plan;
    for (const block of blocks) {
      const at = now();
      try {
        current = await plans.update(organizationId, plan.id, (found) => {
          const next = recordBudgetBlock(
            found,
            {
              stepId: block.stepId,
              usedCredits: block.used,
              neededCredits: block.needed,
              capCredits: block.cap,
            },
            iso(at),
          );
          return {
            plan: next,
            events: [
              buildAuditEvent(
                {
                  action: 'plan.step_blocked',
                  result: 'success',
                  actor: actorOf(tenant),
                  organizationId,
                  target: { type: 'plan', id: next.id },
                  nodeId: block.stepId,
                  reason: BUDGET_EXCEEDED,
                  reference: `used:${block.used}-needed:${block.needed}-cap:${block.cap}`,
                  ...(requestId === undefined ? {} : { requestId }),
                  source: 'api',
                },
                at,
              ),
            ],
          };
        });
      } catch (error) {
        if (!isPlanningError(error)) throw error;
        const fresh = await plans.find(organizationId, plan.id);
        if (fresh?.budgetBlocks?.some((b) => b.stepId === block.stepId) === true) {
          current = fresh;
          continue;
        }
        if (fresh !== undefined && fresh.status !== 'executing') return fresh;
        throw error;
      }
      logger?.info('plan step blocked by its budget', {
        planId: plan.id,
        stepId: block.stepId,
        used: block.used,
        needed: block.needed,
        cap: block.cap,
      });
    }
    return current;
  }

  /**
   * Starts every specialist step that has not started and whose steps before it all completed.
   * A step that waits for people starts only once every approval it waits for was given; until
   * then, it asks for each one not asked for yet (ADR-0146, ADR-0151). Before it starts, each
   * tool approval is attached to its tool node, where the Tool Gate checks it covers the call.
   */
  async function startReady(
    tenant: TenantContext,
    plan: Plan,
    version: PlanVersion,
    views: readonly StepView[],
  ): Promise<void> {
    const { allowed } = await budgetFor(tenant, plan, version, views);
    for (const view of views) {
      const { child } = view;
      if (child === undefined || child.status !== 'pending') continue;
      if (!readyIn(views, view)) continue;
      // Within the approved budget only (ADR-0163); one that does not fit yet waits.
      if (allowed !== undefined && !allowed.has(view.step.id)) continue;
      const gates = gatesOf(plan, version, view.step, child.id);
      if (gates.length > 0 && view.approved !== true) {
        for (const gate of gates) {
          if (!(plan.stepApprovals ?? []).some((a) => a.stepId === gate.entry)) {
            await askApproval(tenant, plan.organizationId, plan, gate);
          }
        }
        continue;
      }
      for (const gate of gates) {
        const entry = plan.stepApprovals?.find((a) => a.stepId === gate.entry);
        if (gate.ask.tool === undefined || entry === undefined) continue;
        await executions.attachPlanStepApproval(tenant, child.id, gate.entry, entry.approvalId);
      }
      await starter.start(tenant, child.id);
    }
  }

  /**
   * Decides one condition step and records its result on the plan, once, with its audit event.
   * A result another call recorded first stands: it is read back, never decided twice.
   */
  async function decide(
    tenant: TenantContext,
    organizationId: OrganizationId,
    plan: Plan,
    step: PlanStep,
  ): Promise<Plan> {
    const condition = step.decision;
    const outcome =
      condition === undefined
        ? { result: 'failed' as const, failure: 'condition_invalid' }
        : conditions === undefined
          ? { result: 'failed' as const, failure: 'condition_not_configured' }
          : await conditions.evaluate(tenant, condition, requestId);
    const at = now();
    try {
      return await plans.update(organizationId, plan.id, (current) => {
        const next = recordCondition(current, { stepId: step.id, ...outcome }, iso(at));
        return {
          plan: next,
          events: [
            buildAuditEvent(
              {
                action: 'plan.condition_evaluated',
                result: 'success',
                actor: actorOf(tenant),
                organizationId,
                target: { type: 'plan', id: next.id },
                nodeId: step.id,
                reason: outcome.failure ?? outcome.result,
                ...(outcome.decision === undefined ? {} : { reference: outcome.decision.id }),
                ...(requestId === undefined ? {} : { requestId }),
                source: 'api',
              },
              at,
            ),
          ],
        };
      });
    } catch (error) {
      if (!isPlanningError(error)) throw error;
      const fresh = await plans.find(organizationId, plan.id);
      if (fresh?.conditions?.some((c) => c.stepId === step.id) === true) return fresh;
      if (fresh !== undefined && fresh.status !== 'executing') return fresh;
      throw error;
    }
  }

  /**
   * Starts one ready wait step (ADR-0152): records its start and end on the plan, once, with its
   * audit event, then asks for the plan to be woken when it ends. A start another call recorded
   * first stands, and that call asked for the wake-up. A wake-up that could not be queued is
   * logged: the sweep advances a plan whose wait is over.
   */
  async function startWait(
    tenant: TenantContext,
    organizationId: OrganizationId,
    plan: Plan,
    step: PlanStep,
  ): Promise<Plan> {
    if (wakeups === undefined || step.wait === undefined) return plan;
    const seconds = step.wait.seconds;
    const at = now();
    let started: Plan;
    try {
      started = await plans.update(organizationId, plan.id, (current) => {
        const next = recordWait(current, { stepId: step.id, seconds }, iso(at));
        return {
          plan: next,
          events: [
            buildAuditEvent(
              {
                action: 'plan.wait_started',
                result: 'success',
                actor: actorOf(tenant),
                organizationId,
                target: { type: 'plan', id: next.id },
                nodeId: step.id,
                reference: `${seconds}s`,
                ...(requestId === undefined ? {} : { requestId }),
                source: 'api',
              },
              at,
            ),
          ],
        };
      });
    } catch (error) {
      if (!isPlanningError(error)) throw error;
      const fresh = await plans.find(organizationId, plan.id);
      if (fresh?.waits?.some((w) => w.stepId === step.id) === true) return fresh;
      if (fresh !== undefined && fresh.status !== 'executing') return fresh;
      throw error;
    }
    const wait = started.waits?.find((w) => w.stepId === step.id);
    if (wait !== undefined) {
      try {
        await wakeups.wake(
          tenant,
          { organizationId, planId: started.id },
          new Date(Date.parse(wait.until) + WAKE_MARGIN_MS),
        );
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        logger?.warn('plan wake-up not queued', {
          planId: started.id,
          stepId: step.id,
          code: typeof code === 'string' ? code : 'error',
        });
      }
    }
    logger?.info('plan wait started', { planId: started.id, stepId: step.id });
    return started;
  }

  /** A plan status change and its event, once: a change another call made is read back. */
  async function finishPlan(
    tenant: TenantContext,
    organizationId: OrganizationId,
    plan: Plan,
    to: 'completed' | 'failed',
    reason?: string,
    /** On a failure (ADR-0155): the step it stopped at, and its child's own code. */
    failed?: { readonly stepId: string; readonly cause?: string },
  ): Promise<Plan> {
    const at = now();
    try {
      return await plans.update(organizationId, plan.id, (current) => {
        const next = applyPlanStatus(current, 'executing', to, iso(at));
        return {
          plan: next,
          events: [
            buildAuditEvent(
              {
                action: 'plan.state_changed',
                result: 'success',
                actor: actorOf(tenant),
                organizationId,
                target: { type: 'plan', id: next.id },
                transition: { from: current.status, to: next.status },
                ...(reason === undefined ? {} : { reason }),
                ...(failed === undefined ? {} : { nodeId: failed.stepId }),
                ...(failed?.cause !== undefined && REFERENCE.test(failed.cause)
                  ? { reference: failed.cause }
                  : {}),
                ...(requestId === undefined ? {} : { requestId }),
                source: 'api',
              },
              at,
            ),
          ],
        };
      });
    } catch (error) {
      if (!isPlanningError(error)) throw error;
      const fresh = await plans.find(organizationId, plan.id);
      if (fresh !== undefined && fresh.status !== 'executing') return fresh;
      throw error;
    }
  }

  /** Runs one change on the planning execution; one another call already made is not an error. */
  async function settle(change: () => Promise<unknown>): Promise<void> {
    try {
      await change();
    } catch (error) {
      if (!isExecutionError(error)) throw error;
      if (
        error.code !== 'execution_concurrency_conflict' &&
        error.code !== 'execution_already_terminal'
      ) {
        throw error;
      }
    }
  }

  /**
   * The planning execution's graph follows its steps: a started child's node runs, then
   * completes with the child as its output; a decided condition's node completes with its
   * decision as its output; a skipped step's node is skipped.
   */
  async function mirror(
    tenant: TenantContext,
    parentId: ExecutionId,
    views: readonly StepView[],
  ): Promise<Execution> {
    let parent = await executions.get(tenant, parentId);
    for (const view of views) {
      const { step } = view;
      const node = parent.nodes.find((n) => n.id === step.id);
      if (node === undefined) throw new PlanningError('delegation_conflict');
      const output =
        view.child !== undefined
          ? { type: 'execution', id: view.child.id }
          : view.wait !== undefined
            ? { type: 'plan_wait', id: waitRef(view) }
            : view.condition?.decision === undefined
              ? undefined
              : { type: 'decision', id: view.condition.decision.id };
      if (view.state === 'skipped' || view.state === 'declined') {
        if (node.status === 'pending') {
          await settle(() =>
            executions.runtimePlanChangeNode(tenant, parentId, {
              nodeId: step.id,
              from: 'pending',
              to: 'skipped',
            }),
          );
        }
      } else if (view.state === 'failed' && view.retry !== true) {
        // A failed step's node fails with its child's own code, or why it failed (ADR-0155,
        // ADR-0162): the graph shows which branch failed while the others go on.
        if (node.status === 'pending') {
          await settle(() =>
            executions.runtimePlanChangeNode(tenant, parentId, {
              nodeId: step.id,
              from: 'pending',
              to: 'running',
            }),
          );
        }
        if (node.status === 'pending' || node.status === 'running') {
          await settle(() =>
            executions.runtimePlanChangeNode(tenant, parentId, {
              nodeId: step.id,
              from: 'running',
              to: 'failed',
              error: { code: view.child?.failure?.code ?? failureOf(view) },
            }),
          );
        }
      } else if (
        view.state === 'running' ||
        view.state === 'delayed' ||
        // A started child shows as running or waiting on a person alike (ADR-0155).
        (view.state === 'awaiting_approval' && view.child?.startedAt !== undefined) ||
        decided(view)
      ) {
        if (node.status === 'pending') {
          await settle(() =>
            executions.runtimePlanChangeNode(tenant, parentId, {
              nodeId: step.id,
              from: 'pending',
              to: 'running',
            }),
          );
        }
        if (decided(view) && node.status !== 'completed' && output !== undefined) {
          await settle(() =>
            executions.runtimePlanChangeNode(tenant, parentId, {
              nodeId: step.id,
              from: 'running',
              to: 'completed',
              output,
            }),
          );
        }
      } else {
        continue;
      }
      parent = await executions.get(tenant, parentId);
    }
    return parent;
  }

  /**
   * Every step completed or was skipped: the planning execution is verified with its children
   * and its decisions, and completes.
   */
  async function complete(
    tenant: TenantContext,
    parent: Execution,
    views: readonly StepView[],
  ): Promise<void> {
    if (parent.status === 'running') {
      await settle(() =>
        executions.runtimePlanChangeStatus(tenant, parent.id, { from: 'running', to: 'verifying' }),
      );
    }
    let current = await executions.get(tenant, parent.id);
    if (current.status === 'verifying' && current.verification === undefined) {
      await settle(() =>
        executions.recordVerification(tenant, parent.id, {
          correlationId: `plan-${parent.id}`,
          nodes: views.filter(decided).map((view) => ({
            nodeId: view.step.id,
            policy: 'checks',
            checks: [
              view.child !== undefined
                ? {
                    code: STEP_CHECK,
                    result: view.child.status === 'completed' ? 'passed' : 'failed',
                    evidence: { type: 'execution', id: view.child.id },
                  }
                : view.step.kind === 'wait'
                  ? {
                      code: WAIT_CHECK,
                      result: view.wait === undefined ? 'failed' : 'passed',
                      evidence: { type: 'plan_wait', id: waitRef(view) },
                    }
                  : {
                      code: CONDITION_CHECK,
                      result: view.condition?.decision === undefined ? 'failed' : 'passed',
                      evidence: {
                        type: 'decision',
                        id: view.condition?.decision?.id ?? view.step.id,
                      },
                    },
            ],
          })),
        }),
      );
      current = await executions.get(tenant, parent.id);
    }
    if (current.status === 'verifying' && current.verification?.result === 'passed') {
      await settle(() =>
        executions.runtimePlanChangeStatus(tenant, parent.id, {
          from: 'verifying',
          to: 'completed',
        }),
      );
    }
  }

  /**
   * The plan is over with a failed step (ADR-0162): the planning execution fails, pointing at the
   * first failed step's child. Its graph shows which step failed and why (ADR-0155): that step's
   * node fails with its child's own code.
   */
  async function stop(
    tenant: TenantContext,
    parent: Execution,
    code: string,
    stopped: StepView,
  ): Promise<void> {
    if (isTerminal(parent.status)) return;
    const { child } = stopped;
    const node = parent.nodes.find((n) => n.id === stopped.step.id);
    if (node?.status === 'running') {
      await settle(() =>
        executions.runtimePlanChangeNode(tenant, parent.id, {
          nodeId: stopped.step.id,
          from: 'running',
          to: 'failed',
          error: { code: child?.failure?.code ?? code },
        }),
      );
    }
    await settle(() =>
      executions.runtimePlanChangeStatus(tenant, parent.id, {
        from: parent.status,
        to: 'failed',
        failure: {
          code,
          ...(child === undefined ? {} : { ref: { type: 'execution', id: child.id } }),
        },
      }),
    );
  }

  /** `advance`, or `resume` when `withConditions` is false: see `PlanConductor`. */
  async function proceed(tenant: TenantContext, planId: string, withConditions: boolean) {
    const organizationId = organizationOf(tenant);
    if (tenant.actor !== 'runtime') throw new PlanningError('permission_denied', 'runtime_only');
    const loaded = await load(organizationId, planId);
    const { version } = loaded;
    let plan = loaded.plan;
    if (plan.status !== 'executing' || plan.delegationState !== 'completed') return plan;
    const current = await executions.get(tenant, plan.executionId);
    if (current.status === 'cancelled') {
      return (await plans.find(organizationId, plan.id)) ?? plan;
    }
    let views = await stepsOf(tenant, plan, version);
    // A step whose approval was declined is recorded first: its branch is skipped.
    if (views.some((v) => (v.declines ?? []).length > 0)) {
      plan = await recordDeclines(tenant, organizationId, plan, views);
      if (plan.status !== 'executing') return plan;
      views = await stepsOf(tenant, plan, version);
    }

    // A step that failed for a passing reason runs again, when the plan asked (ADR-0153).
    const retrying = views.filter((v) => v.retry === true);
    // Only the worker runs a step again; anywhere else the plan is left for it, never stopped.
    if (retrying.length > 0 && (attempts === undefined || wakeups === undefined)) return plan;
    for (const view of retrying) {
      plan = await retryStep(tenant, organizationId, plan, version, view);
      if (plan.status !== 'executing') return plan;
    }
    if (retrying.length > 0) views = await stepsOf(tenant, plan, version);

    // Conditions whose steps before them completed are decided one at a time, in order, until
    // none is ready or one stops the plan: a decision may make the next condition ready. On a
    // resume, they are left to the worker, which always advances after a step ends.
    // A failed step ends only its own branch (ADR-0162): the others go on.
    while (withConditions) {
      const ready = views.find((v) => v.step.kind === 'condition' && readyIn(views, v));
      if (ready === undefined) break;
      plan = await decide(tenant, organizationId, plan, ready.step);
      if (plan.status !== 'executing') return plan;
      views = await stepsOf(tenant, plan, version);
      logger?.info('plan condition decided', { planId: plan.id, stepId: ready.step.id });
    }

    // Waits whose steps before them completed start, each once (ADR-0152). On a resume there is
    // no wake-up: they are left to the worker, which always advances after a step ends.
    if (wakeups !== undefined) {
      const ready = views.filter((v) => v.step.kind === 'wait' && readyIn(views, v));
      for (const view of ready) {
        plan = await startWait(tenant, organizationId, plan, view.step);
        if (plan.status !== 'executing') return plan;
      }
      if (ready.length > 0) views = await stepsOf(tenant, plan, version);
    }

    // A ready step the approved budget cannot cover, with nothing left running, is blocked
    // (ADR-0163): it never starts, and its branch ends as a failed one does.
    const { blocked } = await budgetFor(tenant, plan, version, views);
    if (blocked.length > 0) {
      plan = await blockOverBudget(tenant, organizationId, plan, blocked);
      if (plan.status !== 'executing') return plan;
      views = await stepsOf(tenant, plan, version);
    }

    // A failed step ends its own branch (ADR-0162). The plan fails once every branch failed:
    // nothing it could still run reaches a step that is not lost, so nothing else starts and what
    // waits for a person is withdrawn. Once every step is over and a branch did not fail, it
    // completes with its failed branch shown. Either way its execution records the failure, since
    // a graph with a failed node never verifies (ADR-0029).
    const failed = views.find((v) => v.state === 'failed' && v.retry !== true);
    const whole = failed !== undefined && everyBranchFailed(views);
    if (failed !== undefined && (whole || views.every(over))) {
      const code = whole ? failureOf(failed) : BRANCH_FAILED;
      if (whole) {
        for (const view of views) {
          if (view.state !== 'awaiting_approval' && view.state !== 'waiting') continue;
          // A started step's approval is the gate's own, on its child: not the plan's to withdraw.
          if (view.child?.startedAt !== undefined) continue;
          for (const entry of stepApprovalEntriesOf(plan, view.step.id)) {
            if (entry.declined === undefined && approvals !== undefined) {
              await approvals.cancel(tenant, entry.approvalId, 'plan_ended');
            }
          }
        }
      }
      await stop(tenant, await mirror(tenant, plan.executionId, views), code, failed);
      logger?.info(whole ? 'plan stopped' : 'plan completed with a failed branch', {
        planId: plan.id,
        stepId: failed.step.id,
        code,
      });
      return finishPlan(tenant, organizationId, plan, whole ? 'failed' : 'completed', code, {
        stepId: failed.step.id,
        ...(failed.child?.failure === undefined ? {} : { cause: failed.child.failure.code }),
      });
    }
    if (views.every((v) => decided(v) || v.state === 'skipped' || v.state === 'declined')) {
      // Every step was declined or skipped: nothing ran, so there is nothing to verify. The plan
      // ends failed with that reason, never stuck verifying an empty graph (ADR-0185).
      if (!views.some(decided)) {
        const parent = await mirror(tenant, plan.executionId, views);
        if (!isTerminal(parent.status)) {
          await settle(() =>
            executions.runtimePlanChangeStatus(tenant, parent.id, {
              from: parent.status,
              to: 'failed',
              failure: { code: NOTHING_RAN },
            }),
          );
        }
        logger?.info('plan ended with nothing run', { planId: plan.id });
        return finishPlan(tenant, organizationId, plan, 'failed', NOTHING_RAN);
      }
      await complete(tenant, await mirror(tenant, plan.executionId, views), views);
      const closed = await executions.get(tenant, plan.executionId);
      if (closed.status !== 'completed') return plan;
      logger?.info('plan completed', { planId: plan.id });
      return finishPlan(tenant, organizationId, plan, 'completed');
    }
    await startReady(tenant, plan, version, views);
    // The graph shows what just started too.
    await mirror(tenant, plan.executionId, await stepsOf(tenant, plan, version));
    return plan;
  }

  return Object.freeze({
    async run(tenant: TenantContext, planId: string) {
      const organizationId = organizationOf(tenant);
      if (tenant.actor !== 'user' && tenant.actor !== 'runtime') {
        throw new PlanningError('permission_denied', 'person_only');
      }
      const { plan, version } = await load(organizationId, planId);
      // The runtime starts only a plan its own person's schedule approved (ADR-0185).
      if (
        tenant.actor === 'runtime' &&
        (plan.decision?.via !== 'schedule' || plan.decision.decidedBy !== tenant.userId)
      ) {
        throw new PlanningError('permission_denied', 'person_only');
      }
      const unrunnable = unrunnableStepOf(version);
      if (unrunnable !== undefined) throw new PlanningError('plan_not_runnable', unrunnable);
      if (plan.status !== 'approved' && plan.status !== 'executing') {
        throw new PlanningError('invalid_plan_transition');
      }
      if (delegation === undefined) throw new PlanningError('permission_denied', 'no_delegation');
      const { plan: delegated } = await delegation.delegate(tenant, plan.id);
      if (delegated.status !== 'executing') return delegated;
      // Conditions wait on at least one step, so none is ready yet: the runtime decides them.
      await startReady(tenant, delegated, version, await stepsOf(tenant, delegated, version));
      logger?.info('plan started', { planId: delegated.id });
      return delegated;
    },

    advance: (tenant: TenantContext, planId: string) => proceed(tenant, planId, true),

    resume: (tenant: TenantContext, planId: string) => proceed(tenant, planId, false),

    async abandon(tenant: TenantContext, planId: string, input: AbandonScheduled) {
      if (delegation === undefined) throw new PlanningError('permission_denied', 'no_delegation');
      return delegation.abandon(tenant, planId, input);
    },

    async releaseManual(tenant: TenantContext, planId: string, input: ReleaseManual) {
      if (delegation === undefined) throw new PlanningError('permission_denied', 'no_delegation');
      return delegation.releaseManual(tenant, planId, input);
    },

    async closeFailed(tenant: TenantContext, planId: string) {
      if (delegation === undefined) throw new PlanningError('permission_denied', 'no_delegation');
      return delegation.closeFailed(tenant, planId);
    },
  });
}
