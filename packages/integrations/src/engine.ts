import { actorOf, buildAuditEvent, type AuditService } from '@melonoffice/audit';
import type { ConversationIngress } from '@melonoffice/conversations';
import type {
  ChannelConnection,
  ChannelConnectionId,
  ChannelSecretKind,
  Conversation,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import type { Logger } from '@melonoffice/observability';
import type { ChannelAdapter, ConnectionCheck, OutboundText } from './adapter.js';
import {
  connectionEventOf,
  isConnectionId,
  type ChannelConnectionRepository,
  type ConnectionChecker,
} from './connections.js';
import { IntegrationError, isIntegrationError } from './errors.js';
import { acceptsHandshake, acceptsInbound, isOperational } from './lifecycle.js';
import type { IntegrationRegistry } from './registry.js';
import type { SecretStore } from './secrets.js';

/** Where inbound messages go: the conversations' ingress, possibly with agents' turns. */
export type ConversationIngressPort = Pick<ConversationIngress, 'receive' | 'applyStatus'>;

/** An HTTP-free answer: the webhook route only copies it. */
export interface IngressAnswer {
  readonly status: 200 | 400 | 401 | 403 | 404 | 503;
  /** A JSON body, or the challenge text of a handshake. */
  readonly body: Readonly<Record<string, unknown>> | string;
}

/**
 * The public edge for channel webhooks (ADR-0033): receive, verify, normalize, persist and
 * acknowledge. It never runs a model, a tool or a workflow, and the only authority it accepts is
 * the provider's signature with the connection's own secret. The organization comes from the
 * stored connection, never from the request; the payload must name that connection's own account
 * or nothing is stored.
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

/** Whether a free-form message may be sent now, under the channel's service window. */
export function withinServiceWindow(
  conversation: Pick<Conversation, 'lastInboundAt'>,
  capabilities: { readonly serviceWindowMs?: number },
  now: Date,
): boolean {
  if (capabilities.serviceWindowMs === undefined) return true;
  if (conversation.lastInboundAt === undefined) return false;
  const since = now.getTime() - new Date(conversation.lastInboundAt).getTime();
  return since >= 0 && since < capabilities.serviceWindowMs;
}

/** Why a connection cannot send now. Stable codes, the same for a person's send and an agent's. */
export type ChannelRefusal =
  'channel_not_available' | 'capability_not_available' | 'outside_messaging_window';

/** Whether a connection could send a text in a conversation now, asked before anything is sent. */
export interface AvailabilityQuery {
  readonly organizationId: OrganizationId;
  readonly connectionId: ChannelConnectionId;
  readonly channel: Conversation['channel'];
  /** When given, the channel's service window is checked against it. */
  readonly conversation?: Pick<Conversation, 'lastInboundAt'>;
}

/** Who a send is for: the person, or the person the runtime acts for. */
export interface OutboundActor {
  readonly actor: 'user' | 'runtime';
  readonly userId: UserId;
}

/** A text to send, once the tool gate allowed it (ADR-0044). */
export interface OutboundRequest extends AvailabilityQuery {
  readonly conversation: Pick<Conversation, 'id' | 'lastInboundAt'>;
  readonly message: OutboundText;
  readonly actor: OutboundActor;
  /** Ids for the log line only (execution, node, agent, message, request). */
  readonly trace?: Readonly<Record<string, string | undefined>>;
  /**
   * Asked as the very last step before the provider is called (CV-6B): a refusal code stops the
   * send with nothing sent.
   */
  readonly lastCheck?: () => Promise<string | undefined>;
}

/**
 * What became of a send. `refused`: nothing left MelonOffice, and the code says why. `failed`:
 * the provider was called and answered with an error (or did not answer), which the caller
 * settles (`settlementOfError`): it may have been sent.
 */
export type OutboundResult =
  | { readonly status: 'sent'; readonly externalMessageId: string }
  | { readonly status: 'refused'; readonly code: string }
  | { readonly status: 'failed'; readonly error: unknown };

/**
 * The Integration Engine (CV-6C, ADR-0044): the one way MelonOffice reaches an outside service,
 * in both directions. It holds the provider registry, and every adapter call goes through it:
 *
 * - inbound: webhook → provider adapter (verify, normalize) → connection → organization →
 *   conversations;
 * - outbound: tool gate → `message_send` executor → engine (connection, lifecycle, capability,
 *   channel policy, credential) → provider adapter → official API;
 * - lifecycle: a connection's credentials checked with its provider (`validate`).
 *
 * It decides whether a connection may be used; it never decides who may use it (RBAC and the
 * tool gate do), and it never calls a model (the AI Gateway does). It adds no credits: a
 * channel's own costs are the provider's, and MelonOffice charges no price for them (none is
 * decided).
 */
export interface IntegrationEngine extends WebhookIngress, ConnectionChecker {
  readonly registry: IntegrationRegistry;
  /** `undefined` when a text could be sent now, or the refusal code. Reads no secret. */
  availability(query: AvailabilityQuery): Promise<ChannelRefusal | undefined>;
  /** Sends a text through the connection's provider. Only the `message_send` executor calls it. */
  send(request: OutboundRequest): Promise<OutboundResult>;
}

export interface IntegrationEngineOptions {
  readonly registry: IntegrationRegistry;
  readonly connections: Pick<ChannelConnectionRepository, 'find' | 'findForDelivery' | 'update'>;
  readonly secrets: SecretStore;
  /** Where inbound messages are stored. Absent: deliveries are refused (503). */
  readonly inbound?: ConversationIngressPort;
  /** Records received messages. */
  readonly audit?: Pick<AuditService, 'record'>;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

const refuse = (status: IngressAnswer['status'], error: string): IngressAnswer =>
  Object.freeze({ status, body: Object.freeze({ error }) });

export function createIntegrationEngine(options: IntegrationEngineOptions): IntegrationEngine {
  const {
    registry,
    connections,
    secrets,
    inbound,
    audit,
    logger,
    now = () => new Date(),
  } = options;

  /** The connection's registered adapter, when its account still passes that adapter's check. */
  function adapterOf(connection: ChannelConnection): ChannelAdapter | undefined {
    const adapter = registry.find(connection.provider);
    if (adapter === undefined || adapter.channel !== connection.channel) return undefined;
    try {
      adapter.checkAccount(connection.account);
    } catch {
      return undefined;
    }
    return adapter;
  }

  async function readSecret(connection: ChannelConnection, kind: ChannelSecretKind) {
    return secrets.read(connection.secrets[kind]);
  }

  /** The adapter and the connection a delivery is for, or the refusal. */
  async function resolveDelivery(
    channel: string,
    connectionId: string,
    accepts: (c: ChannelConnection) => boolean,
  ): Promise<
    | { readonly adapter: ChannelAdapter; readonly connection: ChannelConnection }
    | { readonly refusal: IngressAnswer }
  > {
    if (registry.forChannel(channel) === undefined) {
      return { refusal: refuse(404, 'unknown_channel') };
    }
    // A malformed id cannot exist: answered like an unknown one, without a lookup.
    if (!isConnectionId(connectionId)) return { refusal: refuse(404, 'connection_not_found') };
    let connection: ChannelConnection | undefined;
    try {
      connection = await connections.findForDelivery(connectionId);
    } catch (error) {
      logger?.error('webhook connection lookup failed', { code: codeOf(error) });
      return { refusal: refuse(503, 'unavailable') };
    }
    const adapter = connection === undefined ? undefined : adapterOf(connection);
    if (connection === undefined || adapter === undefined || adapter.channel !== channel) {
      return { refusal: refuse(404, 'connection_not_found') };
    }
    if (!accepts(connection)) return { refusal: refuse(403, 'connection_disabled') };
    return { adapter, connection };
  }

  async function secret(connection: ChannelConnection, kind: ChannelSecretKind) {
    try {
      return { value: await readSecret(connection, kind) };
    } catch (error) {
      // The code only: never the reference's value or anything read.
      logger?.error('webhook secret unavailable', {
        connectionId: connection.id,
        code: isIntegrationError(error) ? error.code : 'secret_unavailable',
      });
      return { refusal: refuse(503, 'unavailable') };
    }
  }

  async function availabilityOf(
    query: AvailabilityQuery,
  ): Promise<
    | { readonly code: ChannelRefusal }
    | { readonly adapter: ChannelAdapter; readonly connection: ChannelConnection }
  > {
    const connection = await connections.find(query.organizationId, query.connectionId);
    // Another organization's connection is simply not found: the query is in its own organization.
    if (connection === undefined || connection.organizationId !== query.organizationId) {
      return { code: 'channel_not_available' };
    }
    if (connection.channel !== query.channel || !isOperational(connection)) {
      return { code: 'channel_not_available' };
    }
    const adapter = adapterOf(connection);
    if (adapter === undefined) return { code: 'channel_not_available' };
    if (!connection.capabilities.outboundText || !adapter.capabilities.outboundText) {
      return { code: 'capability_not_available' };
    }
    if (
      query.conversation !== undefined &&
      !withinServiceWindow(query.conversation, connection.capabilities, now())
    ) {
      // WhatsApp: a free-form message only within 24 hours of the contact's last one, and this
      // connection sends no templates (ADR-0044). Nothing is sent outside it.
      return { code: 'outside_messaging_window' };
    }
    return { adapter, connection };
  }

  /** The provider refused the connection's credentials while in use: it goes to `error`. */
  async function recordCredentialFailure(
    connection: ChannelConnection,
    actor: OutboundActor,
    code: string,
  ): Promise<void> {
    try {
      await connections.update(connection.organizationId, connection.id, (current) => {
        if (current.status !== 'connected') {
          throw new IntegrationError('invalid_transition', 'not_connected');
        }
        const at = now();
        const next: ChannelConnection = Object.freeze({
          ...current,
          status: 'error',
          statusReason: code,
          updatedAt: at.toISOString() as ChannelConnection['updatedAt'],
          updatedBy: actor.userId,
          revision: current.revision + 1,
        });
        return {
          connection: next,
          events: [
            connectionEventOf(actorOf(actor), next, 'channel.connection_failed', at, {
              result: 'failure',
              reason: code,
            }),
          ],
        };
      });
      logger?.warn('channel connection failed', {
        organizationId: connection.organizationId,
        connectionId: connection.id,
        provider: connection.provider,
        code,
      });
    } catch (error) {
      logger?.error('channel connection failure not recorded', {
        connectionId: connection.id,
        code: codeOf(error),
      });
    }
  }

  const engine: IntegrationEngine = {
    registry,

    async handshake(channel, connectionId, query) {
      const resolved = await resolveDelivery(channel, connectionId, acceptsHandshake);
      if ('refusal' in resolved) return resolved.refusal;
      const token = await secret(resolved.connection, 'verify_token');
      if (token.refusal !== undefined) return token.refusal;
      const challenge = resolved.adapter.handshake(query, token.value);
      if (challenge === undefined) {
        logger?.warn('webhook handshake refused', { connectionId: resolved.connection.id });
        return refuse(403, 'handshake_refused');
      }
      return Object.freeze({ status: 200, body: challenge });
    },

    async deliver(channel, connectionId, rawBody, headers) {
      const resolved = await resolveDelivery(channel, connectionId, acceptsInbound);
      if ('refusal' in resolved) return resolved.refusal;
      const { adapter, connection } = resolved;
      if (inbound === undefined) return refuse(503, 'unavailable');
      const appSecret = await secret(connection, 'app_secret');
      if (appSecret.refusal !== undefined) return appSecret.refusal;
      if (!adapter.verifySignature(rawBody, headers, appSecret.value)) {
        logger?.warn('webhook signature refused', { connectionId: connection.id });
        return refuse(401, 'invalid_signature');
      }
      let deliveries;
      try {
        deliveries = adapter.normalizeInbound(rawBody);
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
      const accountId = adapter.accountIdOf(connection.account);
      if (deliveries.some((d) => d.accountId !== accountId)) {
        logger?.warn('webhook account mismatch', { connectionId: connection.id });
        return refuse(403, 'account_mismatch');
      }
      const trace = {
        organizationId: connection.organizationId,
        connectionId: connection.id,
        channel: connection.channel,
        provider: connection.provider,
      };
      let received = 0;
      let duplicates = 0;
      let statuses = 0;
      try {
        for (const delivery of deliveries) {
          for (const message of delivery.messages) {
            // The provider's message id is the idempotency key: a repeat is the same message.
            const result = await inbound.receive({
              ...message,
              organizationId: connection.organizationId,
              connectionId: connection.id,
            });
            if (result.duplicate) {
              duplicates += 1;
              continue;
            }
            received += 1;
            logger?.info('inbound message stored', {
              ...trace,
              conversationId: result.conversation.id,
              messageId: result.message.id,
            });
            await audit?.record(
              buildAuditEvent(
                {
                  action: 'conversation.message_received',
                  result: 'success',
                  // The contact is not a user: the channel's signature is the only authority.
                  actor: { type: 'anonymous' },
                  organizationId: connection.organizationId,
                  target: { type: 'message', id: result.message.id },
                  reference: `conversation:${result.conversation.id}`,
                  reason: connection.channel,
                  source: 'api',
                },
                now(),
              ),
            );
          }
          for (const status of delivery.statuses) {
            const { applied } = await inbound.applyStatus({
              ...status,
              organizationId: connection.organizationId,
              connectionId: connection.id,
            });
            if (applied) statuses += 1;
          }
        }
      } catch (error) {
        // Stored so far stays stored; the provider retries and the repeat changes nothing.
        logger?.error('webhook storage failed', { ...trace, code: codeOf(error) });
        return refuse(503, 'unavailable');
      }
      logger?.info('webhook delivered', { ...trace, received, duplicates, statuses });
      return Object.freeze({
        status: 200,
        body: Object.freeze({ received, duplicates, statuses }),
      });
    },

    async availability(query) {
      const found = await availabilityOf(query);
      return 'code' in found ? found.code : undefined;
    },

    async send(request) {
      const trace = {
        organizationId: request.organizationId,
        connectionId: request.connectionId,
        channel: request.channel,
        conversationId: request.conversation.id,
        ...request.trace,
      };
      const found = await availabilityOf(request);
      if ('code' in found) {
        logger?.info('outbound refused', { ...trace, code: found.code });
        return { status: 'refused', code: found.code };
      }
      const { adapter, connection } = found;
      if (request.message.text.length > connection.capabilities.maxOutboundTextLength) {
        return { status: 'refused', code: 'invalid_message' };
      }
      try {
        adapter.normalizeOutbound(request.message);
      } catch {
        return { status: 'refused', code: 'invalid_message' };
      }
      let accessToken: string;
      try {
        accessToken = await readSecret(connection, 'access_token');
      } catch {
        // Nothing left MelonOffice: the credential could not be read.
        logger?.warn('outbound refused', { ...trace, code: 'secret_unavailable' });
        return { status: 'refused', code: 'channel_not_available' };
      }
      const last = await request.lastCheck?.();
      if (last !== undefined) return { status: 'refused', code: last };
      try {
        const { externalMessageId } = await adapter.send(
          connection,
          { accessToken },
          request.message,
        );
        logger?.info('outbound sent', { ...trace, provider: connection.provider, status: 'sent' });
        return { status: 'sent', externalMessageId };
      } catch (error) {
        if (
          isIntegrationError(error) &&
          error.code === 'provider_rejected' &&
          error.detail === 'channel_unauthorized'
        ) {
          await recordCredentialFailure(connection, request.actor, 'channel_unauthorized');
        }
        logger?.warn('outbound failed', {
          ...trace,
          provider: connection.provider,
          code: codeOf(error),
        });
        return { status: 'failed', error };
      }
    },

    async validate(connection): Promise<ConnectionCheck> {
      const adapter = adapterOf(connection);
      if (adapter === undefined) return { status: 'invalid', code: 'provider_not_available' };
      let accessToken: string;
      try {
        // All three must exist before the connection is used; only the token is sent.
        await readSecret(connection, 'app_secret');
        await readSecret(connection, 'verify_token');
        accessToken = await readSecret(connection, 'access_token');
      } catch (error) {
        const code = isIntegrationError(error) ? error.code : 'secret_unavailable';
        return code === 'secret_not_found'
          ? { status: 'invalid', code }
          : { status: 'unavailable', code: 'secret_unavailable' };
      }
      const check = await adapter.validateConnection(connection, { accessToken });
      logger?.info('connection checked', {
        organizationId: connection.organizationId,
        connectionId: connection.id,
        provider: connection.provider,
        status: check.status,
        ...(check.status === 'valid' ? {} : { code: check.code }),
      });
      return check;
    },
  };
  return Object.freeze(engine);
}

/** A stable code for a log line: never a message, a stack or a payload. */
function codeOf(error: unknown): string {
  if (isIntegrationError(error)) return error.code;
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : 'unexpected';
}
