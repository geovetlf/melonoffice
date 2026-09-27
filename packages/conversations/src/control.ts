import type {
  AutonomyLevel,
  Conversation,
  ConversationAIState,
  ConversationControl,
  ConversationHandler,
  ConversationSettings,
  IsoTimestamp,
  OrganizationId,
} from '@melonoffice/domain';

/**
 * Human control of a conversation (CV-6A, ADR-0039): who handles it, how a person takes control
 * or hands it back, and the one check every automatic send must pass. Pure: no storage, no model,
 * no tool. Nothing in CV-6A makes an agent act; this is the guard it will have to pass.
 */

export const AUTONOMY_LEVELS = [
  'manual',
  'assisted',
  'supervised',
  'autonomous',
] as const satisfies readonly AutonomyLevel[];

export const isAutonomyLevel = (value: unknown): value is AutonomyLevel =>
  typeof value === 'string' && (AUTONOMY_LEVELS as readonly string[]).includes(value);

/** The levels at which an agent may handle a conversation at all. */
export const AI_HANDLING_LEVELS: readonly AutonomyLevel[] = ['supervised', 'autonomous'];

export const allowsAIHandling = (autonomy: AutonomyLevel): boolean =>
  AI_HANDLING_LEVELS.includes(autonomy);

export const CONVERSATION_HANDLERS = [
  'human',
  'ai',
] as const satisfies readonly ConversationHandler[];
export const CONVERSATION_AI_STATES = [
  'off',
  'active',
  'paused',
  'escalated',
] as const satisfies readonly ConversationAIState[];

/**
 * Why an agent hands a conversation to a person. A closed list of codes: a model or a contact
 * never writes the reason.
 */
export const HANDOFF_REASONS = [
  'customer_requested_human',
  'low_confidence',
  'tool_failed',
  'not_permitted',
  'sensitive_operation',
  'conflict',
  'too_many_attempts',
  'autonomy_limit',
  'credits_exhausted',
  'business_rule',
  'workflow',
  'outside_business_hours',
  'unresolved',
  'invalid_ai_output',
  'ai_unavailable',
  'channel_unavailable',
] as const;

export type HandoffReason = (typeof HANDOFF_REASONS)[number];

export const isHandoffReason = (value: unknown): value is HandoffReason =>
  typeof value === 'string' && (HANDOFF_REASONS as readonly string[]).includes(value);

/** What a conversation without a control record means: a person, and AI never handled it. */
export const DEFAULT_CONTROL: Omit<ConversationControl, 'changedAt'> = Object.freeze({
  handledBy: 'human',
  aiState: 'off',
  epoch: 0,
});

export const controlOf = (
  conversation: Pick<Conversation, 'control'>,
): Omit<ConversationControl, 'changedAt'> & { readonly changedAt?: IsoTimestamp } =>
  conversation.control ?? DEFAULT_CONTROL;

/** An organization's settings before anyone changed them: AI handles nothing. */
export const defaultSettings = (
  organizationId: OrganizationId,
  at: IsoTimestamp,
): ConversationSettings =>
  Object.freeze({ organizationId, autonomy: 'manual', updatedAt: at, revision: 0 });

/**
 * The pairs of handler and AI state that can exist. Anything else in storage is refused, so a
 * record edited by hand cannot put an agent in charge of a conversation a person holds.
 */
const VALID_STATES: Readonly<Record<ConversationHandler, readonly ConversationAIState[]>> = {
  human: ['off', 'paused', 'escalated'],
  ai: ['active'],
};

export function isValidControl(control: ConversationControl): boolean {
  return (
    (CONVERSATION_HANDLERS as readonly string[]).includes(control.handledBy) &&
    (CONVERSATION_AI_STATES as readonly string[]).includes(control.aiState) &&
    VALID_STATES[control.handledBy].includes(control.aiState) &&
    Number.isSafeInteger(control.epoch) &&
    control.epoch >= 1
  );
}

/** Whether a person may send in the conversation now: never while an agent handles it. */
export const personMaySend = (conversation: Pick<Conversation, 'control'>): boolean =>
  controlOf(conversation).handledBy === 'human';

export type AutoSendRefusal =
  | 'autonomy_not_enabled'
  | 'conversation_handled_by_human'
  | 'conversation_closed'
  | 'control_changed';

export type AutoSendCheck =
  { readonly allowed: true } | { readonly allowed: false; readonly code: AutoSendRefusal };

/**
 * The check an automatic send must pass, right before it is sent (CV-6E will call it inside the
 * send's own transaction). An agent's turn records the control epoch it started under; the send is
 * refused when the organization turned AI handling off, when a person holds the conversation, when
 * it is closed, or when control changed in any way since the turn started.
 */
export function checkAutoSend(
  conversation: Pick<Conversation, 'control' | 'status'>,
  autonomy: AutonomyLevel,
  turnEpoch: number,
): AutoSendCheck {
  const control = controlOf(conversation);
  if (!allowsAIHandling(autonomy)) return { allowed: false, code: 'autonomy_not_enabled' };
  if (control.handledBy !== 'ai' || control.aiState !== 'active') {
    return { allowed: false, code: 'conversation_handled_by_human' };
  }
  if (conversation.status === 'closed') return { allowed: false, code: 'conversation_closed' };
  if (control.epoch !== turnEpoch) return { allowed: false, code: 'control_changed' };
  return { allowed: true };
}
