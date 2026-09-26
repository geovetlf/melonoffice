import type { AuditEvent } from './event.js';
import type { AuditStore } from './service.js';

/** For tests and local runs only. Append only, like every audit store. */
export class InMemoryAuditStore implements AuditStore {
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

  /** A copy of what was recorded, oldest first. Events are frozen. */
  events(): readonly AuditEvent[] {
    return [...this.#events];
  }
}
