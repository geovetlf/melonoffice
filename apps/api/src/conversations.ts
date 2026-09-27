import type {
  ChannelConnection,
  ChannelIdentity,
  Contact,
  Conversation,
  Message,
} from '@melonoffice/domain';
import {
  isConversationError,
  type ConversationAssistant,
  type ConversationFilter,
  type ConversationService,
} from '@melonoffice/conversations';
import {
  isIntegrationError,
  type ChannelConnectionService,
  type MessageSendService,
} from '@melonoffice/integrations';
import type { Context, Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

/**
 * Human inbox routes (ADR-0033). A person reads conversations, messages and contacts, searches
 * and sorts the inbox and opens one conversation whole (CV-3, ADR-0035), assigns a conversation
 * to a member or a department, moves its status and priority and edits its tags, and replies
 * (CV-2, ADR-0034): one text, as themselves, through the tool gate, synchronously. A person may
 * also ask the AI Gateway about a conversation (CV-4, ADR-0037) and gets text to review; nothing
 * here routes by AI or sends on its own: messages arrive only through the verified
 * channel webhook, and leave only when a person sends them. Channel connections are listed
 * without their secret references; they are configured on the server. Another organization's
 * conversation or contact answers exactly like a missing one.
 */
export function registerConversationRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & {
    readonly conversations: ConversationService;
    readonly connections: ChannelConnectionService;
    /** A person's replies (ADR-0034). Absent: the send route answers 503. */
    readonly sender?: MessageSendService;
    /** Assisted AI (ADR-0037). Absent: the assist route answers 503. */
    readonly assistant?: ConversationAssistant;
  },
): void {
  const { conversations, connections, sender, assistant } = dependencies;
  const base = '/v1/organizations/:organizationId';
  const one = `${base}/conversations/:conversationId`;
  const idOf = (c: Context<AuthEnv>) => c.req.param('conversationId') ?? '';

  app.get(
    `${base}/conversations`,
    withPermission('conversation.read', dependencies, async (c, tenant) => {
      const filter = filterOf(new URL(c.req.url).searchParams);
      if (filter === undefined) return c.json({ error: 'invalid_request' }, 400);
      return answer(c, async () => ({
        conversations: (await conversations.inbox(tenant, filter)).map(
          ({ conversation, contact }) => ({
            ...toConversationView(conversation),
            // Who it is with, for a reader of contacts (CV-3); null otherwise.
            contact: contact === undefined ? null : toContactSummary(contact),
          }),
        ),
      }));
    }),
  );

  app.get(
    one,
    withPermission('conversation.read', dependencies, (c, tenant) =>
      answer(c, async () => toConversationView(await conversations.get(tenant, idOf(c)))),
    ),
  );

  /**
   * One conversation opened in the inbox (CV-3): the conversation, its contact, the channel
   * identity it speaks through and its latest messages, in one answer. Never the connection's
   * secret references or anything read from them.
   */
  app.get(
    `${one}/detail`,
    withPermission('conversation.read', dependencies, async (c, tenant) => {
      const query = new URL(c.req.url).searchParams;
      if ([...query.keys()].some((k) => k !== 'limit') || query.getAll('limit').length > 1) {
        return c.json({ error: 'invalid_request' }, 400);
      }
      const limit = limitOf(query.get('limit') ?? undefined);
      if (limit === null) return c.json({ error: 'invalid_request' }, 400);
      return answer(c, async () => {
        const detail = await conversations.detail(
          tenant,
          idOf(c),
          limit === undefined ? {} : { limit },
        );
        return {
          conversation: toConversationView(detail.conversation),
          contact: toContactView(detail.contact),
          identity: toIdentityView(detail.identity),
          messages: detail.messages.map(toMessageView),
        };
      });
    }),
  );

  app.get(
    `${one}/messages`,
    withPermission('conversation.read', dependencies, async (c, tenant) => {
      const limit = limitOf(c.req.query('limit'));
      if (limit === null) return c.json({ error: 'invalid_request' }, 400);
      return answer(c, async () => ({
        messages: (
          await conversations.messages(tenant, idOf(c), limit === undefined ? {} : { limit })
        ).map(toMessageView),
      }));
    }),
  );

  /**
   * A person's reply. The body is exactly `{ clientMessageId, text }`: the organization, the
   * sender, the recipient, the channel account and its credentials all come from the token and
   * the stored conversation. The same `clientMessageId` is the same message: a repeat answers
   * with it as it is and never sends it twice.
   */
  app.post(
    `${one}/messages`,
    withPermission('conversation.send', dependencies, async (c, tenant) => {
      if (sender === undefined) return c.json({ error: 'sending_not_configured' }, 503);
      const body = await bodyOf(c, ['clientMessageId', 'text']);
      if (body === undefined) return c.json({ error: 'invalid_request' }, 400);
      try {
        const { message, created } = await sender.send(tenant, idOf(c), {
          clientMessageId: body.clientMessageId,
          text: body.text,
        });
        const view = toMessageView(message);
        if (message.status === 'unknown') {
          // Accepted by nobody we know of: it may have gone out, and is not sent again.
          return c.json({ error: 'external_send_unknown', message: view }, 202);
        }
        if (message.status === 'failed') {
          const code = message.failureCode ?? 'external_send_failed';
          return Object.hasOwn(SEND_REFUSALS, code)
            ? c.json(
                { error: code, message: view },
                SEND_REFUSALS[code as keyof typeof SEND_REFUSALS],
              )
            : c.json({ error: 'external_send_failed', reason: code, message: view }, 502);
        }
        return c.json({ message: view }, created ? 201 : 200);
      } catch (error) {
        if (isConversationError(error) && Object.hasOwn(STATUS, error.code)) {
          const code = error.code as keyof typeof STATUS;
          return c.json({ error: code }, STATUS[code]);
        }
        throw error;
      }
    }),
  );

  /**
   * Assisted AI on one conversation (CV-4, ADR-0037). The body is exactly
   * `{ operation, requestKey, locale? }`: the organization, the person and the conversation come
   * from the token and the path. The answer is text to review, marked as generated by AI. It is
   * never sent, stored as a message or acted on: a suggested reply goes to the person's composer,
   * and leaves only through the send route above if they send it. The same `requestKey` is the
   * same request: answered once and charged once.
   */
  app.post(
    `${one}/assist`,
    withPermission('conversation.assist', dependencies, async (c, tenant) => {
      if (assistant === undefined) return c.json({ error: 'ai_not_available' }, 503);
      const body = await bodyOf(c, ['operation', 'requestKey', 'locale']);
      if (body === undefined) return c.json({ error: 'invalid_request' }, 400);
      return answer(c, async () => {
        const outcome = await assistant.assist(tenant, idOf(c), {
          operation: body.operation,
          requestKey: body.requestKey,
          ...(body.locale === undefined ? {} : { locale: body.locale }),
        });
        return {
          operation: outcome.operation,
          conversationId: outcome.conversationId,
          generatedBy: 'ai',
          replayed: outcome.replayed,
          result: outcome.result,
        };
      });
    }),
  );

  app.post(
    `${one}/assign`,
    withPermission('conversation.manage', dependencies, async (c, tenant) => {
      const body = await bodyOf(c, ['assigneeId', 'departmentId']);
      if (body === undefined) return c.json({ error: 'invalid_request' }, 400);
      const { assigneeId, departmentId } = body;
      const nullableString = (v: unknown) => v === undefined || v === null || typeof v === 'string';
      if (!nullableString(assigneeId) || !nullableString(departmentId)) {
        return c.json({ error: 'invalid_request' }, 400);
      }
      return answer(c, async () => {
        const conversation = await conversations.assign(tenant, idOf(c), {
          ...(assigneeId === undefined ? {} : { assigneeId: assigneeId as never }),
          ...(departmentId === undefined ? {} : { departmentId: departmentId as never }),
        });
        c.get('logger').info('conversation assigned', { conversationId: conversation.id });
        return toConversationView(conversation);
      });
    }),
  );

  app.post(
    `${one}/status`,
    withPermission('conversation.manage', dependencies, async (c, tenant) => {
      const body = await bodyOf(c, ['status']);
      if (body === undefined || body.status === undefined) {
        return c.json({ error: 'invalid_request' }, 400);
      }
      return answer(c, async () =>
        toConversationView(await conversations.changeStatus(tenant, idOf(c), body.status)),
      );
    }),
  );

  app.post(
    `${one}/priority`,
    withPermission('conversation.manage', dependencies, async (c, tenant) => {
      const body = await bodyOf(c, ['priority']);
      if (body === undefined || body.priority === undefined) {
        return c.json({ error: 'invalid_request' }, 400);
      }
      return answer(c, async () =>
        toConversationView(await conversations.changePriority(tenant, idOf(c), body.priority)),
      );
    }),
  );

  app.post(
    `${one}/tags`,
    withPermission('conversation.manage', dependencies, async (c, tenant) => {
      const body = await bodyOf(c, ['add', 'remove']);
      if (body === undefined) return c.json({ error: 'invalid_request' }, 400);
      const list = (v: unknown) => v === undefined || Array.isArray(v);
      if (!list(body.add) || !list(body.remove)) return c.json({ error: 'invalid_request' }, 400);
      return answer(c, async () =>
        toConversationView(
          await conversations.changeTags(tenant, idOf(c), {
            ...(body.add === undefined ? {} : { add: body.add as unknown[] }),
            ...(body.remove === undefined ? {} : { remove: body.remove as unknown[] }),
          }),
        ),
      );
    }),
  );

  app.get(
    `${base}/contacts`,
    withPermission('contact.read', dependencies, (c, tenant) =>
      answer(c, async () => ({
        contacts: (await conversations.contacts(tenant)).map(toContactView),
      })),
    ),
  );

  app.get(
    `${base}/contacts/:contactId`,
    withPermission('contact.read', dependencies, (c, tenant) =>
      answer(c, async () => {
        const { contact, identities } = await conversations.contact(
          tenant,
          c.req.param('contactId') ?? '',
        );
        return { ...toContactView(contact), identities: identities.map(toIdentityView) };
      }),
    ),
  );

  app.get(
    `${base}/channel-connections`,
    withPermission('channel.read', dependencies, (c, tenant) =>
      answer(c, async () => ({
        connections: (await connections.list(tenant)).map(toConnectionView),
      })),
    ),
  );
}

const FILTER_KEYS = new Set([
  'status',
  'channel',
  'assigneeId',
  'unassigned',
  'departmentId',
  'contactId',
  'tag',
  'priority',
  'q',
  'sort',
  'since',
  'until',
  'limit',
]);

/** Undefined for an unknown or repeated key, or a malformed `limit`/`unassigned`. */
export function filterOf(query: URLSearchParams): ConversationFilter | undefined {
  const filter: Record<string, unknown> = {};
  for (const key of new Set(query.keys())) {
    const values = query.getAll(key);
    if (!FILTER_KEYS.has(key) || values.length !== 1) return undefined;
    filter[key] = values[0];
  }
  if (filter.unassigned !== undefined) {
    if (filter.unassigned !== 'true') return undefined;
    filter.unassigned = true;
  }
  if (filter.limit !== undefined) {
    const limit = limitOf(filter.limit as string);
    if (limit === null) return undefined;
    filter.limit = limit;
  }
  return filter as ConversationFilter;
}

/** `undefined` when absent, `null` when malformed. The service checks the range. */
function limitOf(value: string | undefined): number | undefined | null {
  if (value === undefined) return undefined;
  return /^[0-9]{1,4}$/.test(value) ? Number(value) : null;
}

/** A JSON object with only the allowed keys, or undefined. */
async function bodyOf(
  c: Context<AuthEnv>,
  allowed: readonly string[],
): Promise<Record<string, unknown> | undefined> {
  const body: unknown = await c.req.json().catch(() => undefined);
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some((k) => !allowed.includes(k))) return undefined;
  return record;
}

const STATUS = {
  invalid_request: 400,
  permission_denied: 403,
  requires_user: 403,
  organization_inactive: 403,
  conversation_not_found: 404,
  contact_not_found: 404,
  connection_not_found: 404,
  department_not_found: 404,
  assignee_not_member: 409,
  invalid_transition: 409,
  conversation_concurrency_conflict: 409,
  duplicate_request: 409,
  conversation_closed: 409,
  outside_messaging_window: 409,
  tool_not_human_invokable: 403,
  channel_not_available: 503,
  // Assisted AI (ADR-0037): stable codes only, never a provider's message or detail.
  ai_not_available: 503,
  ai_unavailable: 502,
  ai_invalid_output: 502,
  ai_credits_insufficient: 409,
  rate_limited: 429,
} as const;

/** A send refused before anything left MelonOffice, found once the message was reserved. */
const SEND_REFUSALS = {
  conversation_closed: 409,
  outside_messaging_window: 409,
  tool_not_human_invokable: 403,
  permission_not_held: 403,
  channel_not_available: 503,
  environment_not_allowed: 503,
} as const;

async function answer(c: Context<AuthEnv>, work: () => Promise<unknown>): Promise<Response> {
  try {
    return c.json(await work());
  } catch (error) {
    if (
      (isConversationError(error) || isIntegrationError(error)) &&
      Object.hasOwn(STATUS, error.code)
    ) {
      const code = error.code as keyof typeof STATUS;
      return c.json({ error: code }, STATUS[code]);
    }
    throw error;
  }
}

/** The inbox view of a conversation. The revision and the reserved handoff are internal. */
export function toConversationView(c: Conversation) {
  return {
    id: c.id,
    contactId: c.contactId,
    channelIdentityId: c.channelIdentityId,
    channel: c.channel,
    connectionId: c.connectionId,
    status: c.status,
    assigneeId: c.assigneeId ?? null,
    departmentId: c.departmentId ?? null,
    priority: c.priority,
    tags: [...c.tags],
    lastMessage:
      c.lastMessage === undefined
        ? null
        : {
            id: c.lastMessage.id,
            direction: c.lastMessage.direction,
            type: c.lastMessage.type,
            preview: c.lastMessage.preview ?? null,
            at: c.lastMessage.at,
          },
    lastMessageAt: c.lastMessageAt,
    lastInboundAt: c.lastInboundAt ?? null,
    lastOutboundAt: c.lastOutboundAt ?? null,
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

export function toMessageView(m: Message) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    channel: m.channel,
    direction: m.direction,
    sender:
      m.sender.kind === 'contact'
        ? { kind: 'contact', channelIdentityId: m.sender.channelIdentityId }
        : m.sender.kind === 'user'
          ? { kind: 'user', userId: m.sender.userId }
          : {
              kind: 'specialist',
              specialistId: m.sender.specialistId,
              executionId: m.sender.executionId,
            },
    type: m.type,
    text: m.text ?? null,
    attachments: m.attachments.map((a) => ({
      providerMediaId: a.providerMediaId,
      mimeType: a.mimeType ?? null,
    })),
    replyToExternalId: m.replyToExternalId ?? null,
    status: m.status,
    failureCode: m.failureCode ?? null,
    sentAt: m.sentAt,
    createdAt: m.createdAt,
    deliveredAt: m.deliveredAt ?? null,
    readAt: m.readAt ?? null,
  };
}

export function toContactView(c: Contact) {
  return {
    id: c.id,
    displayName: c.displayName ?? null,
    phone: c.phone ?? null,
    email: c.email ?? null,
    status: c.status,
    origin:
      c.origin.kind === 'channel'
        ? { kind: 'channel', channel: c.origin.channel, connectionId: c.origin.connectionId }
        : { kind: 'user', userId: c.origin.userId },
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}

/** The few contact fields an inbox row shows. */
export function toContactSummary(c: Contact) {
  return {
    id: c.id,
    displayName: c.displayName ?? null,
    phone: c.phone ?? null,
  };
}

export function toIdentityView(i: ChannelIdentity) {
  return {
    id: i.id,
    channel: i.channel,
    externalId: i.externalId,
    displayName: i.displayName ?? null,
    verification: i.verification,
    createdAt: i.createdAt,
  };
}

/** A connection without its secret references: they name where credentials live. */
export function toConnectionView(c: ChannelConnection) {
  return {
    id: c.id,
    channel: c.channel,
    status: c.status,
    displayName: c.displayName,
    account: {
      phoneNumberId: c.account.phoneNumberId,
      displayPhoneNumber: c.account.displayPhoneNumber ?? null,
    },
    createdAt: c.createdAt,
    updatedAt: c.updatedAt,
  };
}
