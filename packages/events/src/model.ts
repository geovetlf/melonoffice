import type { AuditActor } from '@melonoffice/audit';
import type { OrganizationId } from '@melonoffice/domain';

/**
 * A domain event (ADR-0066): something that happened in one organization, said once, so any
 * number of parts of MelonMotor can react to it without the part that caused it calling them.
 * An event is a fact, never a command: it asks nothing to be done. It carries references and
 * codes only, never content (no message text, names, amounts or documents): a subscriber reads
 * the record it needs, as a person or the runtime may, through the service that owns it.
 */
export interface DomainEvent {
  /** `evt_` and 32 hex characters. Delivery is at least once: subscribers dedupe on it. */
  readonly id: string;
  /** A catalogue type, e.g. `follow_up.due`, and the version of its shape. */
  readonly type: string;
  readonly version: number;
  readonly organizationId: OrganizationId;
  readonly occurredAt: string;
  /** Who caused it, as the audit trail names actors. */
  readonly actor: AuditActor;
  /** The record it is about. */
  readonly subject: { readonly type: string; readonly id: string };
  /** The catalogue's fields for this type: ids, codes, numbers, booleans, dates. */
  readonly data: Readonly<Record<string, EventValue>>;
  /** The request or execution it came from, to follow one chain across events. */
  readonly correlationId: string | null;
}

export type EventValue = string | number | boolean | null;

/** What a producer gives; the event bus adds the id, the organization, the actor and the time. */
export interface EventDraft {
  readonly type: string;
  readonly subject: { readonly type: string; readonly id: string };
  readonly data?: Readonly<Record<string, EventValue>>;
  readonly correlationId?: string;
  /** When it happened, if not now (e.g. a follow-up's due time). */
  readonly occurredAt?: Date;
}

export type EventErrorCode =
  'unresolved_tenant' | 'event_type_unknown' | 'invalid_event' | 'subscriber_invalid';

export class EventError extends Error {
  override readonly name = 'EventError';
  constructor(
    readonly code: EventErrorCode,
    readonly field?: string,
  ) {
    super(field === undefined ? code : `${code}: ${field}`);
  }
}

export const isEventError = (error: unknown): error is EventError => error instanceof EventError;
