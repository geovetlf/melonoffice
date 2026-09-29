import {
  createAgentTaskVerifier,
  createAgentTaskWork,
  createBrainContextSource,
  taskOf,
  type AgentTaskRepository,
} from '@melonoffice/agents';
import { createCompanyBrain, type KnowledgeRepository } from '@melonoffice/brain';
import { createConversationService, type ConversationRepository } from '@melonoffice/conversations';
import type { DepartmentRepository } from '@melonoffice/departments';
import type { Execution } from '@melonoffice/domain';
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
import { createSkillCatalogue, type SpecialistRepository } from '@melonoffice/specialists';
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

export interface AgentTaskStores {
  readonly tenancy: TenancyStore;
  readonly specialists: SpecialistRepository;
  readonly tasks: AgentTaskRepository;
  readonly knowledge: KnowledgeRepository;
  readonly outputs: AgentOutputRepository;
}

/** What the runtime needs to run agent tasks (ADR-0063): no tool, no stop hook. */
export interface AgentTaskParts {
  readonly work: NodeWorkSource;
  readonly verifier: VerificationSource;
}

/**
 * Agent tasks' pieces for the worker (ADR-0063): the agent's version, skills and the Company
 * Brain facts its department may read, and the answer's verification. Company Brain is read with
 * the runtime's tenant, so it checks the person the task runs for again.
 */
export function createAgentTaskParts(options: {
  readonly stores: AgentTaskStores;
  readonly logger?: Logger;
  readonly now?: () => Date;
}): AgentTaskParts {
  const { stores, logger, now } = options;
  const brain = createCompanyBrain({
    repository: stores.knowledge,
    organizations: stores.tenancy,
    authorization: createAuthorizationService(),
    ...(now === undefined ? {} : { now }),
    ...(logger === undefined ? {} : { logger }),
  });
  const outputs = createAgentOutputStore(stores.outputs, now);
  return Object.freeze({
    work: createAgentTaskWork({
      tasks: stores.tasks,
      specialists: stores.specialists,
      skills: createSkillCatalogue(),
      context: createBrainContextSource({ brain }),
    }),
    verifier: createAgentTaskVerifier({ outputs }),
  });
}

/**
 * One runtime, two kinds of agent work: an agent task's execution (`taskOf`) goes to the task's
 * pieces, everything else to the conversation agent's, exactly as before (ADR-0063).
 */
export function routeAgentWork(
  conversation: ConversationAgentParts,
  tasks: AgentTaskParts,
): Pick<ConversationAgentParts, 'work' | 'verifier' | 'onStopped'> {
  const isTask = (execution: Execution) => taskOf(execution) !== undefined;
  return Object.freeze({
    work: Object.freeze({
      toolInput: (tenant, execution, node) =>
        (isTask(execution) ? tasks.work : conversation.work).toolInput(tenant, execution, node),
      agentWork: (tenant, execution, node) =>
        (isTask(execution) ? tasks.work : conversation.work).agentWork(tenant, execution, node),
      needed: async (tenant, execution, node) => {
        const source = isTask(execution) ? tasks.work : conversation.work;
        return source.needed === undefined ? true : source.needed(tenant, execution, node);
      },
    } satisfies NodeWorkSource),
    verifier: Object.freeze({
      verify: (tenant, execution) =>
        (isTask(execution) ? tasks.verifier : conversation.verifier).verify(tenant, execution),
    } satisfies VerificationSource),
    onStopped: Object.freeze({
      // A task that stops has nobody to hand over to: its failure is on the execution.
      stopped: async (tenant, execution, code) => {
        if (!isTask(execution)) await conversation.onStopped.stopped(tenant, execution, code);
      },
    } satisfies ExecutionStopHook),
  });
}
