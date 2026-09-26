import type { Firestore, Timestamp as FirestoreTimestamp } from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import type {
  IsoTimestamp,
  Membership,
  MembershipId,
  MembershipRole,
  MembershipStatus,
  Organization,
  OrganizationId,
  OrganizationStatus,
  UserId,
} from '@melonoffice/domain';
import {
  isOrganizationId,
  membershipIdOf,
  newOrganizationId,
  OWNER_ROLE,
  TenancyError,
  type CreatedOrganization,
  type NewOrganization,
  type TenancyStore,
} from '@melonoffice/tenancy';
import { AUDIT_LOGS, toAuditDocument } from './audit-firestore.js';

/** Collections (ADR-0018). Read and written only by the API, never by clients. */
export const ORGANIZATIONS = 'organizations';
export const MEMBERSHIPS = 'memberships';
export const ORGANIZATION_CREATORS = 'organizationCreators';

/** `organizations/{organizationId}` */
interface OrganizationDocument {
  readonly name: string;
  readonly status: OrganizationStatus;
  readonly createdBy: string;
  readonly createdAt: FirestoreTimestamp;
  readonly updatedAt: FirestoreTimestamp;
}

/** `memberships/{organizationId}_{userId}`: the id makes one membership per pair. */
interface MembershipDocument {
  readonly organizationId: string;
  readonly userId: string;
  readonly role: MembershipRole;
  readonly status: MembershipStatus;
  readonly createdAt: FirestoreTimestamp;
  readonly updatedAt: FirestoreTimestamp;
}

/** `organizationCreators/{userId}`: the record that limits each user to one created organization. */
interface CreatorDocument {
  readonly organizationId: string;
  readonly createdAt: FirestoreTimestamp;
}

const ORGANIZATION_STATUSES: readonly string[] = [
  'active',
  'suspended',
] satisfies OrganizationStatus[];
const MEMBERSHIP_STATUSES: readonly string[] = [
  'active',
  'suspended',
  'revoked',
] satisfies MembershipStatus[];

const iso = (timestamp: FirestoreTimestamp): IsoTimestamp =>
  timestamp.toDate().toISOString() as IsoTimestamp;

// Stored values are checked, not trusted: an unknown status is an error, never access. The role
// is passed on as a name: RBAC alone interprets it, and a name it does not know grants nothing.
function toOrganization(id: string, data: OrganizationDocument): Organization {
  if (!ORGANIZATION_STATUSES.includes(data.status)) throw new Error('invalid organization record');
  return Object.freeze({
    id: id as OrganizationId,
    name: data.name,
    status: data.status,
    createdBy: data.createdBy as UserId,
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
  });
}

function toMembership(id: string, data: MembershipDocument): Membership {
  if (!MEMBERSHIP_STATUSES.includes(data.status) || typeof data.role !== 'string') {
    throw new Error('invalid membership record');
  }
  return Object.freeze({
    id: id as MembershipId,
    organizationId: data.organizationId as OrganizationId,
    userId: data.userId as UserId,
    status: data.status,
    role: data.role,
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
  });
}

/**
 * Organizations and memberships in Firestore. An organization, its owner's membership, the
 * creator record and the creation's audit events are written in one transaction with `create`,
 * so they exist together or not at all, and a second organization by the same user fails even
 * under concurrent requests.
 */
export class FirestoreTenancyStore implements TenancyStore {
  constructor(
    private readonly db: Firestore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async createOrganization({
    name,
    creator,
    audit,
  }: NewOrganization): Promise<CreatedOrganization> {
    const creatorRef = this.db.collection(ORGANIZATION_CREATORS).doc(creator);
    return this.db.runTransaction(async (tx) => {
      if ((await tx.get(creatorRef)).exists) throw new TenancyError('organization_limit_reached');
      const at = Timestamp.fromDate(this.now());
      const organizationId = newOrganizationId();
      const membershipId = membershipIdOf(organizationId, creator);
      const organization: OrganizationDocument = {
        name,
        status: 'active',
        createdBy: creator,
        createdAt: at,
        updatedAt: at,
      };
      const membership: MembershipDocument = {
        organizationId,
        userId: creator,
        role: OWNER_ROLE,
        status: 'active',
        createdAt: at,
        updatedAt: at,
      };
      const record: CreatorDocument = { organizationId, createdAt: at };
      const created = {
        organization: toOrganization(organizationId, organization),
        membership: toMembership(membershipId, membership),
      };
      const events = audit?.(created) ?? [];
      tx.create(creatorRef, record);
      tx.create(this.db.collection(ORGANIZATIONS).doc(organizationId), organization);
      tx.create(this.db.collection(MEMBERSHIPS).doc(membershipId), membership);
      for (const event of events) {
        tx.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
      }
      return created;
    });
  }

  async findOrganization(id: OrganizationId): Promise<Organization | undefined> {
    if (!isOrganizationId(id)) return undefined;
    const snapshot = await this.db.collection(ORGANIZATIONS).doc(id).get();
    return snapshot.exists
      ? toOrganization(snapshot.id, snapshot.data() as OrganizationDocument)
      : undefined;
  }

  async findMembership(
    organizationId: OrganizationId,
    userId: UserId,
  ): Promise<Membership | undefined> {
    if (!isOrganizationId(organizationId)) return undefined;
    const snapshot = await this.db
      .collection(MEMBERSHIPS)
      .doc(membershipIdOf(organizationId, userId))
      .get();
    return snapshot.exists
      ? toMembership(snapshot.id, snapshot.data() as MembershipDocument)
      : undefined;
  }

  // Uses Firestore's automatic single-field index on userId; no composite index is needed.
  async membershipsOfUser(userId: UserId): Promise<readonly Membership[]> {
    const snapshot = await this.db.collection(MEMBERSHIPS).where('userId', '==', userId).get();
    return snapshot.docs.map((doc) => toMembership(doc.id, doc.data() as MembershipDocument));
  }
}
