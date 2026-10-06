import type { AuditEvent, InMemoryAuditStore } from '@melonoffice/audit';
import type {
  Execution,
  ExecutionId,
  ExecutionStatus,
  IsoTimestamp,
  OrganizationId,
  SpecialistId,
} from '@melonoffice/domain';
import { ExecutionError } from './errors.js';
import { EXECUTION_STATUSES, isTerminal } from './lifecycle.js';

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

/** The statuses of an execution that has not ended. */
export const OPEN_STATUSES: readonly ExecutionStatus[] = Object.freeze(
  EXECUTION_STATUSES.filter((s) => !isTerminal(s)),
);

/**
 * The executions of one specialist that have not ended (AE-4, ADR-0115), so that pausing or
 * disabling an agent reaches its work in progress. Ids only, at most `limit`, oldest id first;
 * `more` says whether there are others. Another organization's are never returned.
 */
export interface OpenExecutionIndex {
  openOfSpecialist(
    organizationId: OrganizationId,
    specialistId: SpecialistId,
    limit: number,
  ): Promise<{ readonly ids: readonly ExecutionId[]; readonly more: boolean }>;
}

/**
 * How many executions of one organization have not ended, counted up to `limit` (ADR-0119), so
 * that new agent work can be refused when an organization already has too much open.
 */
export interface OpenOrganizationIndex {
  countOpenOfOrganization(organizationId: OrganizationId, limit: number): Promise<number>;
}

/** Where a read of open executions continues (ADR-0183): the last one's update, then its id. */
export interface OpenPosition {
  readonly at: IsoTimestamp;
  readonly id: ExecutionId;
}

/**
 * Open executions of every organization, in one status, not updated since `before`, oldest first
 * by update then id (ADR-0121): the automatic sweep's candidates, read by the worker only. Each
 * one carries its own organization, which every later step checks again. `after` continues a
 * read strictly after that position (ADR-0183), so work that is rightly waiting never hides the
 * work behind it.
 */
export interface StaleExecutionIndex {
  openSince(
    status: ExecutionStatus,
    before: IsoTimestamp,
    limit: number,
    after?: OpenPosition,
  ): Promise<readonly Execution[]>;
}

/** Oldest first by update, then id: the order of `openSince`. */
export const byOldestUpdate = (a: Execution, b: Execution): number =>
  a.updatedAt === b.updatedAt
    ? a.id < b.id
      ? -1
      : a.id > b.id
        ? 1
        : 0
    : a.updatedAt < b.updatedAt
      ? -1
      : 1;

/** Whether an execution comes strictly after `position` in that order. */
export const isAfterOpen = (execution: Execution, position: OpenPosition): boolean =>
  execution.updatedAt > position.at ||
  (execution.updatedAt === position.at && execution.id > position.id);

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
export class InMemoryExecutionRepository
  implements ExecutionRepository, OpenExecutionIndex, OpenOrganizationIndex, StaleExecutionIndex
{
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

  async openOfSpecialist(
    organizationId: OrganizationId,
    specialistId: SpecialistId,
    limit: number,
  ) {
    const ids = [...this.#executions.values()]
      .filter(
        (e) =>
          e.organizationId === organizationId &&
          e.specialistId === specialistId &&
          !isTerminal(e.status),
      )
      .map((e) => e.id)
      .sort();
    return { ids: Object.freeze(ids.slice(0, limit)), more: ids.length > limit };
  }

  async openSince(
    status: ExecutionStatus,
    before: IsoTimestamp,
    limit: number,
    after?: OpenPosition,
  ) {
    return [...this.#executions.values()]
      .filter(
        (e) =>
          e.status === status &&
          e.updatedAt < before &&
          (after === undefined || isAfterOpen(e, after)),
      )
      .sort(byOldestUpdate)
      .slice(0, limit);
  }

  async countOpenOfOrganization(organizationId: OrganizationId, limit: number) {
    const open = [...this.#executions.values()].filter(
      (e) => e.organizationId === organizationId && !isTerminal(e.status),
    ).length;
    return Math.min(open, limit);
  }

  /** Test hook: stores a record as given, the way corrupted or legacy data would look. */
  put(execution: Execution): void {
    this.#executions.set(execution.id, execution);
  }
}
