/**
 * Why a planning operation was refused. Stable codes, safe to log. Another organization's plan
 * is `plan_not_found`, exactly like one that does not exist.
 */
export type PlanningErrorCode =
  | 'unresolved_tenant'
  | 'organization_inactive'
  | 'permission_denied'
  | 'plan_not_found'
  | 'invalid_plan'
  | 'invalid_plan_transition'
  | 'plan_concurrency_conflict'
  | 'plan_version_mismatch'
  | 'gia_cannot_decide'
  | 'runtime_cannot_decide'
  | 'execution_not_plannable'
  | 'specialist_not_eligible'
  | 'delegation_conflict'
  | 'delegation_in_progress'
  | 'delegation_failed'
  | 'plan_not_runnable'
  | 'plan_not_abandonable';

export class PlanningError extends Error {
  override readonly name = 'PlanningError';

  constructor(
    readonly code: PlanningErrorCode,
    /** Which field or rule. A code, never user data. */
    readonly detail?: string,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
  }
}

export const isPlanningError = (error: unknown): error is PlanningError =>
  error instanceof PlanningError;
