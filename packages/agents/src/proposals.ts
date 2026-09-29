import type { AIOutputSchema } from '@melonoffice/ai-gateway';
import { candidateOf, FACT_CANDIDATE_SCHEMA } from '@melonoffice/brain';
import type { FollowUpType } from '@melonoffice/domain';
import type { TenantContext } from '@melonoffice/tenancy';

/**
 * What an agent may propose from a task (ADR-0084), only when one of its skills grants it and the
 * Decision Engine offers it for the person the task is for:
 * - one follow-up with one of the organization's contacts (`follow_up.schedule`), scheduled only
 *   through `follow_up_schedule@2`, after a person approves that exact follow-up;
 * - a few facts for the company memory (`knowledge.propose_fact`), stored as proposed until the
 *   owner confirms them.
 * The model never names a contact by id: it picks one of the references it was given, and the
 * server resolves it. Nothing here schedules or stores anything.
 */

/** The task's second node: the follow-up the agent proposed, approved by a person first. */
export const AGENT_TASK_SCHEDULE_NODE = 'schedule';
/** The tool version an agent schedules with: approval every time. */
export const AGENT_FOLLOW_UP_TOOL = Object.freeze({ id: 'follow_up_schedule', version: 2 });
export const PROPOSE_FOLLOW_UP = 'follow_up.schedule';
export const PROPOSE_FACT = 'knowledge.propose_fact';

export const TASK_PROPOSAL_LIMITS = Object.freeze({
  /** The contacts one task is given to choose from: the most recently changed. */
  contacts: 30,
  facts: 3,
  titleLength: 120,
  /** Below this, a fact is not proposed (the same floor as GIA's, ADR-0052). */
  factConfidence: 0.6,
});

export const TASK_FOLLOW_UP_TYPES: readonly FollowUpType[] = Object.freeze([
  'follow_up',
  'call',
  'message',
  'review',
  'check_in',
]);

/** One contact as a task sees it: a reference and a name, never the contact's details. */
export interface TaskContact {
  readonly id: string;
  readonly name: string;
}

/**
 * The organization's contacts a task may choose from, read for the person the task is for (their
 * `contact.read`), newest change first, at most `TASK_PROPOSAL_LIMITS.contacts`.
 */
export interface TaskContacts {
  list(tenant: TenantContext): Promise<readonly TaskContact[]>;
}

/** The business's today, in its own time zone: the model reads it to propose a date. */
export interface TaskClock {
  today(tenant: TenantContext): Promise<{ readonly date: string; readonly timeZone: string }>;
}

/**
 * A contact's reference in a task: a prefix of its id, spelled in letters (the gateway's schema
 * codes are letters only), resolved by the server.
 */
export const contactRef = (id: string): string =>
  `c_${[...id.replace(/-/g, '').slice(0, 10).toLowerCase()]
    .map((ch) => String.fromCharCode(97 + Number.parseInt(ch, 16)))
    .join('')}`;

/** The one contact a reference names in `contacts`, or `undefined` when none or several do. */
export function resolveContactRef(
  contacts: readonly TaskContact[],
  ref: string,
): TaskContact | undefined {
  const found = contacts.filter((c) => contactRef(c.id) === ref);
  return found.length === 1 ? found[0] : undefined;
}

/** The follow-up an agent proposed, as it answered it. */
export interface TaskFollowUp {
  readonly contact: string;
  readonly type: FollowUpType;
  readonly title: string;
  readonly date: string;
  readonly time: string;
}

/** What a task's answer may carry beyond the text, as the model was allowed. */
export interface TaskProposalOffer {
  /** The contacts' references, when the agent may propose a follow-up. */
  readonly followUpContacts?: readonly string[];
  readonly facts: boolean;
}

export function followUpSchema(refs: readonly string[]): AIOutputSchema {
  return {
    type: 'object',
    nullable: true,
    properties: {
      contact: { type: 'string', enum: [...refs] },
      type: { type: 'string', enum: [...TASK_FOLLOW_UP_TYPES] },
      title: { type: 'string', maxLength: TASK_PROPOSAL_LIMITS.titleLength },
      date: { type: 'string', maxLength: 10 },
      time: { type: 'string', maxLength: 5 },
    },
    required: ['contact', 'type', 'title', 'date', 'time'],
  };
}

export const FACTS_SCHEMA: AIOutputSchema = {
  type: 'array',
  maxItems: TASK_PROPOSAL_LIMITS.facts,
  items: FACT_CANDIDATE_SCHEMA,
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

/** The follow-up in an answer, when it has its shape; anything else is no proposal. */
export function parseTaskFollowUp(value: unknown): TaskFollowUp | undefined {
  if (!isRecord(value)) return undefined;
  const { contact, type, title, date, time } = value;
  if (typeof contact !== 'string' || !/^c_[a-p]{10}$/.test(contact)) return undefined;
  if (!(TASK_FOLLOW_UP_TYPES as readonly unknown[]).includes(type)) return undefined;
  if (typeof title !== 'string') return undefined;
  const text = title.normalize('NFC').trim();
  if (text.length === 0 || [...text].length > TASK_PROPOSAL_LIMITS.titleLength) return undefined;
  if (CONTROL.test(text)) return undefined;
  if (typeof date !== 'string' || !DATE.test(date) || Number.isNaN(Date.parse(date))) {
    return undefined;
  }
  if (typeof time !== 'string' || !TIME.test(time)) return undefined;
  return Object.freeze({ contact, type: type as FollowUpType, title: text, date, time });
}

/** The facts in an answer, as Company Brain inputs, confident enough and at most the limit. */
export function parseTaskFacts(value: unknown): readonly Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return Object.freeze(
    value
      .slice(0, TASK_PROPOSAL_LIMITS.facts)
      .filter(
        (raw) =>
          isRecord(raw) &&
          typeof raw.confidence === 'number' &&
          raw.confidence >= TASK_PROPOSAL_LIMITS.factConfidence,
      )
      .map(candidateOf)
      .filter((c): c is Record<string, unknown> => c !== undefined),
  );
}

/** The key that makes one follow-up of one task: repeating it schedules nothing twice. */
export const taskFollowUpKey = (taskId: string): string => `agent-task-${taskId}`;
