import type {
  Firestore,
  Timestamp as FirestoreTimestamp,
  Transaction,
} from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import type { AuditEvent } from '@melonoffice/audit';
import type {
  BillingRelationship,
  CommercialAccount,
  CommercialAccountId,
  CommercialAccountStatus,
  CommercialLimits,
  CommercialMembership,
  CommercialMembershipId,
  CommercialMembershipStatus,
  CommissionConfig,
  CustomerAccessScope,
  CustomerMode,
  CustomerRelationship,
  CustomerRelationshipId,
  CustomerRelationshipStatus,
  IsoTimestamp,
  OrganizationId,
  PricingProfileRef,
  UserId,
} from '@melonoffice/domain';
import {
  COMMERCIAL_ACCOUNT_TYPES,
  commercialMembershipIdOf,
  CUSTOMER_ACCESS_SCOPES,
  CUSTOMER_MODES,
  customerRelationshipIdOf,
  isCommercialAccountId,
  isOrganizationId,
  TenancyError,
  type CommercialRepository,
} from '@melonoffice/tenancy';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';

/** Collections of the commercial layer (ADR-0086). Read and written only by the API. */
export const COMMERCIAL_ACCOUNTS = 'commercialAccounts';
export const COMMERCIAL_MEMBERSHIPS = 'commercialMemberships';
export const CUSTOMER_RELATIONSHIPS = 'customerRelationships';

/** `commercialAccounts/{accountId}` */
interface AccountDocument {
  readonly type: string;
  readonly name: string;
  readonly status: string;
  readonly pricingProfile: PricingProfileRef | null;
  readonly commission: CommissionConfig | null;
  readonly limits: CommercialLimits | null;
  readonly createdAt: FirestoreTimestamp;
  readonly updatedAt: FirestoreTimestamp;
}

/** `commercialMemberships/{accountId}_{userId}`: one per pair. */
interface MembershipDocument {
  readonly commercialAccountId: string;
  readonly userId: string;
  readonly role: string;
  readonly status: string;
  readonly createdAt: FirestoreTimestamp;
  readonly updatedAt: FirestoreTimestamp;
}

/** `customerRelationships/{accountId}_{organizationId}`: one per pair. */
interface RelationshipDocument {
  readonly commercialAccountId: string;
  readonly organizationId: string;
  readonly mode: string;
  readonly status: string;
  readonly scopes: readonly string[];
  readonly billing: string | null;
  readonly acceptedBy: string | null;
  readonly createdAt: FirestoreTimestamp;
  readonly updatedAt: FirestoreTimestamp;
}

const ACCOUNT_STATUSES: readonly string[] = [
  'active',
  'suspended',
  'closed',
] satisfies CommercialAccountStatus[];
const MEMBERSHIP_STATUSES: readonly string[] = [
  'active',
  'suspended',
  'revoked',
] satisfies CommercialMembershipStatus[];
const RELATIONSHIP_STATUSES: readonly string[] = [
  'pending',
  'active',
  'suspended',
  'ended',
] satisfies CustomerRelationshipStatus[];
const BILLING: readonly string[] = [
  'customer',
  'commercial_account',
] satisfies BillingRelationship[];

const iso = (t: FirestoreTimestamp): IsoTimestamp => t.toDate().toISOString() as IsoTimestamp;
const at = (value: string) => Timestamp.fromDate(new Date(value));

// Stored values are checked, not trusted: a record that fails is refused, never used.
function toAccount(id: string, d: AccountDocument): CommercialAccount {
  if (
    !isCommercialAccountId(id) ||
    !(COMMERCIAL_ACCOUNT_TYPES as readonly string[]).includes(d.type) ||
    !ACCOUNT_STATUSES.includes(d.status) ||
    typeof d.name !== 'string'
  ) {
    throw new Error('invalid commercial account record');
  }
  return Object.freeze({
    id,
    type: d.type as CommercialAccount['type'],
    name: d.name,
    status: d.status as CommercialAccountStatus,
    ...(d.pricingProfile == null ? {} : { pricingProfile: d.pricingProfile }),
    ...(d.commission == null ? {} : { commission: d.commission }),
    ...(d.limits == null ? {} : { limits: d.limits }),
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  });
}

function toMembership(id: string, d: MembershipDocument): CommercialMembership {
  if (
    !isCommercialAccountId(d.commercialAccountId) ||
    id !== commercialMembershipIdOf(d.commercialAccountId, d.userId as UserId) ||
    !MEMBERSHIP_STATUSES.includes(d.status) ||
    typeof d.role !== 'string'
  ) {
    throw new Error('invalid commercial membership record');
  }
  return Object.freeze({
    id: id as CommercialMembershipId,
    commercialAccountId: d.commercialAccountId,
    userId: d.userId as UserId,
    role: d.role,
    status: d.status as CommercialMembershipStatus,
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  });
}

function toRelationship(id: string, d: RelationshipDocument): CustomerRelationship {
  if (
    !isCommercialAccountId(d.commercialAccountId) ||
    !isOrganizationId(d.organizationId) ||
    id !== customerRelationshipIdOf(d.commercialAccountId, d.organizationId) ||
    !(CUSTOMER_MODES as readonly string[]).includes(d.mode) ||
    !RELATIONSHIP_STATUSES.includes(d.status) ||
    !Array.isArray(d.scopes) ||
    !d.scopes.every((s) => (CUSTOMER_ACCESS_SCOPES as readonly string[]).includes(s)) ||
    (d.billing !== null && !BILLING.includes(d.billing))
  ) {
    throw new Error('invalid customer relationship record');
  }
  return Object.freeze({
    id: id as CustomerRelationshipId,
    commercialAccountId: d.commercialAccountId,
    organizationId: d.organizationId,
    mode: d.mode as CustomerMode,
    status: d.status as CustomerRelationshipStatus,
    scopes: Object.freeze([...d.scopes] as CustomerAccessScope[]),
    ...(d.billing === null ? {} : { billing: d.billing as BillingRelationship }),
    ...(d.acceptedBy === null ? {} : { acceptedBy: d.acceptedBy as UserId }),
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  });
}

const accountDocument = (a: CommercialAccount): AccountDocument => ({
  type: a.type,
  name: a.name,
  status: a.status,
  pricingProfile: a.pricingProfile ?? null,
  commission: a.commission ?? null,
  limits: a.limits ?? null,
  createdAt: at(a.createdAt),
  updatedAt: at(a.updatedAt),
});

const membershipDocument = (m: CommercialMembership): MembershipDocument => ({
  commercialAccountId: m.commercialAccountId,
  userId: m.userId,
  role: m.role,
  status: m.status,
  createdAt: at(m.createdAt),
  updatedAt: at(m.updatedAt),
});

const relationshipDocument = (r: CustomerRelationship): RelationshipDocument => ({
  commercialAccountId: r.commercialAccountId,
  organizationId: r.organizationId,
  mode: r.mode,
  status: r.status,
  scopes: [...r.scopes],
  billing: r.billing ?? null,
  acceptedBy: r.acceptedBy ?? null,
  createdAt: at(r.createdAt),
  updatedAt: at(r.updatedAt),
});

/**
 * The commercial layer in Firestore (ADR-0086). Every write runs in a transaction with its audit
 * events, checks the version it read, and counts the account's limit in the same transaction.
 * Every query is an equality on one or two fields, so no composite index is needed.
 */
export class FirestoreCommercialStore implements CommercialRepository {
  constructor(private readonly db: Firestore) {}

  async findAccount(id: CommercialAccountId) {
    if (!isCommercialAccountId(id)) return undefined;
    const snapshot = await this.db.collection(COMMERCIAL_ACCOUNTS).doc(id).get();
    return snapshot.exists ? toAccount(snapshot.id, snapshot.data() as AccountDocument) : undefined;
  }

  async listAccounts() {
    const snapshot = await this.db.collection(COMMERCIAL_ACCOUNTS).get();
    return snapshot.docs.map((d) => toAccount(d.id, d.data() as AccountDocument));
  }

  async findMembership(accountId: CommercialAccountId, userId: UserId) {
    if (!isCommercialAccountId(accountId)) return undefined;
    const snapshot = await this.db
      .collection(COMMERCIAL_MEMBERSHIPS)
      .doc(commercialMembershipIdOf(accountId, userId))
      .get();
    return snapshot.exists
      ? toMembership(snapshot.id, snapshot.data() as MembershipDocument)
      : undefined;
  }

  async membersOfAccount(accountId: CommercialAccountId) {
    const snapshot = await this.db
      .collection(COMMERCIAL_MEMBERSHIPS)
      .where('commercialAccountId', '==', accountId)
      .get();
    return snapshot.docs.map((d) => toMembership(d.id, d.data() as MembershipDocument));
  }

  async membershipsOfUser(userId: UserId) {
    const snapshot = await this.db
      .collection(COMMERCIAL_MEMBERSHIPS)
      .where('userId', '==', userId)
      .get();
    return snapshot.docs.map((d) => toMembership(d.id, d.data() as MembershipDocument));
  }

  async findRelationship(accountId: CommercialAccountId, organizationId: OrganizationId) {
    if (!isCommercialAccountId(accountId) || !isOrganizationId(organizationId)) return undefined;
    const snapshot = await this.db
      .collection(CUSTOMER_RELATIONSHIPS)
      .doc(customerRelationshipIdOf(accountId, organizationId))
      .get();
    return snapshot.exists
      ? toRelationship(snapshot.id, snapshot.data() as RelationshipDocument)
      : undefined;
  }

  async relationshipsOfAccount(accountId: CommercialAccountId) {
    const snapshot = await this.db
      .collection(CUSTOMER_RELATIONSHIPS)
      .where('commercialAccountId', '==', accountId)
      .get();
    return snapshot.docs.map((d) => toRelationship(d.id, d.data() as RelationshipDocument));
  }

  async relationshipsOfOrganization(organizationId: OrganizationId) {
    const snapshot = await this.db
      .collection(CUSTOMER_RELATIONSHIPS)
      .where('organizationId', '==', organizationId)
      .get();
    return snapshot.docs.map((d) => toRelationship(d.id, d.data() as RelationshipDocument));
  }

  async createAccount(
    account: CommercialAccount,
    firstAdmin: CommercialMembership,
    events: readonly AuditEvent[],
  ) {
    if (firstAdmin.commercialAccountId !== account.id) {
      throw new Error('first admin does not belong to the new account');
    }
    await this.db.runTransaction(async (tx) => {
      const ref = this.db.collection(COMMERCIAL_ACCOUNTS).doc(account.id);
      if ((await tx.get(ref)).exists) throw new TenancyError('commercial_conflict');
      tx.create(ref, accountDocument(account));
      tx.create(
        this.db.collection(COMMERCIAL_MEMBERSHIPS).doc(firstAdmin.id),
        membershipDocument(firstAdmin),
      );
      this.#audit(tx, events);
    });
  }

  async saveMembership(
    membership: CommercialMembership,
    expected: CommercialMembership | undefined,
    events: readonly AuditEvent[],
    limit?: number,
  ) {
    if (
      membership.id !== commercialMembershipIdOf(membership.commercialAccountId, membership.userId)
    ) {
      throw new Error('membership id does not match its account and user');
    }
    await this.db.runTransaction(async (tx) => {
      const ref = this.db.collection(COMMERCIAL_MEMBERSHIPS).doc(membership.id);
      const snapshot = await tx.get(ref);
      const current = snapshot.exists
        ? toMembership(snapshot.id, snapshot.data() as MembershipDocument)
        : undefined;
      if (current?.updatedAt !== expected?.updatedAt) throw new TenancyError('commercial_conflict');
      if (limit !== undefined && membership.status === 'active' && current?.status !== 'active') {
        const active = await tx.get(
          this.db
            .collection(COMMERCIAL_MEMBERSHIPS)
            .where('commercialAccountId', '==', membership.commercialAccountId)
            .where('status', '==', 'active'),
        );
        if (active.size >= limit) throw new TenancyError('commercial_limit_reached');
      }
      tx.set(ref, membershipDocument(membership));
      this.#audit(tx, events);
    });
  }

  async saveRelationship(
    relationship: CustomerRelationship,
    expected: CustomerRelationship | undefined,
    events: readonly AuditEvent[],
    limit?: number,
  ) {
    if (
      relationship.id !==
      customerRelationshipIdOf(relationship.commercialAccountId, relationship.organizationId)
    ) {
      throw new Error('relationship id does not match its account and organization');
    }
    await this.db.runTransaction(async (tx) => {
      const ref = this.db.collection(CUSTOMER_RELATIONSHIPS).doc(relationship.id);
      const snapshot = await tx.get(ref);
      const current = snapshot.exists
        ? toRelationship(snapshot.id, snapshot.data() as RelationshipDocument)
        : undefined;
      if (current?.updatedAt !== expected?.updatedAt) throw new TenancyError('commercial_conflict');
      if (limit !== undefined && relationship.status !== 'ended' && current?.status !== 'pending') {
        const all = await tx.get(
          this.db
            .collection(CUSTOMER_RELATIONSHIPS)
            .where('commercialAccountId', '==', relationship.commercialAccountId),
        );
        const open = all.docs.filter((d) => (d.data() as RelationshipDocument).status !== 'ended');
        if (open.length >= limit) throw new TenancyError('commercial_limit_reached');
      }
      tx.set(ref, relationshipDocument(relationship));
      this.#audit(tx, events);
    });
  }

  #audit(tx: Transaction, events: readonly AuditEvent[]) {
    for (const event of events) {
      tx.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
    }
  }
}
