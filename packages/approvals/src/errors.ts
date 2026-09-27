/**
 * Why an approval operation was refused. Stable codes, safe to log. Another organization's
 * approval is `approval_not_found`, exactly like one that does not exist.
 */
export type ApprovalErrorCode =
  | 'unresolved_tenant'
  | 'organization_inactive'
  | 'invalid_approval'
  | 'approval_not_found'
  | 'approval_not_pending'
  | 'approval_expired'
  | 'approval_forbidden'
  | 'approval_concurrency_conflict';

export class ApprovalError extends Error {
  override readonly name = 'ApprovalError';

  constructor(
    readonly code: ApprovalErrorCode,
    /** Which field or rule, for `invalid_approval`. A code, never user data. */
    readonly detail?: string,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
  }
}

export const isApprovalError = (error: unknown): error is ApprovalError =>
  error instanceof ApprovalError;
