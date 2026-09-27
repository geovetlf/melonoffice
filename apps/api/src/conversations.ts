import type {
  ChannelConnection,
  ChannelIdentity,
  Contact,
  Conversation,
  Message,
} from '@melonoffice/domain';
import {
  isConversationError,
  type ConversationFilter,
  type ConversationService,
} from '@melonoffice/conversations';
import { isIntegrationError, type ChannelConnectionService } from '@melonoffice/integrations';
import type { Context, Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

/**
 * Human inbox routes (ADR-0033). A person reads conversations, messages and contacts, assigns a
 * conversation to a member or a department, moves its status and edits its tags. Nothing here
 * sends a message, runs a model or routes by AI: messages arrive only through the verified
 * channel webhook, and sending is decided later through the tool gate (CV-2). Channel
 * connections are listed without their secret references; they are configured on the server.
 * Another organization's conversation or contact answers exactly like a missing one.
 */
export function registerConversationRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & {
    readonly conversations: ConversationService;
    readonly connections: ChannelConnectionService;
  },
): void {
  const { conversations, connections } = dependencies;
  const base = '/v1/organizations/:organizationId';
  const one = `${base}/conversations/:conversationId`;
  const idOf = (c: Context<AuthEnv>) => c.req.param('conversationId') ?? '';

  app.get(
    `${base}/conversations`,
    withPermission('conversation.read', dependencies, async (c, tenant) => {
      const filter = filterOf(new URL(c.req.url).searchParams);
      if (filter === undefined) return c.json({ error: 'invalid_request' }, 400);
      return answer(c, async () => ({
        conversations: (await conversations.list(tenant, filter)).map(toConversationView),
      }));
    }),
  );

  app.get(
    one,
    withPermission('conversation.read', dependencies, (c, tenant) =>
      answer(c, async () => toConversationView(await conversations.get(tenant, idOf(c)))),
    ),
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
