import type { DomainEvent } from './model.js';

/**
 * Where published events wait to be delivered (ADR-0066). A producer appends an event in the
 * same unit of work as its change (a Firestore store will write both in one transaction); the
 * dispatcher claims due events with a lease, delivers them and settles each one. An event is
 * never lost because a subscriber was down, and never delivered twice to a subscriber that
 * already took it.
 */
export type OutboxStatus = 'pending' | 'delivered' | 'dead';

export interface OutboxRecord {
  readonly event: DomainEvent;
  readonly status: OutboxStatus;
  /** Delivery rounds so far. */
  readonly attempts: number;
  /** Subscribers that already handled it: a retry never repeats them. */
  readonly deliveredTo: readonly string[];
  /** Not before this time (ms since epoch): the back-off after a failure. */
  readonly nextAttemptAt: number;
  /** Claimed by a dispatcher until this time (ms since epoch), or 0. */
  readonly leaseUntil: number;
  /** The last failure's subscriber and code, never its message. */
  readonly lastError: { readonly subscriber: string; readonly code: string } | null;
}

export interface OutboxSettlement {
  readonly deliveredTo: readonly string[];
  readonly status: OutboxStatus;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly lastError: OutboxRecord['lastError'];
}

export interface EventOutbox {
  /** Adds events; one with an id already there is ignored (a producer's retry). */
  append(events: readonly DomainEvent[]): Promise<void>;
  /** Claims up to `limit` due pending events, oldest first, for `leaseMs`. */
  claim(options: {
    readonly now: number;
    readonly limit: number;
    readonly leaseMs: number;
  }): Promise<readonly OutboxRecord[]>;
  /** Settles a claimed event and releases its lease. */
  settle(id: string, settlement: OutboxSettlement): Promise<void>;
  /** One event's record, e.g. for support. */
  find(id: string): Promise<OutboxRecord | undefined>;
}

/** In memory: tests, local runs and the shape a Firestore outbox must keep. */
export class InMemoryEventOutbox implements EventOutbox {
  readonly #records = new Map<string, OutboxRecord>();

  async append(events: readonly DomainEvent[]): Promise<void> {
    for (const event of events) {
      if (this.#records.has(event.id)) continue;
      this.#records.set(
        event.id,
        Object.freeze({
          event,
          status: 'pending',
          attempts: 0,
          deliveredTo: Object.freeze([]),
          nextAttemptAt: 0,
          leaseUntil: 0,
          lastError: null,
        }),
      );
    }
  }

  async claim(options: { readonly now: number; readonly limit: number; readonly leaseMs: number }) {
    const due = [...this.#records.values()]
      .filter(
        (r) =>
          r.status === 'pending' && r.nextAttemptAt <= options.now && r.leaseUntil <= options.now,
      )
      .sort((a, b) => a.event.occurredAt.localeCompare(b.event.occurredAt))
      .slice(0, options.limit);
    return due.map((r) => {
      const claimed = Object.freeze({ ...r, leaseUntil: options.now + options.leaseMs });
      this.#records.set(r.event.id, claimed);
      return claimed;
    });
  }

  async settle(id: string, settlement: OutboxSettlement): Promise<void> {
    const record = this.#records.get(id);
    if (record === undefined) return;
    this.#records.set(
      id,
      Object.freeze({
        ...record,
        ...settlement,
        deliveredTo: Object.freeze([...settlement.deliveredTo]),
        leaseUntil: 0,
      }),
    );
  }

  async find(id: string): Promise<OutboxRecord | undefined> {
    return this.#records.get(id);
  }

  /** Every record, oldest first (tests). */
  records(): readonly OutboxRecord[] {
    return [...this.#records.values()].sort((a, b) =>
      a.event.occurredAt.localeCompare(b.event.occurredAt),
    );
  }
}
