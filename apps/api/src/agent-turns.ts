import {
  createAIGateway,
  createModelPolicyCatalogue,
  defaultProviderRegistry,
} from '@melonoffice/ai-gateway';
import { createApprovalService, type ApprovalRepository } from '@melonoffice/approvals';
import type { AuditService } from '@melonoffice/audit';
import { createConversationService, type ConversationRepository } from '@melonoffice/conversations';
import type { DepartmentRepository } from '@melonoffice/departments';
import type { Approval } from '@melonoffice/domain';
import { createExecutionService, type ExecutionRepository } from '@melonoffice/execution';
import { createToolGate } from '@melonoffice/guardrails';
import {
  createAgentTurnTrigger,
  createConversationAgentCheck,
  turnOf,
  type AgentTurnTrigger,
  type IntegrationEngine,
} from '@melonoffice/integrations';
import { createJobService, type JobRepository } from '@melonoffice/jobs';
import type { Logger } from '@melonoffice/observability';
import { createAuthorizationService } from '@melonoffice/rbac';
import { createRuntime, type JobDispatcher } from '@melonoffice/runtime';
import { createSpecialistService, type SpecialistRepository } from '@melonoffice/specialists';
import type { TenancyStore, TenantContext } from '@melonoffice/tenancy';
import type { ToolRegistry } from '@melonoffice/tools';

export interface AgentTurnsOptions {
  readonly tenancy: TenancyStore;
  readonly departments: DepartmentRepository;
  readonly specialists: SpecialistRepository;
  readonly executions: ExecutionRepository;
  readonly approvals: ApprovalRepository;
  readonly jobs: JobRepository;
  readonly conversations: ConversationRepository;
  readonly tools: ToolRegistry;
  readonly audit: AuditService;
  /**
   * Hands a queued job to the worker (Cloud Tasks, ADR-0032). Absent: a turn is started and its
   * first job stays queued until something delivers it (fails closed: nothing runs here).
   */
  readonly dispatcher?: JobDispatcher;
  /**
   * The Integration Engine (ADR-0044), asked whether the conversation's connection could send a
   * reply before a turn starts. Absent: the reply's send refuses later instead.
   */
  readonly channels?: Pick<IntegrationEngine, 'availability'>;
  readonly logger?: Logger;
}

/** What the API does for conversation agents (CV-6B, ADR-0043). */
export interface AgentTurns {
  /** Starts the agent's turn after an inbound message was stored. */
  readonly trigger: AgentTurnTrigger;
  /**
   * After a person decided an approval: hands the waiting job back to the worker (the runtime's
   * own `resume`, which checks the approval is for exactly that node). Never throws: the decision
   * is already stored, and a job that cannot be handed back stays queued.
   */
  afterDecision(tenant: TenantContext, approval: Approval): Promise<void>;
  /**
   * Queues a started execution's first node and hands it to the worker (an agent task, ADR-0063).
   * The runtime refuses one that already ran (`execution_in_progress`).
   */
  kickoff(tenant: TenantContext, executionId: string, correlationId?: string): Promise<unknown>;
}

/**
 * The API's part of conversation agents (ADR-0043), from the same services the worker uses. The
 * API only starts a turn and hands jobs over: it never advances one. Its runtime is the same
 * `createRuntime`, used for `kickoff` and `resume` only; its gate has no executors and its AI
 * Gateway no provider, so even a call that should never happen here could not act.
 */
export function createAgentTurns(options: AgentTurnsOptions): AgentTurns {
  const { tenancy, audit, logger, dispatcher } = options;
  const authorization = createAuthorizationService();
  const specialists = createSpecialistService({
    repository: options.specialists,
    departments: options.departments,
    organizations: tenancy,
    authorization,
  });
  const executionsFor = (requestId?: string) =>
    createExecutionService({
      repository: options.executions,
      organizations: tenancy,
      assignments: specialists.assignments,
      authorization,
      audit,
      ...(requestId === undefined ? {} : { requestId }),
    });
  const approvalsFor = (requestId?: string) =>
    createApprovalService({
      repository: options.approvals,
      organizations: tenancy,
      authorization,
      audit,
      ...(requestId === undefined ? {} : { requestId }),
    });
  const jobsFor = (requestId?: string) =>
    createJobService({
      jobs: options.jobs,
      executions: options.executions,
      tenancy,
      authorization,
      audit,
      // Never used: the API queues and reads jobs, it never leases one.
      leaseMs: 60_000,
      ...(requestId === undefined ? {} : { requestId }),
      ...(logger === undefined ? {} : { logger }),
    });
  const runtime = createRuntime({
    jobs: jobsFor(),
    services: (correlationId) => ({
      executions: executionsFor(correlationId),
      gate: createToolGate({
        executions: options.executions,
        organizations: tenancy,
        specialists,
        departments: options.departments,
        registry: options.tools,
        approvals: approvalsFor(correlationId),
        executors: {},
        authorization,
        audit,
        environment: undefined,
        requestId: correlationId,
      }),
      ai: createAIGateway({
        executions: options.executions,
        organizations: tenancy,
        specialists,
        authorization,
        registry: defaultProviderRegistry(),
        policies: createModelPolicyCatalogue([]),
        environment: undefined,
        audit,
      }),
      jobs: jobsFor(correlationId),
      approvals: approvalsFor(correlationId),
    }),
    ...(dispatcher === undefined ? {} : { dispatcher }),
    ...(logger === undefined ? {} : { logger }),
  });

  const trigger = createAgentTurnTrigger({
    conversations: options.conversations,
    conversationService: createConversationService({
      repository: options.conversations,
      agents: createConversationAgentCheck(options.specialists),
      organizations: tenancy,
      departments: options.departments,
      authorization,
    }),
    specialists: options.specialists,
    executions: executionsFor(),
    tenancy,
    runtime,
    ...(options.channels === undefined ? {} : { channels: options.channels }),
    audit,
    ...(logger === undefined ? {} : { logger }),
  });

  return Object.freeze({
    trigger,
    kickoff: (tenant: TenantContext, executionId: string, correlationId?: string) =>
      runtime.kickoff(tenant, executionId, correlationId),
    async afterDecision(tenant: TenantContext, approval: Approval) {
      try {
        const execution = await options.executions.find(
          approval.organizationId,
          approval.operation.executionId,
        );
        // Only an agent's turn is handed back here; other work has no delivery in the API yet.
        if (execution === undefined || turnOf(execution) === undefined) return;
        await runtime.resume(tenant, execution.id);
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        logger?.warn('agent turn not resumed', {
          approvalId: approval.id,
          code: typeof code === 'string' ? code : 'unexpected',
        });
      }
    },
  });
}
