import type { AIGateway, AIRequest } from '@melonoffice/ai-gateway';
import type { ApprovalService } from '@melonoffice/approvals';
import type {
  AgentToolCallRecord,
  Execution,
  ExecutionNode,
  ExecutionRef,
  JobId,
} from '@melonoffice/domain';
import type {
  AgentOutputInput,
  ExecutionService,
  NodeInput,
  VerificationInput,
} from '@melonoffice/execution';
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
    | 'addNodes'
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
  ): Promise<AgentWork | AgentWorkStop | undefined>;
  /**
   * Whether a ready node still has work to do, from what the nodes before it stored (ADR-0043):
   * `false` skips it (`pending → skipped`), and nothing runs for it. Absent, every node runs.
   * It can only skip: it never runs, completes or fails a node.
   */
  needed?(tenant: TenantContext, execution: Execution, node: ExecutionNode): Promise<boolean>;
  /**
   * Whether a `tool` node's output is kept, once it ran, for the work after it: a tool an agent's
   * model asked for (ADR-0103), whose result the agent's next turn reads. Absent: none is kept.
   */
  keepsToolOutput?(node: ExecutionNode): boolean;
  /**
   * Whether a ready `tool` node must not run because the task reached a limit (ADR-0103): the code
   * it stopped at, or `undefined`. The execution then fails with that code and nothing runs.
   * Absent, nothing is stopped here.
   */
  toolStop?(
    tenant: TenantContext,
    execution: Execution,
    node: ExecutionNode,
  ): Promise<string | undefined>;
}

/**
 * What the Melon Agent Harness decided about the tools an agent's model asked for in the middle of
 * its task (ADR-0103): the nodes that run them and the agent's next turn, or a stop at a limit.
 */
export type AgentToolPlan = { readonly nodes: readonly NodeInput[] } | AgentWorkStop;

/**
 * The Melon Agent Harness's tool loop (ADR-0103). When an agent's model answers with tool calls
 * instead of an answer, the runtime asks it what to do with them; the runtime never runs a call
 * itself. Each call it allows becomes a `tool` node, run through the Tool Gate like any other, and
 * the agent gets one more turn after them. Absent, an answer with tool calls fails the execution
 * (`tool_use_unsupported`): nothing a model asks for runs without the Harness.
 */
export interface AgentToolLoop {
  plan(
    tenant: TenantContext,
    execution: Execution,
    node: ExecutionNode,
    calls: readonly AgentToolCallRecord[],
  ): Promise<AgentToolPlan>;
}

/**
 * Keeps an agent node's answer (ADR-0043), so the nodes after it can read it. Written before the
 * node completes; if it cannot be kept, the node fails as if the model had not answered. Absent,
 * the answer is discarded and only the request reference is stored, as before.
 */
export interface AgentOutputSink {
  record(tenant: TenantContext, input: AgentOutputInput): Promise<void>;
}

/**
 * Told when an execution stops without completing (ADR-0043): it failed, or a node's outcome is
 * unknown and waits on a person. Never when a person cancelled it. It may only react, for
 * example by handing a conversation to a person; its errors are logged and change nothing here.
 */
export interface ExecutionStopHook {
  stopped(tenant: TenantContext, execution: Execution, code: string): Promise<void>;
}

/**
 * Told once an execution ended, completed or failed (WF-1, ADR-0070), after the end is stored:
 * the plan conductor starts the plan's next steps from here. Its failure changes nothing about
 * the execution that ended.
 */
export interface ExecutionEndHook {
  ended(tenant: TenantContext, execution: Execution, status: 'completed' | 'failed'): Promise<void>;
}

/** What the runtime sets on every AI call, never a work source. */
export const RUNTIME_AI_FIELDS = ['requestId', 'executionId', 'nodeId', 'specialistId'] as const;

export type AgentWork = Omit<AIRequest, (typeof RUNTIME_AI_FIELDS)[number]>;

/**
 * Work that must not run (ADR-0100): the Melon Agent Harness stopped the task at one of its
 * limits (time, for example). No model is asked and the execution fails with `stop` as its code,
 * so the person reads why it ended instead of a generic `input_unavailable`.
 */
export interface AgentWorkStop {
  readonly stop: string;
}

const STOP_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export const isAgentWorkStop = (value: unknown): value is AgentWorkStop =>
  typeof value === 'object' &&
  value !== null &&
  Object.keys(value).length === 1 &&
  typeof (value as { stop?: unknown }).stop === 'string' &&
  STOP_CODE.test((value as { stop: string }).stop);

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
