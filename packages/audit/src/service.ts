import type { OrganizationId } from '@melonoffice/domain';
import type { AuditAction } from './actions.js';
import { buildAuditEvent, type AuditEvent, type AuditEventInput } from './event.js';

/**
 * Where events are stored. Append only: there is no update or delete, so the application cannot
 * change or remove a recorded fact. `append` writes all events or none.
 */
export interface AuditStore {
  append(events: readonly AuditEvent[]): Promise<void>;
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
