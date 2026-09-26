import type { OrganizationId, UserId } from '@melonoffice/domain';
import { AuthError } from './errors.js';

/**
 * The organizations a user belongs to. Tenancy owns this; auth only asks it. Until memberships
 * exist, `noMemberships` answers for everyone and no request has an organization.
 */
export interface MembershipDirectory {
  organizationsOf(userId: UserId): Promise<readonly OrganizationId[]>;
}

export const noMemberships: MembershipDirectory = {
  organizationsOf: async () => [],
};

/**
 * Decides the organization of a request from the user's memberships, never from the client.
 * The client may only choose among its own organizations; any other value is refused, with the
 * same answer whether that organization exists or not, so ids cannot be probed.
 * With no choice, a user with exactly one organization gets it; otherwise there is none.
 */
export async function resolveOrganization(
  userId: UserId,
  requested: string | undefined,
  memberships: MembershipDirectory,
): Promise<OrganizationId | undefined> {
  const organizations = await memberships.organizationsOf(userId);
  if (requested !== undefined) {
    const match = organizations.find((id) => id === requested);
    if (match === undefined) throw new AuthError('organization_forbidden');
    return match;
  }
  return organizations.length === 1 ? organizations[0] : undefined;
}
