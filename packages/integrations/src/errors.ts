/**
 * Why an integrations operation was refused. Stable codes, safe to log and to return. They never
 * carry a secret, a token, a signature or a payload.
 */
export type IntegrationErrorCode =
  | 'unresolved_tenant'
  | 'organization_inactive'
  | 'permission_denied'
  | 'requires_user'
  | 'invalid_connection'
  | 'connection_not_found'
  | 'connection_disabled'
  | 'connection_revoked'
  | 'invalid_transition'
  | 'category_not_allowed'
  | 'limit_reached'
  | 'entitlements_unavailable'
  | 'secret_unavailable'
  | 'secret_not_found'
  | 'invalid_signature'
  | 'invalid_payload'
  | 'account_mismatch'
  | 'handshake_refused'
  | 'provider_unavailable'
  | 'provider_rejected'
  | 'invalid_outbound';

export class IntegrationError extends Error {
  override readonly name = 'IntegrationError';

  constructor(
    readonly code: IntegrationErrorCode,
    /** Which field or rule. A code, never data. */
    readonly detail?: string,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
  }
}

export const isIntegrationError = (error: unknown): error is IntegrationError =>
  error instanceof IntegrationError;
