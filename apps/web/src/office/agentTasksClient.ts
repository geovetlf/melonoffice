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
  };
}
