import type { InMemoryAuditStore } from '@melonoffice/audit';
import type {
  OrganizationId,
  Specialist,
  SpecialistId,
  SpecialistVersion,
} from '@melonoffice/domain';
import { SpecialistError } from './errors.js';
import {
  checkSpecialistWrite,
  checkStoredSpecialist,
  checkStoredVersion,
  type SpecialistWrite,
} from './model.js';

/**
 * Where specialists and their versions live: Firestore in the API (ADR-0025), memory in tests.
 * A version is written once, with `create`, and never changed. Every write stores the specialist
 * and its new version together, or nothing. Audit events join these writes with the first route
 * that makes them.
 */
export interface SpecialistRepository {
  /** The specialist, only when it belongs to the organization. Another organization's is absent. */
  find(organizationId: OrganizationId, id: SpecialistId): Promise<Specialist | undefined>;
  /** Every specialist of the organization, in any status. */
  list(organizationId: OrganizationId): Promise<readonly Specialist[]>;
  /** One version of a specialist of the organization. */
  findVersion(
    organizationId: OrganizationId,
    id: SpecialistId,
    version: number,
  ): Promise<SpecialistVersion | undefined>;
  /** Stores a new specialist with its version 1. Refuses an id that already exists. */
  create(write: SpecialistWrite): Promise<void>;
  /**
   * Reads the current specialist and lets `change` decide what to store, in one transaction.
   * The result must pass `checkSpecialistWrite`; a concurrent write in between makes it
   * `specialist_concurrency_conflict`. An absent specialist, or another organization's, is
   * `specialist_not_found`.
   */
  update(
    organizationId: OrganizationId,
    id: SpecialistId,
    change: (current: Specialist) => SpecialistWrite,
  ): Promise<Specialist>;
}

const versionKey = (id: SpecialistId, version: number): string => `${id}_${version}`;

/** For tests and local runs only. */
export class InMemorySpecialistRepository implements SpecialistRepository {
  readonly #specialists = new Map<string, Specialist>();
  readonly #versions = new Map<string, SpecialistVersion>();

  /** `audit` receives a change's events (ADR-0062); a change with events needs one. */
  constructor(private readonly audit?: Pick<InMemoryAuditStore, 'appendNow'>) {}

  async find(organizationId: OrganizationId, id: SpecialistId): Promise<Specialist | undefined> {
    const specialist = this.#specialists.get(id);
    return specialist?.organizationId === organizationId
      ? checkStoredSpecialist(specialist)
      : undefined;
  }

  async list(organizationId: OrganizationId): Promise<readonly Specialist[]> {
    return [...this.#specialists.values()]
      .filter((s) => s.organizationId === organizationId)
      .map(checkStoredSpecialist)
      .sort((a, b) => (a.identity.id < b.identity.id ? -1 : 1));
  }

  async findVersion(
    organizationId: OrganizationId,
    id: SpecialistId,
    version: number,
  ): Promise<SpecialistVersion | undefined> {
    const found = this.#versions.get(versionKey(id, version));
    return found?.organizationId === organizationId ? checkStoredVersion(found) : undefined;
  }

  async create(write: SpecialistWrite): Promise<void> {
    checkSpecialistWrite(undefined, write);
    if (this.#specialists.has(write.specialist.identity.id)) {
      throw new Error('specialist already exists');
    }
    this.#store(write);
  }

  async update(
    organizationId: OrganizationId,
    id: SpecialistId,
    change: (current: Specialist) => SpecialistWrite,
  ): Promise<Specialist> {
    const current = await this.find(organizationId, id);
    if (current === undefined) throw new SpecialistError('specialist_not_found');
    const write = change(current);
    checkSpecialistWrite(current, write);
    // Nothing awaits between the read and this check, but a caller may hold an older copy.
    if (this.#specialists.get(id)?.revision !== current.revision) {
      throw new SpecialistError('specialist_concurrency_conflict');
    }
    this.#store(write);
    return write.specialist;
  }

  #store({ specialist, version, events = [] }: SpecialistWrite): void {
    if (version !== undefined) {
      const key = versionKey(version.specialistId, version.version);
      // Versions are written once: an existing one is never replaced.
      if (this.#versions.has(key)) throw new SpecialistError('specialist_concurrency_conflict');
    }
    if (events.length > 0) {
      if (this.audit === undefined) throw new Error('no audit store for specialist events');
      // The audit events first: if they cannot be stored, nothing of the change is.
      this.audit.appendNow(events);
    }
    if (version !== undefined) {
      this.#versions.set(versionKey(version.specialistId, version.version), version);
    }
    this.#specialists.set(specialist.identity.id, specialist);
  }

  /** Test hook: stores a record as given, the way corrupted or legacy data would look. */
  put(record: Specialist | SpecialistVersion): void {
    if ('identity' in record) this.#specialists.set(record.identity.id, record);
    else this.#versions.set(versionKey(record.specialistId, record.version), record);
  }
}
