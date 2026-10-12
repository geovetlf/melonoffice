import type { OrganizationId } from '@melonoffice/domain';
import type { AuditAction } from './actions.js';
import {
  buildAuditEvent,
  type AuditEvent,
  type AuditEventId,
  type AuditEventInput,
} from './event.js';

/**
 * Where events are stored. Append only: there is no update or delete, so the application cannot
 * change or remove a recorded fact. `append` writes all events or none.
 */
export interface AuditStore {
  /** Stores the events, or rejects with `AuditEventAlreadyStored` when one of their ids is stored already. */
  append(events: readonly AuditEvent[]): Promise<void>;
  /** The stored event with this id, if any. */
  find(id: AuditEventId): Promise<AuditEvent | undefined>;
}

/** A store refused an event whose id it holds: the event was recorded before (a retry, or an earlier attempt). */
export class AuditEventAlreadyStored extends Error {
  readonly code = 'audit_event_already_stored';
  constructor() {
    super('audit event already recorded');
  }
}

/** Another fact holds this id: a repeat may not stand in for it (`recordOnce`). */
export class AuditEventConflict extends Error {
  readonly code = 'audit_event_conflict';
  constructor(readonly id: AuditEventId) {
    super(`audit event ${id} is stored as a different fact`);
  }
}

/** The same fact, whatever time it was written: a retry writes at its own time, and nothing else may differ. */
function sameFact(stored: AuditEvent, event: AuditEvent): boolean {
  return (
    canonical({ ...stored, occurredAt: undefined }) ===
    canonical({ ...event, occurredAt: undefined })
  );
}

/** JSON with sorted keys, so two equal events give one string. */
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
}

/**
 * Reads recorded events back, for the activity view (ADR-0049). One organization at a time, only
 * the listed actions, newest first. It is the only read of the audit trail; nothing edits it.
 */
export interface AuditQuery {
  readonly organizationId: OrganizationId;
  /** At most 30: Firestore's limit for one `in` filter. */
  readonly actions: readonly AuditAction[];
  /** Inclusive. */
  readonly from: Date;
  /** Exclusive. */
  readonly to: Date;
  readonly limit: number;
}

export const MAX_QUERY_ACTIONS = 30;

export interface AuditReader {
  query(query: AuditQuery): Promise<readonly AuditEvent[]>;
}

/** The most events one target's history reads (C2, ADR-0054). */
export const MAX_HISTORY_EVENTS = 200;

/**
 * One record's history (C2, ADR-0054): the organization's events about one target, e.g. an
 * opportunity, newest first. Equality filters only, so it needs no composite index; it reads at
 * most `MAX_HISTORY_EVENTS`.
 */
export interface AuditHistoryReader {
  history(
    organizationId: OrganizationId,
    target: { readonly type: string; readonly id: string },
    limit: number,
  ): Promise<readonly AuditEvent[]>;
}

/**
 * Records facts for any server-side caller: API, auth, tenancy, RBAC, MelonMotor, GIA, workflows
 * and jobs. It decides nothing: it neither grants nor refuses access.
 */
export interface AuditService {
  /** Builds and stores one event. Rejects if it cannot be stored; the caller applies ADR-0020's policy. */
  record(input: AuditEventInput): Promise<AuditEvent>;
  /**
   * Stores a fact under its own id, which a retry records again. A repeat finds the stored copy: `same` when it
   * is the same fact, and `AuditEventConflict` when another fact holds that id. Rejects when it cannot be stored.
   */
  recordOnce(input: AuditEventInput & { readonly id: AuditEventId }): Promise<'written' | 'same'>;
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
    async recordOnce(input: AuditEventInput & { readonly id: AuditEventId }) {
      const event = buildAuditEvent(input, now());
      try {
        await store.append([event]);
        return 'written' as const;
      } catch (error) {
        if (!(error instanceof AuditEventAlreadyStored)) throw error;
      }
      const stored = await store.find(event.id);
      if (stored === undefined || !sameFact(stored, event)) throw new AuditEventConflict(event.id);
      return 'same' as const;
    },
  });
}
