import type { UserId } from '@melonoffice/domain';

/**
 * Who is making a request, derived only from a verified token and server-side records.
 * Nothing in it comes from the request body, query or a client-chosen id.
 */
export interface AuthenticatedContext {
  /** `gia` when GIA acts for this user. It never changes whose identity or access applies. */
  readonly actor: 'user' | 'gia';
  readonly userId: UserId;
  readonly email?: string;
  readonly emailVerified: boolean;
  /**
   * When the person last signed in, in seconds since 1970 (ADR-0138): sensitive administration
   * asks for a recent sign-in. Absent for contexts no sign-in made (operator tools, tests).
   */
  readonly authTime?: number;
}

/**
 * The context GIA works with when acting for a user: the same user, and so the same memberships,
 * permissions and entitlements. It takes nothing else, so GIA cannot add or widen access.
 */
export function actAsGia(context: AuthenticatedContext): AuthenticatedContext {
  return Object.freeze({ ...context, actor: 'gia' });
}

/**
 * How recent a sign-in sensitive administration needs (ADR-0138): changes by platform, white-label
 * and reseller administrators. A business owner working in their own office is never asked.
 */
export const SENSITIVE_SIGN_IN_MAX_AGE_SECONDS = 30 * 60;

/**
 * Whether the person signed in within `maxAgeSeconds` of `now`. A context with no sign-in time
 * (an operator tool, GIA acting for someone) never counts as recent.
 */
export function signedInRecently(
  context: AuthenticatedContext,
  now: Date,
  maxAgeSeconds: number = SENSITIVE_SIGN_IN_MAX_AGE_SECONDS,
): boolean {
  if (context.actor !== 'user' || context.authTime === undefined) return false;
  return now.getTime() / 1000 - context.authTime <= maxAgeSeconds;
}
