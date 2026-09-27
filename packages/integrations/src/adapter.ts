import type { DeliveryStatusUpdate, InboundMessage } from '@melonoffice/conversations';
import type { ChannelConnection, ChannelType } from '@melonoffice/domain';

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
  /** The contact's address on the channel (the identity's external id). */
  readonly to: string;
  readonly text: string;
  readonly replyToExternalId?: string;
  /** Passed to the provider where it supports one, so a repeat sends once. */
  readonly idempotencyKey?: string;
}

/**
 * One channel, behind one interface (ADR-0033). The conversations domain knows the channel's
 * name, never its API. Adding Instagram, Messenger, Telegram, email or web chat is one more
 * adapter, not a change to the domain.
 *
 * An adapter only translates and talks to the official API. It never decides who may send: the
 * tool gate does, before `send` is ever called (CV-2).
 */
export interface ChannelAdapter {
  readonly channel: ChannelType;
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
  parse(rawBody: string): readonly NormalizedDelivery[];
  /** Sends a text through the official API. Returns the provider's message id. */
  send(
    connection: ChannelConnection,
    accessToken: string,
    message: OutboundText,
  ): Promise<{ readonly externalMessageId: string }>;
}
