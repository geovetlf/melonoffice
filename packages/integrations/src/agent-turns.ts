import { promptLabel, type AIRequest } from '@melonoffice/ai-gateway';
import type { AuditService } from '@melonoffice/audit';
import {
  AGENT_DECISION_SCHEMA,
  agentReplyKeyOf,
  agentTurnMessages,
  allowsAIHandling,
  buildAssistContext,
  checkAutoSend,
  controlOf,
  isConversationError,
  newAgentOutboundMessage,
  outboundMessageIdFor,
  parseAgentDecision,
  REPLY_TOOL_VERSIONS,
  stricterAutonomy,
  TURN_CONTROL_KIND,
  TURN_NODES,
  type AgentDecision,
  type ConversationAgentCheck,
  type ConversationIngress,
  type ConversationRepository,
  type ConversationService,
  type HandoffReason,
  type ReceiveResult,
  AGENT_TURN_PROMPT,
} from '@melonoffice/conversations';
import type {
  AutonomyLevel,
  Conversation,
  ConversationAgentProfile,
  ConversationId,
  Execution,
  ExecutionId,
  ExecutionNode,
  Message,
  MessageId,
  OrganizationId,
  Specialist,
  SpecialistConfiguration,
  SpecialistId,
  SpecialistVersion,
} from '@melonoffice/domain';
import {
  executionIdFor,
  isExecutionError,
  type AgentOutputStore,
  type ExecutionRepository,
  type ExecutionService,
  type VerificationInput,
} from '@melonoffice/execution';
import type { Logger } from '@melonoffice/observability';
import {
  isResolvedTenant,
  resolveRuntimeTenant,
  type TenancyStore,
  type TenantContext,
} from '@melonoffice/tenancy';
import {
  CONVERSATION_HANDOFF_TOOL,
  MESSAGE_SEND_TOOL,
  type ToolExecutionContext,
  type ToolExecutor,
  type ToolExecutorOutcome,
} from '@melonoffice/tools';
import { messageEventOf, type AgentReplyCheck } from './outbound.js';
import type { IntegrationEngine } from './engine.js';

/**
 * An agent's turn on a conversation (CV-6B, ADR-0043), on the existing engines only: the turn is
 * an execution of the organization's agent (a specialist), the runtime drives it one node at a
 * time, the model is reached only through the AI Gateway and every effect only through the tool
 * gate. This module holds the conversation-specific pieces those engines ask for: when a turn
 * starts, what each node works on, what the tools check at the moment they act, how a turn is
 * verified and what happens when it stops. None of them decides who may act: RBAC, the gate and
 * the conversation control do.
 */

const HANDOFF = CONVERSATION_HANDOFF_TOOL.versions[0] as NonNullable<
  (typeof CONVERSATION_HANDOFF_TOOL.versions)[0]
>;

/** A turn's call to the model: small, confidential, with a closed answer. */
export const AGENT_TURN_TASK = 'conversation_agent_turn';
export const AGENT_TURN_MAX_OUTPUT_TOKENS = 600;

/** The specialists this module reads: never written here. */
export interface AgentSpecialists {
  find(organizationId: OrganizationId, id: SpecialistId): Promise<Specialist | undefined>;
  findVersion(
    organizationId: OrganizationId,
    id: SpecialistId,
    version: number,
  ): Promise<SpecialistVersion | undefined>;
}

/** What a turn's execution says about its conversation. Only from the stored execution. */
export interface TurnFacts {
  readonly conversationId: ConversationId;
  /** The control epoch the turn started under. */
  readonly epoch: number;
  /** The inbound message the turn answers. */
  readonly inboundMessageId: MessageId;
  readonly specialistId: SpecialistId;
  readonly specialistVersion: number;
}

/** A turn's facts, or `undefined` for any execution that is not a conversation turn. */
export function turnOf(execution: Execution): TurnFacts | undefined {
  const control = execution.versionSnapshot.components.find((c) => c.kind === TURN_CONTROL_KIND);
  if (
    control === undefined ||
    execution.input.type !== 'message' ||
    execution.specialistId === undefined ||
    execution.specialistVersion === undefined
  ) {
    return undefined;
  }
  const epoch = Number(control.version);
  if (!Number.isSafeInteger(epoch) || epoch < 0) return undefined;
  return Object.freeze({
    conversationId: control.id as ConversationId,
    epoch,
    inboundMessageId: execution.input.id as MessageId,
    specialistId: execution.specialistId,
    specialistVersion: execution.specialistVersion,
  });
}

/** The reply tool version each level uses. Only `supervised` and `autonomous` have one. */
const replyVersionOf = (autonomy: AutonomyLevel): number | undefined =>
  autonomy === 'supervised' || autonomy === 'autonomous'
    ? REPLY_TOOL_VERSIONS[autonomy]
    : undefined;

/** Whether a specialist's configuration lists a tool at exactly that version. */
const hasTool = (specialist: Pick<Specialist, 'configuration'>, id: string, version: number) =>
  specialist.configuration.tools.some((t) => t.id === id && t.version === version);

/** The replies an agent already sent or holds in a conversation (failed ones do not count). */
export const agentRepliesIn = (messages: readonly Message[], agentId: SpecialistId): number =>
  messages.filter(
    (m) =>
      m.direction === 'outbound' &&
      m.sender.kind === 'specialist' &&
      m.sender.specialistId === agentId &&
      m.status !== 'failed',
  ).length;

/**
 * Why a turn may no longer act, read from the stored conversation now: `undefined` while the
 * conversation is still the agent's under the turn's control epoch and the turn still answers
 * the latest customer message.
 */
async function staleness(
  conversations: Pick<ConversationRepository, 'findConversation' | 'findMessage'>,
  organizationId: OrganizationId,
  turn: TurnFacts,
  autonomy: AutonomyLevel,
): Promise<{ readonly code: string } | { readonly conversation: Conversation }> {
  const conversation = await conversations.findConversation(organizationId, turn.conversationId);
  if (conversation === undefined) return { code: 'conversation_not_found' };
  const check = checkAutoSend(conversation, autonomy, turn.epoch);
  if (!check.allowed) return { code: check.code };
  const inbound = await conversations.findMessage(organizationId, turn.inboundMessageId);
  if (
    inbound === undefined ||
    inbound.conversationId !== conversation.id ||
    inbound.direction !== 'inbound'
  ) {
    return { code: 'input_unavailable' };
  }
  // A newer customer message has its own turn: this one steps aside, it never answers twice.
  if (conversation.lastInboundAt !== undefined && inbound.sentAt < conversation.lastInboundAt) {
    return { code: 'superseded' };
  }
  return { conversation };
}

/**
 * An agent's conversation profile at its level of autonomy (AE-4.4, ADR-0116): an agent that only
 * proposes never sends a reply by itself, whatever its profile says, so its replies wait on a
 * person (`supervised`). The other levels leave the profile as it is.
 */
const profileAtLevel = (
  configuration: Pick<SpecialistConfiguration, 'conversation' | 'autonomy'> | undefined,
): ConversationAgentProfile | undefined => {
  const profile = configuration?.conversation;
  if (profile === undefined || configuration?.autonomy !== 'propose') return profile;
  return Object.freeze({ ...profile, autonomy: 'supervised' as const });
};

/** The level a turn acts at now: the organization's and the agent's, whichever is stricter. */
async function autonomyOf(
  conversations: Pick<ConversationRepository, 'findSettings'>,
  organizationId: OrganizationId,
  agent: ConversationAgentProfile | undefined,
  agentId: SpecialistId,
): Promise<{ readonly autonomy: AutonomyLevel } | { readonly code: string }> {
  const settings = await conversations.findSettings(organizationId);
  if (settings === undefined || !allowsAIHandling(settings.autonomy)) {
    return { code: 'autonomy_not_enabled' };
  }
  // The organization changed or removed its agent: this one's turns stop.
  if (settings.agentId !== agentId || agent === undefined) return { code: 'agent_changed' };
  return { autonomy: stricterAutonomy(settings.autonomy, agent.autonomy) };
}

// ---------------------------------------------------------------------------------------------
// Starting a turn

export type AgentTurnOutcome =
  | { readonly status: 'started'; readonly executionId: ExecutionId; readonly created: boolean }
  | { readonly status: 'escalated'; readonly code: string }
  | { readonly status: 'skipped'; readonly code: string };

/** The part of the runtime that queues a started execution's first node. */
export interface TurnKickoff {
  kickoff(tenant: TenantContext, executionId: string, correlationId?: string): Promise<unknown>;
}

export interface AgentTurnTriggerOptions {
  readonly conversations: ConversationRepository;
  /** The conversations service, for the agent's assignment and hand-off. */
  readonly conversationService: Pick<ConversationService, 'assignAgent' | 'escalate'>;
  readonly specialists: Pick<AgentSpecialists, 'find'>;
  readonly executions: Pick<ExecutionService, 'create' | 'get' | 'runtimeStart'>;
  readonly tenancy: TenancyStore;
  /** Queues the turn's first job. Without it, a started turn waits in the queue. */
  readonly runtime?: TurnKickoff;
  /**
   * The Integration Engine (ADR-0044), asked whether the conversation's connection could send a
   * reply before any model is asked: a turn that could not answer spends nothing and goes to a
   * person. Absent: the send itself refuses, later.
   */
  readonly channels?: Pick<IntegrationEngine, 'availability'>;
  readonly audit: AuditService;
  readonly logger?: Logger;
  readonly now?: () => Date;
  readonly requestId?: string;
}

export interface AgentTurnTrigger {
  /**
   * After an inbound message was stored: starts the organization's agent's turn on it, when the
   * organization has an agent, allows AI handling, and the conversation is the agent's. A repeat
   * delivery of the same message is the same turn: nothing is started twice.
   */
  afterReceive(result: ReceiveResult): Promise<AgentTurnOutcome>;
}

export function createAgentTurnTrigger(options: AgentTurnTriggerOptions): AgentTurnTrigger {
  const {
    conversations,
    conversationService,
    specialists,
    executions,
    tenancy,
    runtime,
    channels,
    audit,
    logger,
    requestId,
  } = options;
  const skipped = (code: string): AgentTurnOutcome => Object.freeze({ status: 'skipped', code });
  const log = (event: string, fields: Record<string, unknown>) =>
    logger?.info(event, { ...fields, ...(requestId === undefined ? {} : { requestId }) });

  async function executionOf(
    tenant: TenantContext,
    organizationId: OrganizationId,
    conversation: Conversation,
    message: Message,
    specialist: Specialist,
    replyVersion: number,
  ): Promise<{ execution: Execution; created: boolean }> {
    const key = `conversation-turn:${message.id}`;
    const id = executionIdFor(organizationId, key);
    const existing = await executions.get(tenant, id).catch((error: unknown) => {
      if (isExecutionError(error) && error.code === 'execution_not_found') return undefined;
      throw error;
    });
    if (existing !== undefined) return { execution: existing, created: false };
    const agentId = specialist.identity.id;
    const conversationRef = { type: 'conversation', id: conversation.id };
    try {
      const execution = await executions.create(tenant, {
        mode: 'execute',
        input: { type: 'message', id: message.id },
        specialistId: agentId,
        specialistVersion: specialist.version,
        departmentId: specialist.configuration.departmentId,
        versionSnapshot: {
          schemaVersion: 1,
          components: [
            { kind: 'specialist', id: agentId, version: String(specialist.version) },
            {
              kind: TURN_CONTROL_KIND,
              id: conversation.id,
              version: String(controlOf(conversation).epoch),
            },
            { kind: 'tool', id: MESSAGE_SEND_TOOL.id, version: String(replyVersion) },
            { kind: 'tool', id: HANDOFF.toolId, version: String(HANDOFF.version) },
          ],
        },
        nodes: [
          { id: TURN_NODES.decide, type: 'agent', label: 'decide', input: conversationRef },
          {
            id: TURN_NODES.reply,
            type: 'tool',
            label: MESSAGE_SEND_TOOL.id,
            input: conversationRef,
            dependsOn: [TURN_NODES.decide],
            tool: { id: MESSAGE_SEND_TOOL.id, version: replyVersion },
          },
          {
            id: TURN_NODES.handoff,
            type: 'tool',
            label: HANDOFF.toolId,
            input: conversationRef,
            dependsOn: [TURN_NODES.decide],
            tool: { id: HANDOFF.toolId, version: HANDOFF.version },
          },
        ],
        idempotencyKey: key,
      });
      return { execution, created: true };
    } catch (error) {
      // Created concurrently by a repeat delivery of the same message: that one is the turn.
      const raced = await executions.get(tenant, id).catch(() => undefined);
      if (raced !== undefined) return { execution: raced, created: false };
      throw error;
    }
  }

  return Object.freeze({
    async afterReceive(result: ReceiveResult): Promise<AgentTurnOutcome> {
      if (result.duplicate) return skipped('duplicate');
      const { message } = result;
      let conversation = result.conversation;
      if (message.direction !== 'inbound') return skipped('not_inbound');
      const organizationId = conversation.organizationId;
      const settings = await conversations.findSettings(organizationId);
      if (settings?.agentId === undefined) return skipped('no_agent');
      if (!allowsAIHandling(settings.autonomy)) return skipped('autonomy_not_enabled');
      const agentId = settings.agentId;
      const fields = { organizationId, conversationId: conversation.id, agentId };

      const specialist = await specialists.find(organizationId, agentId);
      const profile = profileAtLevel(specialist?.configuration);
      if (
        specialist === undefined ||
        specialist.status !== 'active' ||
        profile === undefined ||
        !profile.channels.includes(conversation.channel)
      ) {
        log('agent_turn_skipped', { ...fields, code: 'agent_not_available' });
        return skipped('agent_not_available');
      }
      const autonomy = stricterAutonomy(settings.autonomy, profile.autonomy);
      const replyVersion = replyVersionOf(autonomy);
      if (
        replyVersion === undefined ||
        !hasTool(specialist, MESSAGE_SEND_TOOL.id, replyVersion) ||
        !hasTool(specialist, HANDOFF.toolId, HANDOFF.version)
      ) {
        // Nothing is asked of a model that could not act on its answer.
        log('agent_turn_skipped', { ...fields, code: 'agent_not_configured' });
        return skipped('agent_not_configured');
      }

      // The agent acts for the person who set up AI handling, through the runtime: never with
      // more than that person may do, and never after they lost access.
      let tenant: TenantContext;
      try {
        if (settings.updatedBy === undefined) throw new Error('no person');
        tenant = await resolveRuntimeTenant(settings.updatedBy, organizationId, tenancy);
      } catch {
        log('agent_turn_skipped', { ...fields, code: 'runtime_tenant_unavailable' });
        return skipped('runtime_tenant_unavailable');
      }

      // A conversation that just started, that nobody controls yet, becomes the agent's.
      if (result.newConversation && conversation.control === undefined) {
        try {
          conversation = await conversationService.assignAgent(tenant, conversation.id, {
            agentId,
          });
        } catch (error) {
          if (!isConversationError(error)) throw error;
          log('agent_turn_skipped', { ...fields, code: error.code });
          return skipped(error.code);
        }
      }
      const control = controlOf(conversation);
      if (conversation.status === 'closed') return skipped('conversation_closed');
      if (control.handledBy !== 'ai' || control.aiState !== 'active') {
        return skipped('conversation_handled_by_human');
      }

      const escalate = async (reason: HandoffReason, code: string): Promise<AgentTurnOutcome> => {
        try {
          await conversationService.escalate(tenant, conversation.id, {
            reason,
            epoch: control.epoch,
          });
        } catch (error) {
          if (!isConversationError(error)) throw error;
          return skipped(error.code);
        }
        log('agent_turn_escalated', { ...fields, code });
        return Object.freeze({ status: 'escalated', code });
      };

      // A reply that could not be sent is never asked of a model: no credits, a person answers.
      const channel = await channels?.availability({
        organizationId,
        connectionId: conversation.connectionId,
        channel: conversation.channel,
        conversation,
      });
      if (channel !== undefined) return escalate('channel_unavailable', channel);

      // The agent's limit in one conversation: past it, a person takes over.
      const messages = await conversations.listMessages(organizationId, conversation.id);
      if (agentRepliesIn(messages, agentId) >= profile.maxRepliesPerConversation) {
        return escalate('too_many_attempts', 'too_many_attempts');
      }

      const { execution, created } = await executionOf(
        tenant,
        organizationId,
        conversation,
        message,
        specialist,
        replyVersion,
      );
      if (execution.status === 'pending') await executions.runtimeStart(tenant, execution.id);
      if (created) {
        await audit.record({
          action: 'conversation.ai_turn_started',
          result: 'success',
          actor: { type: 'system', id: 'runtime', initiatedBy: tenant.userId, via: 'runtime' },
          organizationId,
          target: { type: 'conversation', id: conversation.id },
          reference: `execution:${execution.id}`,
          reason: autonomy,
          ...(requestId === undefined ? {} : { requestId }),
          source: 'api',
        });
      }
      if (runtime !== undefined) {
        try {
          await runtime.kickoff(tenant, execution.id, requestId);
        } catch (error) {
          // Already queued by an earlier delivery: the turn runs once.
          const code = (error as { code?: unknown }).code;
          if (code !== 'execution_in_progress') throw error;
        }
      }
      log('agent_turn_started', { ...fields, executionId: execution.id, autonomy, created });
      return Object.freeze({ status: 'started', executionId: execution.id, created });
    },
  });
}

// ---------------------------------------------------------------------------------------------
// What each node works on

/** The runtime's work-source port, as this module fills it (structurally: no runtime import). */
type TurnAIWork = Omit<AIRequest, 'requestId' | 'executionId' | 'nodeId' | 'specialistId'>;

export interface AgentTurnWork {
  toolInput(tenant: TenantContext, execution: Execution, node: ExecutionNode): Promise<unknown>;
  agentWork(
    tenant: TenantContext,
    execution: Execution,
    node: ExecutionNode,
  ): Promise<TurnAIWork | undefined>;
  needed(tenant: TenantContext, execution: Execution, node: ExecutionNode): Promise<boolean>;
}

export interface AgentTurnWorkOptions {
  readonly conversations: ConversationRepository;
  readonly specialists: AgentSpecialists;
  readonly outputs: Pick<AgentOutputStore, 'find'>;
  readonly now?: () => Date;
}

const organizationOfTenant = (tenant: TenantContext): OrganizationId | undefined =>
  isResolvedTenant(tenant) ? (tenant.organizationId as OrganizationId) : undefined;

export function createAgentTurnWork(options: AgentTurnWorkOptions): AgentTurnWork {
  const { conversations, specialists, outputs, now = () => new Date() } = options;

  /** The decision the turn's model gave, or `undefined` when it gave none. */
  async function decisionOf(
    tenant: TenantContext,
    execution: Execution,
  ): Promise<AgentDecision | undefined> {
    const decide = execution.nodes.find((n) => n.id === TURN_NODES.decide);
    if (decide?.status !== 'completed') return undefined;
    const record = await outputs.find(tenant, execution.id, TURN_NODES.decide);
    // The model answered but its answer is gone: a person takes over, nothing is guessed.
    if (record === undefined) return { action: 'handoff', reason: 'invalid_ai_output' };
    return parseAgentDecision(record.output);
  }

  async function profileOf(organizationId: OrganizationId, turn: TurnFacts) {
    const version = await specialists.findVersion(
      organizationId,
      turn.specialistId,
      turn.specialistVersion,
    );
    const specialist = await specialists.find(organizationId, turn.specialistId);
    const profile = profileAtLevel(version?.configuration);
    if (profile === undefined || specialist === undefined) return undefined;
    return { profile, name: specialist.identity.displayName };
  }

  return Object.freeze({
    async needed(tenant: TenantContext, execution: Execution, node: ExecutionNode) {
      const turn = turnOf(execution);
      const organizationId = organizationOfTenant(tenant);
      if (turn === undefined || organizationId === undefined) return true;
      if (node.id === TURN_NODES.decide) {
        // Nothing is asked of a model for a turn that can no longer act: no credits spent.
        const agent = await profileOf(organizationId, turn);
        const level = await autonomyOf(
          conversations,
          organizationId,
          agent?.profile,
          turn.specialistId,
        );
        if ('code' in level) return false;
        return !('code' in (await staleness(conversations, organizationId, turn, level.autonomy)));
      }
      const decision = await decisionOf(tenant, execution);
      if (decision === undefined) return false;
      if (node.id === TURN_NODES.reply) return decision.action === 'reply';
      if (node.id === TURN_NODES.handoff) return decision.action === 'handoff';
      return true;
    },

    async agentWork(
      tenant: TenantContext,
      execution: Execution,
      node: ExecutionNode,
    ): Promise<TurnAIWork | undefined> {
      const turn = turnOf(execution);
      const organizationId = organizationOfTenant(tenant);
      if (turn === undefined || organizationId === undefined || node.id !== TURN_NODES.decide) {
        return undefined;
      }
      const agent = await profileOf(organizationId, turn);
      const conversation = await conversations.findConversation(
        organizationId,
        turn.conversationId,
      );
      if (agent === undefined || conversation === undefined) return undefined;
      const [contact, identity, messages] = await Promise.all([
        conversations.findContact(organizationId, conversation.contactId),
        conversations.findIdentity(organizationId, conversation.channelIdentityId),
        conversations.listMessages(organizationId, conversation.id),
      ]);
      if (contact === undefined || identity === undefined) return undefined;
      // The conversation as it was when the customer wrote: nothing after the turn's message.
      const inbound = messages.find((m) => m.id === turn.inboundMessageId);
      if (inbound === undefined) return undefined;
      const upTo = messages.filter((m) => m.sentAt <= inbound.sentAt);
      // Departments are not the agent's to route: none are given.
      const { context } = buildAssistContext(
        { conversation, contact, identity, messages: upTo },
        [],
      );
      return {
        taskType: AGENT_TURN_TASK,
        metadata: { prompt: promptLabel(AGENT_TURN_PROMPT) },
        capability: 'text_generation',
        requirements: { structuredOutput: true },
        messages: agentTurnMessages(agent.profile, agent.name, context),
        outputModality: 'text',
        maxOutputTokens: AGENT_TURN_MAX_OUTPUT_TOKENS,
        outputSchema: AGENT_DECISION_SCHEMA,
        sensitivity: 'confidential',
      };
    },

    async toolInput(tenant: TenantContext, execution: Execution, node: ExecutionNode) {
      const turn = turnOf(execution);
      const organizationId = organizationOfTenant(tenant);
      if (turn === undefined || organizationId === undefined) return undefined;
      const decision = await decisionOf(tenant, execution);
      if (decision === undefined) return undefined;
      if (node.id === TURN_NODES.handoff) {
        const reason: HandoffReason =
          decision.action === 'handoff' ? decision.reason : 'unresolved';
        return { conversationId: turn.conversationId, reason };
      }
      if (node.id !== TURN_NODES.reply || decision.action !== 'reply') return undefined;
      const conversation = await conversations.findConversation(
        organizationId,
        turn.conversationId,
      );
      if (conversation === undefined) return undefined;
      // Reserved once per turn: a repeat finds the same message, with the same text.
      const candidate = newAgentOutboundMessage(
        {
          organizationId,
          conversation,
          specialistId: turn.specialistId,
          executionId: execution.id,
          text: decision.text,
        },
        now(),
      );
      const { message } = await conversations.reserveOutbound(candidate);
      if (message.text !== decision.text) return undefined;
      return { conversationId: conversation.id, messageId: message.id };
    },
  });
}

// ---------------------------------------------------------------------------------------------
// Checks at the moment a tool acts

export interface AgentReplyCheckOptions {
  readonly conversations: ConversationRepository;
  readonly executions: Pick<ExecutionRepository, 'find'>;
  readonly specialists: AgentSpecialists;
}

/**
 * What an agent's reply must still hold when it is about to leave (CV-6B): the turn's own
 * execution and agent, the organization's level and agent unchanged, the conversation still the
 * agent's under the turn's epoch, the turn still the latest, and the agent within its reply limit.
 */
export function createAgentReplyCheck(options: AgentReplyCheckOptions): AgentReplyCheck {
  const { conversations, executions, specialists } = options;
  return Object.freeze({
    async refusalOf(context: ToolExecutionContext, conversation: Conversation, message: Message) {
      const execution = await executions.find(context.organizationId, context.executionId);
      const turn = execution === undefined ? undefined : turnOf(execution);
      if (
        turn === undefined ||
        turn.conversationId !== conversation.id ||
        turn.specialistId !== context.specialistId
      ) {
        return 'not_a_turn';
      }
      const version = await specialists.findVersion(
        context.organizationId,
        turn.specialistId,
        turn.specialistVersion,
      );
      const profile = profileAtLevel(version?.configuration);
      const level = await autonomyOf(
        conversations,
        context.organizationId,
        profile,
        turn.specialistId,
      );
      if ('code' in level) return level.code;
      // The level decides the version: an approved reply never goes out as an autonomous one.
      if (replyVersionOf(level.autonomy) !== context.toolVersion) return 'autonomy_changed';
      const stale = await staleness(conversations, context.organizationId, turn, level.autonomy);
      if ('code' in stale) return stale.code;
      if (profile === undefined) return 'agent_changed';
      const messages = await conversations.listMessages(context.organizationId, conversation.id);
      const others = messages.filter((m) => m.id !== message.id);
      if (agentRepliesIn(others, turn.specialistId) >= profile.maxRepliesPerConversation) {
        return 'reply_limit_reached';
      }
      return undefined;
    },
  });
}

export interface ConversationHandoffExecutorOptions {
  readonly executions: Pick<ExecutionRepository, 'find'>;
  readonly tenancy: TenancyStore;
  /** The conversations service for one request id. */
  readonly conversationService: (requestId?: string) => Pick<ConversationService, 'escalate'>;
}

/**
 * The executor of `conversation_handoff` (provider `conversation`): the conversation's own
 * `escalate`, for the runtime tenant of the user the work is for, under the turn's control epoch.
 * Nothing leaves MelonOffice.
 */
export function createConversationHandoffExecutor(
  options: ConversationHandoffExecutorOptions,
): ToolExecutor {
  const { executions, tenancy, conversationService } = options;
  return {
    async execute(context: ToolExecutionContext, input: unknown): Promise<ToolExecutorOutcome> {
      if (context.actor.via !== 'runtime' || context.toolId !== HANDOFF.toolId) {
        return { status: 'failure', code: 'tool_not_runtime_invokable' };
      }
      const { conversationId, reason } = input as { conversationId: string; reason: string };
      const execution = await executions.find(context.organizationId, context.executionId);
      const turn = execution === undefined ? undefined : turnOf(execution);
      if (turn?.conversationId !== conversationId) return { status: 'failure', code: 'not_a_turn' };
      try {
        const tenant = await resolveRuntimeTenant(
          context.actor.userId,
          context.organizationId,
          tenancy,
        );
        await conversationService(context.requestId).escalate(tenant, conversationId, {
          reason,
          executionId: context.executionId,
          epoch: turn.epoch,
        });
      } catch (error) {
        if (isConversationError(error)) {
          // The conversation moved first (a person took it): nothing to hand off.
          return {
            status: 'failure',
            code: error.code === 'invalid_transition' ? 'control_changed' : error.code,
          };
        }
        throw error;
      }
      return { status: 'success', output: { conversationId, status: 'escalated' } };
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Verification and stopping

/** The runtime's verification port, as this module fills it. */
export interface AgentTurnVerifier {
  verify(
    tenant: TenantContext,
    execution: Execution,
  ): Promise<
    | {
        readonly verification: VerificationInput;
        readonly result?: { readonly type: string; readonly id: string };
      }
    | undefined
  >;
}

/**
 * Checks a finished turn (ADR-0029 `checks`), against what it did, not what it said: the model's
 * answer is kept, the reply is stored as sent, or the conversation is handed off by this turn. A
 * turn that stepped aside before asking the model (every node skipped) is never verified: the
 * runtime ends it `no_work_done`.
 */
export function createAgentTurnVerifier(options: {
  readonly outputs: Pick<AgentOutputStore, 'find'>;
  readonly conversations: Pick<ConversationRepository, 'findMessage' | 'findConversation'>;
}): AgentTurnVerifier {
  const { outputs, conversations } = options;
  return Object.freeze({
    async verify(tenant: TenantContext, execution: Execution) {
      const turn = turnOf(execution);
      const organizationId = organizationOfTenant(tenant);
      if (turn === undefined || organizationId === undefined) return undefined;
      const replyId = outboundMessageIdFor(
        organizationId,
        turn.conversationId,
        agentReplyKeyOf(execution.id),
      );
      const nodes: VerificationInput['nodes'][number][] = [];
      for (const node of execution.nodes) {
        if (node.status !== 'completed') continue;
        let code: string;
        let passed: boolean;
        if (node.id === TURN_NODES.decide) {
          code = 'agent_output_kept';
          passed = (await outputs.find(tenant, execution.id, node.id)) !== undefined;
        } else if (node.id === TURN_NODES.reply) {
          code = 'reply_sent';
          passed = (await conversations.findMessage(organizationId, replyId))?.status === 'sent';
        } else if (node.id === TURN_NODES.handoff) {
          code = 'conversation_handed_off';
          const conversation = await conversations.findConversation(
            organizationId,
            turn.conversationId,
          );
          passed = conversation?.handoff?.executionId === execution.id;
        } else {
          code = 'unknown_node';
          passed = false;
        }
        nodes.push({
          nodeId: node.id,
          policy: 'checks',
          checks: [
            {
              code,
              result: passed ? 'passed' : 'failed',
              evidence: node.output ?? { type: 'execution_node', id: node.id },
            },
          ],
        });
      }
      const replied = execution.nodes.some(
        (n) => n.id === TURN_NODES.reply && n.status === 'completed',
      );
      return {
        verification: { correlationId: `turn-${execution.id}`, nodes },
        ...(replied ? { result: { type: 'message', id: replyId } } : {}),
      };
    },
  });
}

/** The hand-off reason of a turn that stopped with this code; `undefined`: nothing to hand off. */
/** The failure the automatic sweep closes an abandoned execution with (ADR-0121). */
const STALE_TURN = 'stale_execution';

export function handoffReasonOf(code: string): HandoffReason | undefined {
  // Someone or something else is in charge now: a person, a newer turn, or no agent at all.
  if (
    [
      'superseded',
      'no_work_done',
      'control_changed',
      'conversation_handled_by_human',
      'conversation_closed',
      'autonomy_not_enabled',
      'autonomy_changed',
      'agent_changed',
    ].includes(code)
  ) {
    return undefined;
  }
  if (code.startsWith('credits_')) return 'credits_exhausted';
  if (code.startsWith('approval_')) return 'not_permitted';
  if (code === 'reply_limit_reached') return 'too_many_attempts';
  if (
    [
      'outside_messaging_window',
      'channel_not_available',
      'capability_not_available',
      'provider_rejected',
      'rate_limited',
      'invalid_message',
    ].includes(code)
  ) {
    return 'channel_unavailable';
  }
  // Nothing moved it for a day and the sweep closed it (ADR-0122): a person picks it up.
  if (code === 'outcome_unknown' || code === STALE_TURN) return 'unresolved';
  // The tool gate refused: the agent may not do this, or the tool cannot run here.
  if (code.startsWith('permission') || code.startsWith('tool_') || code === 'not_a_turn') {
    return 'not_permitted';
  }
  if (['executor_unavailable', 'environment_not_allowed', 'node_failed'].includes(code)) {
    return 'tool_failed';
  }
  if (
    ['input_unavailable', 'invalid_work', 'output_unavailable', 'invalid_response'].includes(code)
  ) {
    return 'invalid_ai_output';
  }
  return 'ai_unavailable';
}

export interface AgentTurnStopHookOptions {
  readonly conversations: ConversationRepository;
  readonly conversationService: Pick<ConversationService, 'escalate'>;
  readonly now?: () => Date;
  readonly logger?: Logger;
}

/**
 * When a turn stops without completing (the runtime's stop hook): its reply, if one was reserved
 * and never sent, is settled so it can never leave later, and the conversation is handed to a
 * person with a reason code, unless someone else is already in charge of it.
 */
export function createAgentTurnStopHook(options: AgentTurnStopHookOptions): {
  stopped(tenant: TenantContext, execution: Execution, code: string): Promise<void>;
} {
  const { conversations, conversationService, now = () => new Date(), logger } = options;
  return Object.freeze({
    async stopped(tenant: TenantContext, execution: Execution, code: string) {
      const turn = turnOf(execution);
      const organizationId = organizationOfTenant(tenant);
      if (turn === undefined || organizationId === undefined) return;
      const replyId = outboundMessageIdFor(
        organizationId,
        turn.conversationId,
        agentReplyKeyOf(execution.id),
      );
      const reply = await conversations.findMessage(organizationId, replyId);
      const node = execution.nodes.find((n) => n.id === TURN_NODES.reply);
      if (reply?.status === 'queued') {
        // A reply whose outcome nobody knows is never marked failed: it may have gone out. A turn
        // the sweep closed (ADR-0122) may have stopped mid-send, but only if its send had started.
        const settlement =
          code === 'outcome_unknown' ||
          (code === STALE_TURN &&
            (node?.status === 'running' || node?.idempotencyKey !== undefined))
            ? ({ status: 'unknown', failureCode: code } as const)
            : ({ status: 'failed', failureCode: code } as const);
        const at = now();
        await conversations.settleOutbound(
          organizationId,
          reply.id,
          settlement,
          [
            messageEventOf(tenant.userId, organizationId, reply, settlement, at, undefined, {
              toolVersion: node?.tool?.version ?? 0,
            }),
          ],
          at,
        );
      }
      // The reply's own refusal says best why the turn stopped (a retried send only finds it
      // settled); a model whose outcome is unknown means the AI did not answer.
      const decided =
        execution.nodes.find((n) => n.id === TURN_NODES.decide)?.status === 'completed';
      const cause =
        reply?.status === 'failed' && reply.failureCode !== undefined
          ? reply.failureCode
          : code === 'outcome_unknown' && !decided
            ? 'ai_timeout'
            : code;
      const reason = handoffReasonOf(cause);
      if (reason === undefined) return;
      try {
        await conversationService.escalate(tenant, turn.conversationId, {
          reason,
          executionId: execution.id,
          epoch: turn.epoch,
        });
        logger?.info('agent_turn_escalated', {
          organizationId,
          conversationId: turn.conversationId,
          executionId: execution.id,
          code: reason,
        });
      } catch (error) {
        // The conversation moved first (a person took it, or it was already handed off).
        if (!isConversationError(error)) throw error;
      }
    },
  });
}

/**
 * Whether a specialist can be chosen as the organization's conversation agent (CV-6B): one of the
 * organization's own, active, with a conversation profile. Read from storage for the tenant's
 * organization only: another organization's specialist is simply not one.
 */
export function createConversationAgentCheck(
  specialists: Pick<AgentSpecialists, 'find'>,
): ConversationAgentCheck {
  return Object.freeze({
    async isConversationAgent(tenant: TenantContext, specialistId: string) {
      const organizationId = organizationOfTenant(tenant);
      if (organizationId === undefined) return false;
      const specialist = await specialists.find(organizationId, specialistId as SpecialistId);
      return (
        specialist?.organizationId === organizationId &&
        specialist.status === 'active' &&
        specialist.configuration.conversation !== undefined
      );
    },
  });
}

/** What the person who takes over reads about a hand-off (CV-6B). */
export interface HandoffSummaries {
  /**
   * The agent's note on why it handed this conversation over and what it knew: only for a
   * hand-off an agent's turn made, read from that turn's own kept answer in the tenant's
   * organization. `undefined` when there is none.
   */
  summaryOf(tenant: TenantContext, conversation: Conversation): Promise<string | undefined>;
}

export function createHandoffSummaries(options: {
  readonly outputs: Pick<AgentOutputStore, 'find'>;
}): HandoffSummaries {
  const { outputs } = options;
  return Object.freeze({
    async summaryOf(tenant: TenantContext, conversation: Conversation) {
      const executionId = conversation.handoff?.executionId;
      if (executionId === undefined) return undefined;
      const organizationId = organizationOfTenant(tenant);
      if (organizationId === undefined || organizationId !== conversation.organizationId) {
        return undefined;
      }
      const record = await outputs.find(tenant, executionId, TURN_NODES.decide);
      if (record === undefined) return undefined;
      const decision = parseAgentDecision(record.output);
      return decision.action === 'handoff' ? decision.summary : undefined;
    },
  });
}

/**
 * The ingress with agents' turns (CV-6B): stores what the channel delivered exactly as before,
 * then starts the agent's turn on it. A turn that cannot start never loses the message: it is
 * stored, the delivery is acknowledged, and the failure is logged.
 */
export function withAgentTurns(
  ingress: ConversationIngress,
  trigger: AgentTurnTrigger,
  logger?: Logger,
): ConversationIngress {
  return Object.freeze({
    async receive(inbound: Parameters<ConversationIngress['receive']>[0]) {
      const result = await ingress.receive(inbound);
      try {
        await trigger.afterReceive(result);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        logger?.error('agent turn not started', {
          organizationId: result.conversation.organizationId,
          conversationId: result.conversation.id,
          code: typeof code === 'string' ? code : 'unexpected',
        });
      }
      return result;
    },
    applyStatus: (update: Parameters<ConversationIngress['applyStatus']>[0]) =>
      ingress.applyStatus(update),
  });
}
