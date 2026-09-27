import type {
  ApprovalId,
  DeploymentEnvironment,
  ExecutionId,
  ExecutionNodeId,
  ExecutionRef,
  OrganizationId,
  SpecialistId,
  ToolId,
  ToolRiskLevel,
  UserId,
} from '@melonoffice/domain';
import { digestOf } from './canonical.js';

/**
 * Everything an executor may know about the call, built by the tool gate from verified context
 * only: the tenant, the stored execution and the registry (ADR-0026). Nothing in it comes from
 * the tool input or a model. There are no credentials: an executor resolves its
 * `CredentialReference`s itself, in secure infrastructure.
 */
export interface ToolExecutionContext {
  readonly organizationId: OrganizationId;
  readonly executionId: ExecutionId;
  readonly nodeId: ExecutionNodeId;
  readonly specialistId: SpecialistId;
  readonly specialistVersion: number;
  readonly toolId: ToolId;
  readonly toolVersion: number;
  readonly action: string;
  /** The user the work is for, and whether GIA was the channel. */
  readonly actor: { readonly userId: UserId; readonly via: 'direct' | 'gia' };
  readonly riskLevel: ToolRiskLevel;
  /** The approval the call runs under, when its policy needed one. */
  readonly approvalId?: ApprovalId;
  /** Present on every mutating tool: pass it to the provider so a repeat changes nothing twice. */
  readonly idempotencyKey?: string;
  readonly environment: DeploymentEnvironment;
  readonly requestId?: string;
  /** When the call must have finished; the gate stops waiting then. */
  readonly deadline: Date;
}

/** What an executor reports. It never throws to report a tool failure. */
export type ToolExecutorOutcome =
  | {
      readonly status: 'success';
      /** The tool's output, checked against its output schema before anyone sees it. */
      readonly output: unknown;
      /** Where the full output is kept, when it is stored elsewhere. */
      readonly outputRef?: ExecutionRef;
    }
  | { readonly status: 'failure'; readonly code: string };

/**
 * Runs one kind of tool (ADR-0026). No executor exists yet: providers (Google, Microsoft,
 * MCP, browser…) plug in here in later phases, and only the tool gate calls them.
 */
export interface ToolExecutor {
  execute(context: ToolExecutionContext, input: unknown): Promise<ToolExecutorOutcome>;
}

/** Executors by provider id (`ToolVersion.provider.id`). */
export type ToolExecutors = Readonly<Record<string, ToolExecutor>>;

/**
 * The result of asking to run a tool: always one of these, never an ambiguous exception.
 *
 * - `success`: it ran, and its output passed the post-execution guardrails.
 * - `failure`: it ran and failed, or its output was rejected (see `code`).
 * - `denied`: a guardrail refused it; nothing ran.
 * - `requires_approval`: a human must approve first; nothing ran.
 * - `timeout`: it did not finish in time.
 */
export type ToolResult =
  | {
      readonly status: 'success';
      readonly output: unknown;
      readonly outputRef?: ExecutionRef;
      readonly durationMs: number;
    }
  | { readonly status: 'failure'; readonly code: string; readonly durationMs?: number }
  | { readonly status: 'denied'; readonly code: string }
  | { readonly status: 'requires_approval'; readonly approvalId: ApprovalId }
  | { readonly status: 'timeout'; readonly durationMs: number };

export type ToolResultStatus = ToolResult['status'];

/**
 * The idempotency key of one tool call: the execution, the node and the exact tool version.
 * The same node can never produce two different changes at a provider.
 */
export const idempotencyKeyOf = (
  executionId: string,
  nodeId: string,
  toolId: string,
  toolVersion: number,
): string => digestOf({ executionId, nodeId, toolId, toolVersion });
