import type { Firestore, Timestamp as FirestoreTimestamp } from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import {
  checkStoredProfile,
  type BusinessProfileRepository,
  type ProfileWrite,
} from '@melonoffice/business';
import type {
  BusinessProfile,
  BusinessTypeId,
  EmployeeRange,
  IsoTimestamp,
  OrganizationId,
  SalesChannel,
  UserId,
} from '@melonoffice/domain';
import { isOrganizationId } from '@melonoffice/tenancy';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';

/**
 * `businessProfiles/{organizationId}` (ADR-0048): one per organization, which is also a field
 * every read checks. Written only by the API, with its audit event, in one transaction.
 */
export const BUSINESS_PROFILES = 'businessProfiles';

export interface BusinessProfileDocument {
  readonly organizationId: string;
  readonly businessType: string;
  readonly country: string;
  readonly currency: string;
  readonly timeZone: string;
  readonly city: string;
  readonly employees: string | null;
  readonly salesChannels: readonly string[];
  readonly offering: string | null;
  readonly needs: string | null;
  readonly notes: string | null;
  readonly revision: number;
  readonly createdAt: FirestoreTimestamp;
  readonly updatedAt: FirestoreTimestamp;
  readonly updatedBy: string;
}

const ts = (value: IsoTimestamp): FirestoreTimestamp => Timestamp.fromDate(new Date(value));
const iso = (value: FirestoreTimestamp): IsoTimestamp =>
  value.toDate().toISOString() as IsoTimestamp;

export function toBusinessProfileDocument(p: BusinessProfile): BusinessProfileDocument {
  return {
    organizationId: p.organizationId,
    businessType: p.businessType,
    country: p.country,
    currency: p.currency,
    timeZone: p.timeZone,
    city: p.city,
    employees: p.employees ?? null,
    salesChannels: p.salesChannels ?? [],
    offering: p.offering ?? null,
    needs: p.needs ?? null,
    notes: p.notes ?? null,
    revision: p.revision,
    createdAt: ts(p.createdAt),
    updatedAt: ts(p.updatedAt),
    updatedBy: p.updatedBy,
  };
}

// Stored values are checked, not trusted: a malformed record is refused, never repaired.
function toBusinessProfile(d: BusinessProfileDocument): BusinessProfile {
  const profile: BusinessProfile = {
    organizationId: d.organizationId as OrganizationId,
    businessType: d.businessType as BusinessTypeId,
    country: d.country,
    currency: d.currency,
    timeZone: d.timeZone,
    city: d.city,
    ...(d.employees === null ? {} : { employees: d.employees as EmployeeRange }),
    ...(d.salesChannels.length === 0
      ? {}
      : { salesChannels: d.salesChannels as readonly SalesChannel[] }),
    ...(d.offering === null ? {} : { offering: d.offering }),
    ...(d.needs === null ? {} : { needs: d.needs }),
    ...(d.notes === null ? {} : { notes: d.notes }),
    revision: d.revision,
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
    updatedBy: d.updatedBy as UserId,
  };
  try {
    return checkStoredProfile(profile);
  } catch {
    throw new Error('invalid business profile record');
  }
}

export class FirestoreBusinessProfileRepository implements BusinessProfileRepository {
  constructor(private readonly db: Firestore) {}

  async find(organizationId: OrganizationId): Promise<BusinessProfile | undefined> {
    if (!isOrganizationId(organizationId)) return undefined;
    const snapshot = await this.db.collection(BUSINESS_PROFILES).doc(organizationId).get();
    if (!snapshot.exists) return undefined;
    const data = snapshot.data() as BusinessProfileDocument;
    if (data.organizationId !== organizationId) return undefined;
    return toBusinessProfile(data);
  }

  async save(
    organizationId: OrganizationId,
    change: (current: BusinessProfile | undefined) => ProfileWrite | undefined,
  ): Promise<BusinessProfile | undefined> {
    if (!isOrganizationId(organizationId)) throw new Error('invalid organization');
    const doc = this.db.collection(BUSINESS_PROFILES).doc(organizationId);
    // Firestore runs the function again when the profile changed before the commit, so `change`
    // always decides on the profile it replaces.
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      const data = snapshot.data() as BusinessProfileDocument | undefined;
      if (data !== undefined && data.organizationId !== organizationId) {
        throw new Error('invalid business profile record');
      }
      const current = data === undefined ? undefined : toBusinessProfile(data);
      const write = change(current);
      if (write === undefined) return current;
      if (
        write.profile.organizationId !== organizationId ||
        write.profile.revision !== (current?.revision ?? 0) + 1
      ) {
        throw new Error('profile_concurrency_conflict');
      }
      checkStoredProfile(write.profile);
      t.set(doc, toBusinessProfileDocument(write.profile));
      for (const event of write.events) {
        if (event.organizationId !== organizationId) throw new Error('audit_event_organization');
        t.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
      }
      return write.profile;
    });
  }
}
