/**
 * Why a workflow operation was refused. Stable codes, safe to log. Another organization's
 * workflow is `workflow_not_found`, exactly like one that does not exist.
 */
export type WorkflowErrorCode =
  | 'unresolved_tenant'
  | 'organization_inactive'
  | 'permission_denied'
  | 'workflow_not_found'
  | 'invalid_workflow'
  | 'invalid_workflow_transition'
  | 'workflow_concurrency_conflict'
  | 'workflow_not_active'
  | 'assignee_unavailable'
  | 'workflow_plan_ended';

export class WorkflowError extends Error {
  override readonly name = 'WorkflowError';

  constructor(
    readonly code: WorkflowErrorCode,
    /** Which field or rule. A code, never user data. */
    readonly detail?: string,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
  }
}

export const isWorkflowError = (error: unknown): error is WorkflowError =>
  error instanceof WorkflowError;
