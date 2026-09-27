/**
 * Why the runtime refused a request (ADR-0031). Stable codes, safe to log. Refusals from the
 * services it calls (`JobError`, `ExecutionError`) are passed on unchanged.
 */
export type RuntimeErrorCode =
  | 'invalid_request'
  | 'actor_not_allowed'
  | 'execution_not_waiting'
  | 'execution_in_progress'
  | 'nothing_to_run'
  | 'approval_pending'
  | 'approval_mismatch'
  | 'job_not_resumable';

export class RuntimeError extends Error {
  override readonly name = 'RuntimeError';

  constructor(
    readonly code: RuntimeErrorCode,
    /** Which field or rule. A code, never user data. */
    readonly detail?: string,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
  }
}

export const isRuntimeError = (error: unknown): error is RuntimeError =>
  error instanceof RuntimeError;
