import type {
  ExecutionId,
  IsoTimestamp,
  OrganizationId,
  Plan,
  PlanConditionResult,
  PlanDecision,
  PlanDelegation,
  PlanDelegationState,
  PlanId,
  PlanSource,
  PlanStatus,
  PlanStepApproval,
  PlanVersion,
  PlanWait,
  UserId,
} from '@melonoffice/domain';
import { isExecutionId } from '@melonoffice/execution';
import { digestOf, isDigest, sameDigest } from '@melonoffice/tools';
import { PlanningError } from './errors.js';
import { canChangePlanStatus, isPlanStatus, isPlanTerminal } from './lifecycle.js';
import { checkProposal } from './proposal.js';
import type { ValidatedPlan } from './validate.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[a-z][a-z_]{0,63}$/;

export const isPlanId = (value: unknown): value is PlanId =>
  typeof value === 'string' && UUID.test(value);

const invalid = (detail: string): never => {
  throw new PlanningError('invalid_plan', detail);
};

/** What a plan version's digest covers: everything it says, nothing about when or who. */
const contentOf = (v: Omit<PlanVersion, 'digest' | 'createdAt' | 'createdBy'>) => ({
  planId: v.planId,
  organizationId: v.organizationId,
  version: v.version,
  request: v.request,
  steps: v.steps,
  riskLevel: v.riskLevel,
  approvalRequired: v.approvalRequired,
  estimate: v.estimate,
  source: v.source,
});

const deepFreeze = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value;
};

/** A new plan and its first version, as the pipeline validated it. */
export interface PlanWrite {
  readonly plan: Plan;
  readonly version: PlanVersion;
}

export interface NewPlan {
  readonly organizationId: OrganizationId;
  readonly executionId: ExecutionId;
  readonly validated: ValidatedPlan;
  readonly source: PlanSource;
}

/**
 * Builds a plan at version 1 from a validated plan (ADR-0028). It starts `approval_required`
 * when any step or its risk needs a human, or when a workflow made it (ADR-0071), and `ready`
 * otherwise: only validated plans are ever stored, so none is kept in `draft`.
 *
 * A plan's id is its planning execution's id: one execution has at most one plan, and storing a
 * second one for it is refused as a conflict. A changed plan is a new version of the same plan.
 */
export function newPlan(request: NewPlan, by: UserId, at: IsoTimestamp): PlanWrite {
  const id = request.executionId as string as PlanId;
  const { validated } = request;
  // A workflow's plan always waits for a person (ADR-0071): a template never runs by itself.
  const approvalRequired = validated.approvalRequired || request.source.kind === 'workflow';
  const content = {
    planId: id,
    organizationId: request.organizationId,
    version: 1,
    request: validated.request,
    steps: validated.steps,
    riskLevel: validated.riskLevel,
    approvalRequired,
    estimate: validated.estimate,
    source: request.source,
  };
  const version: PlanVersion = deepFreeze(
    structuredClone({
      ...content,
      digest: digestOf(contentOf(content)),
      createdAt: at,
      createdBy: by,
    }),
  );
  const plan: Plan = Object.freeze({
    id,
    organizationId: request.organizationId,
    executionId: request.executionId,
    status: approvalRequired ? 'approval_required' : 'ready',
    version: 1,
    delegations: Object.freeze([]),
    revision: 1,
    createdAt: at,
    createdBy: by,
    updatedAt: at,
  });
  return { plan, version };
}

const later = (plan: Plan, at: IsoTimestamp): IsoTimestamp =>
  Date.parse(at) >= Date.parse(plan.updatedAt) ? at : plan.updatedAt;

/**
 * Moves a plan to another status, or refuses without changing anything: the plan must still be
 * in `from`, and the table must allow the move.
 */
export function applyPlanStatus(
  plan: Plan,
  from: PlanStatus,
  to: PlanStatus,
  at: IsoTimestamp,
): Plan {
  if (plan.status !== from) throw new PlanningError('plan_concurrency_conflict');
  if (!canChangePlanStatus(from, to)) throw new PlanningError('invalid_plan_transition');
  return Object.freeze({
    ...plan,
    status: to,
    revision: plan.revision + 1,
    updatedAt: later(plan, at),
  });
}

/**
 * Records a user's decision on exactly one version (ADR-0028). The decision names the version
 * and digest the user saw: a plan that changed since is `plan_version_mismatch`, so an approval
 * can never cover content nobody looked at.
 */
export function decidePlan(
  plan: Plan,
  current: PlanVersion,
  decision: PlanDecision['decision'],
  seen: { readonly version: number; readonly digest: string },
  by: UserId,
  at: IsoTimestamp,
): Plan {
  if (plan.status !== 'approval_required') {
    throw new PlanningError(
      isPlanTerminal(plan.status) ? 'invalid_plan_transition' : 'plan_concurrency_conflict',
    );
  }
  if (
    current.planId !== plan.id ||
    current.version !== plan.version ||
    seen.version !== plan.version ||
    !sameDigest(seen.digest, current.digest)
  ) {
    throw new PlanningError('plan_version_mismatch');
  }
  const next = applyPlanStatus(plan, 'approval_required', decision, at);
  return Object.freeze({
    ...next,
    decision: Object.freeze({
      decision,
      version: current.version,
      digest: current.digest,
      decidedBy: by,
      decidedAt: next.updatedAt,
    }),
  });
}

const DELEGATION_STATES: readonly PlanDelegationState[] = [
  'creating',
  'created',
  'completed',
  'failed',
];

const nextRevision = (plan: Plan, at: IsoTimestamp): Plan =>
  Object.freeze({ ...plan, revision: plan.revision + 1, updatedAt: later(plan, at) });

/**
 * Records a delegation set before any child exists (ADR-0028): one entry per specialist step,
 * each with its deterministic child id. From here the delegation is `creating`, and every retry
 * resumes this exact set. The plan keeps its status until every child exists.
 */
export function beginDelegation(
  plan: Plan,
  delegations: readonly PlanDelegation[],
  at: IsoTimestamp,
): Plan {
  if (plan.status !== 'ready' && plan.status !== 'approved') {
    throw new PlanningError('invalid_plan_transition');
  }
  if (plan.delegationState !== undefined || plan.delegations.length > 0) {
    throw new PlanningError('delegation_conflict');
  }
  return Object.freeze({
    ...nextRevision(plan, at),
    delegations: Object.freeze(delegations.map((d) => Object.freeze({ ...d }))),
    delegationState: 'creating',
  });
}

/** Every child of a `creating` delegation exists: the plan is now `executing`. */
export function markDelegated(plan: Plan, at: IsoTimestamp): Plan {
  if (plan.delegationState !== 'creating') throw new PlanningError('plan_concurrency_conflict');
  return Object.freeze({
    ...applyPlanStatus(plan, plan.status, 'executing', at),
    delegationState: 'created',
  });
}

/** The planning execution of a `created` delegation is `running`: nothing is left to do. */
export function completeDelegation(plan: Plan, at: IsoTimestamp): Plan {
  if (plan.delegationState !== 'created') throw new PlanningError('plan_concurrency_conflict');
  return Object.freeze({ ...nextRevision(plan, at), delegationState: 'completed' });
}

/** A `creating` delegation that cannot finish: the plan fails, with a stable code saying why. */
export function failDelegation(plan: Plan, reason: string, at: IsoTimestamp): Plan {
  if (plan.delegationState !== 'creating') throw new PlanningError('plan_concurrency_conflict');
  if (!isPlanReason(reason)) invalid('delegationFailure');
  return Object.freeze({
    ...applyPlanStatus(plan, plan.status, 'failed', at),
    delegationState: 'failed',
    delegationFailure: reason,
  });
}

/**
 * Checks a stored plan before it is trusted: a record that fails is refused, never repaired.
 */
export function checkStoredPlan(plan: Plan): Plan {
  if (!isPlanId(plan.id)) invalid('id');
  if (!isExecutionId(plan.executionId)) invalid('executionId');
  if (!isPlanStatus(plan.status)) invalid('status');
  if (!Number.isSafeInteger(plan.version) || plan.version < 1) invalid('version');
  if (!Number.isSafeInteger(plan.revision) || plan.revision < 1) invalid('revision');
  if (!Array.isArray(plan.delegations)) invalid('delegations');
  for (const d of plan.delegations) {
    if (typeof d.stepId !== 'string' || !isExecutionId(d.executionId)) invalid('delegations');
  }
  if (new Set(plan.delegations.map((d) => d.stepId)).size !== plan.delegations.length) {
    invalid('delegations');
  }
  checkDelegationState(plan);
  if (plan.conditions !== undefined) {
    if (!Array.isArray(plan.conditions)) invalid('conditions');
    for (const c of plan.conditions) checkConditionResult(c);
    if (new Set(plan.conditions.map((c) => c.stepId)).size !== plan.conditions.length) {
      invalid('conditions');
    }
  }
  if (plan.stepApprovals !== undefined) {
    if (!Array.isArray(plan.stepApprovals)) invalid('stepApprovals');
    for (const a of plan.stepApprovals) checkStepApproval(a);
    if (new Set(plan.stepApprovals.map((a) => a.stepId)).size !== plan.stepApprovals.length) {
      invalid('stepApprovals');
    }
  }
  if (plan.waits !== undefined) {
    if (!Array.isArray(plan.waits)) invalid('waits');
    for (const w of plan.waits) checkWait(w);
    if (new Set(plan.waits.map((w) => w.stepId)).size !== plan.waits.length) invalid('waits');
  }
  const { decision } = plan;
  if (decision !== undefined) {
    if (decision.decision !== 'approved' && decision.decision !== 'rejected') invalid('decision');
    if (!isDigest(decision.digest)) invalid('decision.digest');
  }
  // An approved plan, and every plan that ran after one, carries the decision it ran under.
  if (plan.status === 'approved' && decision?.decision !== 'approved') invalid('decision');
  if (plan.status === 'rejected' && decision?.decision !== 'rejected') invalid('decision');
  return plan;
}

/**
 * Checks a stored plan version: its digest must still match its content, and its steps must
 * still pass the proposal schema. A version whose content changed after it was written is
 * refused: it is never shown, approved or delegated.
 */
export function checkStoredPlanVersion(version: PlanVersion): PlanVersion {
  if (!isPlanId(version.planId)) invalid('planId');
  if (!Number.isSafeInteger(version.version) || version.version < 1) invalid('version');
  if (!isDigest(version.digest) || !sameDigest(digestOf(contentOf(version)), version.digest)) {
    invalid('digest');
  }
  if (!Array.isArray(version.steps) || version.steps.length === 0) invalid('steps');
  // Stored steps carry system fields (specialist, estimate…) a proposal cannot; check the ids.
  const ids = new Set(version.steps.map((s) => s.id));
  if (ids.size !== version.steps.length) invalid('steps');
  const request = checkProposal({
    summary: version.request.summary,
    objective: version.request.objective,
    steps: [{ id: 'check', kind: 'parallel', label: 'check', dependsOn: [] }],
  });
  if (!request.ok) invalid('request');
  return version;
}

/**
 * A delegation's state must agree with the plan: nothing delegated before `creating`; a
 * `creating` plan still `ready` or `approved` (it cannot be cancelled mid-way); a `created` or `completed` one `executing` or
 * ended after it; a `failed` one `failed`, with its reason.
 */
function checkDelegationState(plan: Plan): void {
  const state = plan.delegationState;
  if (state === undefined) {
    if (plan.delegations.length > 0 || plan.delegationFailure !== undefined) invalid('delegations');
    return;
  }
  if (!DELEGATION_STATES.includes(state)) invalid('delegationState');
  if ((state === 'failed') !== (plan.delegationFailure !== undefined)) {
    invalid('delegationFailure');
  }
  if (plan.delegationFailure !== undefined && !isPlanReason(plan.delegationFailure)) {
    invalid('delegationFailure');
  }
  const allowed: Readonly<Record<PlanDelegationState, readonly PlanStatus[]>> = {
    creating: ['ready', 'approved'],
    created: ['executing', 'completed', 'failed', 'cancelled'],
    completed: ['executing', 'completed', 'failed', 'cancelled'],
    failed: ['failed'],
  };
  if (!allowed[state].includes(plan.status)) invalid('delegationState');
}

const CONDITION_RESULTS: readonly PlanConditionResult['result'][] = [
  'continue',
  'stop',
  'await_approval',
  'failed',
];
const DECISION_ID = /^dec_[0-9a-f]{32}$/;
const DECISION_TYPE = /^[a-z][a-z_]*(\.[a-z][a-z_]*)+$/;
const OUTCOME = /^[a-z][a-z0-9_]{0,63}$/;

/** A condition's result must say what happened and, when a decision was made, which one. */
function checkConditionResult(result: PlanConditionResult): void {
  if (typeof result.stepId !== 'string' || result.stepId.length === 0) invalid('conditions');
  if (!CONDITION_RESULTS.includes(result.result)) invalid('conditions');
  if ((result.result === 'failed') !== (result.failure !== undefined)) invalid('conditions');
  if (result.failure !== undefined && !isPlanReason(result.failure)) invalid('conditions');
  // A decision was made for every result but a failure; a failure may still name one.
  if (result.result !== 'failed' && result.decision === undefined) invalid('conditions');
  const { decision } = result;
  if (
    decision !== undefined &&
    (!DECISION_ID.test(decision.id) ||
      !DECISION_TYPE.test(decision.type) ||
      !Number.isSafeInteger(decision.version) ||
      decision.version < 1 ||
      !OUTCOME.test(decision.outcome))
  ) {
    invalid('conditions');
  }
}

/**
 * Records what a condition step did (WF-4, ADR-0075), once: a plan that already holds a result
 * for that step is a concurrent evaluation, and the result already recorded stands.
 */
export function recordCondition(
  plan: Plan,
  result: Omit<PlanConditionResult, 'evaluatedAt'>,
  at: IsoTimestamp,
): Plan {
  if (plan.status !== 'executing') throw new PlanningError('invalid_plan_transition');
  if ((plan.conditions ?? []).some((c) => c.stepId === result.stepId)) {
    throw new PlanningError('plan_concurrency_conflict');
  }
  const next = nextRevision(plan, at);
  const recorded: PlanConditionResult = Object.freeze({
    stepId: result.stepId,
    result: result.result,
    ...(result.decision === undefined ? {} : { decision: Object.freeze({ ...result.decision }) }),
    ...(result.failure === undefined ? {} : { failure: result.failure }),
    evaluatedAt: next.updatedAt,
  });
  checkConditionResult(recorded);
  return Object.freeze({
    ...next,
    conditions: Object.freeze([...(plan.conditions ?? []), recorded]),
  });
}

/** A started wait names its step and two instants, the second after the first. */
function checkWait(wait: PlanWait): void {
  if (typeof wait.stepId !== 'string' || wait.stepId.length === 0) invalid('waits');
  const started = typeof wait.startedAt === 'string' ? Date.parse(wait.startedAt) : NaN;
  const until = typeof wait.until === 'string' ? Date.parse(wait.until) : NaN;
  if (Number.isNaN(started) || Number.isNaN(until) || until <= started) invalid('waits');
}

/**
 * Records that a wait step started (ADR-0152), once: it lasts `seconds` from this write. A plan
 * that already holds one for that step is a concurrent start, and the one recorded stands.
 */
export function recordWait(
  plan: Plan,
  entry: { readonly stepId: string; readonly seconds: number },
  at: IsoTimestamp,
): Plan {
  if (plan.status !== 'executing') throw new PlanningError('invalid_plan_transition');
  if ((plan.waits ?? []).some((w) => w.stepId === entry.stepId)) {
    throw new PlanningError('plan_concurrency_conflict');
  }
  if (!Number.isSafeInteger(entry.seconds) || entry.seconds < 1) invalid('waits');
  const next = nextRevision(plan, at);
  const until = new Date(Date.parse(next.updatedAt) + entry.seconds * 1000).toISOString();
  const recorded: PlanWait = Object.freeze({
    stepId: entry.stepId,
    startedAt: next.updatedAt,
    until: until as IsoTimestamp,
  });
  checkWait(recorded);
  return Object.freeze({ ...next, waits: Object.freeze([...(plan.waits ?? []), recorded]) });
}

/** A step's approval names its step and the approval, nothing else. */
function checkStepApproval(entry: PlanStepApproval): void {
  if (typeof entry.stepId !== 'string' || entry.stepId.length === 0) invalid('stepApprovals');
  if (typeof entry.approvalId !== 'string' || !UUID.test(entry.approvalId)) {
    invalid('stepApprovals');
  }
  if (typeof entry.requestedAt !== 'string' || Number.isNaN(Date.parse(entry.requestedAt))) {
    invalid('stepApprovals');
  }
  if (
    entry.performedBy !== undefined &&
    (typeof entry.performedBy !== 'string' || entry.performedBy.length === 0)
  ) {
    invalid('stepApprovals');
  }
  const { declined } = entry;
  if (
    declined !== undefined &&
    (!CODE.test(declined.reason) ||
      typeof declined.at !== 'string' ||
      Number.isNaN(Date.parse(declined.at)))
  ) {
    invalid('stepApprovals');
  }
}

/**
 * Records that a step's approval was declined (rejected, expired or withdrawn), once: the step
 * never runs and its branch is skipped (ADR-0146).
 */
export function recordStepDeclined(
  plan: Plan,
  stepId: string,
  reason: string,
  at: IsoTimestamp,
): Plan {
  if (plan.status !== 'executing') throw new PlanningError('invalid_plan_transition');
  const entry = (plan.stepApprovals ?? []).find((a) => a.stepId === stepId);
  if (entry === undefined) throw new PlanningError('invalid_plan', 'stepApprovals');
  if (entry.declined !== undefined) throw new PlanningError('plan_concurrency_conflict');
  const next = nextRevision(plan, at);
  const declined: PlanStepApproval = Object.freeze({
    ...entry,
    declined: Object.freeze({ reason, at: next.updatedAt }),
  });
  checkStepApproval(declined);
  return Object.freeze({
    ...next,
    stepApprovals: Object.freeze(
      (plan.stepApprovals ?? []).map((a) => (a.stepId === stepId ? declined : a)),
    ),
  });
}

/**
 * Records the approval a step asked for (ADR-0146), once: one approval per step (ADR-0026, one
 * per node). A plan that already holds one for that step is a concurrent request, and the one
 * already recorded stands.
 */
export function recordStepApproval(
  plan: Plan,
  entry: { readonly stepId: string; readonly approvalId: string; readonly performedBy?: string },
  at: IsoTimestamp,
): Plan {
  if (plan.status !== 'executing') throw new PlanningError('invalid_plan_transition');
  if ((plan.stepApprovals ?? []).some((a) => a.stepId === entry.stepId)) {
    throw new PlanningError('plan_concurrency_conflict');
  }
  const next = nextRevision(plan, at);
  const recorded: PlanStepApproval = Object.freeze({
    stepId: entry.stepId,
    approvalId: entry.approvalId,
    requestedAt: next.updatedAt,
    ...(entry.performedBy === undefined ? {} : { performedBy: entry.performedBy }),
  });
  checkStepApproval(recorded);
  return Object.freeze({
    ...next,
    stepApprovals: Object.freeze([...(plan.stepApprovals ?? []), recorded]),
  });
}

/** A cancellation or failure code, as the audit log stores it. */
export const isPlanReason = (value: unknown): value is string =>
  typeof value === 'string' && CODE.test(value);
