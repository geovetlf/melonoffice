/**
 * Why a request could not be authenticated. Codes are stable and
 * safe to return to clients; they never contain the token or any detail about it.
 */
export type AuthErrorCode =
  | 'missing_token'
  | 'invalid_token'
  | 'token_expired'
  | 'user_not_registered'
  | 'verifier_unavailable';

export class AuthError extends Error {
  override readonly name = 'AuthError';

  constructor(readonly code: AuthErrorCode) {
    super(code);
  }
}

export const isAuthError = (error: unknown): error is AuthError => error instanceof AuthError;
