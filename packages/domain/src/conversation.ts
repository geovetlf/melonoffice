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
/** One organization's message template on one connection (ADR-0046). */
export type ChannelTemplateId = Brand<string, 'ChannelTemplateId'>;

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
  /** Where the contact stands commercially (C1, ADR-0053); absent for a contact nobody marked. */
  readonly commercial?: ContactCommercial;
  /** Increases with every change a person makes (C1); absent, it is 0. */
  readonly revision?: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/**
 * The commercial stage of a contact (C1, ADR-0053): a lead becomes a customer, and either may
 * become inactive. "Lost" belongs to opportunities (C2), not to the contact.
 */
export type ContactStage = 'lead' | 'customer' | 'inactive';

/** How the contact reached the business, as a code (never personal data). */
export type ContactSourceKind = 'channel' | 'manual' | 'import' | 'campaign';

/**
 * Consent to receive messages the business starts (C1). It never blocks creating or managing a
 * contact, nor answering one who wrote first; it is required before bulk or automated sends.
 */
export type MessagingConsent = 'granted' | 'denied' | 'unknown';

export interface ContactCommercial {
  readonly stage: ContactStage;
  /** A member of the organization responsible for the contact. */
  readonly ownerId?: UserId;
  readonly source: { readonly kind: ContactSourceKind; readonly reference?: string };
  readonly consent: {
    readonly messaging: MessagingConsent;
    readonly at?: IsoTimestamp;
    /** Who stated it: the contact itself, or a member recording what the contact said. */
    readonly recordedBy?: 'contact' | 'member';
  };
  /** What to do next and by when (a date in the business's time zone). */
  readonly nextAction?: { readonly text: string; readonly dueOn: string };
  readonly stageChangedAt: IsoTimestamp;
}

/** A note a member wrote about a contact (C1). Written once, never edited or deleted. */
export interface ContactNote {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly contactId: ContactId;
  readonly text: string;
  readonly createdBy: UserId;
  readonly createdAt: IsoTimestamp;
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
  /**
   * The agent (a specialist with a conversation profile) that attends the organization's
   * conversations where autonomy allows it (CV-6B, ADR-0043). Absent: no agent attends any.
   */
  readonly agentId?: SpecialistId;
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

/**
 * What a message carries. Inbound: text, or media referenced by the provider's id. Outbound
 * (CV-6D phase 2, ADR-0046): text, media from a link, or an approved template.
 */
export type MessageType =
  | 'text'
  | 'image'
  | 'document'
  | 'audio'
  | 'video'
  | 'sticker'
  | 'location'
  | 'template'
  | 'unsupported';

/** The media an outbound message can carry, whatever the channel (ADR-0046). */
export type OutboundMediaType = 'image' | 'document' | 'audio' | 'video';

/**
 * Where an outbound message's media comes from: an `https` link the organization gives, which the
 * provider fetches. Never logged or audited: a link may carry a signed, private token.
 */
export interface OutboundMediaRef {
  readonly type: OutboundMediaType;
  readonly url: string;
  /** For documents: the name the contact sees. */
  readonly filename?: string;
}

/**
 * The values of one template's placeholders, in order (`{{1}}`, `{{2}}` …). Plain text only; a
 * header of media takes a link instead.
 */
export interface TemplateValues {
  readonly header?: readonly string[];
  readonly headerMedia?: OutboundMediaRef;
  readonly body: readonly string[];
  /** A dynamic URL button's suffix, by the button's index in the template. */
  readonly buttons?: readonly { readonly index: number; readonly text: string }[];
}

/** An outbound template message: which of the organization's templates, and its values. */
export interface MessageTemplateRef {
  readonly templateId: ChannelTemplateId;
  readonly name: string;
  readonly language: string;
  readonly values: TemplateValues;
}

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
  /** An outbound media message's media (ADR-0046). `text` is then its caption. */
  readonly media?: OutboundMediaRef;
  /** An outbound template message's template and values (ADR-0046). */
  readonly template?: MessageTemplateRef;
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

/**
 * Where a connection is in its life (CV-6C, ADR-0044). Only `connected` may send; `revoked` is
 * final. The transitions live in `@melonoffice/integrations` (`CONNECTION_TRANSITIONS`).
 *
 * - `created`: configured, its credentials not yet checked with the provider.
 * - `connecting`: a check with the provider is under way.
 * - `connected`: checked and in use.
 * - `paused`: a person stopped its outbound; inbound messages are still stored.
 * - `error`: the provider refused its credentials; nothing is sent until it is checked again.
 * - `disconnected`: a person turned it off; its webhooks are refused. It can be connected again.
 * - `revoked`: deleted. Kept only as history; it never comes back.
 */
export type ChannelConnectionStatus =
  'created' | 'connecting' | 'connected' | 'paused' | 'error' | 'disconnected' | 'revoked';

/**
 * The kinds of outside service the Integration Engine connects to (ADR-0044). Messaging is the
 * only one with an adapter today; the others are named so that plans can list them
 * (`integrations.categoriesAllowed`), not because anything implements them.
 */
export type IntegrationCategory = 'messaging' | 'email' | 'calendar' | 'crm' | 'storage';

/**
 * One official provider API, e.g. `meta_whatsapp_cloud` (Meta's WhatsApp Cloud API). Named by
 * the provider registry; never an aggregator or intermediary.
 */
export type IntegrationProviderId = Brand<string, 'IntegrationProviderId'>;

/**
 * What a connection can do on its channel, copied from its provider's adapter when it is created
 * (ADR-0044). The engine refuses anything a connection cannot do before a provider is called.
 */
export interface ChannelCapabilities {
  readonly inboundText: boolean;
  readonly inboundMedia: boolean;
  readonly outboundText: boolean;
  readonly outboundMedia: boolean;
  /** Approved templates, which WhatsApp requires outside its service window. */
  readonly outboundTemplates: boolean;
  readonly deliveryStatus: boolean;
  /** The longest text the provider accepts in one message. */
  readonly maxOutboundTextLength: number;
  /**
   * How long after the contact's last message a free-form message may be sent, when the channel
   * limits it (WhatsApp: 24 hours). Absent: no such window.
   */
  readonly serviceWindowMs?: number;
}

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
 * An organization's connection to one outside service through one official provider (CV-1,
 * generalized in CV-6C, ADR-0044). It stores only non-sensitive configuration and references to
 * secrets that the server derives from the connection id; a client never chooses which secret a
 * connection uses, and no secret value is ever stored here.
 */
export interface ChannelConnection {
  readonly id: ChannelConnectionId;
  readonly organizationId: OrganizationId;
  readonly provider: IntegrationProviderId;
  readonly category: IntegrationCategory;
  readonly channel: ChannelType;
  readonly status: ChannelConnectionStatus;
  /** Why it is in `error` (a stable code, e.g. `channel_unauthorized`). Nothing else has one. */
  readonly statusReason?: string;
  readonly displayName: string;
  /** The provider account it speaks from: public identifiers only, checked by its adapter. */
  readonly account: WhatsAppAccount;
  readonly capabilities: ChannelCapabilities;
  readonly secrets: Readonly<Record<ChannelSecretKind, SecretRef>>;
  readonly createdAt: IsoTimestamp;
  readonly createdBy: UserId;
  readonly updatedAt: IsoTimestamp;
  /**
   * Who made the last change: the person, or the person a send was made for when the provider
   * refused the connection's credentials during it.
   */
  readonly updatedBy: UserId;
  /** When the provider last confirmed its credentials. */
  readonly lastValidatedAt?: IsoTimestamp;
  readonly revision: number;
}

/**
 * Where a template is (ADR-0046). `pending`: registered, not yet checked with the provider.
 * `active`: the provider confirmed it approved, in that language, with the parameters recorded
 * here; only an active template is sent. `invalid`: the provider did not confirm it (the reason
 * says why). `disabled`: a person turned it off.
 */
export type ChannelTemplateStatus = 'pending' | 'active' | 'invalid' | 'disabled';

/** What a template needs, as its provider describes it: how many values, and where. */
export interface ChannelTemplateSpec {
  /** `none`, a text header with this many values, or a media header. */
  readonly header:
    | { readonly format: 'none' }
    | { readonly format: 'text'; readonly parameters: number }
    | { readonly format: 'image' | 'document' | 'video' };
  readonly bodyParameters: number;
  /** Buttons that take a value (a dynamic URL), by index. */
  readonly urlButtons: readonly { readonly index: number }[];
}

/**
 * An organization's message template on one connection (ADR-0046): registered by name and
 * language by a person, then checked with the provider, which says whether it is approved and what
 * it needs. MelonOffice never invents or edits a template: they are created and approved in the
 * provider's own tools.
 */
export interface ChannelTemplate {
  readonly id: ChannelTemplateId;
  readonly organizationId: OrganizationId;
  readonly connectionId: ChannelConnectionId;
  readonly channel: ChannelType;
  readonly name: string;
  readonly language: string;
  readonly status: ChannelTemplateStatus;
  readonly statusReason?: string;
  /** The provider's category (e.g. `utility`, `marketing`), once checked. */
  readonly category?: string;
  /** What it needs, once checked. */
  readonly spec?: ChannelTemplateSpec;
  readonly createdAt: IsoTimestamp;
  readonly createdBy: UserId;
  readonly updatedAt: IsoTimestamp;
  readonly updatedBy: UserId;
  readonly lastValidatedAt?: IsoTimestamp;
  readonly revision: number;
}
