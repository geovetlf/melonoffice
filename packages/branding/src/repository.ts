import type { AuditEvent, InMemoryAuditStore } from '@melonoffice/audit';
import type { BrandConfigRecord, BrandOwner, DomainBinding } from '@melonoffice/domain';
import { BrandingError } from './errors.js';

/** One brand configuration per owner: the id is derived from it. */
export function brandConfigIdOf(owner: BrandOwner): string {
  switch (owner.level) {
    case 'commercial_account':
      return `account_${owner.commercialAccountId}`;
    case 'organization':
      return `organization_${owner.organizationId}`;
    case 'white_label':
      return `white_label_${owner.commercialAccountId}_${owner.organizationId}`;
  }
}

/**
 * Where brand configurations and domain bindings live (ADR-0087). Every write stores its audit
 * events in the same step, and names the version it read (`expected`, by `updatedAt`): a stale
 * write is `brand_conflict` or `domain_conflict`, never a silent overwrite.
 */
export interface BrandRepository {
  findBrand(owner: BrandOwner): Promise<BrandConfigRecord | undefined>;
  saveBrand(
    record: BrandConfigRecord,
    expected: BrandConfigRecord | undefined,
    events: readonly AuditEvent[],
  ): Promise<void>;
  findDomain(hostname: string): Promise<DomainBinding | undefined>;
  /** Every binding, for the platform administrator. */
  listDomains(): Promise<readonly DomainBinding[]>;
  /** Creates or changes a binding; creating one whose hostname is taken is `domain_conflict`. */
  saveDomain(
    binding: DomainBinding,
    expected: DomainBinding | undefined,
    events: readonly AuditEvent[],
  ): Promise<void>;
}

/** For tests and local runs only: everything is lost on restart and not shared between instances. */
export class InMemoryBrandRepository implements BrandRepository {
  readonly #brands = new Map<string, BrandConfigRecord>();
  readonly #domains = new Map<string, DomainBinding>();

  constructor(private readonly audit?: InMemoryAuditStore) {}

  /** For tests that set up a record without going through a write. */
  putBrand(record: BrandConfigRecord): void {
    this.#brands.set(brandConfigIdOf(record.owner), Object.freeze({ ...record }));
  }

  putDomain(binding: DomainBinding): void {
    this.#domains.set(binding.hostname, Object.freeze({ ...binding }));
  }

  async findBrand(owner: BrandOwner) {
    return this.#brands.get(brandConfigIdOf(owner));
  }

  async saveBrand(
    record: BrandConfigRecord,
    expected: BrandConfigRecord | undefined,
    events: readonly AuditEvent[],
  ) {
    if (record.id !== brandConfigIdOf(record.owner)) throw new Error('brand id does not match');
    const current = this.#brands.get(record.id);
    if (current?.updatedAt !== expected?.updatedAt) throw new BrandingError('brand_conflict');
    this.#record(events);
    this.putBrand(record);
  }

  async findDomain(hostname: string) {
    return this.#domains.get(hostname);
  }

  async listDomains() {
    return [...this.#domains.values()];
  }

  async saveDomain(
    binding: DomainBinding,
    expected: DomainBinding | undefined,
    events: readonly AuditEvent[],
  ) {
    const current = this.#domains.get(binding.hostname);
    if (current?.updatedAt !== expected?.updatedAt) throw new BrandingError('domain_conflict');
    this.#record(events);
    this.putDomain(binding);
  }

  #record(events: readonly AuditEvent[]) {
    if (events.length === 0) return;
    if (this.audit === undefined) throw new Error('no audit store for branding events');
    this.audit.appendNow(events);
  }
}
