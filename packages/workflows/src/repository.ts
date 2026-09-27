import type { AuditEvent, InMemoryAuditStore } from '@melonoffice/audit';
import type { OrganizationId, Workflow, WorkflowId, WorkflowVersion } from '@melonoffice/domain';
import { WorkflowError } from './errors.js';
import { checkStoredWorkflow, checkStoredWorkflowVersion, type WorkflowWrite } from './model.js';

/** A workflow change and the audit events that record it: stored together, or not at all. */
export type WorkflowChange = WorkflowWrite & { readonly events: readonly AuditEvent[] };

/**
 * Where workflows live: `workflows/{id}` and write-once `workflowVersions/{id}_{version}` in
 * Firestore (ADR-0028), memory in tests. A write stores the workflow, its new version and its
 * audit events together, or nothing; an existing version is never overwritten, and a change
 * with no audit event is refused.
 */
export interface WorkflowRepository {
  /** The workflow, only when it belongs to the organization. Another organization's is absent. */
  find(organizationId: OrganizationId, id: WorkflowId): Promise<Workflow | undefined>;
  findVersion(
    organizationId: OrganizationId,
    id: WorkflowId,
    version: number,
  ): Promise<WorkflowVersion | undefined>;
  list(organizationId: OrganizationId, limit: number): Promise<readonly Workflow[]>;
  create(write: Required<WorkflowChange>): Promise<void>;
  /** The next workflow must be exactly one revision ahead. Absent: `workflow_not_found`. */
  update(
    organizationId: OrganizationId,
    id: WorkflowId,
    change: (current: Workflow) => WorkflowChange,
  ): Promise<Workflow>;
}

export const workflowVersionKey = (id: WorkflowId, version: number): string => `${id}_${version}`;

/** Every workflow change is audited, in the workflow's own organization (ADR-0028). */
export function checkWorkflowEvents(write: WorkflowChange): void {
  if (
    write.events.length === 0 ||
    write.events.some((e) => e.organizationId !== write.workflow.organizationId)
  ) {
    throw new Error('a workflow change needs its audit events');
  }
}

export function checkNextWorkflow(current: Workflow, write: WorkflowWrite): void {
  const next = write.workflow;
  if (
    next.id !== current.id ||
    next.organizationId !== current.organizationId ||
    next.revision !== current.revision + 1 ||
    (write.version === undefined
      ? next.version !== current.version
      : next.version !== current.version + 1 || write.version.version !== next.version)
  ) {
    throw new WorkflowError('workflow_concurrency_conflict');
  }
}

/** For tests and local runs only. */
export class InMemoryWorkflowRepository implements WorkflowRepository {
  readonly #workflows = new Map<string, Workflow>();
  readonly #versions = new Map<string, WorkflowVersion>();

  constructor(private readonly audit?: InMemoryAuditStore) {}

  async find(organizationId: OrganizationId, id: WorkflowId): Promise<Workflow | undefined> {
    const workflow = this.#workflows.get(id);
    return workflow?.organizationId === organizationId ? checkStoredWorkflow(workflow) : undefined;
  }

  async findVersion(
    organizationId: OrganizationId,
    id: WorkflowId,
    version: number,
  ): Promise<WorkflowVersion | undefined> {
    const found = this.#versions.get(workflowVersionKey(id, version));
    return found?.organizationId === organizationId ? checkStoredWorkflowVersion(found) : undefined;
  }

  async list(organizationId: OrganizationId, limit: number): Promise<readonly Workflow[]> {
    return [...this.#workflows.values()]
      .filter((w) => w.organizationId === organizationId)
      .map(checkStoredWorkflow)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, limit);
  }

  async create(write: Required<WorkflowChange>): Promise<void> {
    const { workflow, version } = write;
    checkWorkflowEvents(write);
    if (this.#workflows.has(workflow.id)) throw new Error('workflow already exists');
    this.#append(write.events);
    this.#workflows.set(workflow.id, workflow);
    this.#versions.set(workflowVersionKey(workflow.id, version.version), version);
  }

  async update(
    organizationId: OrganizationId,
    id: WorkflowId,
    change: (current: Workflow) => WorkflowChange,
  ): Promise<Workflow> {
    const current = await this.find(organizationId, id);
    if (current === undefined) throw new WorkflowError('workflow_not_found');
    const write = change(current);
    checkNextWorkflow(current, write);
    checkWorkflowEvents(write);
    if (this.#workflows.get(id)?.revision !== current.revision) {
      throw new WorkflowError('workflow_concurrency_conflict');
    }
    const key =
      write.version === undefined ? undefined : workflowVersionKey(id, write.version.version);
    if (key !== undefined && this.#versions.has(key)) {
      throw new WorkflowError('workflow_concurrency_conflict');
    }
    // The audit events first: if they cannot be stored, nothing of the change is.
    this.#append(write.events);
    if (key !== undefined && write.version !== undefined) this.#versions.set(key, write.version);
    this.#workflows.set(id, write.workflow);
    return write.workflow;
  }

  #append(events: readonly AuditEvent[]): void {
    if (this.audit === undefined) throw new Error('no audit store for workflow events');
    this.audit.appendNow(events);
  }

  /** Test hook: stores a version as given, the way corrupted data would look. */
  putVersion(version: WorkflowVersion): void {
    this.#versions.set(workflowVersionKey(version.workflowId, version.version), version);
  }
}
