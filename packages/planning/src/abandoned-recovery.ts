import type { IsoTimestamp, PlanId } from '@melonoffice/domain';
import { isTenancyError, resolveRuntimeTenant, type TenancyStore } from '@melonoffice/tenancy';
import type { PlanConductor } from './conductor.js';
import type { AbandonedSweepCursor, PlanRepository } from './repository.js';

/** Plans read per page. */
export const ABANDONED_RECOVER_LIMIT = 50;

/**
 * Pages one pass reads (ADR-0187, decision 9): 500 plans at most. The next pass resumes where this one
 * stopped, so no count of abandoned plans holds the worker for a whole walk.
 */
export const ABANDONED_RECOVER_PAGES = 10;

/** What one pass did (ADR-0187, decision 9). */
export interface AbandonedRecoveryPass {
  /** The walk this pass worked on. Round 0 is the first walk over the abandoned plans. */
  readonly round: number;
  /** The plans the pass read, closed or not. */
  readonly read: number;
  /** The planning executions the pass closed. */
  readonly closed: number;
  /** Whether the walk ended in this pass. The next pass then starts round `round + 1` at its first plan. */
  readonly complete: boolean;
  /** Where the next pass resumes, after this id, while the walk is not complete. */
  readonly after?: PlanId;
}

/**
 * Closes the planning executions an interrupted cleanup of an abandoned plan left open (ADR-0187,
 * decisions 8 and 9). A pass reads the plans the runtime abandoned a page at a time, from the cursor
 * the last pass stored, and at most ABANDONED_RECOVER_PAGES pages. For each plan that failed a lease
 * ago, its creator's runtime asks the conductor to close the execution, and the conductor reads the real
 * state before it changes anything. A creator who left has no active membership, so their plans stay as
 * they are (decision 7).
 */
export interface AbandonedRecovery {
  /** One pass: it resumes the walk where the last pass left it, and reads at most its pages. */
  recover(): Promise<AbandonedRecoveryPass>;
}

export interface AbandonedRecoveryOptions {
  readonly plans: Pick<
    PlanRepository,
    'abandonedPage' | 'abandonedCursor' | 'advanceAbandonedCursor'
  >;
  readonly conductor: Pick<PlanConductor, 'closeAbandoned'>;
  readonly tenancy: TenancyStore;
  /** A plan that failed within this lease is left: the attempt that failed it still has time to finish. */
  readonly leaseMs: number;
  readonly now?: () => Date;
  readonly limit?: number;
  readonly pages?: number;
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
  pages = ABANDONED_RECOVER_PAGES,
  logger,
}: AbandonedRecoveryOptions): AbandonedRecovery {
  return Object.freeze({
    async recover(): Promise<AbandonedRecoveryPass> {
      const untouchedBefore = new Date(now().getTime() - leaseMs).toISOString() as IsoTimestamp;
      const start = await plans.abandonedCursor();
      let cursor = start;
      let read = 0;
      let closed = 0;
      for (let page = 0; page < pages; page += 1) {
        const found = await plans.abandonedPage(
          cursor.after === undefined ? { limit } : { after: cursor.after, limit },
        );
        for (const plan of found.plans) {
          read += 1;
          if (Date.parse(plan.updatedAt) > Date.parse(untouchedBefore)) continue;
          try {
            // The runtime acts only through an active membership (ADR-0029): a creator who left has none, and
            // that plan stays as it is (decision 7). Any other read failure is logged; the plan waits for a later round.
            const tenant = await resolveRuntimeTenant(
              plan.createdBy,
              plan.organizationId,
              tenancy,
            ).catch((error: unknown) => {
              if (!isTenancyError(error) || error.code !== 'organization_forbidden') {
                logger?.warn('abandoned plan recovery could not read the membership', {
                  planId: plan.id,
                  code: (error as { code?: unknown }).code ?? 'error',
                });
              }
              return undefined;
            });
            if (tenant === undefined) continue;
            if (await conductor.closeAbandoned(tenant, plan.id, { untouchedBefore })) closed += 1;
          } catch (error) {
            logger?.warn('abandoned plan recovery failed', {
              planId: plan.id,
              code: (error as { code?: unknown }).code ?? 'error',
            });
          }
        }
        // The store gives no `next` on the walk's last page. The walk ends here, and the next pass starts a new round.
        // A walk with no plan from its first page has nothing to resume: the cursor stays, so an idle sweep writes nothing.
        if (found.next === undefined) {
          if (cursor.after !== undefined || found.plans.length > 0) {
            await plans.advanceAbandonedCursor(cursor, { round: cursor.round + 1 });
          }
          return walkPass(start.round, read, closed, true);
        }
        // The cursor moves once the page is judged, so a crash repeats at most that page, and judging it again writes nothing.
        const next: AbandonedSweepCursor = { round: cursor.round, after: found.next };
        // Another sweep moved the cursor first, and carries the walk on from there: this pass stops.
        if (!(await plans.advanceAbandonedCursor(cursor, next))) {
          return walkPass(start.round, read, closed, false, cursor.after);
        }
        cursor = next;
      }
      return walkPass(start.round, read, closed, false, cursor.after);
    },
  });
}

/** One pass's result. `after` is set only while the walk is not complete and the pass knows where it stopped. */
function walkPass(
  round: number,
  read: number,
  closed: number,
  complete: boolean,
  after?: PlanId,
): AbandonedRecoveryPass {
  return {
    round,
    read,
    closed,
    complete,
    ...(complete || after === undefined ? {} : { after }),
  };
}
