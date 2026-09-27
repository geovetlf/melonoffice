import type { AuditEvent, InMemoryAuditStore } from '@melonoffice/audit';
import type { Execution, ExecutionId, OrganizationId } from '@melonoffice/domain';
import { ExecutionError } from './errors.js';

/** The new state of an execution and the audit events that record the change. */
export interface ExecutionWrite {
  readonly execution: Execution;
  readonly events: readonly AuditEvent[];
}

/**
 * Where executions live: Firestore in the API (ADR-0024), memory in tests. Every write stores
 * the execution and its audit events together, or nothing.
 */
export interface ExecutionRepository {
  /** The execution, only when it belongs to the organization. Another organization's is absent. */
  find(organizationId: OrganizationId, id: ExecutionId): Promise<Execution | undefined>;
  /** Stores a new execution. Refuses an id that already exists. */
  create(write: ExecutionWrite): Promise<void>;
  /**
   * Reads the current execution and lets `change` decide the next one, in one transaction. The
   * next one must be exactly one revision ahead; a concurrent write in between makes it
   * `execution_concurrency_conflict` (Firestore re-runs `change` on the fresh state instead).
   * An absent execution, or another organization's, is `execution_not_found`.
   */
  update(
    organizationId: OrganizationId,
    id: ExecutionId,
    change: (current: Execution) => ExecutionWrite,
  ): Promise<Execution>;
}

/** Checks what `change` returned: the same execution, one revision ahead. */
export function checkNextRevision(current: Execution, next: Execution): void {
  if (
    next.id !== current.id ||
    next.organizationId !== current.organizationId ||
    next.revision !== current.revision + 1
  ) {
    throw new ExecutionError('execution_concurrency_conflict');
  }
}

/** For tests and local runs only. */
export class InMemoryExecutionRepository implements ExecutionRepository {
  readonly #executions = new Map<string, Execution>();

  constructor(private readonly audit?: InMemoryAuditStore) {}

  async find(organizationId: OrganizationId, id: ExecutionId): Promise<Execution | undefined> {
    const execution = this.#executions.get(id);
    return execution?.organizationId === organizationId ? execution : undefined;
  }

  async create({ execution, events }: ExecutionWrite): Promise<void> {
    if (this.#executions.has(execution.id)) throw new Error('execution already exists');
    this.#append(events);
    this.#executions.set(execution.id, execution);
  }

  async update(
    organizationId: OrganizationId,
    id: ExecutionId,
    change: (current: Execution) => ExecutionWrite,
  ): Promise<Execution> {
    const current = await this.find(organizationId, id);
    if (current === undefined) throw new ExecutionError('execution_not_found');
    const { execution, events } = change(current);
    checkNextRevision(current, execution);
    // Nothing awaits between the read and this check, but a caller may hold an older copy.
    if (this.#executions.get(id)?.revision !== current.revision) {
      throw new ExecutionError('execution_concurrency_conflict');
    }
    this.#append(events);
    this.#executions.set(id, execution);
    return execution;
  }

  #append(events: readonly AuditEvent[]): void {
    if (events.length === 0) return;
    if (this.audit === undefined) throw new Error('no audit store for execution events');
    this.audit.appendNow(events);
  }

  /** Test hook: stores a record as given, the way corrupted or legacy data would look. */
  put(execution: Execution): void {
    this.#executions.set(execution.id, execution);
  }
}
