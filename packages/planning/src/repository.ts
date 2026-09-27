import type { AuditEvent, InMemoryAuditStore } from '@melonoffice/audit';
import type { OrganizationId, Plan, PlanId, PlanVersion } from '@melonoffice/domain';
import { PlanningError } from './errors.js';
import { checkStoredPlan, checkStoredPlanVersion } from './model.js';

/** A new plan, its first version, and the audit events that record it. */
export interface PlanCreate {
  readonly plan: Plan;
  readonly version: PlanVersion;
  readonly events: readonly AuditEvent[];
}

/** The new state of a plan and the audit events that record the change. */
export interface PlanUpdate {
  readonly plan: Plan;
  readonly events: readonly AuditEvent[];
}

/**
 * Where plans live: `plans/{planId}` and write-once `planVersions/{planId}_{version}` in
 * Firestore (ADR-0028), memory in tests. Every write stores the plan and its audit events
 * together, or nothing.
 */
export interface PlanRepository {
  /** The plan, only when it belongs to the organization. Another organization's is absent. */
  find(organizationId: OrganizationId, id: PlanId): Promise<Plan | undefined>;
  findVersion(
    organizationId: OrganizationId,
    id: PlanId,
    version: number,
  ): Promise<PlanVersion | undefined>;
  /** The organization's plans, newest first, at most `limit`. */
  list(organizationId: OrganizationId, limit: number): Promise<readonly Plan[]>;
  /** Stores a new plan and its first version. An id that already exists is `plan_concurrency_conflict`. */
  create(write: PlanCreate): Promise<void>;
  /**
   * Reads the current plan and its current version and lets `change` decide the next plan, in
   * one transaction. The next plan must be exactly one revision ahead and keep its version.
   * Absent, or another organization's: `plan_not_found`.
   */
  update(
    organizationId: OrganizationId,
    id: PlanId,
    change: (current: Plan, version: PlanVersion) => PlanUpdate,
  ): Promise<Plan>;
}

export const planVersionKey = (id: PlanId, version: number): string => `${id}_${version}`;

/** Checks what `change` returned: the same plan, at the same version, one revision ahead. */
export function checkNextPlan(current: Plan, next: Plan): void {
  if (
    next.id !== current.id ||
    next.organizationId !== current.organizationId ||
    next.executionId !== current.executionId ||
    next.version !== current.version ||
    next.revision !== current.revision + 1
  ) {
    throw new PlanningError('plan_concurrency_conflict');
  }
}

/** For tests and local runs only. */
export class InMemoryPlanRepository implements PlanRepository {
  readonly #plans = new Map<string, Plan>();
  readonly #versions = new Map<string, PlanVersion>();

  constructor(private readonly audit?: InMemoryAuditStore) {}

  async find(organizationId: OrganizationId, id: PlanId): Promise<Plan | undefined> {
    const plan = this.#plans.get(id);
    return plan?.organizationId === organizationId ? checkStoredPlan(plan) : undefined;
  }

  async findVersion(
    organizationId: OrganizationId,
    id: PlanId,
    version: number,
  ): Promise<PlanVersion | undefined> {
    const found = this.#versions.get(planVersionKey(id, version));
    return found?.organizationId === organizationId ? checkStoredPlanVersion(found) : undefined;
  }

  async list(organizationId: OrganizationId, limit: number): Promise<readonly Plan[]> {
    return [...this.#plans.values()]
      .filter((p) => p.organizationId === organizationId)
      .map(checkStoredPlan)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, limit);
  }

  async create({ plan, version, events }: PlanCreate): Promise<void> {
    const key = planVersionKey(plan.id, version.version);
    if (this.#plans.has(plan.id) || this.#versions.has(key)) {
      throw new PlanningError('plan_concurrency_conflict');
    }
    this.#append(events);
    this.#plans.set(plan.id, plan);
    this.#versions.set(key, version);
  }

  async update(
    organizationId: OrganizationId,
    id: PlanId,
    change: (current: Plan, version: PlanVersion) => PlanUpdate,
  ): Promise<Plan> {
    const current = await this.find(organizationId, id);
    const version =
      current === undefined
        ? undefined
        : await this.findVersion(organizationId, id, current.version);
    if (current === undefined || version === undefined) throw new PlanningError('plan_not_found');
    const { plan, events } = change(current, version);
    checkNextPlan(current, plan);
    if (this.#plans.get(id)?.revision !== current.revision) {
      throw new PlanningError('plan_concurrency_conflict');
    }
    this.#append(events);
    this.#plans.set(id, plan);
    return plan;
  }

  #append(events: readonly AuditEvent[]): void {
    if (events.length === 0) return;
    if (this.audit === undefined) throw new Error('no audit store for plan events');
    this.audit.appendNow(events);
  }

  /** Test hook: stores a version as given, the way corrupted data would look. */
  putVersion(version: PlanVersion): void {
    this.#versions.set(planVersionKey(version.planId, version.version), version);
  }
}
