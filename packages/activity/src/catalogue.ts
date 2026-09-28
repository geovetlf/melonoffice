import { MAX_QUERY_ACTIONS, type AuditAction, type AuditEvent } from '@melonoffice/audit';
import type { UserId } from '@melonoffice/domain';

/**
 * What a person sees as their office's activity (ADR-0049): the events that say something
 * happened in the business, not the plumbing under it. Sign-ins, tenant resolution, permission
 * checks, job leases and delivery attempts are recorded but not shown.
 *
 * One audit query filters at most 30 actions (the limit of one Firestore `in` filter), so the
 * actions come in groups and the activity view runs one query per group (C1, ADR-0053). The limit
 * per query is never raised.
 */
const OFFICE_ACTIONS = [
  'organization.create',
  'organization.profile_updated',
  'membership.create',
  'department.archived',
  'conversation.message_received',
  'conversation.message_sent',
  'conversation.message_send_failed',
  'conversation.assigned',
  'conversation.status_changed',
  'conversation.autonomy_changed',
  'conversation.ai_turn_started',
  'conversation.ai_human_takeover',
  'conversation.ai_handed_back',
  'conversation.ai_escalated',
  'conversation.ai_summary_requested',
  'conversation.ai_reply_suggested',
  'channel.connection_created',
  'channel.connection_disconnected',
  'channel.connection_failed',
  'channel.template_registered',
  'tool.execution_completed',
  'tool.approval_requested',
  'tool.approval_approved',
  'tool.approval_rejected',
  'execution.created',
  'plan.created',
  'plan.approved',
  'workflow.created',
  'credits.grant',
  'gia.message_answered',
] as const satisfies readonly AuditAction[];

/**
 * Customers and leads (C1): a new contact, a stage change and a new responsible person; and
 * opportunities (C2): opened, won and lost.
 */
const CUSTOMER_ACTIONS = [
  'contact.created',
  'contact.stage_changed',
  'contact.owner_changed',
  'opportunity.created',
  'opportunity.won',
  'opportunity.lost',
] as const satisfies readonly AuditAction[];

/**
 * Follow-ups (C5, ADR-0058): scheduled, due (the internal notice that its time came), done,
 * rescheduled, cancelled and failed. Nothing is sent to the contact; the office shows it.
 */
const FOLLOW_UP_ACTIONS = [
  'follow_up.created',
  'follow_up.due',
  'follow_up.completed',
  'follow_up.rescheduled',
  'follow_up.cancelled',
  'follow_up.failed',
] as const satisfies readonly AuditAction[];

/** The actions of each audit query the activity view runs. */
export const ACTIVITY_ACTION_GROUPS: readonly (readonly AuditAction[])[] = [
  OFFICE_ACTIONS,
  CUSTOMER_ACTIONS,
  FOLLOW_UP_ACTIONS,
];

/** Every action the activity view shows. */
export const ACTIVITY_ACTIONS: readonly AuditAction[] = ACTIVITY_ACTION_GROUPS.flat();

if (ACTIVITY_ACTION_GROUPS.some((group) => group.length > MAX_QUERY_ACTIONS)) {
  throw new Error('too many activity actions for one audit query');
}
if (new Set(ACTIVITY_ACTIONS).size !== ACTIVITY_ACTIONS.length) {
  throw new Error('an activity action is in more than one group');
}

/** Who did it, as a person reading their office understands it. Never another user's id. */
export type ActivityActor = 'you' | 'member' | 'gia' | 'agent' | 'contact' | 'system';

export interface ActivityItem {
  readonly id: string;
  readonly at: string;
  readonly action: string;
  readonly result: string;
  readonly actor: ActivityActor;
  /** What the event is about, when the app can open it: a conversation or a follow-up. */
  readonly link?: { readonly kind: 'conversation' | 'follow_up'; readonly id: string };
}

function actorOf(event: AuditEvent, viewer: UserId): ActivityActor {
  const actor = event.actor;
  if (actor.type === 'user') {
    if (actor.via === 'gia') return 'gia';
    return actor.userId === viewer ? 'you' : 'member';
  }
  // The scheduler marking a follow-up due is the system, not an agent (C5).
  if (actor.type === 'system') return event.action.startsWith('follow_up.') ? 'system' : 'agent';
  // Only a verified channel records an anonymous actor: the contact wrote.
  return event.action === 'conversation.message_received' ? 'contact' : 'system';
}

const CONVERSATION_REFERENCE = /^conversation:([A-Za-z0-9_-]{1,128})$/;

function linkOf(event: AuditEvent): ActivityItem['link'] {
  if (event.target?.type === 'conversation') return { kind: 'conversation', id: event.target.id };
  if (event.target?.type === 'follow_up') return { kind: 'follow_up', id: event.target.id };
  const found = CONVERSATION_REFERENCE.exec(event.reference ?? '');
  return found?.[1] === undefined ? undefined : { kind: 'conversation', id: found[1] };
}

/**
 * One event as the activity view shows it: when, what, how it ended, who and what it links to.
 * The event's other fields (reasons, references, versions) stay in the audit trail.
 */
export function toActivityItem(event: AuditEvent, viewer: UserId): ActivityItem {
  const link = linkOf(event);
  return Object.freeze({
    id: event.id,
    at: event.occurredAt,
    action: event.action,
    result: event.result,
    actor: actorOf(event, viewer),
    ...(link === undefined ? {} : { link: Object.freeze(link) }),
  });
}
