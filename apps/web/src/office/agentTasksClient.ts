import type { ReplyRequest } from '../conversations/sendReply.js';

/**
 * Agent tasks (ADR-0063), as the API serves them: what a person asked one of the organization's
 * agents, the state of its execution and, once it completed and passed its verification, the
 * agent's answer. The web never runs anything: it asks, and reads what the worker produced.
 */

export type AgentTaskStatus =
  | 'pending'
  | 'planning'
  | 'waiting_approval'
  | 'running'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused'
  | 'retrying'
  | 'unknown';

export interface AgentTaskView {
  readonly id: string;
  readonly specialistId: string;
  readonly request: string;
  readonly createdAt: string;
  readonly status: AgentTaskStatus;
  readonly failure: string | null;
  /** Open but not moving for long (ADR-0120): it may be stopped. Absent from older APIs. */
  readonly stale?: boolean;
  readonly completedAt: string | null;
  readonly answer: {
    readonly answer: string;
    readonly missing: readonly string[];
    /** How many facts it proposed for the company memory, for the owner to confirm (ADR-0084). */
    readonly facts?: number;
    /** The follow-up it proposed, and where it stands (ADR-0084). */
    readonly followUp?: TaskFollowUpView | null;
  } | null;
  /**
   * A follow-up the agent asked to schedule with its own tool, and where it stands (ADR-0104): it
   * can wait for a person's approval before the agent has answered.
   */
  readonly toolFollowUp?: TaskFollowUpView | null;
  /** The task it was handed from (ADR-0117), when another agent proposed it. */
  readonly parentTaskId?: string | null;
  /** The handoff this task proposed to another department's agent (ADR-0117), if any. */
  readonly agentHandoff?: AgentHandoffView | null;
  /** Whether it now needs a person, and why (ADR-0101): codes only. */
  readonly handoff?: { readonly reason: string; readonly code: string | null } | null;
}

/** What an agent proposed to hand to another department's agent, and where it stands. */
export interface AgentHandoffView {
  readonly state: 'proposed' | 'accepted' | 'declined' | 'refused' | 'completed' | 'failed';
  readonly reason: string;
  /** The department's catalogue type (`marketing`, `design`…). */
  readonly department: string;
  readonly request: string;
  readonly context: string;
  readonly requestingAgentId: string;
  readonly receivingAgentId: string | null;
  readonly childTaskId: string | null;
  readonly refusal: string | null;
  readonly maxCredits: number | null;
  readonly creditsConsumed: number | null;
}

/** Everything that happened in a task (ADR-0117): steps, tools, approvals, models and credits. */
export interface AgentTaskTraceView {
  readonly taskId: string;
  readonly status: string;
  readonly failure: string | null;
  /** From creation to the end, once it ended (ADR-0119). */
  readonly durationMs?: number | null;
  readonly steps: readonly {
    readonly nodeId: string;
    readonly type: string;
    readonly status: string;
    readonly tool: { readonly id: string; readonly version: number } | null;
    readonly approvalId: string | null;
    readonly error: string | null;
    readonly durationMs?: number | null;
    readonly model: {
      readonly provider: string;
      readonly model: string;
      readonly credits: number;
    } | null;
  }[];
  readonly review: { readonly verdict: string; readonly reason: string } | null;
  readonly subtasks: readonly {
    readonly taskId: string;
    readonly specialistId: string;
    readonly status: string;
    readonly credits: number;
  }[];
  readonly credits: {
    readonly task: number;
    readonly review: number;
    readonly subtasks: number;
    readonly total: number;
    readonly budget: number | null;
    readonly byAgent: readonly { readonly specialistId: string; readonly credits: number }[];
  };
}

/** The follow-up a task proposed or asked for with its tool, if any. */
export const followUpOfTask = (task: AgentTaskView): TaskFollowUpView | null =>
  task.answer?.followUp ?? task.toolFollowUp ?? null;

export type TaskFollowUpState =
  'preparing' | 'waiting_approval' | 'scheduled' | 'rejected' | 'expired' | 'not_scheduled';

export interface TaskFollowUpView {
  readonly contactId: string | null;
  readonly contactName: string | null;
  readonly type: string;
  readonly title: string;
  readonly date: string;
  readonly time: string;
  readonly state: TaskFollowUpState;
  /** Only while it waits for a person's approval. */
  readonly approvalId: string | null;
}

export interface AgentTaskPage {
  readonly tasks: readonly AgentTaskView[];
  readonly nextCursor: string | null;
}

export interface AgentTasksClient {
  list(agentId: string, cursor?: string): Promise<AgentTaskPage>;
  /** The same `requestKey` for the same agent is the same task: a retry never asks twice. */
  assign(agentId: string, request: string, requestKey: string): Promise<AgentTaskView>;
  get(taskId: string): Promise<AgentTaskView>;
  /** A person accepts the handoff the task proposed (ADR-0117): the other agent gets the work. */
  acceptHandoff?(taskId: string): Promise<unknown>;
  declineHandoff?(taskId: string): Promise<unknown>;
  /** What happened in the task, step by step (ADR-0117). */
  trace?(taskId: string): Promise<AgentTaskTraceView>;
}

/** The API refused or failed, with its code: the screen says what happened, never guesses. */
export class AgentTaskError extends Error {
  override readonly name = 'AgentTaskError';
  constructor(
    readonly status: number,
    readonly code: string,
  ) {
    super(`agent task request failed: ${status} ${code}`);
  }
}

/** Whether a task may still change: the screen reads it again until it settles. */
export const isOpenTask = (task: Pick<AgentTaskView, 'status'>): boolean =>
  !['completed', 'failed', 'cancelled', 'unknown'].includes(task.status);

export function createAgentTasksClient(
  request: ReplyRequest,
  organizationId: string,
): AgentTasksClient {
  const base = `/v1/organizations/${encodeURIComponent(organizationId)}`;
  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await request(`${base}${path}`, init);
    if (!response.ok) {
      const body = (await response.json().catch(() => ({}))) as { error?: unknown };
      throw new AgentTaskError(
        response.status,
        typeof body.error === 'string' ? body.error : 'unexpected',
      );
    }
    return (await response.json()) as T;
  }
  const agentPath = (agentId: string) => `/specialists/${encodeURIComponent(agentId)}/tasks`;
  return {
    list: (agentId, cursor) =>
      call<AgentTaskPage>(
        `${agentPath(agentId)}${cursor === undefined ? '' : `?cursor=${encodeURIComponent(cursor)}`}`,
      ),
    assign: (agentId, text, requestKey) =>
      call<AgentTaskView>(agentPath(agentId), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ request: text, idempotencyKey: requestKey }),
      }),
    get: (taskId) => call<AgentTaskView>(`/agent-tasks/${encodeURIComponent(taskId)}`),
    acceptHandoff: (taskId) =>
      call(`/agent-tasks/${encodeURIComponent(taskId)}/handoff/accept`, { method: 'POST' }),
    declineHandoff: (taskId) =>
      call(`/agent-tasks/${encodeURIComponent(taskId)}/handoff/decline`, { method: 'POST' }),
    trace: (taskId) => call<AgentTaskTraceView>(`/agent-tasks/${encodeURIComponent(taskId)}/trace`),
  };
}
