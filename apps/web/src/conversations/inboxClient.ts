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
  };
}
