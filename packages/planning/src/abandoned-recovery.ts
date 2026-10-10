import type { IsoTimestamp, PlanId } from '@melonoffice/domain';
import { resolveRuntimeTenant, type TenancyStore } from '@melonoffice/tenancy';
import type { PlanConductor } from './conductor.js';
import type { PlanRepository } from './repository.js';

/** Plans read per page. The walk reads every page each run (ADR-0187, decision 8). */
export const ABANDONED_RECOVER_LIMIT = 50;

/**
 * Closes the planning executions an interrupted cleanup of an abandoned plan left open (ADR-0187,
 * decision 8). It reads the plans the runtime abandoned, every page each run. For each plan that failed
 * a lease ago, its creator's runtime asks the conductor to close the execution, and the conductor reads
 * the real state before it changes anything. A creator who left has no active membership, so their
 * plans stay as they are (decision 7).
 */
export interface AbandonedRecovery {
  /** One run: how many planning executions it closed. */
  recover(): Promise<number>;
}

export interface AbandonedRecoveryOptions {
  readonly plans: Pick<PlanRepository, 'abandonedPage'>;
  readonly conductor: Pick<PlanConductor, 'closeAbandoned'>;
  readonly tenancy: TenancyStore;
  /** A plan that failed within this lease is left: the attempt that failed it still has time to finish. */
  readonly leaseMs: number;
  readonly now?: () => Date;
  readonly limit?: number;
  readonly logger?: {
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

export function createAbandonedRecovery({
  plans,
  conductor,
  tenancy,
  leaseMs,
  now = () => new Date(),
  limit = ABANDONED_RECOVER_LIMIT,
  logger,
}: AbandonedRecoveryOptions): AbandonedRecovery {
  return Object.freeze({
    async recover(): Promise<number> {
      const untouchedBefore = new Date(now().getTime() - leaseMs).toISOString() as IsoTimestamp;
      let closed = 0;
      let after: PlanId | undefined;
      do {
        const page = await plans.abandonedPage(after === undefined ? { limit } : { after, limit });
        for (const plan of page.plans) {
          if (Date.parse(plan.updatedAt) > Date.parse(untouchedBefore)) continue;
          try {
            // The runtime acts only through an active membership (ADR-0029): a creator who left has none.
            const tenant = await resolveRuntimeTenant(
              plan.createdBy,
              plan.organizationId,
              tenancy,
            ).catch(() => undefined);
            if (tenant === undefined) continue;
            if (await conductor.closeAbandoned(tenant, plan.id, { untouchedBefore })) closed += 1;
          } catch (error) {
            logger?.warn('abandoned plan recovery failed', {
              planId: plan.id,
              code: (error as { code?: unknown }).code ?? 'error',
            });
          }
        }
        after = page.next;
      } while (after !== undefined);
      return closed;
    },
  });
}
