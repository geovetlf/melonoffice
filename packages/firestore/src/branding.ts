import type {
  Firestore,
  Timestamp as FirestoreTimestamp,
  Transaction,
} from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import type { AuditEvent } from '@melonoffice/audit';
import {
  brandConfigIdOf,
  BrandingError,
  isDomainBindingStatus,
  isHostname,
  parseBrandConfig,
  parseDomainTarget,
  type BrandRepository,
} from '@melonoffice/branding';
import type {
  BrandConfig,
  BrandConfigRecord,
  BrandOwner,
  DomainBinding,
  IsoTimestamp,
  UserId,
} from '@melonoffice/domain';
import { isCommercialAccountId, isOrganizationId } from '@melonoffice/tenancy';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';

/** Collections of brands and domains (ADR-0087). Read and written only by the API. */
export const BRAND_CONFIGS = 'brandConfigs';
export const DOMAIN_BINDINGS = 'domainBindings';

/** `brandConfigs/{account_|organization_|white_label_}...`: one per owner. */
interface BrandDocument {
  readonly level: string;
  readonly commercialAccountId: string | null;
  readonly organizationId: string | null;
  readonly config: Record<string, unknown>;
  readonly createdAt: FirestoreTimestamp;
  readonly updatedAt: FirestoreTimestamp;
  readonly updatedBy: string;
}

/** `domainBindings/{hostname}`: one per hostname. */
interface DomainDocument {
  readonly targetType: string;
  readonly commercialAccountId: string | null;
  readonly organizationId: string | null;
  readonly status: string;
  readonly createdAt: FirestoreTimestamp;
  readonly updatedAt: FirestoreTimestamp;
  readonly createdBy: string;
}

const iso = (t: FirestoreTimestamp): IsoTimestamp => t.toDate().toISOString() as IsoTimestamp;
const at = (value: string) => Timestamp.fromDate(new Date(value));

function ownerOf(d: BrandDocument): BrandOwner {
  const account = d.commercialAccountId;
  const organization = d.organizationId;
  if (d.level === 'commercial_account' && isCommercialAccountId(account) && organization === null) {
    return { level: 'commercial_account', commercialAccountId: account };
  }
  if (d.level === 'organization' && isOrganizationId(organization) && account === null) {
    return { level: 'organization', organizationId: organization };
  }
  if (
    d.level === 'white_label' &&
    isCommercialAccountId(account) &&
    isOrganizationId(organization)
  ) {
    return { level: 'white_label', commercialAccountId: account, organizationId: organization };
  }
  throw new Error('invalid brand config record');
}

// Stored values are checked, not trusted: a record that fails is refused, never used.
function toBrand(id: string, d: BrandDocument): BrandConfigRecord {
  const owner = ownerOf(d);
  if (id !== brandConfigIdOf(owner) || typeof d.updatedBy !== 'string') {
    throw new Error('invalid brand config record');
  }
  let config: BrandConfig;
  try {
    config = parseBrandConfig(d.config, owner.level);
  } catch {
    throw new Error('invalid brand config record');
  }
  return Object.freeze({
    id,
    owner: Object.freeze(owner),
    config,
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
    updatedBy: d.updatedBy as UserId,
  });
}

function toDomain(id: string, d: DomainDocument): DomainBinding {
  if (!isHostname(id) || !isDomainBindingStatus(d.status) || typeof d.createdBy !== 'string') {
    throw new Error('invalid domain binding record');
  }
  let target;
  try {
    target = parseDomainTarget({
      type: d.targetType,
      ...(d.commercialAccountId === null ? {} : { commercialAccountId: d.commercialAccountId }),
      ...(d.organizationId === null ? {} : { organizationId: d.organizationId }),
    });
  } catch {
    throw new Error('invalid domain binding record');
  }
  return Object.freeze({
    hostname: id,
    target,
    status: d.status,
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
    createdBy: d.createdBy as UserId,
  });
}

const brandDocument = (r: BrandConfigRecord): BrandDocument => ({
  level: r.owner.level,
  commercialAccountId: r.owner.level === 'organization' ? null : r.owner.commercialAccountId,
  organizationId: r.owner.level === 'commercial_account' ? null : r.owner.organizationId,
  config: JSON.parse(JSON.stringify(r.config)) as Record<string, unknown>,
  createdAt: at(r.createdAt),
  updatedAt: at(r.updatedAt),
  updatedBy: r.updatedBy,
});

const domainDocument = (b: DomainBinding): DomainDocument => ({
  targetType: b.target.type,
  commercialAccountId: b.target.type === 'commercial_account' ? b.target.commercialAccountId : null,
  organizationId: b.target.type === 'organization' ? b.target.organizationId : null,
  status: b.status,
  createdAt: at(b.createdAt),
  updatedAt: at(b.updatedAt),
  createdBy: b.createdBy,
});

/**
 * Brands and domains in Firestore (ADR-0087). Every write runs in a transaction with its audit
 * events and checks the version it read. Reads are by id only, and the platform administrator's
 * list reads the whole (small) collection, so no index is needed.
 */
export class FirestoreBrandStore implements BrandRepository {
  constructor(private readonly db: Firestore) {}

  async findBrand(owner: BrandOwner) {
    const id = brandConfigIdOf(owner);
    const snapshot = await this.db.collection(BRAND_CONFIGS).doc(id).get();
    if (!snapshot.exists) return undefined;
    const record = toBrand(snapshot.id, snapshot.data() as BrandDocument);
    return record.id === id ? record : undefined;
  }

  async saveBrand(
    record: BrandConfigRecord,
    expected: BrandConfigRecord | undefined,
    events: readonly AuditEvent[],
  ) {
    if (record.id !== brandConfigIdOf(record.owner)) throw new Error('brand id does not match');
    await this.db.runTransaction(async (tx) => {
      const ref = this.db.collection(BRAND_CONFIGS).doc(record.id);
      const snapshot = await tx.get(ref);
      const current = snapshot.exists
        ? toBrand(snapshot.id, snapshot.data() as BrandDocument)
        : undefined;
      if (current?.updatedAt !== expected?.updatedAt) throw new BrandingError('brand_conflict');
      tx.set(ref, brandDocument(record));
      this.#audit(tx, events);
    });
  }

  async findDomain(hostname: string) {
    if (!isHostname(hostname)) return undefined;
    const snapshot = await this.db.collection(DOMAIN_BINDINGS).doc(hostname).get();
    return snapshot.exists ? toDomain(snapshot.id, snapshot.data() as DomainDocument) : undefined;
  }

  async listDomains() {
    const snapshot = await this.db.collection(DOMAIN_BINDINGS).get();
    return snapshot.docs.map((d) => toDomain(d.id, d.data() as DomainDocument));
  }

  async saveDomain(
    binding: DomainBinding,
    expected: DomainBinding | undefined,
    events: readonly AuditEvent[],
  ) {
    if (!isHostname(binding.hostname)) throw new Error('invalid hostname');
    await this.db.runTransaction(async (tx) => {
      const ref = this.db.collection(DOMAIN_BINDINGS).doc(binding.hostname);
      const snapshot = await tx.get(ref);
      const current = snapshot.exists
        ? toDomain(snapshot.id, snapshot.data() as DomainDocument)
        : undefined;
      if (current?.updatedAt !== expected?.updatedAt) throw new BrandingError('domain_conflict');
      tx.set(ref, domainDocument(binding));
      this.#audit(tx, events);
    });
  }

  #audit(tx: Transaction, events: readonly AuditEvent[]) {
    for (const event of events) {
      tx.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
    }
  }
}
