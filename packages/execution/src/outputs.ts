import type {
  AgentOutputRecord,
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
  readonly output: { readonly text?: string; readonly structured?: unknown };
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
      const output = {
        ...(typeof input.output.text === 'string' ? { text: input.output.text } : {}),
        ...(input.output.structured === undefined ? {} : { structured: input.output.structured }),
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
