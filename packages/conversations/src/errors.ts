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
  | 'tool_not_human_invokable';

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
