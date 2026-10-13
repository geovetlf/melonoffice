import type { DocumentReference, Firestore, Transaction } from '@google-cloud/firestore';
import { FieldPath, FieldValue } from '@google-cloud/firestore';
import type { AuditEvent } from '@melonoffice/audit';
import type {
  InvoicingConnection,
  InvoicingConnectionId,
  InvoicingPayment,
  InvoicingRecordType,
  InvoicingSyncJob,
  InvoicingSyncJobId,
  OrganizationId,
} from '@melonoffice/domain';
import {
  checkNextInvoicingConnection,
  checkNextInvoicingJob,
  checkRecordWrite,
  checkStoredInvoicingConnection,
  digestOf,
  holdsSyncLock,
  IntegrationError,
  isFinalSync,
  isInvoicingId,
  isInvoicingRecordType,
  MAX_INVOICING_LIST_PAGE,
  type InvoicingConnectionWrite,
  type InvoicingJobWrite,
  type InvoicingRepository,
  type RecordPage,
  type StoredInvoicingRecord,
  type UpsertOutcome,
} from '@melonoffice/integrations';
import { isOrganizationId } from '@melonoffice/tenancy';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';

/**
 * The Billing Integration Gateway's records (ADR-0193): an organization's connections to its own
 * invoicing systems, their syncs, and the parties, documents and payments read from them. Only
 * public account fields and secret references are stored; a credential's value never is.
 *
 * Every read is by document id or by a range of ids that starts with the organization, so no
 * query needs a composite index and none can reach another organization's documents:
 *
 * - `invoicingConnections/{connectionId}` (listed by `organizationId`, a single-field index);
 * - `invoicingSyncJobs/{organizationId}:{jobId}`;
 * - `invoicingSyncKeys/{organizationId}:{connectionId}:{sha256(key)}`: the sync a key started;
 * - `invoicingSyncLocks/{organizationId}:{connectionId}:{recordType}`: the sync reading that
 *   record type, so two never read it at once;
 * - `invoicingRecords/{organizationId}:{recordType}:{connectionId}:{sha256(externalId)}`;
 * - `invoicingPaymentLinks/{organizationId}:{connectionId}:{sha256(documentExternalId)}`: the
 *   payments that apply to a document, kept in the payment's own write.
 */
export const INVOICING_CONNECTIONS = 'invoicingConnections';
export const INVOICING_SYNC_JOBS = 'invoicingSyncJobs';
export const INVOICING_SYNC_KEYS = 'invoicingSyncKeys';
export const INVOICING_SYNC_LOCKS = 'invoicingSyncLocks';
export const INVOICING_RECORDS = 'invoicingRecords';
export const INVOICING_PAYMENT_LINKS = 'invoicingPaymentLinks';

/** Jobs read per round trip when listing an organization's syncs. */
const JOBS_PER_READ = 500;

/** Plain data: no `undefined`, no class instances. Records are ISO strings throughout. */
const plain = <T>(value: T): Record<string, unknown> =>
  JSON.parse(JSON.stringify(value)) as Record<string, unknown>;

/** The first id after every id that starts with `prefix` (whose separator is `:`). */
const endOf = (prefix: string) => `${prefix.slice(0, -1)};`;

type RecordKey = {
  readonly connectionId: InvoicingConnectionId;
  readonly recordType: InvoicingRecordType;
  readonly externalId: string;
};

function toConnection(data: Record<string, unknown> | undefined): InvoicingConnection | undefined {
  if (data === undefined) return undefined;
  try {
    return Object.freeze(checkStoredInvoicingConnection(data as unknown as InvoicingConnection));
  } catch {
    throw new Error('invalid invoicing connection record');
  }
}

export class FirestoreInvoicingRepository implements InvoicingRepository {
  constructor(private readonly db: Firestore) {}

  #connection(id: string) {
    return this.db.collection(INVOICING_CONNECTIONS).doc(id);
  }

  #job(organizationId: string, id: string) {
    return this.db.collection(INVOICING_SYNC_JOBS).doc(`${organizationId}:${id}`);
  }

  #lock(organizationId: string, connectionId: string, recordType: string) {
    return this.db
      .collection(INVOICING_SYNC_LOCKS)
      .doc(`${organizationId}:${connectionId}:${recordType}`);
  }

  #record(organizationId: string, key: RecordKey) {
    return this.db
      .collection(INVOICING_RECORDS)
      .doc(`${organizationId}:${key.recordType}:${key.connectionId}:${digestOf(key.externalId)}`);
  }

  #paymentLink(organizationId: string, connectionId: string, documentExternalId: string) {
    return this.db
      .collection(INVOICING_PAYMENT_LINKS)
      .doc(`${organizationId}:${connectionId}:${digestOf(documentExternalId)}`);
  }

  async findConnection(organizationId: OrganizationId, id: InvoicingConnectionId) {
    if (!isOrganizationId(organizationId) || !isInvoicingId(id)) return undefined;
    const connection = toConnection((await this.#connection(id).get()).data());
    return connection?.organizationId === organizationId ? connection : undefined;
  }

  async findConnectionForWebhook(id: InvoicingConnectionId) {
    if (!isInvoicingId(id)) return undefined;
    return toConnection((await this.#connection(id).get()).data());
  }

  async listConnections(organizationId: OrganizationId) {
    if (!isOrganizationId(organizationId)) return [];
    const snapshot = await this.db
      .collection(INVOICING_CONNECTIONS)
      .where('organizationId', '==', organizationId)
      .get();
    return snapshot.docs
      .map((doc) => toConnection(doc.data()) as InvoicingConnection)
      .filter((c) => c.organizationId === organizationId)
      .sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }

  async createConnection({ connection, events }: InvoicingConnectionWrite) {
    checkStoredInvoicingConnection(connection);
    await this.db.runTransaction(async (t) => {
      t.create(this.#connection(connection.id), plain(connection));
      this.#append(t, events);
    });
  }

  async updateConnection(
    organizationId: OrganizationId,
    id: InvoicingConnectionId,
    change: (current: InvoicingConnection) => InvoicingConnectionWrite,
  ) {
    if (!isOrganizationId(organizationId) || !isInvoicingId(id)) {
      throw new IntegrationError('connection_not_found');
    }
    const ref = this.#connection(id);
    return this.db.runTransaction(async (t) => {
      const current = toConnection((await t.get(ref)).data());
      if (current?.organizationId !== organizationId) {
        throw new IntegrationError('connection_not_found');
      }
      const { connection, events } = change(current);
      checkNextInvoicingConnection(current, connection);
      t.set(ref, plain(connection));
      this.#append(t, events);
      return connection;
    });
  }

  async createJobOnce({ job, events }: InvoicingJobWrite) {
    if (!isOrganizationId(job.organizationId) || !isInvoicingId(job.id)) {
      throw new IntegrationError('invalid_payload', 'job');
    }
    const keyRef = this.db
      .collection(INVOICING_SYNC_KEYS)
      .doc(`${job.organizationId}:${job.connectionId}:${digestOf(job.idempotencyKey)}`);
    const lockRef = this.#lock(job.organizationId, job.connectionId, job.recordType);
    const jobRef = this.#job(job.organizationId, job.id);
    return this.db.runTransaction(async (t) => {
      const key = (await t.get(keyRef)).data();
      if (key !== undefined) {
        const existing = await this.#readJob(t, job.organizationId, String(key.jobId));
        if (existing === undefined) throw new Error('invoicing sync key without its sync');
        return { job: existing, created: false };
      }
      if (holdsSyncLock(job)) {
        const lock = (await t.get(lockRef)).data();
        if (lock !== undefined) {
          const holder = await this.#readJob(t, job.organizationId, String(lock.jobId));
          if (holder !== undefined && !isFinalSync(holder)) {
            throw new IntegrationError('sync_in_progress');
          }
        }
      }
      t.create(jobRef, plain(job));
      t.create(keyRef, {
        organizationId: job.organizationId,
        connectionId: job.connectionId,
        jobId: job.id,
      });
      if (holdsSyncLock(job)) {
        t.set(lockRef, {
          organizationId: job.organizationId,
          connectionId: job.connectionId,
          recordType: job.recordType,
          jobId: job.id,
        });
      }
      this.#append(t, events);
      return { job, created: true };
    });
  }

  async findJob(organizationId: OrganizationId, id: InvoicingSyncJobId) {
    if (!isOrganizationId(organizationId) || !isInvoicingId(id)) return undefined;
    return toJob(organizationId, id, (await this.#job(organizationId, id).get()).data());
  }

  async activeJob(
    organizationId: OrganizationId,
    connectionId: InvoicingConnectionId,
    recordType: InvoicingRecordType,
  ) {
    if (!isOrganizationId(organizationId) || !isInvoicingId(connectionId)) return undefined;
    const lock = (await this.#lock(organizationId, connectionId, recordType).get()).data();
    if (lock === undefined) return undefined;
    const job = await this.findJob(organizationId, String(lock.jobId) as InvoicingSyncJobId);
    return job === undefined || isFinalSync(job) ? undefined : job;
  }

  async listJobs(
    organizationId: OrganizationId,
    filter: { readonly connectionId?: InvoicingConnectionId; readonly from?: string } = {},
  ) {
    if (!isOrganizationId(organizationId)) return [];
    const prefix = `${organizationId}:`;
    const jobs: InvoicingSyncJob[] = [];
    let after: string | undefined;
    for (;;) {
      let query = this.db
        .collection(INVOICING_SYNC_JOBS)
        .where(FieldPath.documentId(), '>=', prefix)
        .where(FieldPath.documentId(), '<', endOf(prefix))
        .orderBy(FieldPath.documentId());
      if (after !== undefined) query = query.startAfter(after);
      const snapshot = await query.limit(JOBS_PER_READ).get();
      for (const doc of snapshot.docs) {
        const job = toJob(organizationId, doc.id.slice(prefix.length), doc.data());
        if (
          job !== undefined &&
          (filter.connectionId === undefined || job.connectionId === filter.connectionId) &&
          (filter.from === undefined || job.createdAt >= filter.from)
        ) {
          jobs.push(job);
        }
      }
      if (snapshot.docs.length < JOBS_PER_READ) break;
      after = snapshot.docs.at(-1)?.id;
    }
    return jobs.sort((a, b) =>
      a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0,
    );
  }

  async updateJob(
    organizationId: OrganizationId,
    id: InvoicingSyncJobId,
    change: (current: InvoicingSyncJob) => InvoicingJobWrite,
  ) {
    if (!isOrganizationId(organizationId) || !isInvoicingId(id)) {
      throw new IntegrationError('sync_not_found');
    }
    const ref = this.#job(organizationId, id);
    return this.db.runTransaction(async (t) => {
      const current = await this.#readJob(t, organizationId, id);
      if (current === undefined) throw new IntegrationError('sync_not_found');
      const lockRef = this.#lock(organizationId, current.connectionId, current.recordType);
      const lock = holdsSyncLock(current) ? (await t.get(lockRef)).data() : undefined;
      const { job, events } = change(current);
      checkNextInvoicingJob(current, job);
      t.set(ref, plain(job));
      // An ended sync lets the next one start.
      if (isFinalSync(job) && lock?.jobId === id) t.delete(lockRef);
      this.#append(t, events);
      return job;
    });
  }

  async upsertRecord(
    organizationId: OrganizationId,
    build: (existing: StoredInvoicingRecord | undefined) => StoredInvoicingRecord,
    key: RecordKey,
  ): Promise<{ outcome: UpsertOutcome; stored: StoredInvoicingRecord }> {
    if (!isOrganizationId(organizationId) || !isInvoicingId(key.connectionId)) {
      throw new IntegrationError('invalid_payload', 'record.key');
    }
    const ref = this.#record(organizationId, key);
    return this.db.runTransaction(async (t) => {
      const existing = toRecord(organizationId, key.recordType, (await t.get(ref)).data());
      const stored = build(existing);
      checkRecordWrite(organizationId, key, existing, stored);
      if (existing !== undefined && existing.record.revision === stored.record.revision) {
        return { outcome: 'unchanged' as const, stored: existing };
      }
      t.set(ref, {
        organizationId,
        connectionId: key.connectionId,
        recordType: key.recordType,
        record: plain(stored.record),
      });
      if (stored.recordType === 'payment') {
        this.#linkPayment(t, ref, existing, stored.record);
      }
      return {
        outcome: existing === undefined ? ('created' as const) : ('updated' as const),
        stored,
      };
    });
  }

  async findRecord(organizationId: OrganizationId, key: RecordKey) {
    if (!isOrganizationId(organizationId) || !isInvoicingId(key.connectionId)) return undefined;
    if (!isInvoicingRecordType(key.recordType)) return undefined;
    const data = (await this.#record(organizationId, key).get()).data();
    const stored = toRecord(organizationId, key.recordType, data);
    return stored?.record.source.connectionId === key.connectionId &&
      stored.record.source.externalId === key.externalId
      ? stored
      : undefined;
  }

  async paymentsFor(
    organizationId: OrganizationId,
    connectionId: InvoicingConnectionId,
    documentExternalId: string,
  ) {
    if (!isOrganizationId(organizationId) || !isInvoicingId(connectionId)) return [];
    const link = (
      await this.#paymentLink(organizationId, connectionId, documentExternalId).get()
    ).data();
    const ids = Array.isArray(link?.payments) ? (link.payments as string[]) : [];
    if (ids.length === 0) return [];
    const snapshots = await this.db.getAll(
      ...ids.map((id) => this.db.collection(INVOICING_RECORDS).doc(id)),
    );
    const payments: InvoicingPayment[] = [];
    for (const snapshot of snapshots) {
      const stored = toRecord(organizationId, 'payment', snapshot.data());
      if (
        stored?.recordType === 'payment' &&
        stored.record.source.connectionId === connectionId &&
        stored.record.appliesTo.some((a) => a.externalId === documentExternalId)
      ) {
        payments.push(stored.record);
      }
    }
    return payments;
  }

  async listRecords(
    organizationId: OrganizationId,
    filter: {
      readonly recordType: InvoicingRecordType;
      readonly connectionId?: InvoicingConnectionId;
      readonly pageSize: number;
      readonly cursor?: string;
    },
  ): Promise<RecordPage> {
    if (!isOrganizationId(organizationId) || !isInvoicingRecordType(filter.recordType)) {
      return { items: [] };
    }
    if (filter.connectionId !== undefined && !isInvoicingId(filter.connectionId)) {
      return { items: [] };
    }
    const prefix =
      filter.connectionId === undefined
        ? `${organizationId}:${filter.recordType}:`
        : `${organizationId}:${filter.recordType}:${filter.connectionId}:`;
    if (filter.cursor !== undefined && !filter.cursor.startsWith(prefix)) {
      throw new IntegrationError('invalid_payload', 'cursor');
    }
    const size = Math.min(Math.max(1, Math.floor(filter.pageSize)), MAX_INVOICING_LIST_PAGE);
    let query = this.db
      .collection(INVOICING_RECORDS)
      .where(FieldPath.documentId(), '>=', prefix)
      .where(FieldPath.documentId(), '<', endOf(prefix))
      .orderBy(FieldPath.documentId());
    if (filter.cursor !== undefined) query = query.startAfter(filter.cursor);
    const snapshot = await query.limit(size + 1).get();
    const docs = snapshot.docs.slice(0, size);
    const items = docs
      .map((doc) => toRecord(organizationId, filter.recordType, doc.data()))
      .filter((s): s is StoredInvoicingRecord => s !== undefined);
    const last = docs.at(-1);
    return {
      items,
      ...(snapshot.docs.length > size && last !== undefined ? { nextCursor: last.id } : {}),
    };
  }

  /** Keeps each document's list of payments in step with what the payment says it applies to. */
  #linkPayment(
    t: Transaction,
    ref: DocumentReference,
    existing: StoredInvoicingRecord | undefined,
    payment: InvoicingPayment,
  ): void {
    const before = new Set(
      existing?.recordType === 'payment' ? existing.record.appliesTo.map((a) => a.externalId) : [],
    );
    const after = new Set(payment.appliesTo.map((a) => a.externalId));
    const { organizationId } = payment;
    const { connectionId } = payment.source;
    for (const externalId of after) {
      if (before.has(externalId)) continue;
      t.set(
        this.#paymentLink(organizationId, connectionId, externalId),
        { organizationId, connectionId, payments: FieldValue.arrayUnion(ref.id) },
        { merge: true },
      );
    }
    for (const externalId of before) {
      if (after.has(externalId)) continue;
      t.set(
        this.#paymentLink(organizationId, connectionId, externalId),
        { organizationId, connectionId, payments: FieldValue.arrayRemove(ref.id) },
        { merge: true },
      );
    }
  }

  async #readJob(t: Transaction, organizationId: string, id: string) {
    return toJob(organizationId, id, (await t.get(this.#job(organizationId, id))).data());
  }

  #append(t: Transaction, events: readonly AuditEvent[]): void {
    for (const event of events) {
      t.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
    }
  }
}

function toJob(
  organizationId: string,
  id: string,
  data: Record<string, unknown> | undefined,
): InvoicingSyncJob | undefined {
  if (data === undefined) return undefined;
  if (data.organizationId !== organizationId || data.id !== id) {
    throw new Error('invalid invoicing sync record');
  }
  return Object.freeze(data as unknown as InvoicingSyncJob);
}

function toRecord(
  organizationId: string,
  recordType: InvoicingRecordType,
  data: Record<string, unknown> | undefined,
): StoredInvoicingRecord | undefined {
  if (data === undefined) return undefined;
  const record = data.record as StoredInvoicingRecord['record'] | undefined;
  if (
    data.organizationId !== organizationId ||
    data.recordType !== recordType ||
    record?.organizationId !== organizationId ||
    record.source?.connectionId !== data.connectionId
  ) {
    throw new Error('invalid invoicing record');
  }
  return { recordType, record: Object.freeze(record) } as StoredInvoicingRecord;
}
