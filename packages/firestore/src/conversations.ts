import type {
  Firestore,
  Timestamp as FirestoreTimestamp,
  Transaction,
} from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import type { AuditEvent } from '@melonoffice/audit';
import {
  applyInbound,
  applyOutbound,
  applyStatus,
  byConversationOrder,
  byLatestActivity,
  channelIdentityIdFor,
  checkInbound,
  checkNextConversation,
  checkNextSettings,
  checkStatusUpdate,
  checkStoredSettings,
  checkStoredConversation,
  conversationIdFor,
  ConversationError,
  inboundMessageIdFor,
  isContactId,
  isConversationId,
  isUuid,
  messageRefKeyFor,
  settleOutbound,
  type ConversationRepository,
  type ConversationWrite,
  type DeliveryStatusUpdate,
  type InboundMessage,
  type OutboundSettlement,
  type ReceiveResult,
  type ReserveResult,
  type SettingsWrite,
  type SettleResult,
} from '@melonoffice/conversations';
import type {
  ChannelIdentity,
  ChannelIdentityId,
  Contact,
  ContactId,
  Conversation,
  ConversationId,
  ConversationSettings,
  IsoTimestamp,
  Message,
  MessageId,
  OrganizationId,
} from '@melonoffice/domain';
import { isOrganizationId } from '@melonoffice/tenancy';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';

/**
 * The conversations domain in Firestore (ADR-0033). Every document carries `organizationId`,
 * which every read checks; ids that must never be duplicated are derived, not random:
 *
 * - `contacts/{contactId}`: a contact.
 * - `channelIdentities/{id}`: one address; id from organization + channel + external id.
 * - `conversations/{id}`: one per identity and connection; id from those three.
 * - `messages/{id}`: inbound id from organization + channel + provider message id, so a
 *   repeated webhook finds the message already there and stores nothing.
 * - `messageRefs/{key}`: provider message id → our outbound message, for delivery reports.
 * - `conversationSettings/{organizationId}`: how far AI may act (CV-6A).
 *
 * Lists use the automatic single-field index on `organizationId` (or `conversationId`) and sort
 * here, like the rest of the repository: no composite index is needed.
 */
export const CONTACTS = 'contacts';
export const CHANNEL_IDENTITIES = 'channelIdentities';
export const CONVERSATIONS = 'conversations';
export const MESSAGES = 'messages';
export const MESSAGE_REFS = 'messageRefs';
/** `conversationSettings/{organizationId}`: one per organization (CV-6A, ADR-0039). */
export const CONVERSATION_SETTINGS = 'conversationSettings';

const ts = (value: IsoTimestamp): FirestoreTimestamp => Timestamp.fromDate(new Date(value));
const iso = (value: FirestoreTimestamp): IsoTimestamp =>
  value.toDate().toISOString() as IsoTimestamp;
const tsOrNull = (value: IsoTimestamp | undefined) => (value === undefined ? null : ts(value));
const isoOrAbsent = <K extends string>(key: K, value: FirestoreTimestamp | null | undefined) =>
  (value == null ? {} : { [key]: iso(value) }) as Partial<Record<K, IsoTimestamp>>;
const orAbsent = <K extends string, V>(key: K, value: V | null | undefined) =>
  (value == null ? {} : { [key]: value }) as Partial<Record<K, V>>;

type Doc = Record<string, unknown>;

// Contacts ------------------------------------------------------------------------------------

export function toContactDocument(c: Contact): Doc {
  return {
    organizationId: c.organizationId,
    displayName: c.displayName ?? null,
    phone: c.phone ?? null,
    email: c.email ?? null,
    status: c.status,
    origin: { ...c.origin },
    createdAt: ts(c.createdAt),
    updatedAt: ts(c.updatedAt),
  };
}

function toContact(id: string, d: Doc): Contact {
  return Object.freeze({
    id: id as ContactId,
    organizationId: d.organizationId as OrganizationId,
    ...orAbsent('displayName', d.displayName as string | null),
    ...orAbsent('phone', d.phone as string | null),
    ...orAbsent('email', d.email as string | null),
    status: d.status as Contact['status'],
    origin: Object.freeze({ ...(d.origin as Contact['origin']) }),
    createdAt: iso(d.createdAt as FirestoreTimestamp),
    updatedAt: iso(d.updatedAt as FirestoreTimestamp),
  });
}

// Identities ----------------------------------------------------------------------------------

export function toIdentityDocument(i: ChannelIdentity): Doc {
  return {
    organizationId: i.organizationId,
    contactId: i.contactId,
    channel: i.channel,
    externalId: i.externalId,
    displayName: i.displayName ?? null,
    verification: i.verification,
    createdAt: ts(i.createdAt),
    updatedAt: ts(i.updatedAt),
  };
}

function toIdentity(id: string, d: Doc): ChannelIdentity {
  return Object.freeze({
    id: id as ChannelIdentity['id'],
    organizationId: d.organizationId as OrganizationId,
    contactId: d.contactId as ContactId,
    channel: d.channel as ChannelIdentity['channel'],
    externalId: d.externalId as string,
    ...orAbsent('displayName', d.displayName as string | null),
    verification: d.verification as ChannelIdentity['verification'],
    createdAt: iso(d.createdAt as FirestoreTimestamp),
    updatedAt: iso(d.updatedAt as FirestoreTimestamp),
  });
}

// Conversations -------------------------------------------------------------------------------

export function toConversationDocument(c: Conversation): Doc {
  return {
    organizationId: c.organizationId,
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
            at: ts(c.lastMessage.at),
          },
    lastMessageAt: ts(c.lastMessageAt),
    lastInboundAt: tsOrNull(c.lastInboundAt),
    lastOutboundAt: tsOrNull(c.lastOutboundAt),
    handoff:
      c.handoff === undefined
        ? null
        : {
            reason: c.handoff.reason,
            requestedAt: ts(c.handoff.requestedAt),
            summary: c.handoff.summary ?? null,
            executionId: c.handoff.executionId ?? null,
          },
    control:
      c.control === undefined
        ? null
        : {
            handledBy: c.control.handledBy,
            aiState: c.control.aiState,
            epoch: c.control.epoch,
            changedAt: ts(c.control.changedAt),
            changedBy: c.control.changedBy ?? null,
          },
    createdAt: ts(c.createdAt),
    updatedAt: ts(c.updatedAt),
    revision: c.revision,
  };
}

function toConversation(id: string, d: Doc): Conversation {
  const last = d.lastMessage as Doc | null;
  const handoff = d.handoff as Doc | null;
  // Absent in records written before CV-6A: a person handles them.
  const control = d.control as Doc | null | undefined;
  const conversation = {
    id,
    organizationId: d.organizationId,
    contactId: d.contactId,
    channelIdentityId: d.channelIdentityId,
    channel: d.channel,
    connectionId: d.connectionId,
    status: d.status,
    ...orAbsent('assigneeId', d.assigneeId),
    ...orAbsent('departmentId', d.departmentId),
    priority: d.priority,
    tags: Object.freeze([...((d.tags as string[] | undefined) ?? [])]),
    ...(last == null
      ? {}
      : {
          lastMessage: Object.freeze({
            id: last.id,
            direction: last.direction,
            type: last.type,
            ...orAbsent('preview', last.preview),
            at: iso(last.at as FirestoreTimestamp),
          }),
        }),
    lastMessageAt: iso(d.lastMessageAt as FirestoreTimestamp),
    ...isoOrAbsent('lastInboundAt', d.lastInboundAt as FirestoreTimestamp | null),
    ...isoOrAbsent('lastOutboundAt', d.lastOutboundAt as FirestoreTimestamp | null),
    ...(handoff == null
      ? {}
      : {
          handoff: Object.freeze({
            reason: handoff.reason,
            requestedAt: iso(handoff.requestedAt as FirestoreTimestamp),
            ...orAbsent('summary', handoff.summary),
            ...orAbsent('executionId', handoff.executionId),
          }),
        }),
    ...(control == null
      ? {}
      : {
          control: Object.freeze({
            handledBy: control.handledBy,
            aiState: control.aiState,
            epoch: control.epoch,
            changedAt: iso(control.changedAt as FirestoreTimestamp),
            ...orAbsent('changedBy', control.changedBy),
          }),
        }),
    createdAt: iso(d.createdAt as FirestoreTimestamp),
    updatedAt: iso(d.updatedAt as FirestoreTimestamp),
    revision: d.revision,
  } as unknown as Conversation;
  try {
    return Object.freeze(checkStoredConversation(conversation));
  } catch {
    throw new Error('invalid conversation record');
  }
}

// Settings (CV-6A) ----------------------------------------------------------------------------

function toSettingsDocument(s: ConversationSettings): Doc {
  return {
    organizationId: s.organizationId,
    autonomy: s.autonomy,
    agentId: s.agentId ?? null,
    updatedAt: ts(s.updatedAt),
    updatedBy: s.updatedBy ?? null,
    revision: s.revision,
  };
}

function toSettings(d: Doc): ConversationSettings {
  const settings = {
    organizationId: d.organizationId,
    autonomy: d.autonomy,
    ...orAbsent('agentId', d.agentId as string | null | undefined),
    updatedAt: iso(d.updatedAt as FirestoreTimestamp),
    ...orAbsent('updatedBy', d.updatedBy),
    revision: d.revision,
  } as unknown as ConversationSettings;
  try {
    return Object.freeze(checkStoredSettings(settings));
  } catch {
    throw new Error('invalid conversation settings record');
  }
}

// Messages ------------------------------------------------------------------------------------

export function toMessageDocument(m: Message): Doc {
  return {
    organizationId: m.organizationId,
    conversationId: m.conversationId,
    channel: m.channel,
    connectionId: m.connectionId,
    direction: m.direction,
    externalMessageId: m.externalMessageId ?? null,
    clientMessageId: m.clientMessageId ?? null,
    sender: { ...m.sender },
    type: m.type,
    text: m.text ?? null,
    attachments: m.attachments.map((a) => ({
      providerMediaId: a.providerMediaId,
      mimeType: a.mimeType ?? null,
    })),
    replyToExternalId: m.replyToExternalId ?? null,
    status: m.status,
    failureCode: m.failureCode ?? null,
    sentAt: ts(m.sentAt),
    createdAt: ts(m.createdAt),
    deliveredAt: tsOrNull(m.deliveredAt),
    readAt: tsOrNull(m.readAt),
  };
}

function toMessage(id: string, d: Doc): Message {
  return Object.freeze({
    id: id as MessageId,
    organizationId: d.organizationId as OrganizationId,
    conversationId: d.conversationId as ConversationId,
    channel: d.channel as Message['channel'],
    connectionId: d.connectionId as Message['connectionId'],
    direction: d.direction as Message['direction'],
    ...orAbsent('externalMessageId', d.externalMessageId as string | null),
    ...orAbsent('clientMessageId', d.clientMessageId as string | null),
    sender: Object.freeze({ ...(d.sender as Message['sender']) }),
    type: d.type as Message['type'],
    ...orAbsent('text', d.text as string | null),
    attachments: Object.freeze(
      ((d.attachments as Doc[] | undefined) ?? []).map((a) =>
        Object.freeze({
          providerMediaId: a.providerMediaId as string,
          ...orAbsent('mimeType', a.mimeType as string | null),
        }),
      ),
    ),
    ...orAbsent('replyToExternalId', d.replyToExternalId as string | null),
    status: d.status as Message['status'],
    ...orAbsent('failureCode', d.failureCode as string | null),
    sentAt: iso(d.sentAt as FirestoreTimestamp),
    createdAt: iso(d.createdAt as FirestoreTimestamp),
    ...isoOrAbsent('deliveredAt', d.deliveredAt as FirestoreTimestamp | null),
    ...isoOrAbsent('readAt', d.readAt as FirestoreTimestamp | null),
  });
}

/** Conversations in Firestore. Each write is one transaction with its audit events. */
export class FirestoreConversationRepository implements ConversationRepository {
  constructor(private readonly db: Firestore) {}

  async receive(
    inbound: InboundMessage,
    newContactId: ContactId,
    at: Date,
  ): Promise<ReceiveResult> {
    const m = checkInbound(inbound);
    const messageDoc = this.db
      .collection(MESSAGES)
      .doc(inboundMessageIdFor(m.organizationId, m.channel, m.externalMessageId));
    const identityDoc = this.db
      .collection(CHANNEL_IDENTITIES)
      .doc(channelIdentityIdFor(m.organizationId, m.channel, m.from.externalId));
    // Everything is read and written in one transaction: two deliveries of the same message, or
    // two first messages of the same new contact, can never both create records.
    return this.db.runTransaction(async (t) => {
      const storedMessage = await t.get(messageDoc);
      if (storedMessage.exists) {
        const message = toMessage(storedMessage.id, storedMessage.data() as Doc);
        if (message.organizationId !== m.organizationId) throw new Error('message id collision');
        const conversation = await t.get(
          this.db.collection(CONVERSATIONS).doc(message.conversationId),
        );
        return {
          duplicate: true,
          message,
          conversation: toConversation(conversation.id, conversation.data() as Doc),
          newContact: false,
          newConversation: false,
        };
      }
      const identitySnapshot = await t.get(identityDoc);
      const identity = identitySnapshot.exists
        ? toIdentity(identitySnapshot.id, identitySnapshot.data() as Doc)
        : undefined;
      let contact: Contact | undefined;
      let conversation: Conversation | undefined;
      if (identity !== undefined) {
        const contactSnapshot = await t.get(this.db.collection(CONTACTS).doc(identity.contactId));
        if (contactSnapshot.exists) {
          contact = toContact(contactSnapshot.id, contactSnapshot.data() as Doc);
        }
        const conversationSnapshot = await t.get(
          this.db
            .collection(CONVERSATIONS)
            .doc(conversationIdFor(m.organizationId, m.connectionId, identity.id)),
        );
        if (conversationSnapshot.exists) {
          conversation = toConversation(
            conversationSnapshot.id,
            conversationSnapshot.data() as Doc,
          );
        }
      }
      const records = applyInbound(
        m,
        {
          ...(identity === undefined ? {} : { identity }),
          ...(contact === undefined ? {} : { contact }),
          ...(conversation === undefined ? {} : { conversation }),
        },
        newContactId,
        at,
      );
      if (identity === undefined) {
        t.create(
          this.db.collection(CONTACTS).doc(records.contact.id),
          toContactDocument(records.contact),
        );
        t.create(identityDoc, toIdentityDocument(records.identity));
      }
      t.set(
        this.db.collection(CONVERSATIONS).doc(records.conversation.id),
        toConversationDocument(records.conversation),
      );
      t.create(messageDoc, toMessageDocument(records.message));
      return {
        duplicate: false,
        message: records.message,
        conversation: records.conversation,
        newContact: identity === undefined,
        newConversation: conversation === undefined,
      };
    });
  }

  async applyStatus(update: DeliveryStatusUpdate): Promise<{ readonly applied: boolean }> {
    const u = checkStatusUpdate(update);
    const ref = this.db
      .collection(MESSAGE_REFS)
      .doc(messageRefKeyFor(u.organizationId, u.channel, u.externalMessageId));
    return this.db.runTransaction(async (t) => {
      const found = await t.get(ref);
      if (!found.exists || found.get('organizationId') !== u.organizationId) {
        return { applied: false };
      }
      const doc = this.db.collection(MESSAGES).doc(found.get('messageId') as string);
      const snapshot = await t.get(doc);
      if (!snapshot.exists) return { applied: false };
      const message = toMessage(snapshot.id, snapshot.data() as Doc);
      if (message.organizationId !== u.organizationId) return { applied: false };
      const next = applyStatus(message, u);
      if (next === undefined) return { applied: false };
      t.set(doc, toMessageDocument(next));
      return { applied: true };
    });
  }

  async findConversation(
    organizationId: OrganizationId,
    id: ConversationId,
  ): Promise<Conversation | undefined> {
    if (!isOrganizationId(organizationId) || !isConversationId(id)) return undefined;
    const snapshot = await this.db.collection(CONVERSATIONS).doc(id).get();
    const data = snapshot.data();
    // Another organization's conversation is absent, exactly like a missing one.
    if (data?.organizationId !== organizationId) return undefined;
    return toConversation(snapshot.id, data);
  }

  async listConversations(organizationId: OrganizationId): Promise<readonly Conversation[]> {
    if (!isOrganizationId(organizationId)) return [];
    const snapshot = await this.db
      .collection(CONVERSATIONS)
      .where('organizationId', '==', organizationId)
      .get();
    return snapshot.docs.map((doc) => toConversation(doc.id, doc.data())).sort(byLatestActivity);
  }

  async listMessages(
    organizationId: OrganizationId,
    conversationId: ConversationId,
  ): Promise<readonly Message[]> {
    if (!isOrganizationId(organizationId) || !isConversationId(conversationId)) return [];
    const snapshot = await this.db
      .collection(MESSAGES)
      .where('conversationId', '==', conversationId)
      .get();
    return snapshot.docs
      .map((doc) => toMessage(doc.id, doc.data()))
      .filter((m) => m.organizationId === organizationId)
      .sort(byConversationOrder);
  }

  async updateConversation(
    organizationId: OrganizationId,
    id: ConversationId,
    change: (current: Conversation) => ConversationWrite,
  ): Promise<Conversation> {
    if (!isOrganizationId(organizationId) || !isConversationId(id)) {
      throw new ConversationError('conversation_not_found');
    }
    const doc = this.db.collection(CONVERSATIONS).doc(id);
    // Firestore re-runs the function when the document changed after it was read (a message
    // arrived, another person changed it), so a change is always made on the latest state.
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      const data = snapshot.data();
      if (data?.organizationId !== organizationId) {
        throw new ConversationError('conversation_not_found');
      }
      const current = toConversation(snapshot.id, data);
      const { conversation, events } = change(current);
      checkNextConversation(current, conversation);
      t.set(doc, toConversationDocument(conversation));
      this.#append(t, events);
      return conversation;
    });
  }

  async findContact(organizationId: OrganizationId, id: ContactId): Promise<Contact | undefined> {
    if (!isOrganizationId(organizationId) || !isContactId(id)) return undefined;
    const snapshot = await this.db.collection(CONTACTS).doc(id).get();
    const data = snapshot.data();
    if (data?.organizationId !== organizationId) return undefined;
    return toContact(snapshot.id, data);
  }

  async listContacts(organizationId: OrganizationId): Promise<readonly Contact[]> {
    if (!isOrganizationId(organizationId)) return [];
    const snapshot = await this.db
      .collection(CONTACTS)
      .where('organizationId', '==', organizationId)
      .get();
    return snapshot.docs
      .map((doc) => toContact(doc.id, doc.data()))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
  }

  async listIdentities(
    organizationId: OrganizationId,
    contactId: ContactId,
  ): Promise<readonly ChannelIdentity[]> {
    if (!isOrganizationId(organizationId) || !isContactId(contactId)) return [];
    const snapshot = await this.db
      .collection(CHANNEL_IDENTITIES)
      .where('contactId', '==', contactId)
      .get();
    return snapshot.docs
      .map((doc) => toIdentity(doc.id, doc.data()))
      .filter((i) => i.organizationId === organizationId);
  }

  async listOrganizationIdentities(
    organizationId: OrganizationId,
  ): Promise<readonly ChannelIdentity[]> {
    if (!isOrganizationId(organizationId)) return [];
    const snapshot = await this.db
      .collection(CHANNEL_IDENTITIES)
      .where('organizationId', '==', organizationId)
      .get();
    return snapshot.docs.map((doc) => toIdentity(doc.id, doc.data()));
  }

  async findIdentity(
    organizationId: OrganizationId,
    id: ChannelIdentityId,
  ): Promise<ChannelIdentity | undefined> {
    if (!isOrganizationId(organizationId) || !isUuid(id)) return undefined;
    const snapshot = await this.db.collection(CHANNEL_IDENTITIES).doc(id).get();
    const data = snapshot.data();
    if (data?.organizationId !== organizationId) return undefined;
    return toIdentity(snapshot.id, data);
  }

  async findMessage(organizationId: OrganizationId, id: MessageId): Promise<Message | undefined> {
    if (!isOrganizationId(organizationId) || !isUuid(id)) return undefined;
    const snapshot = await this.db.collection(MESSAGES).doc(id).get();
    const data = snapshot.data();
    if (data?.organizationId !== organizationId) return undefined;
    return toMessage(snapshot.id, data);
  }

  async reserveOutbound(message: Message): Promise<ReserveResult> {
    const { organizationId } = message;
    if (!isOrganizationId(organizationId) || !isConversationId(message.conversationId)) {
      throw new ConversationError('conversation_not_found');
    }
    if (message.direction !== 'outbound' || message.status !== 'queued') {
      throw new ConversationError('invalid_request', 'outbound');
    }
    const conversationDoc = this.db.collection(CONVERSATIONS).doc(message.conversationId);
    const messageDoc = this.db.collection(MESSAGES).doc(message.id);
    // One transaction: two concurrent sends of the same key store one message.
    return this.db.runTransaction(async (t) => {
      const conversation = await t.get(conversationDoc);
      if (conversation.get('organizationId') !== organizationId) {
        throw new ConversationError('conversation_not_found');
      }
      const stored = await t.get(messageDoc);
      if (stored.exists) {
        const found = toMessage(stored.id, stored.data() as Doc);
        if (found.organizationId !== organizationId) throw new Error('message id collision');
        return { created: false, message: found };
      }
      t.create(messageDoc, toMessageDocument(message));
      return { created: true, message };
    });
  }

  async settleOutbound(
    organizationId: OrganizationId,
    id: MessageId,
    settlement: OutboundSettlement,
    events: readonly AuditEvent[],
    at: Date,
  ): Promise<SettleResult> {
    if (!isOrganizationId(organizationId) || !isUuid(id)) return { applied: false };
    const messageDoc = this.db.collection(MESSAGES).doc(id);
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(messageDoc);
      const data = snapshot.data();
      if (data?.organizationId !== organizationId) return { applied: false };
      const message = toMessage(snapshot.id, data);
      const next = settleOutbound(message, settlement);
      if (next === undefined) return { applied: false, message };
      if (next.status === 'sent' && next.externalMessageId !== undefined) {
        const conversationDoc = this.db.collection(CONVERSATIONS).doc(next.conversationId);
        const stored = await t.get(conversationDoc);
        if (stored.get('organizationId') !== organizationId) {
          throw new ConversationError('conversation_not_found');
        }
        const conversation = toConversation(stored.id, stored.data() as Doc);
        const updated = applyOutbound(conversation, next, at);
        checkNextConversation(conversation, updated);
        t.set(conversationDoc, toConversationDocument(updated));
        t.create(
          this.db
            .collection(MESSAGE_REFS)
            .doc(messageRefKeyFor(organizationId, next.channel, next.externalMessageId)),
          { organizationId, messageId: next.id },
        );
      }
      t.set(messageDoc, toMessageDocument(next));
      this.#append(t, events);
      return { applied: true, message: next };
    });
  }

  async findSettings(organizationId: OrganizationId): Promise<ConversationSettings | undefined> {
    if (!isOrganizationId(organizationId)) return undefined;
    const snapshot = await this.db.collection(CONVERSATION_SETTINGS).doc(organizationId).get();
    const data = snapshot.data();
    if (data?.organizationId !== organizationId) return undefined;
    return toSettings(data);
  }

  async updateSettings(
    organizationId: OrganizationId,
    change: (current: ConversationSettings | undefined) => SettingsWrite,
  ): Promise<ConversationSettings> {
    if (!isOrganizationId(organizationId)) throw new ConversationError('organization_inactive');
    const doc = this.db.collection(CONVERSATION_SETTINGS).doc(organizationId);
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      const data = snapshot.data();
      if (data !== undefined && data.organizationId !== organizationId) {
        throw new Error('invalid conversation settings record');
      }
      const current = data === undefined ? undefined : toSettings(data);
      const { settings, events } = change(current);
      checkNextSettings(organizationId, current, settings);
      t.set(doc, toSettingsDocument(settings));
      this.#append(t, events);
      return settings;
    });
  }

  #append(t: Transaction, events: readonly AuditEvent[]): void {
    for (const event of events) {
      t.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
    }
  }
}

/** Test helper: stores an outbound message and its provider reference, as a sender will (CV-2). */
export async function putOutboundMessage(db: Firestore, message: Message): Promise<void> {
  await db.collection(MESSAGES).doc(message.id).set(toMessageDocument(message));
  if (message.externalMessageId !== undefined) {
    await db
      .collection(MESSAGE_REFS)
      .doc(messageRefKeyFor(message.organizationId, message.channel, message.externalMessageId))
      .set({ organizationId: message.organizationId, messageId: message.id });
  }
}
