export type BusinessErrorCode =
  | 'invalid_profile'
  | 'profile_not_found'
  | 'profile_concurrency_conflict'
  | 'permission_denied'
  | 'requires_user'
  | 'organization_inactive'
  | 'unresolved_tenant';

export class BusinessError extends Error {
  override readonly name = 'BusinessError';

  constructor(
    readonly code: BusinessErrorCode,
    /** The field that was refused, for `invalid_profile`. Never a value. */
    readonly field?: string,
  ) {
    super(field === undefined ? code : `${code}: ${field}`);
  }
}

export const isBusinessError = (error: unknown): error is BusinessError =>
  error instanceof BusinessError;
