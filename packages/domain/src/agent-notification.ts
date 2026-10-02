import type { IsoTimestamp, OrganizationId, SpecialistId, UserId } from './ids.js';

/**
 * One in-app notice to a person about their agents' work (ADR-0117): an agent needs their
 * approval, finished, is blocked, failed, was stopped, needs information, or handed part of a task
 * to another agent, which received it. It names records by id and says what happened as codes;
 * the screen writes the sentence. It is never an instruction, carries no answer text and no
 * secret, and is read only by the person it is for, in their organization.
 *
 * Kept for a limited time (`expiresAt`), and only marked read: nothing in it is ever run.
 */
export interface AgentNotification {
  readonly id: string;
  readonly organizationId: OrganizationId;
  /** The person it is for: the one who asked for the task. */
  readonly recipientId: UserId;
  readonly kind: AgentNotificationKind;
  /** The agent the notice is about. */
  readonly specialistId: SpecialistId;
  /** The task the notice is about (for a handoff, the task that was handed on). */
  readonly taskId: string;
  /** A stable code saying why (e.g. `agent_paused`, `approval_required`), when there is one. */
  readonly code: string | null;
  /** For a handoff: the agent that received the work, when one did. */
  readonly otherSpecialistId: SpecialistId | null;
  readonly createdAt: IsoTimestamp;
  readonly readAt: IsoTimestamp | null;
  readonly expiresAt: IsoTimestamp;
}

export type AgentNotificationKind =
  | 'approval_required'
  | 'task_finished'
  | 'task_blocked'
  | 'task_failed'
  | 'agent_stopped'
  | 'needs_info'
  | 'task_delegated'
  | 'task_received';
