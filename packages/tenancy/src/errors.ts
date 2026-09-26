/**
 * Why a tenancy request was refused. Codes are stable and safe to return to clients.
 * `organization_forbidden` is the one answer for an organization that does not exist, one the
 * user has no membership in, a suspended or revoked membership and a suspended organization, so
 * a client cannot tell them apart and cannot probe ids.
 */
export type TenancyErrorCode =
  | 'invalid_organization_name'
  | 'organization_limit_reached'
  | 'organization_required'
  | 'organization_forbidden'
  | 'requires_user';

export class TenancyError extends Error {
  override readonly name = 'TenancyError';

  constructor(readonly code: TenancyErrorCode) {
    super(code);
  }
}

export const isTenancyError = (error: unknown): error is TenancyError =>
  error instanceof TenancyError;
