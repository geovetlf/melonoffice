import type { AuthenticatedContext } from './context.js';
import { AuthError } from './errors.js';
import { readBearerToken, type IdTokenVerifier, type VerifiedIdentity } from './identity.js';
import { resolveOrganization, type MembershipDirectory } from './tenancy.js';
import type { UserDirectory } from './users.js';

export interface AuthDependencies {
  readonly verifier: IdTokenVerifier;
  readonly users: UserDirectory;
  readonly memberships: MembershipDirectory;
}

export interface AuthenticationInput {
  /** The raw `Authorization` header. */
  readonly authorization: string | undefined;
  /** An organization the client asks to act in. Only a selector, checked against memberships. */
  readonly requestedOrganization?: string | undefined;
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
 * Answers "who are you?" for a request: a verified token, a registered user and, when the user
 * belongs to one, an organization. Permissions, entitlements and limits are decided elsewhere.
 */
export async function authenticate(
  input: AuthenticationInput,
  { verifier, users, memberships }: AuthDependencies,
): Promise<AuthenticatedContext> {
  const identity = await verifyRequest(input.authorization, verifier);
  const user = await users.findBySubject(identity.subject);
  if (user === undefined) throw new AuthError('user_not_registered');
  const organizationId = await resolveOrganization(
    user.id,
    input.requestedOrganization,
    memberships,
  );
  return Object.freeze({
    actor: 'user',
    userId: user.id,
    ...(organizationId === undefined ? {} : { organizationId }),
    ...(identity.email === undefined ? {} : { email: identity.email }),
    emailVerified: identity.emailVerified,
  });
}
