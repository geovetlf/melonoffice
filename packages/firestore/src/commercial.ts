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
  CustomerInvitation,
  CustomerInvitationId,
  CustomerInvitationStatus,
  CustomerMode,
  CustomerRelationship,
  CustomerRelationshipId,
  CustomerRelationshipStatus,
  IsoTimestamp,
  MemberInvitation,
  MemberInvitationId,
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
  INVITATION_STATUSES,
  isCommercialAccountId,
  isCustomerInvitationId,
  isInvitationTokenHash,
  isMemberInvitationId,
  isOrganizationId,
  TenancyError,
  type CommercialRepository,
} from '@melonoffice/tenancy';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';

/** Collections of the commercial layer (ADR-0086). Read and written only by the API. */
export const COMMERCIAL_ACCOUNTS = 'commercialAccounts';
export const COMMERCIAL_MEMBERSHIPS = 'commercialMemberships';
export const CUSTOMER_RELATIONSHIPS = 'customerRelationships';
export const CUSTOMER_INVITATIONS = 'customerInvitations';
export const MEMBER_INVITATIONS = 'memberInvitations';

/** `commercialAccounts/{accountId}` */
interface AccountDocument {
  readonly type: string;
  readonly name: string;
  readonly status: string;
  readonly pricingProfile: PricingProfileRef | null;
  readonly commission: CommissionConfig | null;
  readonly limits: CommercialLimits | null;
  /** The white label of a reseller (ADR-0098); absent on accounts made before it. */
  readonly parentAccountId?: string | null;
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

/** `customerInvitations/{invitationId}` (ADR-0089). Only the link secret's hash is stored. */
interface InvitationDocument {
  readonly commercialAccountId: string;
  readonly email: string;
  readonly mode: string;
  readonly scopes: readonly string[];
  readonly billing: string | null;
  readonly status: string;
  readonly tokenHash: string;
  readonly expiresAt: FirestoreTimestamp;
  readonly createdBy: string;
  readonly decidedBy: string | null;
  readonly organizationId: string | null;
  readonly createdAt: FirestoreTimestamp;
  readonly updatedAt: FirestoreTimestamp;
}

/** `memberInvitations/{invitationId}` (ADR-0093). Only the link secret's hash is stored. */
interface MemberInvitationDocument {
  readonly commercialAccountId: string;
  readonly email: string;
  readonly role: string;
  readonly status: string;
  readonly tokenHash: string;
  readonly expiresAt: FirestoreTimestamp;
  readonly createdBy: string;
  readonly decidedBy: string | null;
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
    typeof d.name !== 'string' ||
    (d.parentAccountId != null && !isCommercialAccountId(d.parentAccountId))
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
    ...(d.parentAccountId == null
      ? {}
      : { parentAccountId: d.parentAccountId as CommercialAccountId }),
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

function toInvitation(id: string, d: InvitationDocument): CustomerInvitation {
  if (
    !isCustomerInvitationId(id) ||
    !isCommercialAccountId(d.commercialAccountId) ||
    typeof d.email !== 'string' ||
    !(CUSTOMER_MODES as readonly string[]).includes(d.mode) ||
    !(INVITATION_STATUSES as readonly string[]).includes(d.status) ||
    !Array.isArray(d.scopes) ||
    !d.scopes.every((s) => (CUSTOMER_ACCESS_SCOPES as readonly string[]).includes(s)) ||
    (d.billing !== null && !BILLING.includes(d.billing)) ||
    !isInvitationTokenHash(d.tokenHash) ||
    typeof d.createdBy !== 'string' ||
    (d.organizationId !== null && !isOrganizationId(d.organizationId))
  ) {
    throw new Error('invalid customer invitation record');
  }
  return Object.freeze({
    id,
    commercialAccountId: d.commercialAccountId,
    email: d.email,
    mode: d.mode as CustomerMode,
    scopes: Object.freeze([...d.scopes] as CustomerAccessScope[]),
    ...(d.billing === null ? {} : { billing: d.billing as BillingRelationship }),
    status: d.status as CustomerInvitationStatus,
    tokenHash: d.tokenHash,
    expiresAt: iso(d.expiresAt),
    createdBy: d.createdBy as UserId,
    ...(d.decidedBy === null ? {} : { decidedBy: d.decidedBy as UserId }),
    ...(d.organizationId === null ? {} : { organizationId: d.organizationId }),
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  });
}

const invitationDocument = (i: CustomerInvitation): InvitationDocument => ({
  commercialAccountId: i.commercialAccountId,
  email: i.email,
  mode: i.mode,
  scopes: [...i.scopes],
  billing: i.billing ?? null,
  status: i.status,
  tokenHash: i.tokenHash,
  expiresAt: at(i.expiresAt),
  createdBy: i.createdBy,
  decidedBy: i.decidedBy ?? null,
  organizationId: i.organizationId ?? null,
  createdAt: at(i.createdAt),
  updatedAt: at(i.updatedAt),
});

function toMemberInvitation(id: string, d: MemberInvitationDocument): MemberInvitation {
  if (
    !isMemberInvitationId(id) ||
    !isCommercialAccountId(d.commercialAccountId) ||
    typeof d.email !== 'string' ||
    typeof d.role !== 'string' ||
    !(INVITATION_STATUSES as readonly string[]).includes(d.status) ||
    !isInvitationTokenHash(d.tokenHash) ||
    typeof d.createdBy !== 'string'
  ) {
    throw new Error('invalid member invitation record');
  }
  return Object.freeze({
    id,
    commercialAccountId: d.commercialAccountId,
    email: d.email,
    role: d.role,
    status: d.status as CustomerInvitationStatus,
    tokenHash: d.tokenHash,
    expiresAt: iso(d.expiresAt),
    createdBy: d.createdBy as UserId,
    ...(d.decidedBy === null ? {} : { decidedBy: d.decidedBy as UserId }),
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  });
}

const memberInvitationDocument = (i: MemberInvitation): MemberInvitationDocument => ({
  commercialAccountId: i.commercialAccountId,
  email: i.email,
  role: i.role,
  status: i.status,
  tokenHash: i.tokenHash,
  expiresAt: at(i.expiresAt),
  createdBy: i.createdBy,
  decidedBy: i.decidedBy ?? null,
  createdAt: at(i.createdAt),
  updatedAt: at(i.updatedAt),
});

const accountDocument = (a: CommercialAccount): AccountDocument => ({
  type: a.type,
  name: a.name,
  status: a.status,
  pricingProfile: a.pricingProfile ?? null,
  commission: a.commission ?? null,
  limits: a.limits ?? null,
  parentAccountId: a.parentAccountId ?? null,
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

  async accountsWithParent(parentId: CommercialAccountId) {
    const snapshot = await this.db
      .collection(COMMERCIAL_ACCOUNTS)
      .where('parentAccountId', '==', parentId)
      .get();
    return snapshot.docs.map((d) => toAccount(d.id, d.data() as AccountDocument));
  }

  async createChildAccount(
    account: CommercialAccount,
    expectedParent: CommercialAccount,
    firstAdmin: MemberInvitation,
    events: readonly AuditEvent[],
    limit: number,
  ) {
    if (
      account.parentAccountId !== expectedParent.id ||
      firstAdmin.commercialAccountId !== account.id
    ) {
      throw new Error('child account does not match its parent or first admin');
    }
    await this.db.runTransaction(async (tx) => {
      const accounts = this.db.collection(COMMERCIAL_ACCOUNTS);
      const parentSnapshot = await tx.get(accounts.doc(expectedParent.id));
      const parent = parentSnapshot.exists
        ? toAccount(parentSnapshot.id, parentSnapshot.data() as AccountDocument)
        : undefined;
      if (parent?.updatedAt !== expectedParent.updatedAt || parent.status !== 'active') {
        throw new TenancyError('commercial_conflict');
      }
      const children = await tx.get(accounts.where('parentAccountId', '==', parent.id));
      const open = children.docs.filter((d) => (d.data() as AccountDocument).status !== 'closed');
      if (open.length >= limit) throw new TenancyError('commercial_limit_reached');
      const ref = accounts.doc(account.id);
      if ((await tx.get(ref)).exists) throw new TenancyError('commercial_conflict');
      tx.create(ref, accountDocument(account));
      tx.create(
        this.db.collection(MEMBER_INVITATIONS).doc(firstAdmin.id),
        memberInvitationDocument(firstAdmin),
      );
      this.#audit(tx, events);
    });
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

  async saveAccount(
    account: CommercialAccount,
    expected: CommercialAccount,
    events: readonly AuditEvent[],
  ) {
    if (account.id !== expected.id) throw new Error('account id does not match the one read');
    await this.db.runTransaction(async (tx) => {
      const ref = this.db.collection(COMMERCIAL_ACCOUNTS).doc(account.id);
      const snapshot = await tx.get(ref);
      const current = snapshot.exists
        ? toAccount(snapshot.id, snapshot.data() as AccountDocument)
        : undefined;
      if (current === undefined || current.updatedAt !== expected.updatedAt) {
        throw new TenancyError('commercial_conflict');
      }
      tx.set(ref, accountDocument(account));
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

  async findInvitation(id: CustomerInvitationId) {
    if (!isCustomerInvitationId(id)) return undefined;
    const snapshot = await this.db.collection(CUSTOMER_INVITATIONS).doc(id).get();
    return snapshot.exists
      ? toInvitation(snapshot.id, snapshot.data() as InvitationDocument)
      : undefined;
  }

  async findInvitationByTokenHash(tokenHash: string) {
    if (!isInvitationTokenHash(tokenHash)) return undefined;
    const snapshot = await this.db
      .collection(CUSTOMER_INVITATIONS)
      .where('tokenHash', '==', tokenHash)
      .limit(1)
      .get();
    const [doc] = snapshot.docs;
    return doc === undefined ? undefined : toInvitation(doc.id, doc.data() as InvitationDocument);
  }

  async invitationsOfAccount(accountId: CommercialAccountId) {
    const snapshot = await this.db
      .collection(CUSTOMER_INVITATIONS)
      .where('commercialAccountId', '==', accountId)
      .get();
    return snapshot.docs.map((d) => toInvitation(d.id, d.data() as InvitationDocument));
  }

  async saveInvitation(
    invitation: CustomerInvitation,
    expected: CustomerInvitation | undefined,
    events: readonly AuditEvent[],
    limit?: number,
  ) {
    await this.db.runTransaction(async (tx) => {
      const ref = this.db.collection(CUSTOMER_INVITATIONS).doc(invitation.id);
      const snapshot = await tx.get(ref);
      const current = snapshot.exists
        ? toInvitation(snapshot.id, snapshot.data() as InvitationDocument)
        : undefined;
      if (current?.updatedAt !== expected?.updatedAt) throw new TenancyError('commercial_conflict');
      if (limit !== undefined && invitation.status === 'pending' && current === undefined) {
        const pending = await tx.get(
          this.db
            .collection(CUSTOMER_INVITATIONS)
            .where('commercialAccountId', '==', invitation.commercialAccountId)
            .where('status', '==', 'pending'),
        );
        if (pending.size >= limit) throw new TenancyError('commercial_limit_reached');
      }
      tx.set(ref, invitationDocument(invitation));
      this.#audit(tx, events);
    });
  }

  async acceptInvitation(
    invitation: CustomerInvitation,
    expected: CustomerInvitation,
    relationship: CustomerRelationship,
    expectedRelationship: CustomerRelationship | undefined,
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
      const invitationRef = this.db.collection(CUSTOMER_INVITATIONS).doc(invitation.id);
      const relationshipRef = this.db.collection(CUSTOMER_RELATIONSHIPS).doc(relationship.id);
      const [invitationSnapshot, relationshipSnapshot] = await Promise.all([
        tx.get(invitationRef),
        tx.get(relationshipRef),
      ]);
      const currentInvitation = invitationSnapshot.exists
        ? toInvitation(invitationSnapshot.id, invitationSnapshot.data() as InvitationDocument)
        : undefined;
      const currentRelationship = relationshipSnapshot.exists
        ? toRelationship(
            relationshipSnapshot.id,
            relationshipSnapshot.data() as RelationshipDocument,
          )
        : undefined;
      if (
        currentInvitation?.updatedAt !== expected.updatedAt ||
        currentRelationship?.updatedAt !== expectedRelationship?.updatedAt
      ) {
        throw new TenancyError('commercial_conflict');
      }
      if (limit !== undefined) {
        const all = await tx.get(
          this.db
            .collection(CUSTOMER_RELATIONSHIPS)
            .where('commercialAccountId', '==', relationship.commercialAccountId),
        );
        const open = all.docs.filter((d) => (d.data() as RelationshipDocument).status !== 'ended');
        if (open.length >= limit) throw new TenancyError('commercial_limit_reached');
      }
      tx.set(invitationRef, invitationDocument(invitation));
      tx.set(relationshipRef, relationshipDocument(relationship));
      this.#audit(tx, events);
    });
  }

  async findMemberInvitation(id: MemberInvitationId) {
    if (!isMemberInvitationId(id)) return undefined;
    const snapshot = await this.db.collection(MEMBER_INVITATIONS).doc(id).get();
    return snapshot.exists
      ? toMemberInvitation(snapshot.id, snapshot.data() as MemberInvitationDocument)
      : undefined;
  }

  async findMemberInvitationByTokenHash(tokenHash: string) {
    if (!isInvitationTokenHash(tokenHash)) return undefined;
    const snapshot = await this.db
      .collection(MEMBER_INVITATIONS)
      .where('tokenHash', '==', tokenHash)
      .limit(1)
      .get();
    const [doc] = snapshot.docs;
    return doc === undefined
      ? undefined
      : toMemberInvitation(doc.id, doc.data() as MemberInvitationDocument);
  }

  async memberInvitationsOfAccount(accountId: CommercialAccountId) {
    const snapshot = await this.db
      .collection(MEMBER_INVITATIONS)
      .where('commercialAccountId', '==', accountId)
      .get();
    return snapshot.docs.map((d) => toMemberInvitation(d.id, d.data() as MemberInvitationDocument));
  }

  async saveMemberInvitation(
    invitation: MemberInvitation,
    expected: MemberInvitation | undefined,
    events: readonly AuditEvent[],
    limit?: number,
  ) {
    await this.db.runTransaction(async (tx) => {
      const ref = this.db.collection(MEMBER_INVITATIONS).doc(invitation.id);
      const snapshot = await tx.get(ref);
      const current = snapshot.exists
        ? toMemberInvitation(snapshot.id, snapshot.data() as MemberInvitationDocument)
        : undefined;
      if (current?.updatedAt !== expected?.updatedAt) throw new TenancyError('commercial_conflict');
      if (limit !== undefined && invitation.status === 'pending' && current === undefined) {
        const pending = await tx.get(
          this.db
            .collection(MEMBER_INVITATIONS)
            .where('commercialAccountId', '==', invitation.commercialAccountId)
            .where('status', '==', 'pending'),
        );
        if (pending.size >= limit) throw new TenancyError('commercial_limit_reached');
      }
      tx.set(ref, memberInvitationDocument(invitation));
      this.#audit(tx, events);
    });
  }

  async acceptMemberInvitation(
    invitation: MemberInvitation,
    expected: MemberInvitation,
    membership: CommercialMembership,
    expectedMembership: CommercialMembership | undefined,
    events: readonly AuditEvent[],
    limit: number,
  ) {
    if (
      membership.id !== commercialMembershipIdOf(membership.commercialAccountId, membership.userId)
    ) {
      throw new Error('membership id does not match its account and user');
    }
    await this.db.runTransaction(async (tx) => {
      const invitationRef = this.db.collection(MEMBER_INVITATIONS).doc(invitation.id);
      const membershipRef = this.db.collection(COMMERCIAL_MEMBERSHIPS).doc(membership.id);
      const [invitationSnapshot, membershipSnapshot, active] = await Promise.all([
        tx.get(invitationRef),
        tx.get(membershipRef),
        tx.get(
          this.db
            .collection(COMMERCIAL_MEMBERSHIPS)
            .where('commercialAccountId', '==', membership.commercialAccountId)
            .where('status', '==', 'active'),
        ),
      ]);
      const currentInvitation = invitationSnapshot.exists
        ? toMemberInvitation(
            invitationSnapshot.id,
            invitationSnapshot.data() as MemberInvitationDocument,
          )
        : undefined;
      const currentMembership = membershipSnapshot.exists
        ? toMembership(membershipSnapshot.id, membershipSnapshot.data() as MembershipDocument)
        : undefined;
      if (
        currentInvitation?.updatedAt !== expected.updatedAt ||
        currentMembership?.updatedAt !== expectedMembership?.updatedAt
      ) {
        throw new TenancyError('commercial_conflict');
      }
      if (currentMembership?.status !== 'active' && active.size >= limit) {
        throw new TenancyError('commercial_limit_reached');
      }
      tx.set(invitationRef, memberInvitationDocument(invitation));
      tx.set(membershipRef, membershipDocument(membership));
      this.#audit(tx, events);
    });
  }

  #audit(tx: Transaction, events: readonly AuditEvent[]) {
    for (const event of events) {
      tx.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
    }
  }
}
