/** Why GIA did not answer (ADR-0052). Stable codes; never a message with content. */
export type GiaErrorCode =
  | 'invalid_request'
  | 'unresolved_tenant'
  | 'requires_user'
  | 'permission_denied'
  | 'organization_inactive'
  | 'rate_limited'
  | 'ai_credits_insufficient'
  | 'ai_policy_denied'
  | 'ai_not_available'
  | 'ai_unavailable'
  | 'ai_timeout'
  | 'ai_invalid_output';

export class GiaError extends Error {
  override readonly name = 'GiaError';
  constructor(
    readonly code: GiaErrorCode,
    /** For `invalid_request`: which field. */
    readonly field?: string,
    /** For `ai_credits_insufficient`: about how many credits the request would have used. */
    readonly estimatedCredits?: number,
  ) {
    super(field === undefined ? code : `${code}: ${field}`);
  }
}

export const isGiaError = (error: unknown): error is GiaError => error instanceof GiaError;
