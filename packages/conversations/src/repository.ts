import type { AuditEvent, InMemoryAuditStore } from '@melonoffice/audit';
import type {
  ChannelIdentity,
  ChannelIdentityId,
  Contact,
  ContactId,
  Conversation,
  ConversationId,
  Message,
  MessageId,
  OrganizationId,
} from '@melonoffice/domain';
import { ConversationError } from './errors.js';
import {
  applyInbound,
  applyOutbound,
  applyStatus,
  byConversationOrder,
  byLatestActivity,
  channelIdentityIdFor,
  checkInbound,
  checkStatusUpdate,
  checkStoredConversation,
  conversationIdFor,
  inboundMessageIdFor,
  messageRefKeyFor,
  settleOutbound,
  type DeliveryStatusUpdate,
  type InboundMessage,
  type InboundRecords,
  type OutboundSettlement,
} from './model.js';

/** What storing one inbound message did. A repeat of an already stored message changes nothing. */
export interface ReceiveResult {
  readonly duplicate: boolean;
  readonly message: Message;
  readonly conversation: Conversation;
  /** A new contact and identity were created for an address seen for the first time. */
  readonly newContact: boolean;
}

/** What reserving an outbound message did: stored it now, or found it already there. */
export interface ReserveResult {
  readonly created: boolean;
  readonly message: Message;
}

/** What settling an outbound message did. Only a `queued` message settles, once. */
export interface SettleResult {
  readonly applied: boolean;
  /** The message as it is now; absent when it does not exist in the organization. */
  readonly message?: Message;
}

/** The new state of a conversation and the audit events that record the change. */
export interface ConversationWrite {
  readonly conversation: Conversation;
  readonly events: readonly AuditEvent[];
}

/**
 * Where conversations live: Firestore in the API (ADR-0033), memory in tests. Every read takes
 * the organization and answers only with its records: another organization's are absent.
 */
export interface ConversationRepository {
  /**
   * Stores an inbound message and everything it implies (contact, identity, conversation) in one
   * transaction. Idempotent on organization + channel + provider message id: however often the
   * provider delivers it, one message exists.
   */
  receive(inbound: InboundMessage, newContactId: ContactId, at: Date): Promise<ReceiveResult>;
  /**
   * Applies a provider's delivery report to the outbound message it names. Unknown messages and
   * reports that would move a status backwards change nothing (`applied: false`).
   */
  applyStatus(update: DeliveryStatusUpdate): Promise<{ readonly applied: boolean }>;
  findConversation(
    organizationId: OrganizationId,
    id: ConversationId,
  ): Promise<Conversation | undefined>;
  /** The organization's conversations, newest activity first. Filters are the caller's. */
  listConversations(organizationId: OrganizationId): Promise<readonly Conversation[]>;
  /** A conversation's messages, oldest first. Empty for another organization's conversation. */
  listMessages(
    organizationId: OrganizationId,
    conversationId: ConversationId,
  ): Promise<readonly Message[]>;
  /**
   * Reads the current conversation and lets `change` decide the next one, in one transaction. It
   * must be exactly one revision ahead. Absent, or another organization's: `conversation_not_found`.
   */
  updateConversation(
    organizationId: OrganizationId,
    id: ConversationId,
    change: (current: Conversation) => ConversationWrite,
  ): Promise<Conversation>;
  findContact(organizationId: OrganizationId, id: ContactId): Promise<Contact | undefined>;
  listContacts(organizationId: OrganizationId): Promise<readonly Contact[]>;
  /** A contact's channel identities. Empty for another organization's contact. */
  listIdentities(
    organizationId: OrganizationId,
    contactId: ContactId,
  ): Promise<readonly ChannelIdentity[]>;
  /** One identity, or undefined when it is absent or another organization's. */
  findIdentity(
    organizationId: OrganizationId,
    id: ChannelIdentityId,
  ): Promise<ChannelIdentity | undefined>;
  /** One message, or undefined when it is absent or another organization's. */
  findMessage(organizationId: OrganizationId, id: MessageId): Promise<Message | undefined>;
  /**
   * Stores a person's `queued` outbound message before anything is sent (ADR-0034), if its id is
   * not stored yet; otherwise returns the stored one unchanged. The conversation must exist in
   * the message's organization (`conversation_not_found`).
   */
  reserveOutbound(message: Message): Promise<ReserveResult>;
  /**
   * Settles a `queued` outbound message, with its audit events, in one transaction. `sent` also
   * records the provider's id (for delivery reports) and the conversation's last outbound
   * activity. A message that is not `queued` changes nothing, and its events are not recorded.
   */
  settleOutbound(
    organizationId: OrganizationId,
    id: MessageId,
    settlement: OutboundSettlement,
    events: readonly AuditEvent[],
    at: Date,
  ): Promise<SettleResult>;
}

export function checkNextConversation(current: Conversation, next: Conversation): void {
  if (
    next.id !== current.id ||
    next.organizationId !== current.organizationId ||
    next.contactId !== current.contactId ||
    next.channelIdentityId !== current.channelIdentityId ||
    next.connectionId !== current.connectionId ||
    next.channel !== current.channel ||
    next.revision !== current.revision + 1
  ) {
    throw new ConversationError('conversation_concurrency_conflict');
  }
  checkStoredConversation(next);
}

/** For tests and local runs only. */
export class InMemoryConversationRepository implements ConversationRepository {
  readonly #contacts = new Map<string, Contact>();
  readonly #identities = new Map<string, ChannelIdentity>();
  readonly #conversations = new Map<string, Conversation>();
  readonly #messages = new Map<string, Message>();
  /** Provider message id key → our outbound message id. */
  readonly #refs = new Map<string, MessageId>();

  constructor(private readonly audit?: InMemoryAuditStore) {}

  async receive(
    inbound: InboundMessage,
    newContactId: ContactId,
    at: Date,
  ): Promise<ReceiveResult> {
    const m = checkInbound(inbound);
    const messageId = inboundMessageIdFor(m.organizationId, m.channel, m.externalMessageId);
    const stored = this.#messages.get(messageId);
    if (stored !== undefined) {
      const conversation = this.#conversations.get(stored.conversationId) as Conversation;
      return { duplicate: true, message: stored, conversation, newContact: false };
    }
    const identity = this.#identities.get(
      channelIdentityIdFor(m.organizationId, m.channel, m.from.externalId),
    );
    const contact = identity === undefined ? undefined : this.#contacts.get(identity.contactId);
    const conversation =
      identity === undefined
        ? undefined
        : this.#conversations.get(conversationIdFor(m.organizationId, m.connectionId, identity.id));
    const records: InboundRecords = applyInbound(
      m,
      {
        ...(identity === undefined ? {} : { identity }),
        ...(contact === undefined ? {} : { contact }),
        ...(conversation === undefined ? {} : { conversation }),
      },
      newContactId,
      at,
    );
    this.#contacts.set(records.contact.id, records.contact);
    this.#identities.set(records.identity.id, records.identity);
    this.#conversations.set(records.conversation.id, records.conversation);
    this.#messages.set(records.message.id, records.message);
    return {
      duplicate: false,
      message: records.message,
      conversation: records.conversation,
      newContact: identity === undefined,
    };
  }

  async applyStatus(update: DeliveryStatusUpdate): Promise<{ readonly applied: boolean }> {
    const u = checkStatusUpdate(update);
    const id = this.#refs.get(messageRefKeyFor(u.organizationId, u.channel, u.externalMessageId));
    const message = id === undefined ? undefined : this.#messages.get(id);
    if (message === undefined || message.organizationId !== u.organizationId) {
      return { applied: false };
    }
    const next = applyStatus(message, u);
    if (next === undefined) return { applied: false };
    this.#messages.set(next.id, next);
    return { applied: true };
  }

  async findConversation(
    organizationId: OrganizationId,
    id: ConversationId,
  ): Promise<Conversation | undefined> {
    const c = this.#conversations.get(id);
    return c?.organizationId === organizationId ? checkStoredConversation(c) : undefined;
  }

  async listConversations(organizationId: OrganizationId): Promise<readonly Conversation[]> {
    return [...this.#conversations.values()]
      .filter((c) => c.organizationId === organizationId)
      .map(checkStoredConversation)
      .sort(byLatestActivity);
  }

  async listMessages(
    organizationId: OrganizationId,
    conversationId: ConversationId,
  ): Promise<readonly Message[]> {
    return [...this.#messages.values()]
      .filter((m) => m.organizationId === organizationId && m.conversationId === conversationId)
      .sort(byConversationOrder);
  }

  async updateConversation(
    organizationId: OrganizationId,
    id: ConversationId,
    change: (current: Conversation) => ConversationWrite,
  ): Promise<Conversation> {
    const current = await this.findConversation(organizationId, id);
    if (current === undefined) throw new ConversationError('conversation_not_found');
    const { conversation, events } = change(current);
    checkNextConversation(current, conversation);
    this.audit?.append(events);
    this.#conversations.set(id, conversation);
    return conversation;
  }

  async findContact(organizationId: OrganizationId, id: ContactId): Promise<Contact | undefined> {
    const c = this.#contacts.get(id);
    return c?.organizationId === organizationId ? c : undefined;
  }

  async listContacts(organizationId: OrganizationId): Promise<readonly Contact[]> {
    return [...this.#contacts.values()]
      .filter((c) => c.organizationId === organizationId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  async listIdentities(
    organizationId: OrganizationId,
    contactId: ContactId,
  ): Promise<readonly ChannelIdentity[]> {
    return [...this.#identities.values()].filter(
      (i) => i.organizationId === organizationId && i.contactId === contactId,
    );
  }

  async findIdentity(
    organizationId: OrganizationId,
    id: ChannelIdentityId,
  ): Promise<ChannelIdentity | undefined> {
    const i = this.#identities.get(id);
    return i?.organizationId === organizationId ? i : undefined;
  }

  async findMessage(organizationId: OrganizationId, id: MessageId): Promise<Message | undefined> {
    const m = this.#messages.get(id);
    return m?.organizationId === organizationId ? m : undefined;
  }

  async reserveOutbound(message: Message): Promise<ReserveResult> {
    const conversation = await this.findConversation(
      message.organizationId,
      message.conversationId,
    );
    if (conversation === undefined) throw new ConversationError('conversation_not_found');
    const stored = this.#messages.get(message.id);
    if (stored !== undefined) {
      if (stored.organizationId !== message.organizationId) throw new Error('message id collision');
      return { created: false, message: stored };
    }
    if (message.direction !== 'outbound' || message.status !== 'queued') {
      throw new ConversationError('invalid_request', 'outbound');
    }
    this.#messages.set(message.id, message);
    return { created: true, message };
  }

  async settleOutbound(
    organizationId: OrganizationId,
    id: MessageId,
    settlement: OutboundSettlement,
    events: readonly AuditEvent[],
    at: Date,
  ): Promise<SettleResult> {
    const message = await this.findMessage(organizationId, id);
    if (message === undefined) return { applied: false };
    const next = settleOutbound(message, settlement);
    if (next === undefined) return { applied: false, message };
    if (next.status === 'sent' && next.externalMessageId !== undefined) {
      // A provider id names one message: a second one under it is refused, as in Firestore.
      if (this.#refs.has(messageRefKeyFor(organizationId, next.channel, next.externalMessageId))) {
        throw new Error('message reference collision');
      }
      const conversation = await this.findConversation(organizationId, next.conversationId);
      if (conversation === undefined) throw new ConversationError('conversation_not_found');
      const updated = applyOutbound(conversation, next, at);
      checkNextConversation(conversation, updated);
      this.#conversations.set(updated.id, updated);
    }
    this.audit?.append(events);
    this.putOutbound(next);
    return { applied: true, message: next };
  }

  /** Test helper: stores an outbound message as a sender would, with its provider id. */
  putOutbound(message: Message): void {
    this.#messages.set(message.id, message);
    if (message.externalMessageId !== undefined) {
      this.#refs.set(
        messageRefKeyFor(message.organizationId, message.channel, message.externalMessageId),
        message.id,
      );
    }
  }
}
