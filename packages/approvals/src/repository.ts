import type { AuditEvent, InMemoryAuditStore } from '@melonoffice/audit';
import type { Approval, ApprovalId, OrganizationId } from '@melonoffice/domain';
import { ApprovalError } from './errors.js';
import { checkStoredApproval } from './model.js';

/** The new state of an approval and the audit events that record the change. */
export interface ApprovalWrite {
  readonly approval: Approval;
  readonly events: readonly AuditEvent[];
}

/**
 * Where approvals live: Firestore in the API (ADR-0026), memory in tests. Every write stores the
 * approval and its audit events together, or nothing.
 */
export interface ApprovalRepository {
  /** The approval, only when it belongs to the organization. Another organization's is absent. */
  find(organizationId: OrganizationId, id: ApprovalId): Promise<Approval | undefined>;
  /** The organization's approvals, newest first, at most `limit`. */
  list(organizationId: OrganizationId, limit: number): Promise<readonly Approval[]>;
  create(write: ApprovalWrite): Promise<void>;
  /**
   * Reads the current approval and lets `change` decide the next one, in one transaction. It
   * must be exactly one revision ahead. Absent, or another organization's: `approval_not_found`.
   */
  update(
    organizationId: OrganizationId,
    id: ApprovalId,
    change: (current: Approval) => ApprovalWrite,
  ): Promise<Approval>;
}

export function checkNextApproval(current: Approval, next: Approval): void {
  if (
    next.id !== current.id ||
    next.organizationId !== current.organizationId ||
    next.bindingDigest !== current.bindingDigest ||
    next.revision !== current.revision + 1
  ) {
    throw new ApprovalError('approval_concurrency_conflict');
  }
}

/** For tests and local runs only. */
export class InMemoryApprovalRepository implements ApprovalRepository {
  readonly #approvals = new Map<string, Approval>();

  constructor(private readonly audit?: InMemoryAuditStore) {}

  async find(organizationId: OrganizationId, id: ApprovalId): Promise<Approval | undefined> {
    const approval = this.#approvals.get(id);
    return approval?.organizationId === organizationId ? checkStoredApproval(approval) : undefined;
  }

  async list(organizationId: OrganizationId, limit: number): Promise<readonly Approval[]> {
    return [...this.#approvals.values()]
      .filter((a) => a.organizationId === organizationId)
      .map(checkStoredApproval)
      .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : a.requestedAt > b.requestedAt ? -1 : 0))
      .slice(0, limit);
  }

  async create({ approval, events }: ApprovalWrite): Promise<void> {
    if (this.#approvals.has(approval.id)) throw new Error('approval already exists');
    this.#append(events);
    this.#approvals.set(approval.id, approval);
  }

  async update(
    organizationId: OrganizationId,
    id: ApprovalId,
    change: (current: Approval) => ApprovalWrite,
  ): Promise<Approval> {
    const current = await this.find(organizationId, id);
    if (current === undefined) throw new ApprovalError('approval_not_found');
    const { approval, events } = change(current);
    checkNextApproval(current, approval);
    if (this.#approvals.get(id)?.revision !== current.revision) {
      throw new ApprovalError('approval_concurrency_conflict');
    }
    this.#append(events);
    this.#approvals.set(id, approval);
    return approval;
  }

  #append(events: readonly AuditEvent[]): void {
    if (events.length === 0) return;
    if (this.audit === undefined) throw new Error('no audit store for approval events');
    this.audit.appendNow(events);
  }

  /** Test hook: stores a record as given, the way corrupted or legacy data would look. */
  put(approval: Approval): void {
    this.#approvals.set(approval.id, approval);
  }
}
