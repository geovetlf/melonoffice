/**
 * HANDOFF_TO_HUMAN (ADR-0101): when a task should go to a person, and why. Only the decision and
 * its reason, as a closed code: who the person is and how they are told is the surface's (the
 * inbox's hand-off for a conversation, ADR-0043; the task's screen for an agent task). No queue,
 * assignment or notification system is built here.
 */
export const HANDOFF_TO_HUMAN = 'HANDOFF_TO_HUMAN';

export type HandoffReason =
  /** The person asked for a person. */
  | 'person_requested'
  /** The agent said what it needs and does not have. */
  | 'missing_information'
  /** More credits, or a person's approval, are needed to go on. */
  | 'authorization_required'
  /** It failed after the runtime's own retries, or nobody knows whether it ran. */
  | 'repeated_error'
  /** The planner could not make a plan, or its plan was refused. */
  | 'plan_failed'
  /** A plan that must not run as it is (limits, a loop). */
  | 'policy';

export interface HandoffToHuman {
  readonly type: typeof HANDOFF_TO_HUMAN;
  readonly reason: HandoffReason;
  /** The code that led to it, when there is one (a failure code, a limit). */
  readonly code: string | null;
}

export const handoffTo = (reason: HandoffReason, code: string | null = null): HandoffToHuman =>
  Object.freeze({ type: HANDOFF_TO_HUMAN, reason, code });

/** Failures a person unlocks: budget, balance, or an approval that lapsed. */
const NEEDS_AUTHORIZATION = new Set([
  'credit_limit_exceeded',
  'credits_insufficient',
  'credits_unavailable',
  'approval_expired',
]);

/**
 * Whether a finished or stopped task should go to a person. A task a person cancelled, or whose
 * approval a person rejected, stays with that person's decision: no hand-off. A running task has
 * none yet.
 */
export function handoffForTask(outcome: {
  readonly status: string;
  readonly failure: string | null;
  readonly missing: readonly string[];
}): HandoffToHuman | null {
  const { status, failure, missing } = outcome;
  if (status === 'failed') {
    if (failure === 'approval_rejected') return null;
    if (failure !== null && NEEDS_AUTHORIZATION.has(failure)) {
      return handoffTo('authorization_required', failure);
    }
    return handoffTo('repeated_error', failure);
  }
  if (status === 'waiting_approval')
    return handoffTo('authorization_required', 'approval_required');
  if (status === 'completed' && missing.length > 0) return handoffTo('missing_information');
  return null;
}
