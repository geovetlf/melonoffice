import { createConversationService, type ConversationRepository } from '@melonoffice/conversations';
import type { DepartmentRepository } from '@melonoffice/departments';
import {
  createAgentOutputStore,
  type AgentOutputRepository,
  type ExecutionRepository,
} from '@melonoffice/execution';
import {
  createAgentReplyCheck,
  createAgentTurnStopHook,
  createAgentTurnVerifier,
  createAgentTurnWork,
  createChannelMessageExecutor,
  createConversationHandoffExecutor,
  type IntegrationEngine,
} from '@melonoffice/integrations';
import type { Logger } from '@melonoffice/observability';
import { createAuthorizationService } from '@melonoffice/rbac';
import type {
  AgentOutputSink,
  ExecutionStopHook,
  NodeWorkSource,
  VerificationSource,
} from '@melonoffice/runtime';
import type { SpecialistRepository } from '@melonoffice/specialists';
import type { TenancyStore } from '@melonoffice/tenancy';
import type { ToolExecutors } from '@melonoffice/tools';

export interface ConversationAgentStores {
  readonly tenancy: TenancyStore;
  readonly departments: DepartmentRepository;
  readonly specialists: SpecialistRepository;
  readonly executions: ExecutionRepository;
  readonly conversations: ConversationRepository;
  readonly outputs: AgentOutputRepository;
}

export interface ConversationAgentOptions {
  readonly stores: ConversationAgentStores;
  /**
   * The Integration Engine (ADR-0044): the channel side of an agent's reply. Absent: the reply
   * tool has no executor, so a reply fails at the gate and the conversation goes to a person.
   */
  readonly channels?: Pick<IntegrationEngine, 'send'>;
  readonly logger?: Logger;
  readonly now?: () => Date;
}

/** What the runtime needs to run conversation agents' turns (CV-6B, ADR-0043). */
export interface ConversationAgentParts {
  readonly executors: ToolExecutors;
  readonly work: NodeWorkSource;
  readonly verifier: VerificationSource;
  readonly outputs: AgentOutputSink;
  readonly onStopped: ExecutionStopHook;
}

/**
 * The conversation agent's pieces for the worker (ADR-0043), over the same repositories as the
 * API: the executors of its two tools, its work source, verifier, answer store and stop hook.
 * Composition only: each piece is the integrations package's, and every decision stays with the
 * runtime, the tool gate, the AI Gateway and the conversation control.
 */
export function createConversationAgentParts(
  options: ConversationAgentOptions,
): ConversationAgentParts {
  const { stores, channels, logger, now } = options;
  const clock = now === undefined ? {} : { now };
  const authorization = createAuthorizationService();
  const conversationService = (requestId?: string) =>
    createConversationService({
      repository: stores.conversations,
      organizations: stores.tenancy,
      departments: stores.departments,
      authorization,
      ...clock,
      ...(requestId === undefined ? {} : { requestId }),
    });
  const outputs = createAgentOutputStore(stores.outputs, now);
  const executors: Record<string, ToolExecutors[string]> = {
    conversation: createConversationHandoffExecutor({
      executions: stores.executions,
      tenancy: stores.tenancy,
      conversationService,
    }),
  };
  if (channels !== undefined) {
    executors.channel = createChannelMessageExecutor({
      conversations: stores.conversations,
      engine: channels,
      agentReplies: createAgentReplyCheck({
        conversations: stores.conversations,
        executions: stores.executions,
        specialists: stores.specialists,
      }),
      ...clock,
    });
  }
  return Object.freeze({
    executors,
    work: createAgentTurnWork({
      conversations: stores.conversations,
      specialists: stores.specialists,
      outputs,
      ...clock,
    }),
    verifier: createAgentTurnVerifier({ outputs, conversations: stores.conversations }),
    outputs,
    onStopped: createAgentTurnStopHook({
      conversations: stores.conversations,
      conversationService: conversationService(),
      ...clock,
      ...(logger === undefined ? {} : { logger }),
    }),
  });
}
