/**
 * Why a job operation was refused (ADR-0030). Stable codes, safe to log. A job of another
 * organization is `job_not_found`, exactly like one that does not exist.
 */
export type JobErrorCode =
  | 'invalid_job'
  | 'unresolved_tenant'
  | 'organization_inactive'
  | 'actor_not_allowed'
  | 'permission_denied'
  | 'job_not_found'
  | 'execution_not_found'
  | 'execution_not_runnable'
  | 'execution_not_ended'
  | 'node_not_runnable'
  | 'job_forbidden'
  | 'job_attempt_mismatch'
  | 'job_lease_held'
  | 'job_lease_expired'
  | 'job_lease_mismatch'
  | 'job_revision_mismatch'
  | 'job_terminal'
  | 'job_cancelled'
  | 'job_concurrency_conflict';

export class JobError extends Error {
  override readonly name = 'JobError';

  constructor(
    readonly code: JobErrorCode,
    /** Which field or rule. A code, never user data. */
    readonly detail?: string,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
  }
}

export const isJobError = (error: unknown): error is JobError => error instanceof JobError;
