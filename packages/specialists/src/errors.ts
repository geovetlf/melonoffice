/**
 * Why a specialist operation was refused. Stable codes, safe to log. Another organization's
 * specialist is `specialist_not_found`, exactly like one that does not exist.
 */
export type SpecialistErrorCode =
  | 'unresolved_tenant'
  | 'organization_inactive'
  | 'invalid_specialist'
  | 'specialist_not_found'
  | 'invalid_specialist_transition'
  | 'specialist_archived'
  | 'specialist_concurrency_conflict'
  | 'department_not_assignable'
  | 'permission_denied'
  /** It may not be activated yet: `problems` says what is missing (AE-4, ADR-0115). */
  | 'specialist_not_ready';

export class SpecialistError extends Error {
  override readonly name = 'SpecialistError';

  constructor(
    readonly code: SpecialistErrorCode,
    /** Which field or rule, for `invalid_specialist`. A code, never user data. */
    readonly detail?: string,
    /** What stops activation, for `specialist_not_ready`: stable codes, never user data. */
    readonly problems?: readonly { readonly kind: string }[],
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
  }
}

export const isSpecialistError = (error: unknown): error is SpecialistError =>
  error instanceof SpecialistError;
