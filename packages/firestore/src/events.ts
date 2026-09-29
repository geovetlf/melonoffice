import type { DocumentData, Firestore } from '@google-cloud/firestore';
import type { OrganizationId } from '@melonoffice/domain';
import {
  beginOn,
  newOutboxRecord,
  OutboxConflictError,
  settleOn,
  type DomainEvent,
  type EventOutbox,
  type OutboxLease,
  type OutboxRecord,
  type OutboxSettlement,
} from '@melonoffice/events';

/**
 * `domainEvents/{eventId}` (EV-2, ADR-0067): the event outbox. One document per event, written
 * once with its delivery record; the organization is a field every read checks. Deliveries take
 * and settle their lease in a transaction, so two deliveries of one event never both run it.
 * Reads are by id only: no composite index is needed.
 */
export const DOMAIN_EVENTS = 'domainEvents';

interface DomainEventDocument {
  readonly organizationId: string;
  readonly type: string;
  readonly status: OutboxRecord['status'];
  readonly event: DomainEvent;
  readonly attempts: number;
  readonly deliveredTo: readonly string[];
  readonly leaseId: string | null;
  readonly leaseUntil: number;
  readonly lastError: OutboxRecord['lastError'];
  readonly createdAt: string;
  readonly queuedAt: string | null;
  readonly settledAt: string | null;
}

/** Plain data: Firestore keeps no frozen objects or undefined fields. */
const plain = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

const toDocument = (record: OutboxRecord): DomainEventDocument => ({
  organizationId: record.event.organizationId,
  type: record.event.type,
  status: record.status,
  event: plain(record.event),
  attempts: record.attempts,
  deliveredTo: [...record.deliveredTo],
  leaseId: record.leaseId,
  leaseUntil: record.leaseUntil,
  lastError: record.lastError === null ? null : plain(record.lastError),
  createdAt: record.createdAt,
  queuedAt: record.queuedAt,
  settledAt: record.settledAt,
});

const freezeDeep = <T>(value: T): T => {
  if (typeof value === 'object' && value !== null) {
    for (const inner of Object.values(value)) freezeDeep(inner);
    Object.freeze(value);
  }
  return value;
};

const toRecord = (data: DocumentData): OutboxRecord => {
  const d = data as DomainEventDocument;
  return freezeDeep({
    event: plain(d.event),
    status: d.status,
    attempts: d.attempts,
    deliveredTo: [...d.deliveredTo],
    leaseId: d.leaseId,
    leaseUntil: d.leaseUntil,
    lastError: d.lastError === null ? null : { ...d.lastError },
    createdAt: d.createdAt,
    queuedAt: d.queuedAt,
    settledAt: d.settledAt,
  });
};

export class FirestoreEventOutbox implements EventOutbox {
  constructor(private readonly db: Firestore) {}

  #doc(id: string) {
    return this.db.collection(DOMAIN_EVENTS).doc(id);
  }

  async append(events: readonly DomainEvent[], at: string): Promise<readonly OutboxRecord[]> {
    if (events.length === 0) return [];
    // All in one transaction: a publish stores all its events or none.
    return this.db.runTransaction(async (t) => {
      const refs = events.map((e) => this.#doc(e.id));
      const snapshots = await t.getAll(...refs);
      const records = events.map((event, i) => {
        const snapshot = snapshots[i];
        if (snapshot?.exists === true) {
          const stored = toRecord(snapshot.data() as DocumentData);
          if (stored.event.organizationId !== event.organizationId) throw new OutboxConflictError();
          return { record: stored, created: false };
        }
        return { record: newOutboxRecord(event, at), created: true };
      });
      records.forEach(({ record, created }, i) => {
        const ref = refs[i];
        if (created && ref !== undefined) t.create(ref, toDocument(record));
      });
      return records.map((r) => r.record);
    });
  }

  async markQueued(organizationId: OrganizationId, id: string, at: string): Promise<void> {
    await this.db.runTransaction(async (t) => {
      const snapshot = await t.get(this.#doc(id));
      if (!snapshot.exists) return;
      const record = toRecord(snapshot.data() as DocumentData);
      if (record.event.organizationId !== organizationId || record.status !== 'pending') return;
      t.update(this.#doc(id), { status: 'queued', queuedAt: at });
    });
  }

  async begin(organizationId: OrganizationId, id: string, lease: OutboxLease) {
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(this.#doc(id));
      if (!snapshot.exists) return { kind: 'not_found' } as const;
      const record = toRecord(snapshot.data() as DocumentData);
      if (record.event.organizationId !== organizationId) return { kind: 'not_found' } as const;
      const { result, next } = beginOn(record, lease);
      if (next !== undefined) {
        t.update(this.#doc(id), {
          attempts: next.attempts,
          leaseId: next.leaseId,
          leaseUntil: next.leaseUntil,
        });
      }
      return result;
    });
  }

  async settle(
    organizationId: OrganizationId,
    id: string,
    leaseId: string,
    settlement: OutboxSettlement,
  ): Promise<boolean> {
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(this.#doc(id));
      if (!snapshot.exists) return false;
      const record = toRecord(snapshot.data() as DocumentData);
      if (record.event.organizationId !== organizationId) return false;
      const next = settleOn(record, leaseId, settlement);
      if (next === undefined) return false;
      t.update(this.#doc(id), {
        status: next.status,
        deliveredTo: [...next.deliveredTo],
        lastError: next.lastError === null ? null : plain(next.lastError),
        leaseId: null,
        leaseUntil: 0,
        queuedAt: next.queuedAt,
        settledAt: next.settledAt,
      });
      return true;
    });
  }

  async find(organizationId: OrganizationId, id: string): Promise<OutboxRecord | undefined> {
    const snapshot = await this.#doc(id).get();
    if (!snapshot.exists) return undefined;
    const record = toRecord(snapshot.data() as DocumentData);
    return record.event.organizationId === organizationId ? record : undefined;
  }
}
