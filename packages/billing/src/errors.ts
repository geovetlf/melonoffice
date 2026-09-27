/** Why a billing operation was refused. Stable codes, safe to log. */
export type BillingErrorCode = 'invalid_transition' | 'invalid_plan' | 'subscription_canceled';

export class BillingError extends Error {
  override readonly name = 'BillingError';

  constructor(readonly code: BillingErrorCode) {
    super(code);
  }
}

export const isBillingError = (error: unknown): error is BillingError =>
  error instanceof BillingError;
