import { sendReply, type ReplyOutcome, type ReplyRequest } from './sendReply.js';

/**
 * The Conversations Center's view of the API (CV-3, ADR-0035). It only calls the inbox routes of
 * one organization, through the caller's authenticated request function: the organization, the
 * contact, the channel and its credentials are decided by the server. Replies go through CV-2's
 * send route, which goes through the tool gate; nothing here talks to a channel provider.
 */

export type ConversationStatus = 'open' | 'pending' | 'closed';
export type ConversationPriority = 'low' | 'normal' | 'high' | 'urgent';
export type ConversationSort = 'last_activity' | 'created' | 'priority';

export const STATUSES: readonly ConversationStatus[] = ['open', 'pending', 'closed'];
export const PRIORITIES: readonly ConversationPriority[] = ['low', 'normal', 'high', 'urgent'];

/** Who handles a conversation (CV-6A, ADR-0039), as the server decided it. */
export type ConversationAIState = 'off' | 'active' | 'paused' | 'escalated';

export interface ConversationControlView {
  readonly handledBy: 'human' | 'ai';
  readonly aiState: ConversationAIState;
  readonly changedAt: string | null;
}

export interface ContactSummary {
  readonly id: string;
  readonly displayName: string | null;
  readonly phone: string | null;
}

export interface ConversationRow {
  readonly id: string;
  readonly contactId: string;
  readonly channel: string;
  readonly status: ConversationStatus;
  readonly assigneeId: string | null;
  readonly departmentId: string | null;
  readonly priority: ConversationPriority;
  readonly tags: readonly string[];
  readonly lastMessage: {
    readonly direction: 'inbound' | 'outbound';
    readonly preview: string | null;
    readonly at: string;
  } | null;
  readonly lastMessageAt: string;
  readonly createdAt: string;
  /** Who handles it (CV-6A). Absent from older answers: a person. */
  readonly control?: ConversationControlView;
  /** Why an agent handed it to a person, as a stable code. */
  readonly handoff?: { readonly reason: string; readonly requestedAt: string } | null;
  /** Null for a reader without `contact.read`. */
  readonly contact?: ContactSummary | null;
}

export interface MessageRow {
  readonly id: string;
  readonly direction: 'inbound' | 'outbound';
  readonly sender: { readonly kind: string; readonly userId?: string };
  readonly type: string;
  readonly text: string | null;
  readonly status: string;
  readonly sentAt: string;
}

export interface ConversationDetail {
  readonly conversation: ConversationRow;
  readonly contact: {
    readonly id: string;
    readonly displayName: string | null;
    readonly phone: string | null;
    readonly email: string | null;
    readonly createdAt: string;
  };
  readonly identity: {
    readonly channel: string;
    readonly externalId: string;
    readonly displayName: string | null;
  };
  readonly messages: readonly MessageRow[];
}

export interface DepartmentOption {
  readonly id: string;
  readonly nameKey: string | null;
  readonly name: string | null;
}

export interface InboxQuery {
  readonly status?: ConversationStatus;
  /** Only conversations nobody is responsible for. */
  readonly unassigned?: boolean;
  readonly q?: string;
  readonly sort?: ConversationSort;
}

/** Why the API refused something: a stable code, never a message from the server. */
export class InboxError extends Error {
  override readonly name = 'InboxError';
  constructor(readonly code: string) {
    super(code);
  }
}

/** What a person can ask the AI about a conversation (CV-4, ADR-0037). */
export type AssistOperation = 'summary' | 'intent' | 'reply' | 'next_steps';

/** The AI's answer, as the API checked it. Shown as text to review; never acted on. */
export type AssistResult =
  | {
      readonly type: 'summary';
      readonly summary: string;
      readonly intent: string;
      readonly customerNeed: string | null;
      readonly keyPoints: readonly string[];
      readonly providedData: readonly { readonly label: string; readonly value: string }[];
      readonly actionsTaken: readonly string[];
      readonly pendingInformation: readonly string[];
      readonly nextSteps: readonly string[];
    }
  | {
      readonly type: 'intent';
      readonly primary: string;
      readonly secondary: readonly string[];
      readonly confidence: number | null;
      readonly missingInformation: readonly string[];
      readonly requiresHuman: boolean;
      readonly requiresHumanReason: string | null;
    }
  | {
      readonly type: 'reply';
      readonly reply: string;
      readonly explanation: string | null;
      readonly warnings: readonly string[];
    }
  | {
      readonly type: 'next_steps';
      readonly nextSteps: readonly string[];
      readonly missingInformation: readonly string[];
      readonly departmentId: string | null;
      readonly requiresHuman: boolean;
    };

/** The agent that attends the organization's conversations (CV-6B). */
export interface ConversationAgentView {
  readonly id: string;
  readonly name: string | null;
}

export interface InboxClient {
  list(query: InboxQuery): Promise<readonly ConversationRow[]>;
  detail(id: string): Promise<ConversationDetail>;
  departments(): Promise<readonly DepartmentOption[]>;
  assign(
    id: string,
    change: { readonly assigneeId?: string | null; readonly departmentId?: string | null },
  ): Promise<ConversationRow>;
  setStatus(id: string, status: ConversationStatus): Promise<ConversationRow>;
  setPriority(id: string, priority: ConversationPriority): Promise<ConversationRow>;
  changeTags(
    id: string,
    change: { readonly add?: readonly string[]; readonly remove?: readonly string[] },
  ): Promise<ConversationRow>;
  reply(
    id: string,
    reply: { readonly clientMessageId: string; readonly text: string },
  ): Promise<ReplyOutcome>;
  /**
   * The organization's conversation agent (CV-6B, ADR-0043), or `null` when it has none. The name
   * is `null` for a reader who may not read specialists.
   */
  agent?(): Promise<ConversationAgentView | null>;
  /** A person takes control from AI (CV-6A): AI pauses and sends nothing more. */
  takeOver(id: string): Promise<ConversationRow>;
  /** A person hands the conversation back to AI, where the organization allows it. */
  handBack(id: string): Promise<ConversationRow>;
  /**
   * Asks the AI about a conversation (ADR-0037). The same `requestKey` is the same request,
   * answered and charged once. It sends nothing and changes nothing.
   */
  assist(
    id: string,
    request: {
      readonly operation: AssistOperation;
      readonly requestKey: string;
      readonly locale: 'en' | 'es';
    },
  ): Promise<AssistResult>;
}

export function createInboxClient(request: ReplyRequest, organizationId: string): InboxClient {
  const base = `/v1/organizations/${encodeURIComponent(organizationId)}`;
  const one = (id: string) => `${base}/conversations/${encodeURIComponent(id)}`;

  async function call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const response = await request(path, init);
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    if (!response.ok) {
      throw new InboxError(typeof body.error === 'string' ? body.error : 'generic');
    }
    return body as T;
  }
  const post = <T>(path: string, body: unknown) =>
    call<T>(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });

  return {
    async list(query) {
      const params = new URLSearchParams();
      if (query.status !== undefined) params.set('status', query.status);
      if (query.unassigned === true) params.set('unassigned', 'true');
      const q = query.q?.trim();
      if (q !== undefined && q.length >= 2) params.set('q', q);
      if (query.sort !== undefined) params.set('sort', query.sort);
      const search = params.toString();
      return (
        await call<{ conversations: ConversationRow[] }>(
          `${base}/conversations${search === '' ? '' : `?${search}`}`,
        )
      ).conversations;
    },
    detail: (id) => call<ConversationDetail>(`${one(id)}/detail`),
    async departments() {
      return (await call<{ departments: DepartmentOption[] }>(`${base}/departments`)).departments;
    },
    assign: (id, change) => post<ConversationRow>(`${one(id)}/assign`, change),
    setStatus: (id, status) => post<ConversationRow>(`${one(id)}/status`, { status }),
    setPriority: (id, priority) => post<ConversationRow>(`${one(id)}/priority`, { priority }),
    changeTags: (id, change) => post<ConversationRow>(`${one(id)}/tags`, change),
    reply: (id, reply) => sendReply(request, organizationId, id, reply),
    async agent() {
      const { agentId } = await call<{ agentId?: string | null }>(`${base}/conversation-settings`);
      if (typeof agentId !== 'string') return null;
      const specialist = await call<{ displayName?: unknown }>(
        `${base}/specialists/${encodeURIComponent(agentId)}`,
      ).catch(() => undefined);
      const name = specialist?.displayName;
      return { id: agentId, name: typeof name === 'string' ? name : null };
    },
    takeOver: (id) => post<ConversationRow>(`${one(id)}/takeover`, {}),
    handBack: (id) => post<ConversationRow>(`${one(id)}/handback`, {}),
    async assist(id, body) {
      return (await post<{ result: AssistResult }>(`${one(id)}/assist`, body)).result;
    },
  };
}
