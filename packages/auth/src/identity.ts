/** Who the identity provider says signed in. Built only from a verified ID token. */
export interface VerifiedIdentity {
  /** The provider's stable user id (the token's `sub`). */
  readonly subject: string;
  readonly email?: string;
  readonly emailVerified: boolean;
}

/** Verifies an ID token and returns the identity in it, or throws an `AuthError`. */
export interface IdTokenVerifier {
  verify(token: string): Promise<VerifiedIdentity>;
}

const BEARER = /^Bearer ([A-Za-z0-9._~+/-]+=*)$/;

/**
 * Reads the token from an `Authorization: Bearer <token>` header. Returns undefined when the
 * header is absent; a present but malformed header is an invalid token, not a missing one.
 */
export function readBearerToken(header: string | undefined): string | undefined | null {
  if (header === undefined || header === '') return undefined;
  const match = BEARER.exec(header);
  return match?.[1] ?? null;
}
