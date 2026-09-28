import { actorOf, buildAuditEvent, type AuditEvent, type AuditService } from '@melonoffice/audit';
import {
  ConversationError,
  isClientMessageId,
  isConversationId,
  newOutboundMessage,
  personMaySend,
  type ConversationRepository,
  type OutboundSettlement,
} from '@melonoffice/conversations';
import type {
  Conversation,
  ConversationId,
  Execution,
  Message,
  MessageId,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import { executionIdFor, isExecutionError, type ExecutionService } from '@melonoffice/execution';
import type { Logger } from '@melonoffice/observability';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import {
  MESSAGE_SEND_TOOL,
  type ToolExecutionContext,
  type ToolExecutor,
  type ToolExecutorOutcome,
  type ToolResult,
} from '@melonoffice/tools';
import type { IntegrationEngine } from './engine.js';
import { isIntegrationError } from './errors.js';

/**
 * A person's reply in a conversation (CV-2, ADR-0034). There is one way out of MelonOffice for
 * it: the tool gate, with the `message_send` tool, invoked by the person directly. This module
 * holds the two halves the gate does not: the executor the gate calls, and the synchronous
 * flow around the gate (reserve the message, create and start its execution, invoke, settle).
 * Neither decides who may send: RBAC and the gate do.
 */

export const MESSAGE_SEND = MESSAGE_SEND_TOOL.versions[0] as NonNullable<
  (typeof MESSAGE_SEND_TOOL.versions)[0]
>;
/** The one node of a send's execution. */
export const SEND_NODE = 'send';

/** The audit event of a settled send: who, which message, in which conversation, and how. */
export function messageEventOf(
  userId: UserId,
  organizationId: OrganizationId,
  message: Pick<Message, 'id' | 'conversationId' | 'channel'>,
  settlement: OutboundSettlement | { readonly status: 'denied'; readonly failureCode: string },
  at: Date,
  requestId?: string,
  /** An agent's reply (CV-6B): the runtime sent it for `userId`, with this tool version. */
  agent?: { readonly toolVersion: number },
): AuditEvent {
  return buildAuditEvent(
    {
      action:
        settlement.status === 'sent'
          ? 'conversation.message_sent'
          : settlement.status === 'unknown'
            ? 'conversation.message_send_unknown'
            : 'conversation.message_send_failed',
      result:
        settlement.status === 'sent'
          ? 'success'
          : settlement.status === 'denied'
            ? 'denied'
            : 'failure',
      actor:
        agent === undefined
          ? { type: 'user', userId, via: 'direct' }
          : actorOf({ actor: 'runtime', userId }),
      organizationId,
      target: { type: 'message', id: message.id },
      reference: `conversation:${message.conversationId}`,
      reason: settlement.status === 'sent' ? message.channel : settlement.failureCode,
      tool: { id: MESSAGE_SEND.toolId, version: agent?.toolVersion ?? MESSAGE_SEND.version },
      ...(requestId === undefined ? {} : { requestId }),
      source: 'api',
    },
    at,
  );
}

/**
 * What a provider's refusal means for the message. `failed`: nothing was sent, and the code says
 * why. `unknown`: the provider may have accepted it; it is never sent again blindly.
 */
export function settlementOfError(error: unknown): OutboundSettlement {
  if (!isIntegrationError(error)) return { status: 'unknown', failureCode: 'outcome_unknown' };
  switch (error.code) {
    case 'provider_rejected':
      return { status: 'failed', failureCode: error.detail ?? 'provider_rejected' };
    case 'invalid_outbound':
      return { status: 'failed', failureCode: 'invalid_message' };
    case 'provider_unavailable':
      if (error.detail === 'rate_limited') return { status: 'failed', failureCode: 'rate_limited' };
      if (error.detail === 'graph_api_version') {
        return { status: 'failed', failureCode: 'channel_not_available' };
      }
      return { status: 'unknown', failureCode: 'outcome_unknown' };
    default:
      return { status: 'unknown', failureCode: 'outcome_unknown' };
  }
}

/** The `message_send` versions an agent's reply uses (CV-6B, ADR-0043): never a person's. */
export const AGENT_REPLY_VERSIONS: readonly number[] = [2, 3];

/**
 * Whether an agent's reply may still go out, read at the moment of sending (CV-6B, ADR-0043):
 * the conversation is still the agent's, under the control its turn started with, the turn is
 * still the latest, and the agent is within its limits. A refusal code, or `undefined`.
 */
export interface AgentReplyCheck {
  refusalOf(
    context: ToolExecutionContext,
    conversation: Conversation,
    message: Message,
  ): Promise<string | undefined>;
}

export interface ChannelMessageExecutorOptions {
  readonly conversations: ConversationRepository;
  /** The Integration Engine (ADR-0044): the only way the executor reaches a provider. */
  readonly engine: Pick<IntegrationEngine, 'send'>;
  /** Checks agents' replies. Without it, the runtime's versions are refused. */
  readonly agentReplies?: AgentReplyCheck;
  readonly now?: () => Date;
}

/**
 * The executor of `message_send` (provider `channel`). The gate calls it only after its checks
 * passed, with context built from verified data. Everything it sends is read again here, in the
 * context's organization: the reserved message (the person's own, or the agent's for this turn,
 * still `queued`), its conversation and the recipient's identity. The Integration Engine then
 * checks the connection (lifecycle, capability, the channel's window) and reads the access token
 * at that moment, used once and dropped (ADR-0044). It settles the message itself, with its
 * audit event, in one write: `sent` with the provider's id, or `failed`/`unknown`.
 */
export function createChannelMessageExecutor(options: ChannelMessageExecutorOptions): ToolExecutor {
  const { conversations, engine, agentReplies, now = () => new Date() } = options;

  return {
    async execute(context: ToolExecutionContext, input: unknown): Promise<ToolExecutorOutcome> {
      // A person's own call to version 1, or the runtime's call to an agent's version (CV-6B).
      // Anything else is refused before any read.
      const agent = context.actor.via === 'runtime';
      if (context.toolId !== MESSAGE_SEND.toolId) {
        return { status: 'failure', code: 'tool_not_human_invokable' };
      }
      if (
        !agent &&
        (context.actor.via !== 'direct' || context.toolVersion !== MESSAGE_SEND.version)
      ) {
        return { status: 'failure', code: 'tool_not_human_invokable' };
      }
      if (
        agent &&
        (agentReplies === undefined ||
          !AGENT_REPLY_VERSIONS.includes(context.toolVersion) ||
          context.specialistId === undefined)
      ) {
        return { status: 'failure', code: 'tool_not_runtime_invokable' };
      }
      const { conversationId, messageId } = input as {
        readonly conversationId: ConversationId;
        readonly messageId: MessageId;
      };
      const organizationId = context.organizationId;
      const userId = context.actor.userId;
      const message = await conversations.findMessage(organizationId, messageId);
      if (
        message === undefined ||
        message.direction !== 'outbound' ||
        message.status !== 'queued' ||
        message.conversationId !== conversationId ||
        !(agent
          ? message.sender.kind === 'specialist' &&
            message.sender.specialistId === context.specialistId &&
            message.sender.executionId === context.executionId
          : message.sender.kind === 'user' && message.sender.userId === userId) ||
        message.text === undefined
      ) {
        return { status: 'failure', code: 'message_not_sendable' };
      }

      const settle = async (settlement: OutboundSettlement): Promise<ToolExecutorOutcome> => {
        const at = now();
        await conversations.settleOutbound(
          organizationId,
          message.id,
          settlement,
          [
            messageEventOf(
              userId,
              organizationId,
              message,
              settlement,
              at,
              context.requestId,
              agent ? { toolVersion: context.toolVersion } : undefined,
            ),
          ],
          at,
        );
        return settlement.status === 'sent'
          ? { status: 'success', output: { messageId: message.id, status: 'sent' } }
          : { status: 'failure', code: settlement.failureCode };
      };
      const refuse = (failureCode: string) => settle({ status: 'failed', failureCode });

      const conversation = await conversations.findConversation(organizationId, conversationId);
      if (conversation === undefined || conversation.connectionId !== message.connectionId) {
        return refuse('conversation_not_found');
      }
      if (conversation.status === 'closed') return refuse('conversation_closed');
      if (agent) {
        // Read now, just before sending: a person who took control is never overtaken (CV-6B).
        const refusal = await agentReplies?.refusalOf(context, conversation, message);
        if (refusal !== undefined) return refuse(refusal);
      } else if (!personMaySend(conversation)) {
        // An agent took the conversation while the person's message waited (CV-6A): not sent.
        return refuse('conversation_handled_by_ai');
      }
      const identity = await conversations.findIdentity(
        organizationId,
        conversation.channelIdentityId,
      );
      if (identity === undefined || identity.channel !== conversation.channel) {
        return refuse('channel_not_available');
      }
      const result = await engine.send({
        organizationId,
        connectionId: conversation.connectionId,
        channel: conversation.channel,
        conversation,
        message: {
          to: identity.externalId,
          text: message.text,
          ...(context.idempotencyKey === undefined
            ? {}
            : { idempotencyKey: context.idempotencyKey }),
        },
        actor: { actor: agent ? 'runtime' : 'user', userId },
        trace: {
          messageId: message.id,
          executionId: context.executionId,
          nodeId: context.nodeId,
          toolCallId: context.idempotencyKey,
          agentId: context.specialistId,
          requestId: context.requestId,
        },
        ...(agent
          ? {
              // Checked again as the very last step before the provider is called (CV-6B): a
              // person who took control while the channel was being prepared is never overtaken.
              lastCheck: async () => {
                const latest = await conversations.findConversation(organizationId, conversationId);
                return latest === undefined
                  ? 'conversation_not_found'
                  : agentReplies?.refusalOf(context, latest, message);
              },
            }
          : {}),
      });
      if (result.status === 'refused') return refuse(result.code);
      if (result.status === 'failed') return settle(settlementOfError(result.error));
      const { externalMessageId } = result;
      return settle({ status: 'sent', externalMessageId });
    },
  };
}

/** What a person sends: their own key for the message, and its text. Nothing else. */
export interface SendRequest {
  readonly clientMessageId: unknown;
  readonly text: unknown;
}

/** The message as it is after the send, and whether this call created it. */
export interface SendOutcome {
  readonly message: Message;
  /** False when the same key had already been sent (or tried): the stored message, unchanged. */
  readonly created: boolean;
}

/** The part of the tool gate this flow uses. */
export interface ToolInvoker {
  invoke(
    tenant: TenantContext,
    invocation: { readonly executionId: string; readonly nodeId: string; readonly input: unknown },
  ): Promise<ToolResult>;
}

export interface MessageSendServiceOptions {
  readonly conversations: ConversationRepository;
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly executions: Pick<ExecutionService, 'create' | 'get' | 'start'>;
  readonly gate: ToolInvoker;
  /** Asked before a message is reserved: whether its connection could send now (ADR-0044). */
  readonly channels: Pick<IntegrationEngine, 'availability'>;
  /** Records refusals made before a message is reserved. */
  readonly audit: AuditService;
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly requestId?: string;
}

export interface MessageSendService {
  /**
   * Sends a person's text in a conversation of their organization, synchronously, through the
   * tool gate. The organization, the sender, the recipient and the channel all come from the
   * tenant and the stored conversation. The same `clientMessageId` is the same message: a repeat
   * returns it as it is, and never sends it twice.
   */
  send(tenant: TenantContext, conversationId: string, request: SendRequest): Promise<SendOutcome>;
}

/** Gate denials that mean another attempt of the same message holds it. */
const HELD = new Set(['node_not_pending', 'execution_not_running']);
/** Gate denials that mean the person may not use the tool at all. */
const NOT_HUMAN = new Set(['runtime_only', 'tool_not_human_invokable', 'specialist_execution']);

export function createMessageSendService(options: MessageSendServiceOptions): MessageSendService {
  const {
    conversations,
    organizations,
    authorization,
    executions,
    gate,
    channels,
    audit,
    logger,
    now = () => new Date(),
    requestId,
  } = options;
  const log = (event: string, fields: Record<string, unknown>) =>
    logger?.info(event, { ...fields, ...(requestId === undefined ? {} : { requestId }) });

  /** The person's organization, once every permission the send needs is held. */
  async function organizationOf(tenant: TenantContext): Promise<OrganizationId> {
    if (!isResolvedTenant(tenant)) throw new ConversationError('unresolved_tenant');
    // A person acting directly: never GIA, never the runtime (ADR-0034).
    if (tenant.actor !== 'user') throw new ConversationError('requires_user');
    // Everything the send will be checked for, asked up front so that nothing is reserved for
    // a send that cannot happen. The gate and the execution service check again.
    for (const permission of ['conversation.send', 'tool.execute', 'execution.start']) {
      if (!authorization.authorize(tenant, permission).allowed) {
        throw new ConversationError('permission_denied');
      }
    }
    const organization = await organizations.findOrganization(tenant.organizationId);
    if (organization?.id !== tenant.organizationId || organization.status !== 'active') {
      throw new ConversationError('organization_inactive');
    }
    return organization.id;
  }

  /** The send's execution: one per message, created once, whoever asks again. */
  async function executionOf(
    tenant: TenantContext,
    organizationId: OrganizationId,
    message: Message,
  ): Promise<Execution> {
    const key = `message:${message.id}`;
    const id = executionIdFor(organizationId, key);
    const existing = await executions.get(tenant, id).catch((error: unknown) => {
      if (isExecutionError(error) && error.code === 'execution_not_found') return undefined;
      throw error;
    });
    if (existing !== undefined) return existing;
    try {
      return await executions.create(tenant, {
        mode: 'execute',
        input: { type: 'message', id: message.id },
        versionSnapshot: {
          schemaVersion: 1,
          components: [
            { kind: 'tool', id: MESSAGE_SEND.toolId, version: String(MESSAGE_SEND.version) },
          ],
        },
        nodes: [
          {
            id: SEND_NODE,
            type: 'tool',
            label: MESSAGE_SEND.toolId,
            input: { type: 'message', id: message.id },
            tool: { id: MESSAGE_SEND.toolId, version: MESSAGE_SEND.version },
          },
        ],
        idempotencyKey: key,
      });
    } catch (error) {
      // Created concurrently by a repeat of the same send: use that one.
      const raced = await executions.get(tenant, id).catch(() => undefined);
      if (raced !== undefined) return raced;
      throw error;
    }
  }

  async function settle(
    tenant: TenantContext & { readonly userId: UserId },
    organizationId: OrganizationId,
    message: Message,
    settlement: OutboundSettlement,
  ): Promise<Message> {
    const at = now();
    const { message: current } = await conversations.settleOutbound(
      organizationId,
      message.id,
      settlement,
      [messageEventOf(tenant.userId, organizationId, message, settlement, at, requestId)],
      at,
    );
    return current ?? message;
  }

  /**
   * The message after the gate answered. The executor settles what it sent or refused; what is
   * still `queued` here was never settled: a denial before anything left (failed), another
   * attempt still running (left as it is), or an outcome nobody learned (unknown).
   */
  async function afterGate(
    tenant: TenantContext & { readonly userId: UserId },
    organizationId: OrganizationId,
    message: Message,
    result: ToolResult,
    execution: Execution,
  ): Promise<Message> {
    const current = (await conversations.findMessage(organizationId, message.id)) ?? message;
    if (current.status !== 'queued') return current;
    if (result.status === 'denied' && HELD.has(result.code)) {
      const fresh = await executions.get(tenant, execution.id).catch(() => execution);
      const node = fresh.nodes.find((n) => n.id === SEND_NODE);
      const startedAt = node?.startedAt === undefined ? undefined : Date.parse(node.startedAt);
      const running =
        node?.status === 'running' &&
        startedAt !== undefined &&
        now().getTime() - startedAt < MESSAGE_SEND.timeoutMs;
      if (running) throw new ConversationError('duplicate_request');
      if (node?.status === 'pending' && fresh.status === 'running') {
        throw new ConversationError('duplicate_request');
      }
      // Started and never settled: it may have gone out. Never sent again blindly.
      return settle(tenant, organizationId, current, {
        status: 'unknown',
        failureCode: 'outcome_unknown',
      });
    }
    if (result.status === 'denied') {
      log('tool_gate_human_denied', { reason: result.code, messageId: message.id });
      return settle(tenant, organizationId, current, {
        status: 'failed',
        failureCode: NOT_HUMAN.has(result.code) ? 'tool_not_human_invokable' : result.code,
      });
    }
    if (result.status === 'failure' && result.code === 'executor_unavailable') {
      return settle(tenant, organizationId, current, {
        status: 'failed',
        failureCode: 'channel_not_available',
      });
    }
    // A timeout, an executor that threw, or an answer lost on the way: nobody knows.
    return settle(tenant, organizationId, current, {
      status: 'unknown',
      failureCode: 'outcome_unknown',
    });
  }

  const service: MessageSendService = {
    async send(tenant, conversationId, request) {
      const organizationId = await organizationOf(tenant);
      const user = tenant as TenantContext & { readonly userId: UserId };
      const { clientMessageId, text } = request;
      if (!isClientMessageId(clientMessageId) || typeof text !== 'string') {
        throw new ConversationError('invalid_request', 'message');
      }
      if (!isConversationId(conversationId)) throw new ConversationError('conversation_not_found');
      const conversation = await conversations.findConversation(organizationId, conversationId);
      if (conversation === undefined) throw new ConversationError('conversation_not_found');

      // Built first, so a malformed text is refused before anything else is decided.
      const candidate = newOutboundMessage(
        { organizationId, conversation, userId: user.userId, clientMessageId, text },
        now(),
      );
      const id = candidate.id;
      const stored = await conversations.findMessage(organizationId, id);
      if (stored !== undefined && stored.text !== text) {
        // The same key names one message: a different text under it is refused, never sent.
        throw new ConversationError('duplicate_request');
      }
      // Already settled by an earlier attempt: answered as it is, never sent again.
      if (stored !== undefined && stored.status !== 'queued') {
        return { message: stored, created: false };
      }

      const fields = { organizationId, conversationId: conversation.id, messageId: id };
      log('human_message_send_attempt', { ...fields, channel: conversation.channel });
      let message = stored;
      if (message === undefined) {
        // Refusals that need no attempt: nothing is reserved, nothing leaves.
        const refusal =
          conversation.status === 'closed'
            ? 'conversation_closed'
            : !personMaySend(conversation)
              ? 'conversation_handled_by_ai'
              : await channels.availability({
                  organizationId,
                  connectionId: conversation.connectionId,
                  channel: conversation.channel,
                  conversation,
                });
        if (refusal !== undefined) {
          await audit.record(
            messageEventOf(
              user.userId,
              organizationId,
              { id, conversationId: conversation.id, channel: conversation.channel },
              { status: 'denied', failureCode: refusal },
              now(),
              requestId,
            ),
          );
          log('human_message_send_failure', { ...fields, code: refusal });
          throw new ConversationError(refusal);
        }
        const reserved = await conversations.reserveOutbound(candidate);
        message = reserved.message;
        if (message.text !== text) throw new ConversationError('duplicate_request');
        if (message.status !== 'queued') return { message, created: false };
      }

      const execution = await executionOf(tenant, organizationId, message);
      if (execution.status === 'pending') await executions.start(tenant, execution.id);
      const result = await gate.invoke(tenant, {
        executionId: execution.id,
        nodeId: SEND_NODE,
        input: { conversationId: conversation.id, messageId: message.id },
      });
      const settled = await afterGate(user, organizationId, message, result, execution);
      log(
        settled.status === 'sent'
          ? 'human_message_send_success'
          : settled.status === 'unknown'
            ? 'human_message_send_unknown'
            : 'human_message_send_failure',
        {
          ...fields,
          status: settled.status,
          ...(settled.failureCode === undefined ? {} : { code: settled.failureCode }),
        },
      );
      return { message: settled, created: stored === undefined };
    },
  };
  return Object.freeze(service);
}
