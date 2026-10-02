import type { IsoTimestamp, OrganizationId, SpecialistId, UserId } from './ids.js';
import type { ExecutionId } from './execution.js';

/**
 * One agent handing part of its task to an agent of another department (ADR-0117). The first
 * agent only proposes it, in its answer; MelonOffice picks the receiving agent and a person
 * decides. Accepted, the receiving agent gets a task of its own (a child of the first), which it
 * does with its own permissions, skills and policy: nothing is inherited from the first agent.
 *
 * Its id is the first task's: one handoff per task.
 */
export interface AgentHandoff {
  readonly id: ExecutionId;
  readonly organizationId: OrganizationId;
  /** The task the handoff came from. */
  readonly parentTaskId: ExecutionId;
  readonly requestingAgent: AgentRef;
  /** The department the first agent asked for, by its type (`marketing`, `design`, …). */
  readonly department: string;
  /** The agent MelonOffice chose in that department; absent when none could take it. */
  readonly receivingAgent?: AgentRef;
  /** Why the first agent asked, as a code. */
  readonly reason: AgentHandoffReason;
  /** What the receiving agent is asked, in the first agent's words. */
  readonly request: string;
  /** What it should know from the first task: the first agent's own summary. */
  readonly context: string;
  readonly state: AgentHandoffState;
  /** Why MelonOffice refused it, when it did (a code). */
  readonly refusal?: string;
  /** The receiving agent's task, once accepted. */
  readonly childTaskId?: ExecutionId;
  /** The receiving agent's permissions when it was accepted: its own, never the first agent's. */
  readonly permissions?: readonly string[];
  /** The receiving task's budget: never more than the first task had left. */
  readonly maxCredits?: number;
  /** Who accepted or declined it, and when. */
  readonly decision?: { readonly by: UserId; readonly at: IsoTimestamp };
  /** What the receiving task spent on AI, in credits, once it ended. */
  readonly creditsConsumed?: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

export interface AgentRef {
  readonly specialistId: SpecialistId;
  readonly version: number;
}

export type AgentHandoffReason = 'outside_role' | 'needs_specialist' | 'next_step';

export type AgentHandoffState =
  'proposed' | 'accepted' | 'declined' | 'refused' | 'completed' | 'failed';
