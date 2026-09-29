import type { TenantContext } from '@melonoffice/tenancy';
import type { DecisionEngine } from './engine.js';
import { isDecisionError, type DecisionResult } from './model.js';

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

/** A plan's decision condition (WF-4): the workflow contract plus the decision's fixed input. */
export interface PlanDecisionInput extends WorkflowCondition {
  readonly input?: Readonly<Record<string, string | number | boolean>>;
}

/** What a plan's condition step did, as the plan conductor records it (ADR-0075). */
export type PlanConditionOutcome =
  | {
      readonly result: WorkflowStep;
      readonly decision: {
        readonly id: string;
        readonly type: string;
        readonly version: number;
        readonly outcome: string;
      };
    }
  | { readonly result: 'failed'; readonly failure: string };

/**
 * The plan conductor's condition evaluator (WF-4, ADR-0075), over this engine: the decision is
 * made as the tenant the conductor gives (the runtime of the person the plan runs for, so their
 * permissions and reach apply), audited as any decision, and read only through
 * `workflowStepOf`. A decision the engine refuses (unknown type, bad input, a permission the
 * person lacks, a decider not set up here) is a `failed` result with its code, so the plan
 * stops and says why. Anything else is thrown: the condition stays undecided.
 */
export function planConditionEvaluator(engine: Pick<DecisionEngine, 'evaluateDecision'>): {
  evaluate(
    tenant: TenantContext,
    condition: PlanDecisionInput,
    requestId?: string,
  ): Promise<PlanConditionOutcome>;
} {
  return Object.freeze({
    async evaluate(tenant: TenantContext, condition: PlanDecisionInput, requestId?: string) {
      let result: DecisionResult;
      try {
        result = await engine.evaluateDecision(tenant, {
          type: condition.decision,
          ...(condition.input === undefined ? {} : { input: condition.input }),
          ...(requestId === undefined ? {} : { requestId }),
        });
      } catch (error) {
        if (isDecisionError(error)) {
          return Object.freeze({ result: 'failed' as const, failure: `condition_${error.code}` });
        }
        throw error;
      }
      return Object.freeze({
        result: workflowStepOf(condition, result),
        decision: Object.freeze({
          id: result.id,
          type: result.type,
          version: result.version,
          outcome: result.outcome,
        }),
      });
    },
  });
}
