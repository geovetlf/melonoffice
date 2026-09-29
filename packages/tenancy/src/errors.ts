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
  | 'requires_user'
  // The commercial layer (ADR-0085). `commercial_account_forbidden` and `customer_forbidden` are
  // each the one answer for every refusal, as `organization_forbidden` is.
  | 'commercial_account_forbidden'
  | 'customer_forbidden'
  | 'invalid_commercial_account_name'
  | 'invalid_customer_scopes'
  | 'invalid_commission';

export class TenancyError extends Error {
  override readonly name = 'TenancyError';

  constructor(readonly code: TenancyErrorCode) {
    super(code);
  }
}

export const isTenancyError = (error: unknown): error is TenancyError =>
  error instanceof TenancyError;
