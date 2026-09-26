import type { IsoTimestamp, MembershipId, OrganizationId, UserId } from './ids.js';

/**
 * The tenant: a company using MelonOffice (D-10: organizations only, no workspaces). Its id is
 * internal and stable; the name is display data and may repeat across organizations.
 */
export interface Organization {
  readonly id: OrganizationId;
  readonly name: string;
  readonly status: OrganizationStatus;
  /** The user who created it. Kept for history; it grants nothing by itself. */
  readonly createdBy: UserId;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/** `active`: usable. `suspended`: nobody can act in it until reactivated. */
export type OrganizationStatus = 'active' | 'suspended';

/** The explicit link between one user and one organization. There is at most one per pair. */
export interface Membership {
  readonly id: MembershipId;
  readonly organizationId: OrganizationId;
  readonly userId: UserId;
  readonly status: MembershipStatus;
  /**
   * The member's role, as a name only. What a role may do is RBAC's job and is not defined yet.
   * Today the only role is `owner` (D-22: owner only).
   */
  readonly role: MembershipRole;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/**
 * - `active`: the user can act in the organization.
 * - `suspended`: temporarily blocked; can be reactivated without losing history.
 * - `revoked`: removed; kept for history. No way back is defined yet (invitations come later).
 *
 * Only `active` grants access.
 */
export type MembershipStatus = 'active' | 'suspended' | 'revoked';

export type MembershipRole = 'owner';
