import type { DeliveryStatusUpdate, InboundMessage } from '@melonoffice/conversations';
import type {
  ChannelCapabilities,
  ChannelConnection,
  ChannelType,
  IntegrationCategory,
  IntegrationProviderId,
  OutboundMediaRef,
  WhatsAppAccount,
} from '@melonoffice/domain';
import type { ResolvedTemplate, TemplateCheck } from './templates.js';

/**
 * What one channel delivered, normalized: no provider types reach the conversations domain.
 * The organization and connection are not here: they come from the verified connection.
 */
export interface NormalizedDelivery {
  /** The provider account the events were addressed to (for WhatsApp, the phone number id). */
  readonly accountId: string;
  readonly messages: readonly Omit<InboundMessage, 'organizationId' | 'connectionId'>[];
  readonly statuses: readonly Omit<DeliveryStatusUpdate, 'organizationId' | 'connectionId'>[];
}

/** A text to send to one address of a conversation. */
export interface OutboundText {
  readonly kind?: 'text';
  /** The contact's address on the channel (the identity's external id). */
  readonly to: string;
  readonly text: string;
  readonly replyToExternalId?: string;
  /** Passed to the provider where it supports one, so a repeat sends once. */
  readonly idempotencyKey?: string;
}

/** Media from a link, with an optional caption (ADR-0046). */
export interface OutboundMedia {
  readonly kind: 'media';
  readonly to: string;
  readonly media: OutboundMediaRef;
  readonly caption?: string;
  readonly replyToExternalId?: string;
  readonly idempotencyKey?: string;
}

/** An approved template with every value it needs, already checked (ADR-0046). */
export interface OutboundTemplate {
  readonly kind: 'template';
  readonly to: string;
  readonly template: ResolvedTemplate;
  readonly idempotencyKey?: string;
}

/** Anything an adapter may be asked to send. The Integration Engine decides whether it may. */
export type OutboundMessage = OutboundText | OutboundMedia | OutboundTemplate;

/** What kind of message it is, as the engine's channel policy sees it. */
export type OutboundKind = 'text' | 'media' | 'template';

export const outboundKindOf = (message: OutboundMessage): OutboundKind => message.kind ?? 'text';

/** What the Integration Engine asks of one provider call (ADR-0045). */
export interface SendOptions {
  /** The longest this call may take: never more than the adapter's own limit. */
  readonly timeoutMs?: number;
}

/** The credentials a check or a send uses: read from the secret store at that moment, then dropped. */
export interface ConnectionCredentials {
  readonly accessToken: string;
}

/**
 * What the provider answered about a connection's credentials. `invalid`: it refused them (the
 * code is stable and safe to store). `unavailable`: no answer, so nothing is known.
 */
export type ConnectionCheck =
  | { readonly status: 'valid' }
  | { readonly status: 'invalid'; readonly code: string }
  | { readonly status: 'unavailable'; readonly code: string };

/**
 * One provider of one channel, behind one interface (ADR-0033, generalized in ADR-0044). The
 * conversations domain, the runtime, the tool gate, credits and the AI Gateway know a channel's
 * name, never its API. Adding email, Instagram or a CRM is one more adapter in the provider
 * registry, not a change to any of them.
 *
 * An adapter only translates and talks to its provider's official API. It never decides who may
 * send or whether a connection may be used: the tool gate and the Integration Engine do, before
 * it is ever called. Only the Integration Engine calls an adapter.
 *
 * `receive` is `verifySignature` and then `normalizeInbound`, kept apart so that a forged
 * delivery and a malformed one are answered differently.
 */
export interface ChannelAdapter {
  /** The official provider API this adapter speaks, e.g. `meta_whatsapp_cloud`. */
  readonly provider: IntegrationProviderId;
  readonly category: IntegrationCategory;
  readonly channel: ChannelType;
  /** What its connections can do. Copied onto each connection when it is created. */
  readonly capabilities: ChannelCapabilities;
  /**
   * The provider account a person configures, checked: only its known, non-sensitive fields.
   * Throws `invalid_connection` on anything else (a token, a secret, an unknown field).
   */
  checkAccount(value: unknown): WhatsAppAccount;
  /** The account's id as the provider addresses deliveries to it (the tenant binding). */
  accountIdOf(account: WhatsAppAccount): string;
  /**
   * Whether a delivery really comes from the provider: the provider's signature over the exact
   * raw body, with the connection's secret. Constant-time.
   */
  verifySignature(rawBody: string, headers: Headers, appSecret: string): boolean;
  /**
   * The provider's subscription check (e.g. Meta's `hub.challenge`): the value to echo, or
   * `undefined` to refuse it.
   */
  handshake(query: URLSearchParams, verifyToken: string): string | undefined;
  /** The deliveries in a verified body. Throws `invalid_payload` on anything malformed. */
  normalizeInbound(rawBody: string): readonly NormalizedDelivery[];
  /**
   * The provider's request body for a text, checked. Pure: nothing is sent. Throws
   * `invalid_outbound` on a text or address the provider would refuse.
   */
  normalizeOutbound(message: OutboundMessage): Readonly<Record<string, unknown>>;
  /**
   * Sends a text through the official API, once: retrying is the Integration Engine's, never an
   * adapter's (ADR-0045). Returns the provider's message id. Throws `provider_rejected` (the
   * provider refused: nothing was sent; the detail is a stable code) or `provider_unavailable`
   * (the detail says whether it may have been sent: `no_answer`, `server_error` and `response`
   * may; `rate_limited`, `temporary_provider_error`, `not_connected` and `graph_api_version` did
   * not). A transient error may carry the provider's `retryAfterMs`.
   */
  send(
    connection: ChannelConnection,
    credentials: ConnectionCredentials,
    message: OutboundMessage,
    options?: SendOptions,
  ): Promise<{ readonly externalMessageId: string }>;
  /**
   * Asks the provider whether a template exists on the connection's account in that language,
   * is approved, and what it needs (ADR-0046). Reads only. Absent: the provider has no templates.
   */
  checkTemplate?(
    connection: ChannelConnection,
    credentials: ConnectionCredentials,
    template: { readonly name: string; readonly language: string },
  ): Promise<TemplateCheck>;
  /**
   * Asks the provider whether the connection's credentials open its account, before it is used.
   * Reads only; never sends a message.
   */
  validateConnection(
    connection: ChannelConnection,
    credentials: ConnectionCredentials,
  ): Promise<ConnectionCheck>;
  /** The same question, asked of a connection already in use. */
  healthCheck(
    connection: ChannelConnection,
    credentials: ConnectionCredentials,
  ): Promise<ConnectionCheck>;
}
