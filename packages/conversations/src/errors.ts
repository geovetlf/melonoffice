/**
 * Why a conversations operation was refused. Stable codes, safe to log. Another organization's
 * conversation, contact or connection is `*_not_found`, exactly like one that does not exist.
 */
export type ConversationErrorCode =
  | 'unresolved_tenant'
  | 'organization_inactive'
  | 'permission_denied'
  | 'requires_user'
  | 'invalid_request'
  | 'invalid_inbound'
  | 'conversation_not_found'
  | 'contact_not_found'
  | 'connection_not_found'
  | 'assignee_not_member'
  | 'department_not_found'
  | 'invalid_transition'
  | 'conversation_concurrency_conflict'
  // A person's send (CV-2, ADR-0034).
  | 'duplicate_request'
  | 'conversation_closed'
  | 'channel_not_available'
  | 'outside_messaging_window'
  // The connection cannot do this (ADR-0044).
  | 'capability_not_available'
  | 'tool_not_human_invokable'
  // Assisted AI on a conversation (CV-4, ADR-0037).
  | 'ai_not_available'
  | 'ai_unavailable'
  | 'ai_invalid_output'
  | 'ai_credits_insufficient'
  // Activation (CV-5, ADR-0038): the model policy refused, or the provider did not answer in time.
  | 'ai_policy_denied'
  | 'ai_timeout'
  | 'rate_limited'
  // Human control (CV-6A, ADR-0039).
  | 'autonomy_not_enabled'
  | 'conversation_handled_by_ai'
  | 'settings_concurrency_conflict'
  // The conversation agent (CV-6B, ADR-0043).
  | 'agent_not_available'
  // Templates (CV-6D phase 2, ADR-0046): refused before anything is reserved or sent.
  | 'template_not_found'
  | 'template_not_active'
  | 'template_parameters_invalid'
  // Customers and leads (C1, ADR-0053).
  | 'duplicate_contact'
  | 'owner_not_member'
  | 'contact_concurrency_conflict'
  // Opportunities and pipeline (C2, ADR-0054).
  | 'opportunity_not_found'
  | 'opportunity_concurrency_conflict'
  | 'opportunity_closed'
  | 'pipeline_concurrency_conflict'
  | 'stage_not_found'
  | 'stage_in_use'
  // Follow-ups (C5, ADR-0058).
  | 'follow_up_not_found'
  | 'follow_up_concurrency_conflict'
  | 'follow_up_closed'
  | 'follow_up_limit_reached'
  | 'follow_up_not_scheduled'
  | 'follow_up_scheduler_unavailable'
  | 'next_action_from_follow_up';

export class ConversationError extends Error {
  override readonly name = 'ConversationError';

  constructor(
    readonly code: ConversationErrorCode,
    /** Which field or rule, for `invalid_*`. A code, never user data. */
    readonly detail?: string,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
  }
}

export const isConversationError = (error: unknown): error is ConversationError =>
  error instanceof ConversationError;
