/**
 * Why an execution operation was refused. Stable codes, safe to log. Tenancy and RBAC keep
 * their own codes (`organization_forbidden`, `permission_denied`); an execution of another
 * organization is `execution_not_found`, exactly like one that does not exist.
 */
export type ExecutionErrorCode =
  | 'unresolved_tenant'
  | 'organization_inactive'
  | 'invalid_execution'
  | 'execution_not_found'
  | 'invalid_execution_transition'
  | 'execution_already_terminal'
  | 'execution_concurrency_conflict'
  | 'specialist_not_eligible'
  | 'permission_denied'
  | 'actor_not_allowed'
  | 'execution_not_started'
  | 'execution_parent_ended'
  | 'verification_required'
  | 'verification_policy_not_available'
  | 'retry_not_allowed';

export class ExecutionError extends Error {
  override readonly name = 'ExecutionError';

  constructor(
    readonly code: ExecutionErrorCode,
    /** Which field or rule, for `invalid_execution`. A code, never user data. */
    readonly detail?: string,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
  }
}

export const isExecutionError = (error: unknown): error is ExecutionError =>
  error instanceof ExecutionError;
