import type { OrganizationId, UserId } from '@melonoffice/domain';

/**
 * Who is making a request, derived only from a verified token and server-side records.
 * Nothing in it comes from the request body, query or a client-chosen id.
 */
export interface AuthenticatedContext {
  /** `gia` when GIA acts for this user. It never changes whose identity or access applies. */
  readonly actor: 'user' | 'gia';
  readonly userId: UserId;
  /** Absent until the user belongs to an organization (tenancy). */
  readonly organizationId?: OrganizationId;
  readonly email?: string;
  readonly emailVerified: boolean;
}

/**
 * The context GIA works with when acting for a user: the same user, the same organization and so
 * the same permissions and entitlements. It takes nothing else, so GIA cannot add or widen access.
 */
export function actAsGia(context: AuthenticatedContext): AuthenticatedContext {
  return Object.freeze({ ...context, actor: 'gia' });
}
