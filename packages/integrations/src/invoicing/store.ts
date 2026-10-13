import type { AuditEvent, InMemoryAuditStore } from '@melonoffice/audit';
import type {
  FiscalDocument,
  InvoicingConnection,
  InvoicingConnectionId,
  InvoicingParty,
  InvoicingPayment,
  InvoicingRecordType,
  InvoicingSyncJob,
  InvoicingSyncJobId,
  OrganizationId,
} from '@melonoffice/domain';
import { IntegrationError } from '../errors.js';
import { canTransition } from '../lifecycle.js';
import { canMoveSync, checkStoredInvoicingConnection, isFinalSync } from './model.js';

/**
 * Where the Billing Integration Gateway keeps its records (ADR-0193): connections, syncs and the
 * normalized parties, documents and payments. Every read and write names the organization; a
 * record of another organization is never returned, changed or overwritten. Firestore is the
 * production store (phase 2); memory is for tests and local runs.
 *
 * Collections (phase 2, each document carrying `organizationId`):
 * - `invoicingConnections/{connectionId}`
 * - `invoicingSyncJobs/{organizationId}:{jobId}`, with
 *   `invoicingSyncKeys/{organizationId}:{connectionId}:{sha256(key)}` holding the job id and
 *   `invoicingSyncLocks/{organizationId}:{connectionId}:{recordType}` holding the running sync,
 *   written in the same transaction, so a key starts one sync and a record type runs one;
 * - `invoicingRecords/{organizationId}:{recordType}:{connectionId}:{sha256(externalId)}`, with
 *   `invoicingPaymentLinks/{organizationId}:{connectionId}:{sha256(documentExternalId)}` listing
 *   the payments that apply to a document.
 *
 * Each is read by id or by id range, so none needs a composite index.
 */

export type StoredInvoicingRecord =
  | { readonly recordType: 'party'; readonly record: InvoicingParty }
  | { readonly recordType: 'document'; readonly record: FiscalDocument }
  | { readonly recordType: 'payment'; readonly record: InvoicingPayment };

/** A change to a connection and the audit events that record it: stored together or not at all. */
export interface InvoicingConnectionWrite {
  readonly connection: InvoicingConnection;
  readonly events: readonly AuditEvent[];
}

export interface InvoicingJobWrite {
  readonly job: InvoicingSyncJob;
  readonly events: readonly AuditEvent[];
}

/** What upserting one record did. */
export type UpsertOutcome = 'created' | 'updated' | 'unchanged';

export interface RecordPage {
  readonly items: readonly StoredInvoicingRecord[];
  readonly nextCursor?: string;
}

export interface InvoicingRepository {
  findConnection(
    organizationId: OrganizationId,
    id: InvoicingConnectionId,
  ): Promise<InvoicingConnection | undefined>;
  /** By id alone, for webhooks: the stored connection names the organization, never the request. */
  findConnectionForWebhook(id: InvoicingConnectionId): Promise<InvoicingConnection | undefined>;
  listConnections(organizationId: OrganizationId): Promise<readonly InvoicingConnection[]>;
  createConnection(write: InvoicingConnectionWrite): Promise<void>;
  /** Reads the current record, applies `change` and stores the result, atomically. */
  updateConnection(
    organizationId: OrganizationId,
    id: InvoicingConnectionId,
    change: (current: InvoicingConnection) => InvoicingConnectionWrite,
  ): Promise<InvoicingConnection>;

  /**
   * Stores a new sync unless one with the same organization, connection and key exists, which is
   * returned instead (`created: false`). Atomic.
   */
  createJobOnce(write: InvoicingJobWrite): Promise<{ job: InvoicingSyncJob; created: boolean }>;
  findJob(
    organizationId: OrganizationId,
    id: InvoicingSyncJobId,
  ): Promise<InvoicingSyncJob | undefined>;
  /**
   * The sync not yet ended for one connection and record type, if any (file imports aside: see
   * `holdsSyncLock`). `createJobOnce` refuses a second one with `sync_in_progress`.
   */
  activeJob(
    organizationId: OrganizationId,
    connectionId: InvoicingConnectionId,
    recordType: InvoicingRecordType,
  ): Promise<InvoicingSyncJob | undefined>;
  listJobs(
    organizationId: OrganizationId,
    filter?: { readonly connectionId?: InvoicingConnectionId; readonly from?: string },
  ): Promise<readonly InvoicingSyncJob[]>;
  updateJob(
    organizationId: OrganizationId,
    id: InvoicingSyncJobId,
    change: (current: InvoicingSyncJob) => InvoicingJobWrite,
  ): Promise<InvoicingSyncJob>;

  /**
   * Stores a record by its organization, connection, type and provider id. Unchanged when the
   * original's digest is the same; otherwise a new revision of the same record.
   */
  upsertRecord(
    organizationId: OrganizationId,
    build: (existing: StoredInvoicingRecord | undefined) => StoredInvoicingRecord,
    key: {
      readonly connectionId: InvoicingConnectionId;
      readonly recordType: InvoicingRecordType;
      readonly externalId: string;
    },
  ): Promise<{ outcome: UpsertOutcome; stored: StoredInvoicingRecord }>;
  findRecord(
    organizationId: OrganizationId,
    key: {
      readonly connectionId: InvoicingConnectionId;
      readonly recordType: InvoicingRecordType;
      readonly externalId: string;
    },
  ): Promise<StoredInvoicingRecord | undefined>;
  /** Payments of one connection that apply to a document, for its confirmed total. */
  paymentsFor(
    organizationId: OrganizationId,
    connectionId: InvoicingConnectionId,
    documentExternalId: string,
  ): Promise<readonly InvoicingPayment[]>;
  listRecords(
    organizationId: OrganizationId,
    filter: {
      readonly recordType: InvoicingRecordType;
      readonly connectionId?: InvoicingConnectionId;
      readonly pageSize: number;
      readonly cursor?: string;
    },
  ): Promise<RecordPage>;
}

const recordKey = (
  organizationId: string,
  key: { connectionId: string; recordType: string; externalId: string },
) => `${organizationId}\u0000${key.connectionId}\u0000${key.recordType}\u0000${key.externalId}`;

/** The most records one listed page holds. */
export const MAX_INVOICING_LIST_PAGE = 100;

/**
 * Whether a sync takes its connection and record type's lock: every sync that reads the provider.
 * A file import reads only the file it was given, ends inside the request, and may run beside one.
 */
export const holdsSyncLock = (job: Pick<InvoicingSyncJob, 'trigger'>): boolean =>
  job.trigger !== 'file_import';

/** For tests and local runs only. */
export class InMemoryInvoicingRepository implements InvoicingRepository {
  readonly #connections = new Map<string, InvoicingConnection>();
  readonly #jobs = new Map<string, InvoicingSyncJob>();
  readonly #jobKeys = new Map<string, string>();
  readonly #records = new Map<string, StoredInvoicingRecord>();

  constructor(private readonly audit?: InMemoryAuditStore) {}

  async findConnection(organizationId: OrganizationId, id: InvoicingConnectionId) {
    const c = this.#connections.get(id);
    return c?.organizationId === organizationId ? checkStoredInvoicingConnection(c) : undefined;
  }

  async findConnectionForWebhook(id: InvoicingConnectionId) {
    const c = this.#connections.get(id);
    return c === undefined ? undefined : checkStoredInvoicingConnection(c);
  }

  async listConnections(organizationId: OrganizationId) {
    return [...this.#connections.values()]
      .filter((c) => c.organizationId === organizationId)
      .map(checkStoredInvoicingConnection)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  async createConnection({ connection, events }: InvoicingConnectionWrite) {
    if (this.#connections.has(connection.id)) throw new Error('connection already exists');
    checkStoredInvoicingConnection(connection);
    this.audit?.appendNow(events);
    this.#connections.set(connection.id, connection);
  }

  async updateConnection(
    organizationId: OrganizationId,
    id: InvoicingConnectionId,
    change: (current: InvoicingConnection) => InvoicingConnectionWrite,
  ) {
    const current = await this.findConnection(organizationId, id);
    if (current === undefined) throw new IntegrationError('connection_not_found');
    const { connection, events } = change(current);
    checkNextInvoicingConnection(current, connection);
    this.audit?.appendNow(events);
    this.#connections.set(id, connection);
    return connection;
  }

  async createJobOnce({ job, events }: InvoicingJobWrite) {
    const key = `${job.organizationId}\u0000${job.connectionId}\u0000${job.idempotencyKey}`;
    const existing = this.#jobKeys.get(key);
    if (existing !== undefined) {
      return { job: this.#jobs.get(existing) as InvoicingSyncJob, created: false };
    }
    if (this.#jobs.has(job.id)) throw new Error('job already exists');
    // One sync at a time per connection and record type, as the Firestore lock does.
    if (
      holdsSyncLock(job) &&
      (await this.activeJob(job.organizationId, job.connectionId, job.recordType)) !== undefined
    ) {
      throw new IntegrationError('sync_in_progress');
    }
    this.audit?.appendNow(events);
    this.#jobs.set(job.id, job);
    this.#jobKeys.set(key, job.id);
    return { job, created: true };
  }

  async findJob(organizationId: OrganizationId, id: InvoicingSyncJobId) {
    const job = this.#jobs.get(id);
    return job?.organizationId === organizationId ? job : undefined;
  }

  async activeJob(
    organizationId: OrganizationId,
    connectionId: InvoicingConnectionId,
    recordType: InvoicingRecordType,
  ) {
    return [...this.#jobs.values()].find(
      (j) =>
        j.organizationId === organizationId &&
        j.connectionId === connectionId &&
        j.recordType === recordType &&
        holdsSyncLock(j) &&
        !isFinalSync(j),
    );
  }

  async listJobs(
    organizationId: OrganizationId,
    filter: { readonly connectionId?: InvoicingConnectionId; readonly from?: string } = {},
  ) {
    return [...this.#jobs.values()]
      .filter(
        (j) =>
          j.organizationId === organizationId &&
          (filter.connectionId === undefined || j.connectionId === filter.connectionId) &&
          (filter.from === undefined || j.createdAt >= filter.from),
      )
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  async updateJob(
    organizationId: OrganizationId,
    id: InvoicingSyncJobId,
    change: (current: InvoicingSyncJob) => InvoicingJobWrite,
  ) {
    const current = await this.findJob(organizationId, id);
    if (current === undefined) throw new IntegrationError('sync_not_found');
    const { job, events } = change(current);
    checkNextInvoicingJob(current, job);
    this.audit?.appendNow(events);
    this.#jobs.set(id, job);
    return job;
  }

  async upsertRecord(
    organizationId: OrganizationId,
    build: (existing: StoredInvoicingRecord | undefined) => StoredInvoicingRecord,
    key: {
      connectionId: InvoicingConnectionId;
      recordType: InvoicingRecordType;
      externalId: string;
    },
  ) {
    const k = recordKey(organizationId, key);
    const existing = this.#records.get(k);
    const stored = build(existing);
    checkRecordWrite(organizationId, key, existing, stored);
    if (existing !== undefined && existing.record.revision === stored.record.revision) {
      return { outcome: 'unchanged' as const, stored: existing };
    }
    this.#records.set(k, stored);
    return {
      outcome: existing === undefined ? ('created' as const) : ('updated' as const),
      stored,
    };
  }

  async findRecord(
    organizationId: OrganizationId,
    key: {
      connectionId: InvoicingConnectionId;
      recordType: InvoicingRecordType;
      externalId: string;
    },
  ) {
    return this.#records.get(recordKey(organizationId, key));
  }

  async paymentsFor(
    organizationId: OrganizationId,
    connectionId: InvoicingConnectionId,
    documentExternalId: string,
  ) {
    return [...this.#records.values()]
      .filter(
        (s): s is Extract<StoredInvoicingRecord, { recordType: 'payment' }> =>
          s.recordType === 'payment' &&
          s.record.organizationId === organizationId &&
          s.record.source.connectionId === connectionId &&
          s.record.appliesTo.some((a) => a.externalId === documentExternalId),
      )
      .map((s) => s.record);
  }

  async listRecords(
    organizationId: OrganizationId,
    filter: {
      recordType: InvoicingRecordType;
      connectionId?: InvoicingConnectionId;
      pageSize: number;
      cursor?: string;
    },
  ) {
    const size = Math.min(Math.max(1, Math.floor(filter.pageSize)), MAX_INVOICING_LIST_PAGE);
    const all = [...this.#records.entries()]
      .filter(
        ([, s]) =>
          s.record.organizationId === organizationId &&
          s.recordType === filter.recordType &&
          (filter.connectionId === undefined ||
            s.record.source.connectionId === filter.connectionId),
      )
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    const start =
      filter.cursor === undefined ? 0 : all.findIndex(([k]) => k > (filter.cursor as string));
    const slice = start < 0 ? [] : all.slice(start, start + size);
    const last = slice.at(-1);
    const more = start >= 0 && start + size < all.length;
    return {
      items: slice.map(([, s]) => s),
      ...(more && last !== undefined ? { nextCursor: last[0] } : {}),
    };
  }

  /** Test helper: stores a connection as given, the way bad data or an operator change would. */
  putConnection(connection: InvoicingConnection): void {
    this.#connections.set(connection.id, connection);
  }
}

/**
 * What a change may alter: name, status (along an allowed transition), its reason, when it was
 * last checked, capabilities when a check connects it, and where each record type's sync stands.
 * Never the organization, provider, jurisdiction, account or secret references. One revision at
 * a time.
 */
export function checkNextInvoicingConnection(
  current: InvoicingConnection,
  next: InvoicingConnection,
): void {
  const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
  if (
    next.id !== current.id ||
    next.organizationId !== current.organizationId ||
    next.provider !== current.provider ||
    next.jurisdiction !== current.jurisdiction ||
    next.revision !== current.revision + 1 ||
    next.createdAt !== current.createdAt ||
    next.createdBy !== current.createdBy ||
    !same(next.account, current.account) ||
    !same(next.secrets, current.secrets) ||
    (!same(next.capabilities, current.capabilities) &&
      !(current.status === 'connecting' && next.status === 'connected'))
  ) {
    throw new IntegrationError('invalid_connection', 'concurrency');
  }
  if (next.status !== current.status && !canTransition(current.status, next.status)) {
    throw new IntegrationError('invalid_transition', `${current.status}->${next.status}`);
  }
  checkStoredInvoicingConnection(next);
}

/** What a sync's change may alter: never its identity, key, trigger or record type. */
export function checkNextInvoicingJob(current: InvoicingSyncJob, next: InvoicingSyncJob): void {
  if (
    next.id !== current.id ||
    next.organizationId !== current.organizationId ||
    next.connectionId !== current.connectionId ||
    next.recordType !== current.recordType ||
    next.trigger !== current.trigger ||
    next.idempotencyKey !== current.idempotencyKey ||
    next.revision !== current.revision + 1
  ) {
    throw new IntegrationError('invalid_connection', 'concurrency');
  }
  if (next.status !== current.status && !canMoveSync(current.status, next.status)) {
    throw new IntegrationError('invalid_transition', `${current.status}->${next.status}`);
  }
}

/** A record is stored under its own organization, connection, type and provider id only. */
export function checkRecordWrite(
  organizationId: OrganizationId,
  key: {
    readonly connectionId: InvoicingConnectionId;
    readonly recordType: InvoicingRecordType;
    readonly externalId: string;
  },
  existing: StoredInvoicingRecord | undefined,
  stored: StoredInvoicingRecord,
): void {
  const r = stored.record;
  if (
    r.organizationId !== organizationId ||
    stored.recordType !== key.recordType ||
    r.source.connectionId !== key.connectionId ||
    r.source.externalId !== key.externalId ||
    (existing !== undefined && r.id !== existing.record.id)
  ) {
    throw new IntegrationError('invalid_payload', 'record.key');
  }
}
