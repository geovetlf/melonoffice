import type { IsoTimestamp, OrganizationId, SpecialistId, UserId } from './ids.js';
import type { ExecutionId } from './execution.js';

/**
 * A task a person asked one of the organization's agents to do (Agent Engine phase 2, ADR-0063).
 * It holds only what was asked; its state is its execution's (the task id is the execution id),
 * and its answer is the execution's agent output. Written once, never changed.
 */
export interface AgentTask {
  readonly id: ExecutionId;
  readonly organizationId: OrganizationId;
  readonly specialistId: SpecialistId;
  /** The agent version the task was asked of: the one its execution runs. */
  readonly specialistVersion: number;
  /** What the person asked, in their words. */
  readonly request: string;
  readonly requestedBy: UserId;
  readonly createdAt: IsoTimestamp;
  /**
   * The most credits the task may spend on AI, when the person set a budget (ADR-0100). Absent:
   * no task budget; each call is still limited by the balance and its model policy.
   */
  readonly maxCredits?: number;
  /**
   * The task this one was handed from (ADR-0117), when another agent proposed it and a person
   * accepted. A handed task never hands on again.
   */
  readonly parentTaskId?: ExecutionId;
}
