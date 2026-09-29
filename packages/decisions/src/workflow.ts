import type { DecisionResult } from './model.js';

/**
 * Decisions inside workflows (ADR-0065). A workflow's `condition` node (ADR-0031 keeps it
 * refused by the runtime until its behaviour is defined) will name a decision type and the
 * outcomes that let the workflow go on. This is that contract, so the runtime can adopt it
 * without a second decision path: the decision is evaluated through the engine (audited), and
 * the node reads only its outcome and whether it needs approval.
 */
export interface WorkflowCondition {
  /** The decision type to evaluate, e.g. `action.policy_check`. */
  readonly decision: string;
  /** Outcomes that let the workflow continue. Any other stops it. */
  readonly continueOn: readonly string[];
}

export type WorkflowStep =
  /** The next node may run. */
  | 'continue'
  /** The next node waits for an approval (the approval node, ADR-0026). */
  | 'await_approval'
  /** The workflow goes no further along this path. */
  | 'stop';

/** What a condition node does with a decision. Approval always wins: it is never skipped. */
export function workflowStepOf(condition: WorkflowCondition, result: DecisionResult): WorkflowStep {
  if (result.type !== condition.decision) return 'stop';
  if (!condition.continueOn.includes(result.outcome)) return 'stop';
  return result.requiredApproval ? 'await_approval' : 'continue';
}
