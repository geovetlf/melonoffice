import type { OrganizationId } from '@melonoffice/domain';
import type { DomainEvent } from './model.js';

/**
 * Where published events are kept and their delivery is recorded (ADR-0066, EV-2 ADR-0067). An
 * event is stored before it is queued, so it is never lost because the queue or a subscriber was
 * down. Each queued delivery takes a lease on the event: two deliveries of the same event (a
 * queue retry, a duplicate task) never run its subscribers at the same time, and a subscriber
 * that already took it is never given it again.
 *
 * Every read and write names the organization: a record of another organization is not found.
 */
export type OutboxStatus =
  /** Stored, not yet handed to the queue. */
  | 'pending'
  /** Handed to the queue; delivered or retried by it. */
  | 'queued'
  | 'delivered'
  /** Its last delivery failed: set aside for a person, never dropped. */
  | 'dead';

export interface OutboxRecord {
  readonly event: DomainEvent;
  readonly status: OutboxStatus;
  /** Deliveries started so far. */
  readonly attempts: number;
  /** Subscribers that already handled it: a retry never repeats them. */
  readonly deliveredTo: readonly string[];
  /** The delivery that holds it now, or null. */
  readonly leaseId: string | null;
  /** Held until this time (ms since epoch), or 0. */
  readonly leaseUntil: number;
  /** The last failure's subscriber and code, never its message. */
  readonly lastError: { readonly subscriber: string; readonly code: string } | null;
  readonly createdAt: string;
  readonly queuedAt: string | null;
  /** When it was delivered or set aside. */
  readonly settledAt: string | null;
}

export type BeginResult =
  | { readonly kind: 'claimed'; readonly record: OutboxRecord }
  /** No such event in this organization. */
  | { readonly kind: 'not_found' }
  /** Already delivered or dead: nothing to do. */
  | { readonly kind: 'settled'; readonly record: OutboxRecord }
  /** Another delivery holds it. */
  | { readonly kind: 'busy' };

export interface OutboxLease {
  readonly leaseId: string;
  readonly now: number;
  readonly leaseMs: number;
}

export interface OutboxSettlement {
  readonly deliveredTo: readonly string[];
  /** `queued` releases it for the queue's next delivery. */
  readonly status: 'queued' | 'delivered' | 'dead';
  readonly lastError: OutboxRecord['lastError'];
  readonly at: string;
}

export interface EventOutbox {
  /**
   * Stores events and returns their records. An id already stored returns the stored record,
   * unchanged (a producer's retry); an id stored for another organization is refused.
   */
  append(events: readonly DomainEvent[], at: string): Promise<readonly OutboxRecord[]>;
  /** Records that the queue has it: `pending` becomes `queued`; any other status is kept. */
  markQueued(organizationId: OrganizationId, id: string, at: string): Promise<void>;
  /** Takes the event for one delivery until `now + leaseMs`, unless held or settled. */
  begin(organizationId: OrganizationId, id: string, lease: OutboxLease): Promise<BeginResult>;
  /** Settles a delivery and releases its lease; false when the lease is no longer its own. */
  settle(
    organizationId: OrganizationId,
    id: string,
    leaseId: string,
    settlement: OutboxSettlement,
  ): Promise<boolean>;
  find(organizationId: OrganizationId, id: string): Promise<OutboxRecord | undefined>;
}

export class OutboxConflictError extends Error {
  override readonly name = 'OutboxConflictError';
  constructor() {
    super('event id taken');
  }
}

/** A new record for a stored event. */
export const newOutboxRecord = (event: DomainEvent, at: string): OutboxRecord =>
  Object.freeze({
    event,
    status: 'pending',
    attempts: 0,
    deliveredTo: Object.freeze([]),
    leaseId: null,
    leaseUntil: 0,
    lastError: null,
    createdAt: at,
    queuedAt: null,
    settledAt: null,
  });

/** The begin rule, shared by every store so they decide alike. */
export function beginOn(
  record: OutboxRecord,
  lease: OutboxLease,
): { readonly result: BeginResult; readonly next?: OutboxRecord } {
  if (record.status === 'delivered' || record.status === 'dead') {
    return { result: { kind: 'settled', record } };
  }
  if (record.leaseId !== null && record.leaseUntil > lease.now) return { result: { kind: 'busy' } };
  const next: OutboxRecord = Object.freeze({
    ...record,
    attempts: record.attempts + 1,
    leaseId: lease.leaseId,
    leaseUntil: lease.now + lease.leaseMs,
  });
  return { result: { kind: 'claimed', record: next }, next };
}

/** The settle rule, shared by every store: undefined when the lease is not the caller's. */
export function settleOn(
  record: OutboxRecord,
  leaseId: string,
  settlement: OutboxSettlement,
): OutboxRecord | undefined {
  if (record.leaseId !== leaseId || record.status === 'delivered' || record.status === 'dead') {
    return undefined;
  }
  return Object.freeze({
    ...record,
    status: settlement.status,
    deliveredTo: Object.freeze([...settlement.deliveredTo]),
    lastError: settlement.lastError,
    leaseId: null,
    leaseUntil: 0,
    queuedAt: record.queuedAt ?? settlement.at,
    settledAt: settlement.status === 'queued' ? null : settlement.at,
  });
}

/** In memory: tests, local runs and the behaviour the Firestore outbox keeps. */
export class InMemoryEventOutbox implements EventOutbox {
  readonly #records = new Map<string, OutboxRecord>();

  #own(organizationId: OrganizationId, id: string): OutboxRecord | undefined {
    const record = this.#records.get(id);
    return record?.event.organizationId === organizationId ? record : undefined;
  }

  async append(events: readonly DomainEvent[], at: string): Promise<readonly OutboxRecord[]> {
    for (const event of events) {
      const stored = this.#records.get(event.id);
      if (stored !== undefined && stored.event.organizationId !== event.organizationId) {
        throw new OutboxConflictError();
      }
    }
    return events.map((event) => {
      const stored = this.#records.get(event.id);
      if (stored !== undefined) return stored;
      const record = newOutboxRecord(event, at);
      this.#records.set(event.id, record);
      return record;
    });
  }

  async markQueued(organizationId: OrganizationId, id: string, at: string): Promise<void> {
    const record = this.#own(organizationId, id);
    if (record?.status !== 'pending') return;
    this.#records.set(id, Object.freeze({ ...record, status: 'queued', queuedAt: at }));
  }

  async begin(organizationId: OrganizationId, id: string, lease: OutboxLease) {
    const record = this.#own(organizationId, id);
    if (record === undefined) return { kind: 'not_found' } as const;
    const { result, next } = beginOn(record, lease);
    if (next !== undefined) this.#records.set(id, next);
    return result;
  }

  async settle(
    organizationId: OrganizationId,
    id: string,
    leaseId: string,
    settlement: OutboxSettlement,
  ): Promise<boolean> {
    const record = this.#own(organizationId, id);
    const next = record === undefined ? undefined : settleOn(record, leaseId, settlement);
    if (next === undefined) return false;
    this.#records.set(id, next);
    return true;
  }

  async find(organizationId: OrganizationId, id: string): Promise<OutboxRecord | undefined> {
    return this.#own(organizationId, id);
  }

  /** Every record, oldest first (tests). */
  records(): readonly OutboxRecord[] {
    return [...this.#records.values()].sort((a, b) =>
      a.event.occurredAt.localeCompare(b.event.occurredAt),
    );
  }
}
