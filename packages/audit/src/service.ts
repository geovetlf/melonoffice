import { buildAuditEvent, type AuditEvent, type AuditEventInput } from './event.js';

/**
 * Where events are stored. Append only: there is no update or delete, so the application cannot
 * change or remove a recorded fact. `append` writes all events or none.
 */
export interface AuditStore {
  append(events: readonly AuditEvent[]): Promise<void>;
}

/**
 * Records facts for any server-side caller: API, auth, tenancy, RBAC, MelonMotor, GIA, workflows
 * and jobs. It decides nothing: it neither grants nor refuses access.
 */
export interface AuditService {
  /** Builds and stores one event. Rejects if it cannot be stored; the caller applies ADR-0020's policy. */
  record(input: AuditEventInput): Promise<AuditEvent>;
}

export function createAuditService(
  store: AuditStore,
  now: () => Date = () => new Date(),
): AuditService {
  return Object.freeze({
    async record(input: AuditEventInput): Promise<AuditEvent> {
      const event = buildAuditEvent(input, now());
      await store.append([event]);
      return event;
    },
  });
}
