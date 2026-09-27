import type { AIGateway, AIRequest } from '@melonoffice/ai-gateway';
import type { ApprovalService } from '@melonoffice/approvals';
import type { Execution, ExecutionNode, ExecutionRef, JobId } from '@melonoffice/domain';
import type { ExecutionService, VerificationInput } from '@melonoffice/execution';
import type { ToolGate } from '@melonoffice/guardrails';
import type { JobService } from '@melonoffice/jobs';
import type { TenantContext } from '@melonoffice/tenancy';

/**
 * The services the runtime works through (ADR-0031), built for one correlation id so every
 * event and log line of one job carries it. Nothing else: no repository, no adapter, no
 * provider, no credential. A tool runs only through the gate, a model only through the gateway.
 */
export interface RuntimeServices {
  readonly executions: Pick<
    ExecutionService,
    | 'get'
    | 'runtimeChangeStatus'
    | 'runtimeChangeNode'
    | 'recordVerification'
    | 'retryNode'
    | 'markOutcomeUnknown'
  >;
  readonly gate: ToolGate;
  readonly ai: AIGateway;
  readonly jobs: Pick<JobService, 'enqueue' | 'get' | 'cancelForExecution'>;
  readonly approvals: Pick<ApprovalService, 'get'>;
}

/**
 * What a node works on, which the execution only points at (`node.input` is a reference). Its
 * answers are content, never authority: the organization, user, execution, node, specialist,
 * tool, approval and request id always come from storage and the runtime. Absent, or answering
 * `undefined`, the node cannot run and the execution fails with `input_unavailable`: nothing is
 * invented. Company Context (ADR-0030) will be read here, once it exists.
 */
export interface NodeWorkSource {
  /** The input of a `tool` node, as the tool's schema expects it. The gate checks it. */
  toolInput(tenant: TenantContext, execution: Execution, node: ExecutionNode): Promise<unknown>;
  /**
   * The call of an `agent` node, without the fields the runtime sets itself. The gateway checks
   * it; a field the runtime sets is refused here, not overwritten.
   */
  agentWork(
    tenant: TenantContext,
    execution: Execution,
    node: ExecutionNode,
  ): Promise<AgentWork | undefined>;
}

/** What the runtime sets on every AI call, never a work source. */
export const RUNTIME_AI_FIELDS = ['requestId', 'executionId', 'nodeId', 'specialistId'] as const;

export type AgentWork = Omit<AIRequest, (typeof RUNTIME_AI_FIELDS)[number]>;

/**
 * Checks an execution's finished work and returns the evidence (ADR-0029: `output_schema` or
 * `checks`, never a human or specialist review). Absent, or answering `undefined`, the execution
 * stays `verifying`: it is never completed without evidence.
 */
export interface VerificationSource {
  verify(
    tenant: TenantContext,
    execution: Execution,
  ): Promise<
    { readonly verification: VerificationInput; readonly result?: ExecutionRef } | undefined
  >;
}

/**
 * Hands a queued job to whatever delivers it to a worker (X6d). The runtime passes only the id.
 * Absent, jobs stay queued for a caller to deliver. A failed hand-off is logged, never retried
 * here: the job is stored, so nothing is lost.
 */
export interface JobDispatcher {
  dispatch(jobId: JobId): Promise<void>;
}
