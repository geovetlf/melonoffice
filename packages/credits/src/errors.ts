/**
 * Why a credits operation was refused (ADR-0023). Stable codes, safe to log. None says anything
 * about another organization.
 */
export type CreditsErrorCode =
  | 'unresolved_tenant'
  | 'unresolved_platform_admin'
  | 'organization_inactive'
  | 'invalid_amount'
  | 'invalid_reference'
  | 'invalid_reason'
  | 'credits_wallet_missing'
  | 'credits_insufficient'
  | 'credits_balance_limit'
  | 'credits_reference_conflict'
  | 'credits_refund_invalid';

export class CreditsError extends Error {
  override readonly name = 'CreditsError';

  constructor(readonly code: CreditsErrorCode) {
    super(code);
  }
}

export const isCreditsError = (error: unknown): error is CreditsError =>
  error instanceof CreditsError;
