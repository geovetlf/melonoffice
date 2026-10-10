import type { IsoTimestamp, Plan, PlanId } from '@melonoffice/domain';
import type { AuthorizationService } from '@melonoffice/rbac';
import { resolveRuntimeTenant, type TenancyStore } from '@melonoffice/tenancy';
import type { PlanConductor } from './conductor.js';
import type { PlanRepository } from './repository.js';

/** Plans read per page, and pages per run: the bounds the schedules' sweep uses (ADR-0186). */
export const PERMISSION_RECOVER_LIMIT = 50;
export const PERMISSION_RECOVER_PAGES = 10;

/**
 * Releases a person's hand-made plans once they may no longer plan (ADR-0187, decision 6). It reads
 * the `creating` plans of every organization a page at a time. For each plan whose creator still has
 * an active membership but no `plan.create`, it releases the delegation as that creator's runtime.
 * A creator who left the organization has no active membership, so their plans stay as they are
 * (decision 7). A schedule's plan is closed by the schedule's own sweep (ADR-0186), never here.
 */
export interface PermissionRecovery {
  /** One run: how many plans it released. */
  recover(): Promise<number>;
}

export interface PermissionRecoveryOptions {
  readonly plans: Pick<PlanRepository, 'creatingPage'>;
  readonly conductor: Pick<PlanConductor, 'releaseManual'>;
  readonly tenancy: TenancyStore;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  /** A plan changed within this lease is left to the attempt that changed it (ADR-0185). */
  readonly leaseMs: number;
  readonly now?: () => Date;
  readonly limit?: number;
  readonly pages?: number;
  readonly logger?: {
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createPermissionRecovery({
  plans,
  conductor,
  tenancy,
  authorization,
  leaseMs,
  now = () => new Date(),
  limit = PERMISSION_RECOVER_LIMIT,
  pages = PERMISSION_RECOVER_PAGES,
  logger,
}: PermissionRecoveryOptions): PermissionRecovery {
  /** Releases one plan when its creator lost the permission; false when the plan is left as it is. */
  async function releaseOne(plan: Plan, untouchedBefore: IsoTimestamp): Promise<boolean> {
    if (plan.decision?.via === 'schedule' || plan.workflow?.occurrence !== undefined) return false;
    // The runtime acts only through an active membership (ADR-0029): a creator who left has none.
    const tenant = await resolveRuntimeTenant(plan.createdBy, plan.organizationId, tenancy).catch(
      () => undefined,
    );
    if (tenant === undefined) return false;
    const { allowed } = authorization.authorize(tenant, 'plan.create', {
      organizationId: plan.organizationId,
    });
    if (allowed) return false;
    await conductor.releaseManual(tenant, plan.id, { untouchedBefore });
    return true;
  }

  return Object.freeze({
    async recover(): Promise<number> {
      const untouchedBefore = new Date(now().getTime() - leaseMs).toISOString() as IsoTimestamp;
      let released = 0;
      let after: PlanId | undefined;
      for (let page = 0; page < pages; page += 1) {
        const { plans: open, next } = await plans.creatingPage(
          after === undefined ? { limit } : { after, limit },
        );
        for (const plan of open) {
          // Changed within its lease: the attempt that changed it still owns it.
          if (Date.parse(plan.updatedAt) > Date.parse(untouchedBefore)) continue;
          try {
            if (await releaseOne(plan, untouchedBefore)) released += 1;
          } catch (error) {
            logger?.warn('plan permission recovery failed', {
              planId: plan.id,
              code: (error as { code?: unknown }).code ?? 'error',
            });
          }
        }
        if (next === undefined) break;
        after = next;
      }
      return released;
    },
  });
}
