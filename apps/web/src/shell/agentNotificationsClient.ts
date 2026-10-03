import type { ReplyRequest } from '../conversations/sendReply.js';

/**
 * The person's in-app notices about their agents (ADR-0117): ids and codes only. The screen writes
 * the sentence; nothing in a notice is ever run.
 */
export type AgentNoticeKind =
  | 'approval_required'
  | 'task_finished'
  | 'task_blocked'
  | 'task_failed'
  | 'agent_stopped'
  | 'needs_info'
  | 'task_delegated'
  | 'task_received'
  // A plan of several agents ended (ADR-0119).
  | 'result_available'
  | 'plan_failed'
  // Closed by the automatic sweep (ADR-0121).
  | 'task_abandoned'
  // The Agent Guardian found something to check in an answer (G-2).
  | 'guardian_warning';

export interface AgentNoticeView {
  readonly id: string;
  readonly kind: AgentNoticeKind;
  /** Null for a plan's result, which is several agents' work. */
  readonly specialistId: string | null;
  readonly taskId: string;
  /** For a plan's result (ADR-0119): GIA's page opens it to summarize. */
  readonly planId?: string | null;
  readonly code: string | null;
  readonly otherSpecialistId: string | null;
  readonly createdAt: string;
  readonly read: boolean;
}

export interface AgentNoticePage {
  readonly notifications: readonly AgentNoticeView[];
  readonly nextCursor: string | null;
  readonly unread: number;
}

export interface AgentNotificationsClient {
  list(): Promise<AgentNoticePage>;
  markRead(id: string): Promise<void>;
  markAllRead(): Promise<void>;
}

export function createAgentNotificationsClient(
  request: ReplyRequest,
  organizationId: string,
): AgentNotificationsClient {
  const base = `/v1/organizations/${encodeURIComponent(organizationId)}/notifications`;
  const send = async (path: string, init: RequestInit = {}) => {
    const response = await request(`${base}${path}`, init);
    if (!response.ok) throw new Error(`notifications request failed: ${response.status}`);
    return response;
  };
  return {
    async list() {
      const body = (await (await send('?limit=10')).json()) as Partial<AgentNoticePage>;
      return {
        notifications: body.notifications ?? [],
        nextCursor: body.nextCursor ?? null,
        unread: typeof body.unread === 'number' ? body.unread : 0,
      };
    },
    async markRead(id) {
      await send(`/${encodeURIComponent(id)}/read`, { method: 'POST' });
    },
    async markAllRead() {
      await send('/read', { method: 'POST' });
    },
  };
}
