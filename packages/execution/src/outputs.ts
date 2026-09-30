import type {
  AICallTrace,
  AgentOutputRecord,
  AgentToolCallRecord,
  ExecutionId,
  ExecutionNodeId,
  IsoTimestamp,
  OrganizationId,
} from '@melonoffice/domain';
import { isResolvedTenant, type TenantContext } from '@melonoffice/tenancy';
import { ExecutionError } from './errors.js';
import { isExecutionId } from './model.js';

/**
 * Where agent node answers live (CV-6B, ADR-0043): Firestore `agentOutputs/{executionId}_{nodeId}`
 * in the worker, memory in tests. One record per node: a retried node's answer replaces the last.
 */
export interface AgentOutputRepository {
  save(record: AgentOutputRecord): Promise<void>;
  /** The record, only when it belongs to the organization. Another organization's is absent. */
  find(
    organizationId: OrganizationId,
    executionId: ExecutionId,
    nodeId: string,
  ): Promise<AgentOutputRecord | undefined>;
}

/** What the runtime records for one agent node. The organization and time come from here. */
export interface AgentOutputInput {
  readonly executionId: ExecutionId;
  readonly nodeId: ExecutionNodeId;
  readonly requestId: string;
  readonly output: {
    readonly text?: string;
    readonly structured?: unknown;
    /** The tools the model asked for instead of answering (ADR-0103). */
    readonly toolCalls?: readonly AgentToolCallRecord[];
  };
  readonly ai?: AICallTrace;
}

/**
 * Agent answers of an organization. Only the runtime records one, for the organization of its
 * resolved context; any resolved context of that organization reads them back.
 */
export interface AgentOutputStore {
  record(tenant: TenantContext, input: AgentOutputInput): Promise<void>;
  find(
    tenant: TenantContext,
    executionId: string,
    nodeId: string,
  ): Promise<AgentOutputRecord | undefined>;
}

/** An answer larger than this is not kept: nothing a node needs is this long. */
export const MAX_AGENT_OUTPUT_LENGTH = 16_000;
const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID = /^[\w-]{1,128}$/;

const TRACE_CODE = /^[A-Za-z0-9_./:-]{1,128}$/;
const count = (v: unknown): boolean => typeof v === 'number' && Number.isSafeInteger(v) && v >= 0;
const countOrNull = (v: unknown): boolean => v === null || count(v);
const codeOrNull = (v: unknown): boolean =>
  v === null || (typeof v === 'string' && TRACE_CODE.test(v));

const TOOL_NAME = /^[a-z][a-z0-9_]{0,63}$/;
const TOOL_CALL_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The most tool calls one answer may carry (the AI Gateway's own limit, ADR-0076). */
const MAX_TOOL_CALLS = 16;

/** Tool calls as the AI Gateway checked them (ADR-0076): ids, names and plain object arguments. */
export function isToolCallList(value: unknown): value is readonly AgentToolCallRecord[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= MAX_TOOL_CALLS &&
    value.every(
      (c) =>
        typeof c === 'object' &&
        c !== null &&
        typeof (c as AgentToolCallRecord).id === 'string' &&
        TOOL_CALL_ID.test((c as AgentToolCallRecord).id) &&
        typeof (c as AgentToolCallRecord).name === 'string' &&
        TOOL_NAME.test((c as AgentToolCallRecord).name) &&
        typeof (c as AgentToolCallRecord).arguments === 'object' &&
        (c as AgentToolCallRecord).arguments !== null &&
        !Array.isArray((c as AgentToolCallRecord).arguments),
    )
  );
}

/** A call trace of codes and whole numbers only, or the whole record is refused. */
export function checkTrace(trace: AICallTrace): AICallTrace {
  const ok =
    typeof trace.provider === 'string' &&
    TRACE_CODE.test(trace.provider) &&
    typeof trace.model === 'string' &&
    TRACE_CODE.test(trace.model) &&
    codeOrNull(trace.strategy) &&
    codeOrNull(trace.fallbackFrom) &&
    codeOrNull(trace.escalation) &&
    countOrNull(trace.estimatedMicroUsd) &&
    countOrNull(trace.actualMicroUsd) &&
    countOrNull(trace.creditsEstimated) &&
    count(trace.creditsConsumed) &&
    countOrNull(trace.maxCredits) &&
    count(trace.attempts) &&
    [trace.capability, trace.sensitivity, trace.dataClass, trace.intent].every(
      (v) => v === undefined || codeOrNull(v),
    );
  if (!ok) throw new ExecutionError('invalid_execution', 'agent_output_trace');
  return Object.freeze({
    provider: trace.provider,
    model: trace.model,
    strategy: trace.strategy,
    fallbackFrom: trace.fallbackFrom,
    estimatedMicroUsd: trace.estimatedMicroUsd,
    actualMicroUsd: trace.actualMicroUsd,
    creditsEstimated: trace.creditsEstimated,
    creditsConsumed: trace.creditsConsumed,
    maxCredits: trace.maxCredits,
    escalation: trace.escalation,
    attempts: trace.attempts,
    ...(typeof trace.capability === 'string' ? { capability: trace.capability } : {}),
    ...(typeof trace.sensitivity === 'string' ? { sensitivity: trace.sensitivity } : {}),
    ...(typeof trace.dataClass === 'string' ? { dataClass: trace.dataClass } : {}),
    ...(typeof trace.intent === 'string' ? { intent: trace.intent } : {}),
  });
}

export function createAgentOutputStore(
  repository: AgentOutputRepository,
  now: () => Date = () => new Date(),
): AgentOutputStore {
  const organizationOf = (tenant: TenantContext): OrganizationId => {
    if (!isResolvedTenant(tenant)) throw new ExecutionError('unresolved_tenant');
    return tenant.organizationId;
  };
  return Object.freeze({
    async record(tenant: TenantContext, input: AgentOutputInput): Promise<void> {
      if (tenant.actor !== 'runtime') throw new ExecutionError('actor_not_allowed', 'runtime_only');
      const organizationId = organizationOf(tenant);
      if (
        !isExecutionId(input.executionId) ||
        !NODE_ID.test(input.nodeId) ||
        !REQUEST_ID.test(input.requestId)
      ) {
        throw new ExecutionError('invalid_execution', 'agent_output');
      }
      const toolCalls = input.output.toolCalls;
      if (toolCalls !== undefined && !isToolCallList(toolCalls)) {
        throw new ExecutionError('invalid_execution', 'tool_calls');
      }
      const output = {
        ...(typeof input.output.text === 'string' ? { text: input.output.text } : {}),
        ...(input.output.structured === undefined ? {} : { structured: input.output.structured }),
        ...(toolCalls === undefined
          ? {}
          : {
              toolCalls: toolCalls.map((c) => ({ id: c.id, name: c.name, arguments: c.arguments })),
            }),
      };
      if (JSON.stringify(output).length > MAX_AGENT_OUTPUT_LENGTH) {
        throw new ExecutionError('invalid_execution', 'output_too_large');
      }
      await repository.save(
        Object.freeze({
          organizationId,
          executionId: input.executionId,
          nodeId: input.nodeId,
          requestId: input.requestId,
          output,
          ...(input.ai === undefined ? {} : { ai: checkTrace(input.ai) }),
          createdAt: now().toISOString() as IsoTimestamp,
        }),
      );
    },

    async find(tenant: TenantContext, executionId: string, nodeId: string) {
      const organizationId = organizationOf(tenant);
      if (!isExecutionId(executionId) || !NODE_ID.test(nodeId)) return undefined;
      return repository.find(organizationId, executionId, nodeId);
    },
  });
}

/** For tests and local runs only. */
export class InMemoryAgentOutputRepository implements AgentOutputRepository {
  readonly #records = new Map<string, AgentOutputRecord>();

  async save(record: AgentOutputRecord): Promise<void> {
    this.#records.set(`${record.executionId}_${record.nodeId}`, record);
  }

  async find(organizationId: OrganizationId, executionId: ExecutionId, nodeId: string) {
    const record = this.#records.get(`${executionId}_${nodeId}`);
    return record?.organizationId === organizationId ? record : undefined;
  }

  records(): readonly AgentOutputRecord[] {
    return [...this.#records.values()];
  }
}
