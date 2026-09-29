import { EventError, type EventValue } from './model.js';

/**
 * The events MelonMotor knows (ADR-0066), as data like the tools and skills catalogues. An event
 * type not listed here is refused: producers cannot invent one, and subscribers cannot listen to
 * one that no producer is allowed to publish. Each field has a kind, and no kind holds free text.
 */

export type EventFieldKind =
  /** A record id: letters, digits, `_` and `-`, up to 128. */
  | 'id'
  /** A closed code: lower-case letters and `_`, up to 64. */
  | 'code'
  | 'number'
  | 'boolean'
  /** `YYYY-MM-DD`. */
  | 'date';

export interface EventField {
  readonly kind: EventFieldKind;
  /** A field that may be absent or null. */
  readonly optional?: boolean;
}

export interface EventDefinition {
  readonly type: string;
  readonly version: number;
  /** The record type the event is about. */
  readonly subject: string;
  readonly fields: Readonly<Record<string, EventField>>;
}

const define = (
  type: string,
  subject: string,
  fields: Record<string, EventField> = {},
  version = 1,
): EventDefinition =>
  Object.freeze({ type, version, subject, fields: Object.freeze({ ...fields }) });

export const EVENT_CATALOGUE: readonly EventDefinition[] = Object.freeze([
  // A customer wrote on a channel (ADR-0033/0044).
  define('conversation.message_received', 'conversation', {
    channel: { kind: 'code' },
    contactId: { kind: 'id', optional: true },
  }),
  // A follow-up reached its time (ADR-0058).
  define('follow_up.due', 'follow_up', {
    opportunityId: { kind: 'id', optional: true },
    contactId: { kind: 'id', optional: true },
  }),
  // An opportunity moved in the pipeline (ADR-0054).
  define('opportunity.stage_changed', 'opportunity', {
    from: { kind: 'code' },
    to: { kind: 'code' },
    status: { kind: 'code' },
  }),
  // A document was read into Company Brain (ADR-0051).
  define('knowledge.document_ingested', 'knowledge_document', {
    facts: { kind: 'number' },
  }),
  // An agent task ended (ADR-0063).
  define('agent_task.finished', 'execution', {
    specialistId: { kind: 'id' },
    outcome: { kind: 'code' },
  }),
  // A decision asked for approval (ADR-0065).
  define('decision.approval_required', 'decision', {
    decisionType: { kind: 'code' },
  }),
]);

const TYPE = /^[a-z][a-z_]*\.[a-z][a-z_]*$/;
const CODE = /^[a-z][a-z_]{0,63}$/;
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const FIELD = /^[a-z][A-Za-z]{0,39}$/;
const MAX_FIELDS = 12;

/** Checks a catalogue once: unique types, plain codes, bounded fields. */
export function checkEventCatalogue(
  definitions: readonly EventDefinition[],
): readonly EventDefinition[] {
  const seen = new Set<string>();
  for (const d of definitions) {
    if (!TYPE.test(d.type)) throw new Error(`invalid event type ${d.type}`);
    if (seen.has(d.type)) throw new Error(`duplicate event type ${d.type}`);
    seen.add(d.type);
    if (!Number.isInteger(d.version) || d.version < 1) throw new Error(`invalid version ${d.type}`);
    if (!CODE.test(d.subject)) throw new Error(`invalid subject ${d.type}`);
    const names = Object.keys(d.fields);
    if (names.length > MAX_FIELDS || names.some((n) => !FIELD.test(n))) {
      throw new Error(`invalid fields ${d.type}`);
    }
  }
  return Object.freeze([...definitions]);
}

function valid(kind: EventFieldKind, value: EventValue): boolean {
  switch (kind) {
    case 'id':
      return typeof value === 'string' && ID.test(value);
    case 'code':
      return typeof value === 'string' && CODE.test(value);
    case 'number':
      return typeof value === 'number' && Number.isFinite(value);
    case 'boolean':
      return typeof value === 'boolean';
    case 'date':
      return typeof value === 'string' && DATE.test(value);
  }
}

/** The event's data, checked against its definition: exactly its fields, each of its kind. */
export function checkEventData(
  definition: EventDefinition,
  subject: { readonly type: string; readonly id: string },
  data: Readonly<Record<string, EventValue>>,
): Readonly<Record<string, EventValue>> {
  if (subject.type !== definition.subject || !ID.test(subject.id)) {
    throw new EventError('invalid_event', 'subject');
  }
  for (const key of Object.keys(data)) {
    if (!Object.hasOwn(definition.fields, key)) throw new EventError('invalid_event', key);
  }
  const out: Record<string, EventValue> = {};
  for (const [key, field] of Object.entries(definition.fields)) {
    const value = data[key];
    if (value === undefined || value === null) {
      if (field.optional !== true) throw new EventError('invalid_event', key);
      continue;
    }
    if (!valid(field.kind, value)) throw new EventError('invalid_event', key);
    out[key] = value;
  }
  return Object.freeze(out);
}
