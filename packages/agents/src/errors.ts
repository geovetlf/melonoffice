/**
 * Why an agent task was refused (ADR-0063). Stable codes, safe to log. Another organization's
 * task or agent is `task_not_found` or `specialist_not_found`, exactly like a missing one.
 */
export type AgentTaskErrorCode =
  | 'unresolved_tenant'
  | 'permission_denied'
  | 'invalid_task'
  | 'specialist_not_found'
  | 'specialist_not_available'
  | 'task_not_found'
  | 'idempotency_conflict'
  // An agent's own memory (ADR-0117).
  | 'invalid_memory'
  | 'memory_not_found'
  | 'memory_full'
  // Handoffs between agents (ADR-0117).
  | 'handoff_not_found'
  | 'handoff_not_pending'
  | 'no_agent_available'
  | 'budget_exhausted'
  // In-app notifications (ADR-0117).
  | 'notification_not_found';

export class AgentTaskError extends Error {
  override readonly name = 'AgentTaskError';

  constructor(
    readonly code: AgentTaskErrorCode,
    /** Which field or status. A code, never user data. */
    readonly detail?: string,
  ) {
    super(detail === undefined ? code : `${code}: ${detail}`);
  }
}

export const isAgentTaskError = (error: unknown): error is AgentTaskError =>
  error instanceof AgentTaskError;
