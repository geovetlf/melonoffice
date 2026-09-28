import type { AuditEvent } from './event.js';
import type { AuditQuery, AuditReader, AuditStore } from './service.js';

/** For tests and local runs only. Append only, like every audit store. */
export class InMemoryAuditStore implements AuditStore, AuditReader {
  readonly #events: AuditEvent[] = [];

  async append(events: readonly AuditEvent[]): Promise<void> {
    this.appendNow(events);
  }

  /** Synchronous append, for an in-memory store that must write in the same step as its data. */
  appendNow(events: readonly AuditEvent[]): void {
    if (events.some((event) => this.#events.some((stored) => stored.id === event.id))) {
      throw new Error('audit event already recorded');
    }
    this.#events.push(...events);
  }

  async query(q: AuditQuery): Promise<readonly AuditEvent[]> {
    const from = q.from.getTime();
    const to = q.to.getTime();
    return this.#events
      .filter((event) => {
        const at = Date.parse(event.occurredAt);
        return (
          event.organizationId === q.organizationId &&
          (q.actions as readonly string[]).includes(event.action) &&
          at >= from &&
          at < to
        );
      })
      .sort((a, b) => (a.occurredAt < b.occurredAt ? 1 : a.occurredAt > b.occurredAt ? -1 : 0))
      .slice(0, q.limit);
  }

  /** A copy of what was recorded, oldest first. Events are frozen. */
  events(): readonly AuditEvent[] {
    return [...this.#events];
  }
}
