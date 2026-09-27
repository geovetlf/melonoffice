import type {
  ChannelConnectionId,
  ChannelIdentity,
  ChannelIdentityId,
  ChannelType,
  Contact,
  ContactId,
  Conversation,
  ConversationId,
  ConversationPriority,
  ConversationStatus,
  IsoTimestamp,
  Message,
  MessageAttachment,
  MessageId,
  MessageStatus,
  MessageType,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import { nameBasedUuid } from '@melonoffice/execution';
import { isHandoffReason, isValidControl } from './control.js';
import { ConversationError } from './errors.js';

export const CHANNEL_TYPES = ['whatsapp'] as const satisfies readonly ChannelType[];
export const CONVERSATION_STATUSES = [
  'open',
  'pending',
  'closed',
] as const satisfies readonly ConversationStatus[];
export const PRIORITIES = [
  'low',
  'normal',
  'high',
  'urgent',
] as const satisfies readonly ConversationPriority[];
export const MESSAGE_TYPES = [
  'text',
  'image',
  'document',
  'audio',
  'video',
  'sticker',
  'location',
  'unsupported',
] as const satisfies readonly MessageType[];

/**
 * The status changes a person can make. Open and pending move freely and can be closed; a closed
 * conversation can only be reopened (or reopens by itself when the contact writes again).
 */
export const CONVERSATION_TRANSITIONS: Readonly<
  Record<ConversationStatus, readonly ConversationStatus[]>
> = Object.freeze({
  open: Object.freeze(['pending', 'closed'] as const),
  pending: Object.freeze(['open', 'closed'] as const),
  closed: Object.freeze(['open'] as const),
});

/** How far an outbound status has come. A status never moves backwards; `failed` is final. */
const STATUS_RANK: Readonly<Record<MessageStatus, number>> = Object.freeze({
  received: 0,
  queued: 1,
  sent: 2,
  delivered: 3,
  read: 4,
  failed: 5,
  // Not a step on the way: no provider report moves it, since none can name it (ADR-0034).
  unknown: 5,
});

export const MAX_TEXT_LENGTH = 4096;
export const MAX_PREVIEW_LENGTH = 120;
export const MAX_DISPLAY_NAME_LENGTH = 128;
export const MAX_TAGS = 20;
export const MAX_ATTACHMENTS = 10;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** A provider id: printable, no spaces, bounded. WhatsApp ids are `wamid.` plus base64. */
const EXTERNAL_ID = /^[A-Za-z0-9._:=+/-]{1,256}$/;
const CLIENT_MESSAGE_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const E164 = /^\+[1-9][0-9]{6,14}$/;
const TAG = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const MIME = /^[a-z]+\/[A-Za-z0-9.+_-]{1,100}(; ?[A-Za-z0-9=._-]{1,60})?$/;

const invalid = (detail: string): never => {
  throw new ConversationError('invalid_request', detail);
};

export const isUuid = (value: unknown): value is string =>
  typeof value === 'string' && UUID.test(value);
export const isConversationId = (value: unknown): value is ConversationId => isUuid(value);
export const isContactId = (value: unknown): value is ContactId => isUuid(value);
export const isConnectionId = (value: unknown): value is ChannelConnectionId => isUuid(value);
export const isExternalId = (value: unknown): value is string =>
  typeof value === 'string' && EXTERNAL_ID.test(value);
export const isClientMessageId = (value: unknown): value is string =>
  typeof value === 'string' && CLIENT_MESSAGE_ID.test(value);
export const isChannelType = (value: unknown): value is ChannelType =>
  typeof value === 'string' && (CHANNEL_TYPES as readonly string[]).includes(value);
export const isConversationStatus = (value: unknown): value is ConversationStatus =>
  typeof value === 'string' && (CONVERSATION_STATUSES as readonly string[]).includes(value);
export const isPriority = (value: unknown): value is ConversationPriority =>
  typeof value === 'string' && (PRIORITIES as readonly string[]).includes(value);
export const isMessageType = (value: unknown): value is MessageType =>
  typeof value === 'string' && (MESSAGE_TYPES as readonly string[]).includes(value);
export const isTag = (value: unknown): value is string =>
  typeof value === 'string' && TAG.test(value);
export const isE164 = (value: unknown): value is string =>
  typeof value === 'string' && E164.test(value);

/**
 * The one identity an address can have in an organization: the same organization, channel and
 * external id always name the same identity, so it is never created twice. Another organization
 * gets another id for the same number.
 */
export function channelIdentityIdFor(
  organizationId: OrganizationId,
  channel: ChannelType,
  externalId: string,
): ChannelIdentityId {
  if (!isUuid(organizationId)) invalid('organizationId');
  if (!isChannelType(channel)) invalid('channel');
  if (!isExternalId(externalId)) invalid('externalId');
  return nameBasedUuid('melonoffice.channel_identity', [
    organizationId,
    channel,
    externalId,
  ]) as ChannelIdentityId;
}

/** The one conversation an identity has on a connection: reopened, never duplicated. */
export function conversationIdFor(
  organizationId: OrganizationId,
  connectionId: ChannelConnectionId,
  channelIdentityId: ChannelIdentityId,
): ConversationId {
  if (!isUuid(organizationId)) invalid('organizationId');
  if (!isConnectionId(connectionId)) invalid('connectionId');
  if (!isUuid(channelIdentityId)) invalid('channelIdentityId');
  return nameBasedUuid('melonoffice.conversation', [
    organizationId,
    connectionId,
    channelIdentityId,
  ]) as ConversationId;
}

/**
 * The id of a message the provider sent us: organization + channel + provider message id. The
 * same delivery, however often the provider retries it, is always the same message.
 */
export function inboundMessageIdFor(
  organizationId: OrganizationId,
  channel: ChannelType,
  externalMessageId: string,
): MessageId {
  if (!isUuid(organizationId)) invalid('organizationId');
  if (!isChannelType(channel)) invalid('channel');
  if (!isExternalId(externalMessageId)) invalid('externalMessageId');
  return nameBasedUuid('melonoffice.message.inbound', [
    organizationId,
    channel,
    externalMessageId,
  ]) as MessageId;
}

/** The id of a message we send: organization + conversation + the sender's own key. */
export function outboundMessageIdFor(
  organizationId: OrganizationId,
  conversationId: ConversationId,
  clientMessageId: string,
): MessageId {
  if (!isUuid(organizationId)) invalid('organizationId');
  if (!isConversationId(conversationId)) invalid('conversationId');
  if (!isClientMessageId(clientMessageId)) invalid('clientMessageId');
  return nameBasedUuid('melonoffice.message.outbound', [
    organizationId,
    conversationId,
    clientMessageId,
  ]) as MessageId;
}

/**
 * The key that finds our own outbound message when the provider reports its status by its own
 * id: organization + channel + provider message id.
 */
export function messageRefKeyFor(
  organizationId: OrganizationId,
  channel: ChannelType,
  externalMessageId: string,
): string {
  return inboundMessageIdFor(organizationId, channel, externalMessageId);
}

/**
 * A message the provider delivered, normalized by a channel adapter: nothing provider-specific.
 * The organization and connection come from the verified channel configuration, never from the
 * payload.
 */
export interface InboundMessage {
  readonly organizationId: OrganizationId;
  readonly connectionId: ChannelConnectionId;
  readonly channel: ChannelType;
  readonly externalMessageId: string;
  readonly from: {
    readonly externalId: string;
    readonly displayName?: string;
    /** E.164, only when the channel vouches for it. */
    readonly phone?: string;
  };
  readonly type: MessageType;
  readonly text?: string;
  readonly attachments: readonly MessageAttachment[];
  readonly replyToExternalId?: string;
  readonly sentAt: IsoTimestamp;
}

/** A provider's report about a message we sent. */
export interface DeliveryStatusUpdate {
  readonly organizationId: OrganizationId;
  readonly connectionId: ChannelConnectionId;
  readonly channel: ChannelType;
  readonly externalMessageId: string;
  readonly status: Extract<MessageStatus, 'sent' | 'delivered' | 'read' | 'failed'>;
  readonly at: IsoTimestamp;
  readonly failureCode?: string;
}

const CODE = /^[a-z0-9][a-z0-9_]{0,63}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
export const isIsoTimestamp = (value: unknown): value is IsoTimestamp =>
  typeof value === 'string' && ISO.test(value) && !Number.isNaN(Date.parse(value));

const bad = (detail: string): never => {
  throw new ConversationError('invalid_inbound', detail);
};

/** Bounded, printable text: control characters other than line breaks and tabs are refused. */
function checkText(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > max) bad(field);
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value as string)) bad(field);
  return value as string;
}

/** Checks a normalized inbound message before anything is stored. */
export function checkInbound(m: InboundMessage): InboundMessage {
  if (!isUuid(m.organizationId)) bad('organizationId');
  if (!isConnectionId(m.connectionId)) bad('connectionId');
  if (!isChannelType(m.channel)) bad('channel');
  if (!isExternalId(m.externalMessageId)) bad('externalMessageId');
  if (!isExternalId(m.from.externalId)) bad('from.externalId');
  if (m.from.displayName !== undefined) {
    checkText(m.from.displayName, MAX_DISPLAY_NAME_LENGTH, 'from.displayName');
  }
  if (m.from.phone !== undefined && !isE164(m.from.phone)) bad('from.phone');
  if (!isMessageType(m.type)) bad('type');
  if (m.text !== undefined) checkText(m.text, MAX_TEXT_LENGTH, 'text');
  if (m.type === 'text' && m.text === undefined) bad('text');
  if (!Array.isArray(m.attachments) || m.attachments.length > MAX_ATTACHMENTS) bad('attachments');
  for (const a of m.attachments) {
    if (!isExternalId(a.providerMediaId)) bad('attachments.providerMediaId');
    if (a.mimeType !== undefined && !MIME.test(a.mimeType)) bad('attachments.mimeType');
  }
  if (m.replyToExternalId !== undefined && !isExternalId(m.replyToExternalId)) {
    bad('replyToExternalId');
  }
  if (!isIsoTimestamp(m.sentAt)) bad('sentAt');
  return m;
}

export function checkStatusUpdate(u: DeliveryStatusUpdate): DeliveryStatusUpdate {
  if (!isUuid(u.organizationId)) bad('organizationId');
  if (!isConnectionId(u.connectionId)) bad('connectionId');
  if (!isChannelType(u.channel)) bad('channel');
  if (!isExternalId(u.externalMessageId)) bad('externalMessageId');
  if (!['sent', 'delivered', 'read', 'failed'].includes(u.status)) bad('status');
  if (!isIsoTimestamp(u.at)) bad('at');
  if (u.failureCode !== undefined && !CODE.test(u.failureCode)) bad('failureCode');
  return u;
}

const previewOf = (m: Pick<Message, 'text'>): string | undefined =>
  m.text === undefined ? undefined : m.text.slice(0, MAX_PREVIEW_LENGTH);

/** The records an inbound message creates or changes. Pure: storage decides what already exists. */
export interface InboundRecords {
  readonly contact: Contact;
  readonly identity: ChannelIdentity;
  readonly conversation: Conversation;
  readonly message: Message;
}

/**
 * What storing an inbound message means, given what already exists. A new address creates its
 * contact and identity; an existing one is reused as is (a new profile name never renames a
 * contact a person may have named). The conversation is created, or updated and reopened when
 * closed.
 */
export function applyInbound(
  inbound: InboundMessage,
  existing: {
    readonly identity?: ChannelIdentity;
    readonly contact?: Contact;
    readonly conversation?: Conversation;
  },
  newContactId: ContactId,
  at: Date,
): InboundRecords {
  const m = checkInbound(inbound);
  const now = at.toISOString() as IsoTimestamp;
  const identityId = channelIdentityIdFor(m.organizationId, m.channel, m.from.externalId);
  const contact: Contact =
    existing.identity !== undefined && existing.contact !== undefined
      ? existing.contact
      : Object.freeze({
          id: newContactId,
          organizationId: m.organizationId,
          ...(m.from.displayName === undefined ? {} : { displayName: m.from.displayName }),
          ...(m.from.phone === undefined ? {} : { phone: m.from.phone }),
          status: 'active',
          origin: Object.freeze({
            kind: 'channel',
            channel: m.channel,
            connectionId: m.connectionId,
          }),
          createdAt: now,
          updatedAt: now,
        });
  const identity: ChannelIdentity =
    existing.identity ??
    Object.freeze({
      id: identityId,
      organizationId: m.organizationId,
      contactId: contact.id,
      channel: m.channel,
      externalId: m.from.externalId,
      ...(m.from.displayName === undefined ? {} : { displayName: m.from.displayName }),
      verification: 'provider',
      createdAt: now,
      updatedAt: now,
    });
  const conversationId = conversationIdFor(m.organizationId, m.connectionId, identity.id);
  const messageId = inboundMessageIdFor(m.organizationId, m.channel, m.externalMessageId);
  const message: Message = Object.freeze({
    id: messageId,
    organizationId: m.organizationId,
    conversationId,
    channel: m.channel,
    connectionId: m.connectionId,
    direction: 'inbound',
    externalMessageId: m.externalMessageId,
    sender: Object.freeze({ kind: 'contact', channelIdentityId: identity.id }),
    type: m.type,
    ...(m.text === undefined ? {} : { text: m.text }),
    attachments: Object.freeze(m.attachments.map((a) => Object.freeze({ ...a }))),
    ...(m.replyToExternalId === undefined ? {} : { replyToExternalId: m.replyToExternalId }),
    status: 'received',
    sentAt: m.sentAt,
    createdAt: now,
  });
  const preview = previewOf(message);
  const lastMessage = Object.freeze({
    id: message.id,
    direction: message.direction,
    type: message.type,
    ...(preview === undefined ? {} : { preview }),
    at: message.sentAt,
  });
  const current = existing.conversation;
  // An older message delivered late never replaces a newer one as the latest.
  const isLatest = current === undefined || message.sentAt >= current.lastMessageAt;
  const conversation: Conversation =
    current === undefined
      ? Object.freeze({
          id: conversationId,
          organizationId: m.organizationId,
          contactId: contact.id,
          channelIdentityId: identity.id,
          channel: m.channel,
          connectionId: m.connectionId,
          status: 'open',
          priority: 'normal',
          tags: Object.freeze([]),
          lastMessage,
          lastMessageAt: message.sentAt,
          lastInboundAt: message.sentAt,
          createdAt: now,
          updatedAt: now,
          revision: 1,
        })
      : Object.freeze({
          ...current,
          // The contact writing again reopens a closed conversation.
          status: current.status === 'closed' ? 'open' : current.status,
          ...(isLatest ? { lastMessage, lastMessageAt: message.sentAt } : {}),
          lastInboundAt:
            current.lastInboundAt === undefined || message.sentAt > current.lastInboundAt
              ? message.sentAt
              : current.lastInboundAt,
          updatedAt: now,
          revision: current.revision + 1,
        });
  return { contact, identity, conversation, message };
}

/**
 * The next state of an outbound message given a provider's status report, or `undefined` when
 * the report changes nothing: an older status, a repeat, or anything after a failure.
 */
export function applyStatus(message: Message, update: DeliveryStatusUpdate): Message | undefined {
  if (message.direction !== 'outbound') return undefined;
  const from = STATUS_RANK[message.status];
  const to = STATUS_RANK[update.status];
  if (message.status === 'failed' || message.status === 'unknown' || to <= from) return undefined;
  return Object.freeze({
    ...message,
    status: update.status,
    ...(update.status === 'delivered' || update.status === 'read'
      ? { deliveredAt: message.deliveredAt ?? update.at }
      : {}),
    ...(update.status === 'read' ? { readAt: update.at } : {}),
    ...(update.status === 'failed'
      ? { failureCode: update.failureCode ?? 'provider_failure' }
      : {}),
  });
}

/** Tags as stored: validated, unique and sorted. */
export function normalizeTags(tags: readonly unknown[]): readonly string[] {
  if (!tags.every(isTag)) invalid('tags');
  const unique = [...new Set(tags as string[])].sort();
  if (unique.length > MAX_TAGS) invalid('tags.max');
  return Object.freeze(unique);
}

/** Checks a conversation read back from storage; bad data is refused, never passed on. */
export function checkStoredConversation(c: Conversation): Conversation {
  if (
    !isConversationId(c.id) ||
    !isUuid(c.organizationId) ||
    !isChannelType(c.channel) ||
    !isConversationStatus(c.status) ||
    !isPriority(c.priority) ||
    !Array.isArray(c.tags) ||
    !c.tags.every(isTag) ||
    !Number.isSafeInteger(c.revision) ||
    c.revision < 1 ||
    (c.control !== undefined && !isValidControl(c.control)) ||
    (c.handoff !== undefined && !isHandoffReason(c.handoff.reason))
  ) {
    throw new ConversationError('invalid_request', 'stored_conversation');
  }
  return c;
}

/** Sorts newest activity first, by the time of the last message then the id (stable). */
export const byLatestActivity = (a: Conversation, b: Conversation): number =>
  a.lastMessageAt < b.lastMessageAt
    ? 1
    : a.lastMessageAt > b.lastMessageAt
      ? -1
      : a.id < b.id
        ? -1
        : 1;

/** Oldest first: the order a conversation is read in. */
export const byConversationOrder = (a: Message, b: Message): number =>
  a.sentAt < b.sentAt
    ? -1
    : a.sentAt > b.sentAt
      ? 1
      : a.createdAt < b.createdAt
        ? -1
        : a.id < b.id
          ? -1
          : 1;

// Outbound (CV-2, ADR-0034) ----------------------------------------------------------------------

/** What a person asks to send: text only. The organization and sender come from the tenant. */
export interface OutboundRequest {
  readonly organizationId: OrganizationId;
  readonly conversation: Conversation;
  readonly userId: UserId;
  /** The sender's own key: the same key is the same message, however often it is sent. */
  readonly clientMessageId: string;
  readonly text: string;
}

/**
 * The outbound message a person's send reserves before anything leaves MelonOffice: `queued`,
 * with an id derived from the organization, the conversation and the sender's key, so a repeat
 * finds it instead of creating a second one.
 */
export function newOutboundMessage(request: OutboundRequest, at: Date): Message {
  const { organizationId, conversation, userId, clientMessageId, text } = request;
  if (conversation.organizationId !== organizationId) invalid('conversation');
  if (typeof text !== 'string' || text.trim().length === 0) invalid('text');
  if (text.length > MAX_TEXT_LENGTH) invalid('text.max');
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) invalid('text.control');
  const now = at.toISOString() as IsoTimestamp;
  return Object.freeze({
    id: outboundMessageIdFor(organizationId, conversation.id, clientMessageId),
    organizationId,
    conversationId: conversation.id,
    channel: conversation.channel,
    connectionId: conversation.connectionId,
    direction: 'outbound',
    clientMessageId,
    sender: Object.freeze({ kind: 'user', userId }),
    type: 'text',
    text,
    attachments: Object.freeze([]),
    status: 'queued',
    sentAt: now,
    createdAt: now,
  });
}

/** How a reserved outbound message ended: sent, refused, or not known. */
export type OutboundSettlement =
  | { readonly status: 'sent'; readonly externalMessageId: string }
  | { readonly status: 'failed'; readonly failureCode: string }
  | { readonly status: 'unknown'; readonly failureCode: string };

const FAILURE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

/**
 * The next state of a reserved message, or `undefined` when it was already settled: only a
 * `queued` message settles, once. A second settlement, whatever it says, changes nothing.
 */
export function settleOutbound(
  message: Message,
  settlement: OutboundSettlement,
): Message | undefined {
  if (message.direction !== 'outbound' || message.status !== 'queued') return undefined;
  if (settlement.status === 'sent') {
    if (!isExternalId(settlement.externalMessageId)) invalid('externalMessageId');
    return Object.freeze({
      ...message,
      status: 'sent',
      externalMessageId: settlement.externalMessageId,
    });
  }
  if (!FAILURE_CODE.test(settlement.failureCode)) invalid('failureCode');
  return Object.freeze({
    ...message,
    status: settlement.status,
    failureCode: settlement.failureCode,
  });
}

/** The conversation after one of its outbound messages was sent: last message and activity. */
export function applyOutbound(
  conversation: Conversation,
  message: Message,
  at: Date,
): Conversation {
  if (message.conversationId !== conversation.id || message.status !== 'sent') {
    invalid('outbound');
  }
  const now = at.toISOString() as IsoTimestamp;
  const isLatest = message.sentAt >= conversation.lastMessageAt;
  const preview = previewOf(message);
  return Object.freeze({
    ...conversation,
    ...(isLatest
      ? {
          lastMessage: Object.freeze({
            id: message.id,
            direction: 'outbound' as const,
            type: message.type,
            ...(preview === undefined ? {} : { preview }),
            at: message.sentAt,
          }),
          lastMessageAt: message.sentAt,
        }
      : {}),
    lastOutboundAt:
      conversation.lastOutboundAt === undefined || message.sentAt > conversation.lastOutboundAt
        ? message.sentAt
        : conversation.lastOutboundAt,
    updatedAt: now,
    revision: conversation.revision + 1,
  });
}

/** How the inbox list is ordered (CV-3). Every order breaks ties by the latest activity. */
export const CONVERSATION_SORTS = ['last_activity', 'created', 'priority'] as const;
export type ConversationSort = (typeof CONVERSATION_SORTS)[number];
export const isConversationSort = (value: unknown): value is ConversationSort =>
  typeof value === 'string' && (CONVERSATION_SORTS as readonly string[]).includes(value);

/** Most urgent first. */
const PRIORITY_RANK: Readonly<Record<ConversationPriority, number>> = Object.freeze({
  urgent: 0,
  high: 1,
  normal: 2,
  low: 3,
});

export function conversationOrder(
  sort: ConversationSort,
): (a: Conversation, b: Conversation) => number {
  switch (sort) {
    case 'created':
      return (a, b) =>
        a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : byLatestActivity(a, b);
    case 'priority':
      return (a, b) =>
        PRIORITY_RANK[a.priority] - PRIORITY_RANK[b.priority] || byLatestActivity(a, b);
    case 'last_activity':
      return byLatestActivity;
  }
}

export const MIN_SEARCH_LENGTH = 2;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
export const MAX_SEARCH_LENGTH = 100;

/** Lower case, without accents or repeated spaces: "José  Pérez" and "jose perez" match. */
export const foldText = (value: string): string =>
  value.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();

const digitsOf = (value: string): string => value.replace(/[^0-9]/g, '');

/**
 * A search of the inbox (CV-3): a trimmed text of 2 to 100 printable characters. Invalid is
 * refused, never ignored.
 */
export function checkSearch(value: unknown): string {
  if (typeof value !== 'string') return invalid('q');
  const folded = foldText(value);
  if (
    folded.length < MIN_SEARCH_LENGTH ||
    folded.length > MAX_SEARCH_LENGTH ||
    CONTROL.test(value)
  ) {
    return invalid('q');
  }
  return folded;
}

/**
 * Whether a contact matches a search: its name, email or phone, or one of its channel
 * identities (the provider's address and name). A phone matches by its digits, however it is
 * typed ("+1 555-123" finds "+1555123…"). Message text is not searched: see ADR-0035.
 */
export function contactMatches(
  folded: string,
  contact: Pick<Contact, 'displayName' | 'phone' | 'email'> | undefined,
  identities: readonly Pick<ChannelIdentity, 'externalId' | 'displayName'>[],
): boolean {
  const texts = [
    contact?.displayName,
    contact?.email,
    ...identities.map((i) => i.displayName),
  ].filter((t): t is string => t !== undefined);
  if (texts.some((t) => foldText(t).includes(folded))) return true;
  const digits = digitsOf(folded);
  if (
    digits.length < MIN_SEARCH_LENGTH ||
    digits.length !== folded.replace(/[\s+().-]/g, '').length
  ) {
    return false;
  }
  return [contact?.phone, ...identities.map((i) => i.externalId)]
    .filter((t): t is string => t !== undefined)
    .some((t) => digitsOf(t).includes(digits));
}
