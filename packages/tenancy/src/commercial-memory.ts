import type { AuditEvent, InMemoryAuditStore } from '@melonoffice/audit';
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
  UserId,
} from '@melonoffice/domain';
import type { CommercialRepository } from './commercial-writes.js';
import { TenancyError } from './errors.js';

/** For tests and local runs only: everything is lost on restart and not shared between instances. */
export class InMemoryCommercialStore implements CommercialRepository {
  readonly #accounts = new Map<string, CommercialAccount>();
  readonly #memberships = new Map<string, CommercialMembership>();
  readonly #relationships = new Map<string, CustomerRelationship>();
  readonly #invitations = new Map<string, CustomerInvitation>();
  readonly #memberInvitations = new Map<string, MemberInvitation>();

  /** Receives the writes' audit events in the same step as the data. */
  constructor(private readonly audit?: InMemoryAuditStore) {}

  // Direct puts, for tests that set up records without going through a write.
  putAccount(account: CommercialAccount): void {
    this.#accounts.set(account.id, Object.freeze({ ...account }));
  }

  putMembership(membership: CommercialMembership): void {
    this.#memberships.set(
      `${membership.commercialAccountId}_${membership.userId}`,
      Object.freeze({ ...membership }),
    );
  }

  putRelationship(relationship: CustomerRelationship): void {
    this.#relationships.set(
      `${relationship.commercialAccountId}_${relationship.organizationId}`,
      Object.freeze({ ...relationship, scopes: Object.freeze([...relationship.scopes]) }),
    );
  }

  async findAccount(id: CommercialAccountId) {
    return this.#accounts.get(id);
  }

  async listAccounts() {
    return [...this.#accounts.values()];
  }

  async findMembership(accountId: CommercialAccountId, userId: UserId) {
    return this.#memberships.get(`${accountId}_${userId}`);
  }

  async membersOfAccount(accountId: CommercialAccountId) {
    return [...this.#memberships.values()].filter((m) => m.commercialAccountId === accountId);
  }

  async membershipsOfUser(userId: UserId) {
    return [...this.#memberships.values()].filter((m) => m.userId === userId);
  }

  async findRelationship(accountId: CommercialAccountId, organizationId: OrganizationId) {
    return this.#relationships.get(`${accountId}_${organizationId}`);
  }

  async relationshipsOfAccount(accountId: CommercialAccountId) {
    return [...this.#relationships.values()].filter((r) => r.commercialAccountId === accountId);
  }

  async relationshipsOfOrganization(organizationId: OrganizationId) {
    return [...this.#relationships.values()].filter((r) => r.organizationId === organizationId);
  }

  async accountsWithParent(parentId: CommercialAccountId) {
    return [...this.#accounts.values()].filter((a) => a.parentAccountId === parentId);
  }

  async createChildAccount(
    account: CommercialAccount,
    expectedParent: CommercialAccount,
    firstAdmin: MemberInvitation,
    events: readonly AuditEvent[],
    limit: number,
  ) {
    if (this.#accounts.has(account.id)) throw new TenancyError('commercial_conflict');
    const parent = this.#accounts.get(expectedParent.id);
    if (parent === undefined || parent.updatedAt !== expectedParent.updatedAt) {
      throw new TenancyError('commercial_conflict');
    }
    if (parent.status !== 'active') throw new TenancyError('commercial_conflict');
    const children = (await this.accountsWithParent(parent.id)).filter(
      (a) => a.status !== 'closed',
    ).length;
    if (children >= limit) throw new TenancyError('commercial_limit_reached');
    this.#record(events);
    this.putAccount(account);
    this.#memberInvitations.set(firstAdmin.id, Object.freeze({ ...firstAdmin }));
  }

  async createAccount(
    account: CommercialAccount,
    firstAdmin: CommercialMembership,
    events: readonly AuditEvent[],
  ) {
    if (this.#accounts.has(account.id)) throw new TenancyError('commercial_conflict');
    this.#record(events);
    this.putAccount(account);
    this.putMembership(firstAdmin);
  }

  async saveAccount(
    account: CommercialAccount,
    expected: CommercialAccount,
    events: readonly AuditEvent[],
  ) {
    const current = await this.findAccount(account.id);
    if (current === undefined || current.updatedAt !== expected.updatedAt) {
      throw new TenancyError('commercial_conflict');
    }
    this.#record(events);
    this.putAccount(account);
  }

  async saveMembership(
    membership: CommercialMembership,
    expected: CommercialMembership | undefined,
    events: readonly AuditEvent[],
    limit?: number,
  ) {
    const current = await this.findMembership(membership.commercialAccountId, membership.userId);
    if (current?.updatedAt !== expected?.updatedAt) throw new TenancyError('commercial_conflict');
    if (limit !== undefined && membership.status === 'active' && current?.status !== 'active') {
      const active = [...this.#memberships.values()].filter(
        (m) => m.commercialAccountId === membership.commercialAccountId && m.status === 'active',
      ).length;
      if (active >= limit) throw new TenancyError('commercial_limit_reached');
    }
    this.#record(events);
    this.putMembership(membership);
  }

  async saveRelationship(
    relationship: CustomerRelationship,
    expected: CustomerRelationship | undefined,
    events: readonly AuditEvent[],
    limit?: number,
  ) {
    const current = await this.findRelationship(
      relationship.commercialAccountId,
      relationship.organizationId,
    );
    if (current?.updatedAt !== expected?.updatedAt) throw new TenancyError('commercial_conflict');
    if (limit !== undefined && relationship.status !== 'ended' && current?.status !== 'pending') {
      const open = (await this.relationshipsOfAccount(relationship.commercialAccountId)).filter(
        (r) => r.status !== 'ended',
      ).length;
      if (open >= limit) throw new TenancyError('commercial_limit_reached');
    }
    this.#record(events);
    this.putRelationship(relationship);
  }

  putInvitation(invitation: CustomerInvitation): void {
    this.#invitations.set(
      invitation.id,
      Object.freeze({ ...invitation, scopes: Object.freeze([...invitation.scopes]) }),
    );
  }

  async findInvitation(id: CustomerInvitationId) {
    return this.#invitations.get(id);
  }

  async findInvitationByTokenHash(tokenHash: string) {
    return [...this.#invitations.values()].find((i) => i.tokenHash === tokenHash);
  }

  async invitationsOfAccount(accountId: CommercialAccountId) {
    return [...this.#invitations.values()].filter((i) => i.commercialAccountId === accountId);
  }

  async saveInvitation(
    invitation: CustomerInvitation,
    expected: CustomerInvitation | undefined,
    events: readonly AuditEvent[],
    limit?: number,
  ) {
    const current = this.#invitations.get(invitation.id);
    if (current?.updatedAt !== expected?.updatedAt) throw new TenancyError('commercial_conflict');
    if (limit !== undefined && invitation.status === 'pending' && current === undefined) {
      const pending = (await this.invitationsOfAccount(invitation.commercialAccountId)).filter(
        (i) => i.status === 'pending',
      ).length;
      if (pending >= limit) throw new TenancyError('commercial_limit_reached');
    }
    this.#record(events);
    this.putInvitation(invitation);
  }

  async acceptInvitation(
    invitation: CustomerInvitation,
    expected: CustomerInvitation,
    relationship: CustomerRelationship,
    expectedRelationship: CustomerRelationship | undefined,
    events: readonly AuditEvent[],
    limit?: number,
  ) {
    if (this.#invitations.get(invitation.id)?.updatedAt !== expected.updatedAt) {
      throw new TenancyError('commercial_conflict');
    }
    const current = await this.findRelationship(
      relationship.commercialAccountId,
      relationship.organizationId,
    );
    if (current?.updatedAt !== expectedRelationship?.updatedAt) {
      throw new TenancyError('commercial_conflict');
    }
    if (limit !== undefined) {
      const open = (await this.relationshipsOfAccount(relationship.commercialAccountId)).filter(
        (r) => r.status !== 'ended',
      ).length;
      if (open >= limit) throw new TenancyError('commercial_limit_reached');
    }
    this.#record(events);
    this.putInvitation(invitation);
    this.putRelationship(relationship);
  }

  async findMemberInvitation(id: MemberInvitationId) {
    return this.#memberInvitations.get(id);
  }

  async findMemberInvitationByTokenHash(tokenHash: string) {
    return [...this.#memberInvitations.values()].find((i) => i.tokenHash === tokenHash);
  }

  async memberInvitationsOfAccount(accountId: CommercialAccountId) {
    return [...this.#memberInvitations.values()].filter((i) => i.commercialAccountId === accountId);
  }

  async saveMemberInvitation(
    invitation: MemberInvitation,
    expected: MemberInvitation | undefined,
    events: readonly AuditEvent[],
    limit?: number,
  ) {
    const current = this.#memberInvitations.get(invitation.id);
    if (current?.updatedAt !== expected?.updatedAt) throw new TenancyError('commercial_conflict');
    if (limit !== undefined && invitation.status === 'pending' && current === undefined) {
      const pending = (
        await this.memberInvitationsOfAccount(invitation.commercialAccountId)
      ).filter((i) => i.status === 'pending').length;
      if (pending >= limit) throw new TenancyError('commercial_limit_reached');
    }
    this.#record(events);
    this.#memberInvitations.set(invitation.id, Object.freeze({ ...invitation }));
  }

  async acceptMemberInvitation(
    invitation: MemberInvitation,
    expected: MemberInvitation,
    membership: CommercialMembership,
    expectedMembership: CommercialMembership | undefined,
    events: readonly AuditEvent[],
    limit: number,
  ) {
    if (this.#memberInvitations.get(invitation.id)?.updatedAt !== expected.updatedAt) {
      throw new TenancyError('commercial_conflict');
    }
    const current = await this.findMembership(membership.commercialAccountId, membership.userId);
    if (current?.updatedAt !== expectedMembership?.updatedAt) {
      throw new TenancyError('commercial_conflict');
    }
    const active = [...this.#memberships.values()].filter(
      (m) => m.commercialAccountId === membership.commercialAccountId && m.status === 'active',
    ).length;
    if (current?.status !== 'active' && active >= limit) {
      throw new TenancyError('commercial_limit_reached');
    }
    this.#record(events);
    this.#memberInvitations.set(invitation.id, Object.freeze({ ...invitation }));
    this.putMembership(membership);
  }

  #record(events: readonly AuditEvent[]) {
    if (events.length === 0) return;
    if (this.audit === undefined) throw new Error('no audit store for commercial events');
    this.audit.appendNow(events);
  }
}
