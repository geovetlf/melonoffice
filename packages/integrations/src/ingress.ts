import type { ConversationIngress } from '@melonoffice/conversations';
import type { ChannelConnection } from '@melonoffice/domain';
import type { Logger } from '@melonoffice/observability';
import type { ChannelAdapter } from './adapter.js';
import type { ChannelConnectionRepository } from './connections.js';
import { isConnectionId } from './connections.js';
import { isIntegrationError } from './errors.js';
import type { SecretStore } from './secrets.js';

/** An HTTP-free answer: the route only copies it. */
export interface IngressAnswer {
  readonly status: 200 | 400 | 401 | 403 | 404 | 503;
  /** A JSON body, or the challenge text of a handshake. */
  readonly body: Readonly<Record<string, unknown>> | string;
}

/**
 * The public edge for channel webhooks (ADR-0033). It can only do five things: receive, verify,
 * normalize, persist and acknowledge. It never runs a model, a tool or a workflow, and the only
 * authority it accepts is the provider's signature with the connection's own secret. The
 * organization comes from the stored connection, never from the request; the payload must name
 * that connection's own account or nothing is stored.
 */
export interface WebhookIngress {
  handshake(channel: string, connectionId: string, query: URLSearchParams): Promise<IngressAnswer>;
  deliver(
    channel: string,
    connectionId: string,
    rawBody: string,
    headers: Headers,
  ): Promise<IngressAnswer>;
}

export interface WebhookIngressOptions {
  readonly connections: Pick<ChannelConnectionRepository, 'findForDelivery'>;
  readonly secrets: SecretStore;
  readonly adapters: readonly ChannelAdapter[];
  readonly conversations: ConversationIngress;
  readonly logger?: Logger;
}

const refuse = (status: IngressAnswer['status'], error: string): IngressAnswer =>
  Object.freeze({ status, body: Object.freeze({ error }) });

export function createWebhookIngress({
  connections,
  secrets,
  adapters,
  conversations,
  logger,
}: WebhookIngressOptions): WebhookIngress {
  const byChannel = new Map(adapters.map((a) => [a.channel as string, a]));

  /** The adapter and the active connection a delivery is for, or the refusal. */
  async function resolve(
    channel: string,
    connectionId: string,
  ): Promise<
    | { readonly adapter: ChannelAdapter; readonly connection: ChannelConnection }
    | { readonly refusal: IngressAnswer }
  > {
    const adapter = byChannel.get(channel);
    if (adapter === undefined) return { refusal: refuse(404, 'unknown_channel') };
    // A malformed id cannot exist: answered like an unknown one, without a lookup.
    if (!isConnectionId(connectionId)) return { refusal: refuse(404, 'connection_not_found') };
    let connection: ChannelConnection | undefined;
    try {
      connection = await connections.findForDelivery(connectionId);
    } catch (error) {
      logger?.error('webhook connection lookup failed', { error });
      return { refusal: refuse(503, 'unavailable') };
    }
    if (connection === undefined || connection.channel !== adapter.channel) {
      return { refusal: refuse(404, 'connection_not_found') };
    }
    if (connection.status !== 'active') return { refusal: refuse(403, 'connection_disabled') };
    return { adapter, connection };
  }

  async function secret(ref: ChannelConnection['secrets'][keyof ChannelConnection['secrets']]) {
    try {
      return { value: await secrets.read(ref) };
    } catch (error) {
      // The code only: never the reference's value or anything read.
      logger?.error('webhook secret unavailable', {
        code: isIntegrationError(error) ? error.code : 'secret_unavailable',
      });
      return { refusal: refuse(503, 'unavailable') };
    }
  }

  return {
    async handshake(channel, connectionId, query) {
      const resolved = await resolve(channel, connectionId);
      if ('refusal' in resolved) return resolved.refusal;
      const token = await secret(resolved.connection.secrets.verify_token);
      if (token.refusal !== undefined) return token.refusal;
      const challenge = resolved.adapter.handshake(query, token.value);
      if (challenge === undefined) {
        logger?.warn('webhook handshake refused', { connectionId });
        return refuse(403, 'handshake_refused');
      }
      return Object.freeze({ status: 200, body: challenge });
    },

    async deliver(channel, connectionId, rawBody, headers) {
      const resolved = await resolve(channel, connectionId);
      if ('refusal' in resolved) return resolved.refusal;
      const { adapter, connection } = resolved;
      const appSecret = await secret(connection.secrets.app_secret);
      if (appSecret.refusal !== undefined) return appSecret.refusal;
      if (!adapter.verifySignature(rawBody, headers, appSecret.value)) {
        logger?.warn('webhook signature refused', { connectionId: connection.id });
        return refuse(401, 'invalid_signature');
      }
      let deliveries;
      try {
        deliveries = adapter.parse(rawBody);
      } catch (error) {
        if (!isIntegrationError(error)) throw error;
        logger?.warn('webhook payload refused', {
          connectionId: connection.id,
          code: error.code,
          ...(error.detail === undefined ? {} : { detail: error.detail }),
        });
        return refuse(400, 'invalid_payload');
      }
      // Tenant binding: every event must be addressed to this connection's own account.
      if (deliveries.some((d) => d.accountId !== connection.account.phoneNumberId)) {
        logger?.warn('webhook account mismatch', { connectionId: connection.id });
        return refuse(403, 'account_mismatch');
      }
      let received = 0;
      let duplicates = 0;
      let statuses = 0;
      try {
        for (const delivery of deliveries) {
          for (const message of delivery.messages) {
            const result = await conversations.receive({
              ...message,
              organizationId: connection.organizationId,
              connectionId: connection.id,
            });
            if (result.duplicate) duplicates += 1;
            else received += 1;
          }
          for (const status of delivery.statuses) {
            const { applied } = await conversations.applyStatus({
              ...status,
              organizationId: connection.organizationId,
              connectionId: connection.id,
            });
            if (applied) statuses += 1;
          }
        }
      } catch (error) {
        // Stored so far stays stored; the provider retries and the repeat changes nothing.
        logger?.error('webhook storage failed', {
          connectionId: connection.id,
          code: isIntegrationError(error) ? error.code : 'storage_failed',
        });
        return refuse(503, 'unavailable');
      }
      logger?.info('webhook delivered', {
        connectionId: connection.id,
        organizationId: connection.organizationId,
        received,
        duplicates,
        statuses,
      });
      return Object.freeze({
        status: 200,
        body: Object.freeze({ received, duplicates, statuses }),
      });
    },
  };
}
