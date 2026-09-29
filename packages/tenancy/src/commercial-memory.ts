import type {
  CommercialAccount,
  CommercialAccountId,
  CommercialMembership,
  CustomerRelationship,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import type { CommercialStore } from './commercial.js';

/**
 * For tests and local runs only (ADR-0085, phase 1): the commercial layer has no writes yet, so
 * records are put here directly. Phase 2 adds the Firestore store and the audited writes.
 */
export class InMemoryCommercialStore implements CommercialStore {
  readonly #accounts = new Map<string, CommercialAccount>();
  readonly #memberships = new Map<string, CommercialMembership>();
  readonly #relationships = new Map<string, CustomerRelationship>();

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

  async findMembership(accountId: CommercialAccountId, userId: UserId) {
    return this.#memberships.get(`${accountId}_${userId}`);
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
}
