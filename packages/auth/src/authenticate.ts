import type { AuthenticatedContext } from './context.js';
import { AuthError } from './errors.js';
import { readBearerToken, type IdTokenVerifier, type VerifiedIdentity } from './identity.js';
import type { UserDirectory } from './users.js';

export interface AuthDependencies {
  readonly verifier: IdTokenVerifier;
  readonly users: UserDirectory;
}

export interface AuthenticationInput {
  /** The raw `Authorization` header. */
  readonly authorization: string | undefined;
}

/** Verifies the bearer token and returns the identity in it. Needs no user record. */
export async function verifyRequest(
  authorization: string | undefined,
  verifier: IdTokenVerifier,
): Promise<VerifiedIdentity> {
  const token = readBearerToken(authorization);
  if (token === undefined) throw new AuthError('missing_token');
  if (token === null) throw new AuthError('invalid_token');
  return verifier.verify(token);
}

/**
 * Answers "who are you?" for a request: a verified token and a registered user. The organization
 * is decided by tenancy (ADR-0018); permissions, entitlements and limits elsewhere.
 */
export async function authenticate(
  input: AuthenticationInput,
  { verifier, users }: AuthDependencies,
): Promise<AuthenticatedContext> {
  const identity = await verifyRequest(input.authorization, verifier);
  const user = await users.findBySubject(identity.subject);
  if (user === undefined) throw new AuthError('user_not_registered');
  return Object.freeze({
    actor: 'user',
    userId: user.id,
    ...(identity.email === undefined ? {} : { email: identity.email }),
    emailVerified: identity.emailVerified,
    ...(identity.authTime === undefined ? {} : { authTime: identity.authTime }),
  });
}
