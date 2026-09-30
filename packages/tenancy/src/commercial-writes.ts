import type { AuditEvent } from '@melonoffice/audit';
import type {
  CommercialAccount,
  CommercialAccountId,
  CommercialMembership,
  CustomerInvitation,
  CustomerInvitationId,
  MemberInvitation,
  MemberInvitationId,
  CustomerRelationship,
  OrganizationId,
} from '@melonoffice/domain';
import type { CommercialStore } from './commercial.js';

/**
 * Writes of the commercial layer (ADR-0086). Every write stores its audit events in the same step,
 * so a change never exists without its record. A write that changes an existing record names the
 * version it read (`expected`, by `updatedAt`), so two people changing the same record cannot
 * overwrite each other: the second one gets `commercial_conflict`.
 */
export interface CommercialRepository extends CommercialStore {
  /** Every account, for the platform administrator. */
  listAccounts(): Promise<readonly CommercialAccount[]>;
  /** The members of one account, in any status. */
  membersOfAccount(accountId: CommercialAccountId): Promise<readonly CommercialMembership[]>;
  /** The relationships of one organization, in any status, for its owner. */
  relationshipsOfOrganization(
    organizationId: OrganizationId,
  ): Promise<readonly CustomerRelationship[]>;
  /** The resellers of one white label (ADR-0098), in any status. */
  accountsWithParent(parentId: CommercialAccountId): Promise<readonly CommercialAccount[]>;
  /**
   * A new reseller under a white label (ADR-0098), with the invitation of its first admin, in one
   * step. The white label must still be the version read (`expectedParent`) and active, and have
   * fewer than `limit` resellers not closed.
   */
  createChildAccount(
    account: CommercialAccount,
    expectedParent: CommercialAccount,
    firstAdmin: MemberInvitation,
    events: readonly AuditEvent[],
    limit: number,
  ): Promise<void>;
  /** A new account with its first admin. Fails if the id exists. */
  createAccount(
    account: CommercialAccount,
    firstAdmin: CommercialMembership,
    events: readonly AuditEvent[],
  ): Promise<void>;
  /**
   * Changes an existing account: its status or its limits (ADR-0091). The id, type and history
   * stay; `expected` is the version read, so a concurrent change gets `commercial_conflict`.
   */
  saveAccount(
    account: CommercialAccount,
    expected: CommercialAccount,
    events: readonly AuditEvent[],
  ): Promise<void>;
  /**
   * Creates or changes a membership. `limit`, when given, is the most active members the account
   * may have, counted in the same step so concurrent additions cannot pass it.
   */
  saveMembership(
    membership: CommercialMembership,
    expected: CommercialMembership | undefined,
    events: readonly AuditEvent[],
    limit?: number,
  ): Promise<void>;
  /**
   * Creates or changes a relationship. `limit`, when given, is the most relationships not ended
   * the account may have, counted in the same step.
   */
  saveRelationship(
    relationship: CustomerRelationship,
    expected: CustomerRelationship | undefined,
    events: readonly AuditEvent[],
    limit?: number,
  ): Promise<void>;
  /** One invitation by id (ADR-0089). */
  findInvitation(id: CustomerInvitationId): Promise<CustomerInvitation | undefined>;
  /** The invitation whose link secret has this hash. */
  findInvitationByTokenHash(tokenHash: string): Promise<CustomerInvitation | undefined>;
  /** The invitations of one account, in any status. */
  invitationsOfAccount(accountId: CommercialAccountId): Promise<readonly CustomerInvitation[]>;
  /**
   * Creates or changes an invitation. `limit`, when given, is the most pending invitations the
   * account may have, counted in the same step.
   */
  saveInvitation(
    invitation: CustomerInvitation,
    expected: CustomerInvitation | undefined,
    events: readonly AuditEvent[],
    limit?: number,
  ): Promise<void>;
  /**
   * Takes an invitation: stores it accepted and creates its relationship in the same step, so
   * neither exists without the other. Both versions are checked, and `limit` is counted as in
   * `saveRelationship`.
   */
  acceptInvitation(
    invitation: CustomerInvitation,
    expected: CustomerInvitation,
    relationship: CustomerRelationship,
    expectedRelationship: CustomerRelationship | undefined,
    events: readonly AuditEvent[],
    limit?: number,
  ): Promise<void>;
  /** One member invitation by id (ADR-0093). */
  findMemberInvitation(id: MemberInvitationId): Promise<MemberInvitation | undefined>;
  /** The member invitation whose link secret has this hash. */
  findMemberInvitationByTokenHash(tokenHash: string): Promise<MemberInvitation | undefined>;
  /** The member invitations of one account, in any status. */
  memberInvitationsOfAccount(accountId: CommercialAccountId): Promise<readonly MemberInvitation[]>;
  /**
   * Creates or changes a member invitation. `limit`, when given, is the most pending member
   * invitations the account may have, counted in the same step.
   */
  saveMemberInvitation(
    invitation: MemberInvitation,
    expected: MemberInvitation | undefined,
    events: readonly AuditEvent[],
    limit?: number,
  ): Promise<void>;
  /**
   * Takes a member invitation: stores it accepted and the membership active in the same step, so
   * neither exists without the other. Both versions are checked, and `limit` (the most active
   * members) is counted as in `saveMembership`.
   */
  acceptMemberInvitation(
    invitation: MemberInvitation,
    expected: MemberInvitation,
    membership: CommercialMembership,
    expectedMembership: CommercialMembership | undefined,
    events: readonly AuditEvent[],
    limit: number,
  ): Promise<void>;
}
