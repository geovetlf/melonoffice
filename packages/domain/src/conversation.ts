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
 * How far an organization lets AI act on its conversations (CV-6, ADR-0039). A restriction only:
 * it never grants a permission, a tool, a channel or credits (V3).
 *
 * - `manual`: AI does nothing on its own.
 * - `assisted`: AI analyses, summarizes and suggests when a person asks; the person decides (CV-4).
 * - `supervised`: an agent may prepare replies; a person approves each one before it is sent.
 * - `autonomous`: an agent may handle a conversation on its own, within its limits.
 *
 * `manual` is the default: an organization turns AI handling on explicitly.
 */
export type AutonomyLevel = 'manual' | 'assisted' | 'supervised' | 'autonomous';

/** The organization's own conversation settings (CV-6). One per organization. */
export interface ConversationSettings {
  readonly organizationId: OrganizationId;
  readonly autonomy: AutonomyLevel;
  readonly updatedAt: IsoTimestamp;
  /** The person who last changed it; absent while nobody has. */
  readonly updatedBy?: UserId;
  /** 0 while nobody has changed it, +1 on every change. */
  readonly revision: number;
}

/** Who handles a conversation right now: a person, or an agent within its limits (CV-6). */
export type ConversationHandler = 'human' | 'ai';

/**
 * Where AI handling of one conversation is (CV-6):
 *
 * - `off`: AI never handled it.
 * - `active`: an agent handles it (`handledBy: 'ai'`).
 * - `paused`: a person took control; AI stays out until a person hands it back.
 * - `escalated`: the agent handed it to a person, with a reason (`handoff`).
 */
export type ConversationAIState = 'off' | 'active' | 'paused' | 'escalated';

/**
 * Who controls a conversation (CV-6, ADR-0039). Absent on a conversation means a person handles
 * it and AI never did: `{ handledBy: 'human', aiState: 'off', epoch: 0 }`.
 */
export interface ConversationControl {
  readonly handledBy: ConversationHandler;
  readonly aiState: ConversationAIState;
  /**
   * +1 on every change of control. An agent's turn records the epoch it started under, and any
   * automatic send is refused once it moved: a person who took control is never overtaken.
   */
  readonly epoch: number;
  readonly changedAt: IsoTimestamp;
  /** The person who changed it; absent when the runtime escalated. */
  readonly changedBy?: UserId;
}

/**
 * Why a conversation needs a person, with pointers to what was gathered (CV-6, ADR-0039). Set
 * when an agent escalates; the reason is a stable code from the conversations package, never
 * free text from a model or a contact.
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
  /** Who controls it (CV-6). Absent: a person, and AI never handled it. */
  readonly control?: ConversationControl;
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
 * `delivered` → `read`, or `failed`; a status never moves backwards. `unknown` (CV-2, ADR-0034):
 * the provider may have accepted it but MelonOffice never learned whether; it is final until a
 * person or a later reconciliation resolves it, and it is never sent again blindly.
 */
export type MessageStatus =
  'received' | 'queued' | 'sent' | 'delivered' | 'read' | 'failed' | 'unknown';

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
  /** A stable code, for `failed` and `unknown`. */
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
