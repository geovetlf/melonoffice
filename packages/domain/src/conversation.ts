import type { ExecutionId, ExecutionRef } from './execution.js';
import type {
  Brand,
  DepartmentId,
  IsoTimestamp,
  OrganizationId,
  SpecialistId,
  UserId,
} from './ids.js';

/**
 * The conversations domain (CV-1, ADR-0033): the organization's communication with its contacts
 * over external channels. It is history, not work: work about a conversation is an execution
 * that references it (`{ type: 'conversation', id }`), never a second task or workflow model.
 * Every record belongs to exactly one organization.
 */

export type ContactId = Brand<string, 'ContactId'>;
export type ChannelIdentityId = Brand<string, 'ChannelIdentityId'>;
export type ConversationId = Brand<string, 'ConversationId'>;
export type MessageId = Brand<string, 'MessageId'>;
export type ChannelConnectionId = Brand<string, 'ChannelConnectionId'>;

/**
 * The channels MelonOffice can speak on. A closed list, extended one adapter at a time: WhatsApp
 * (Cloud API, official) is the first (DG-2).
 */
export type ChannelType = 'whatsapp';

/**
 * Where a record came from. An inbound message is the external contact speaking through a
 * channel connection: it is never attributed to a user of the organization, and it is not an
 * audit actor (the global actor model is unchanged in CV-1).
 */
export type ConversationOrigin =
  | {
      readonly kind: 'channel';
      readonly channel: ChannelType;
      readonly connectionId: ChannelConnectionId;
    }
  | { readonly kind: 'user'; readonly userId: UserId };

export type ContactStatus = 'active' | 'archived';

/** A person or business the organization talks to. One contact can have several channel identities. */
export interface Contact {
  readonly id: ContactId;
  readonly organizationId: OrganizationId;
  /** As the contact presents itself (e.g. its WhatsApp profile name) or as a person set it. */
  readonly displayName?: string;
  /** E.164, when known from a channel that verifies it (WhatsApp) or entered by a person. */
  readonly phone?: string;
  readonly email?: string;
  readonly status: ContactStatus;
  readonly origin: ConversationOrigin;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/**
 * One address of a contact on one channel, e.g. a WhatsApp id. Unique per organization, channel
 * and external id: the same number in two organizations is two unrelated identities. It is only
 * ever linked to a contact by exact identifier; a similar name, username or photo never merges
 * anything (safe by default).
 */
export interface ChannelIdentity {
  readonly id: ChannelIdentityId;
  readonly organizationId: OrganizationId;
  readonly contactId: ContactId;
  readonly channel: ChannelType;
  /** The provider's id for the address (for WhatsApp, the `wa_id`). */
  readonly externalId: string;
  readonly displayName?: string;
  /**
   * `provider`: the channel itself vouches for the address (a WhatsApp id is a verified phone).
   * `unverified`: typed in by a person. Future identity resolution weighs evidence by this.
   */
  readonly verification: 'provider' | 'unverified';
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/**
 * Where a conversation is. A closed set: `open` needs the organization, `pending` waits on
 * something (the contact, an internal answer), `closed` is done and reopens when the contact
 * writes again.
 */
export type ConversationStatus = 'open' | 'pending' | 'closed';

export type ConversationPriority = 'low' | 'normal' | 'high' | 'urgent';

/** A short, non-authoritative view of the last message, for inbox lists. */
export interface ConversationLastMessage {
  readonly id: MessageId;
  readonly direction: MessageDirection;
  readonly type: MessageType;
  readonly preview?: string;
  readonly at: IsoTimestamp;
}

/**
 * Reserved for the future AI → human handoff (CV-5): why a conversation needs a person, with
 * pointers to what was gathered. Nothing sets it in CV-1, where the AI never acts on its own.
 */
export interface ConversationHandoff {
  readonly reason: string;
  readonly requestedAt: IsoTimestamp;
  readonly summary?: ExecutionRef;
  readonly executionId?: ExecutionId;
}

/**
 * One thread between the organization and one contact identity on one channel connection. There
 * is exactly one per identity and connection: it is reopened, never duplicated.
 */
export interface Conversation {
  readonly id: ConversationId;
  readonly organizationId: OrganizationId;
  readonly contactId: ContactId;
  readonly channelIdentityId: ChannelIdentityId;
  readonly channel: ChannelType;
  readonly connectionId: ChannelConnectionId;
  readonly status: ConversationStatus;
  /** The person responsible, a member of the organization. */
  readonly assigneeId?: UserId;
  /** The department that owns it, from the organization's departments. */
  readonly departmentId?: DepartmentId;
  readonly priority: ConversationPriority;
  /** Short codes, sorted, without duplicates. */
  readonly tags: readonly string[];
  readonly lastMessage?: ConversationLastMessage;
  readonly lastMessageAt: IsoTimestamp;
  readonly lastInboundAt?: IsoTimestamp;
  readonly lastOutboundAt?: IsoTimestamp;
  readonly handoff?: ConversationHandoff;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  /** 1 on creation, +1 on every change: concurrent changes never overwrite each other. */
  readonly revision: number;
}

export type MessageDirection = 'inbound' | 'outbound';

/** What a message carries. CV-1 stores text; the others are kept as typed placeholders. */
export type MessageType =
  'text' | 'image' | 'document' | 'audio' | 'video' | 'sticker' | 'location' | 'unsupported';

/**
 * Where a message is. Inbound messages are `received`. Outbound ones go `queued` → `sent` →
 * `delivered` → `read`, or `failed`; a status never moves backwards.
 */
export type MessageStatus = 'received' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed';

/** Who wrote a message: the external contact, a person of the organization, or a specialist (later). */
export type MessageSender =
  | { readonly kind: 'contact'; readonly channelIdentityId: ChannelIdentityId }
  | { readonly kind: 'user'; readonly userId: UserId }
  | {
      readonly kind: 'specialist';
      readonly specialistId: SpecialistId;
      readonly executionId: ExecutionId;
    };

/** Media is referenced by the provider's id until it is copied to storage; never inlined. */
export interface MessageAttachment {
  readonly providerMediaId: string;
  readonly mimeType?: string;
}

export interface Message {
  readonly id: MessageId;
  readonly organizationId: OrganizationId;
  readonly conversationId: ConversationId;
  readonly channel: ChannelType;
  readonly connectionId: ChannelConnectionId;
  readonly direction: MessageDirection;
  /** The provider's message id: the idempotency key of inbound messages. */
  readonly externalMessageId?: string;
  /** The sender's own key of an outbound message, so a repeated send stores it once. */
  readonly clientMessageId?: string;
  readonly sender: MessageSender;
  readonly type: MessageType;
  readonly text?: string;
  readonly attachments: readonly MessageAttachment[];
  /** The external id of the message this one answers, when the channel says so. */
  readonly replyToExternalId?: string;
  readonly status: MessageStatus;
  /** A stable code, for `failed`. */
  readonly failureCode?: string;
  /** When it was sent, by the provider's clock for inbound messages. */
  readonly sentAt: IsoTimestamp;
  /** When MelonOffice stored it. */
  readonly createdAt: IsoTimestamp;
  readonly deliveredAt?: IsoTimestamp;
  readonly readAt?: IsoTimestamp;
}

export type ChannelConnectionStatus = 'active' | 'disabled';

/**
 * The provider account a WhatsApp connection speaks from: public, non-sensitive identifiers only.
 */
export interface WhatsAppAccount {
  readonly phoneNumberId: string;
  readonly businessAccountId?: string;
  readonly displayPhoneNumber?: string;
}

/**
 * A pointer to a secret in the secret store (Secret Manager). Never the secret: the value is
 * read by server infrastructure at the moment it is needed and is never stored, logged or
 * returned.
 */
export type SecretRef = Brand<string, 'SecretRef'>;

/** The secrets a channel connection needs, by purpose. */
export type ChannelSecretKind = 'app_secret' | 'access_token' | 'verify_token';

/**
 * An organization's connection to one channel account. It stores only non-sensitive
 * configuration and references to secrets that the server derives from the connection id; a
 * client never chooses which secret a connection uses.
 */
export interface ChannelConnection {
  readonly id: ChannelConnectionId;
  readonly organizationId: OrganizationId;
  readonly channel: ChannelType;
  readonly status: ChannelConnectionStatus;
  readonly displayName: string;
  readonly account: WhatsAppAccount;
  readonly secrets: Readonly<Record<ChannelSecretKind, SecretRef>>;
  readonly createdAt: IsoTimestamp;
  readonly createdBy: UserId;
  readonly updatedAt: IsoTimestamp;
  readonly revision: number;
}
