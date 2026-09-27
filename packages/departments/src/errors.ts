/**
 * Why a department operation was refused. Stable codes, safe to log. Another organization's
 * department is `department_not_found`, exactly like one that does not exist.
 */
export type DepartmentErrorCode =
  | 'unresolved_tenant'
  | 'organization_inactive'
  | 'invalid_department'
  | 'department_not_found'
  | 'invalid_department_transition'
  | 'department_concurrency_conflict';

export class DepartmentError extends Error {
  override readonly name = 'DepartmentError';

  constructor(
    readonly code: DepartmentErrorCode,
    /** Which field or rule, for `invalid_department`. A code, never user data. */
    readonly detail?: string,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
  }
}

export const isDepartmentError = (error: unknown): error is DepartmentError =>
  error instanceof DepartmentError;
