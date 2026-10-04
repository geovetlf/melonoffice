import type { OrganizationId, Plan, PlanId, UserId } from '@melonoffice/domain';
import type { ExecutionRepository } from '@melonoffice/execution';
import type { Logger } from '@melonoffice/observability';
import { isPlanId, type PlanRepository, type PlanWakeups } from '@melonoffice/planning';
import { resolveRuntimeTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';

/**
 * The only route that wakes a plan (ADR-0152): a wait step ended, so the plan is advanced and the
 * steps after it start. It means "look at this plan again" and nothing else: the plan, its wait
 * and its person are read from Firestore, so a repeated, late or early task changes nothing.
 */
export const RUN_PLAN_WAKE_PATH = '/internal/plans/wake';

export interface PlanWakeRunResult {
  readonly status: 200 | 400 | 503;
  readonly body: { readonly result: string; readonly code?: string };
}

export interface PlanWakeHandler {
  run(request: unknown): Promise<PlanWakeRunResult>;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Exactly `{ organizationId, planId }`. */
function wakeOf(
  request: unknown,
): { readonly organizationId: OrganizationId; readonly planId: PlanId } | undefined {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return undefined;
  if (Object.keys(request).sort().join(',') !== 'organizationId,planId') return undefined;
  const { organizationId, planId } = request as Record<string, unknown>;
  if (typeof organizationId !== 'string' || !UUID.test(organizationId)) return undefined;
  if (!isPlanId(planId)) return undefined;
  return { organizationId: organizationId as OrganizationId, planId };
}

const answer = (status: PlanWakeRunResult['status'], body: PlanWakeRunResult['body']) =>
  Object.freeze({ status, body: Object.freeze(body) });

/** Queues a plan's wake-up on the worker's own queue: the body names the plan, nothing else. */
export function createPlanWakeups(scheduler: {
  schedule(body: object, at: Date): Promise<void>;
}): PlanWakeups {
  return Object.freeze({
    async wake(
      _tenant: TenantContext,
      plan: { readonly organizationId: string; readonly planId: string },
      at: Date,
    ) {
      await scheduler.schedule({ organizationId: plan.organizationId, planId: plan.planId }, at);
    },
  });
}

/**
 * The worker's wake-up handler: thin, like the job handler. A plan that is not running, or that
 * this organization does not have, is left alone (`200`). The plan is advanced as the runtime of
 * the person its planning execution runs for, never anyone else. `503` asks the queue to deliver
 * again, which is safe.
 */
export function createPlanWakeHandler(options: {
  readonly plans: Pick<PlanRepository, 'find'>;
  readonly executions: Pick<ExecutionRepository, 'find'>;
  readonly tenancy: TenancyStore;
  readonly advance: (tenant: TenantContext, planId: PlanId) => Promise<unknown>;
  readonly logger?: Logger;
}): PlanWakeHandler {
  const { plans, executions, tenancy, advance, logger } = options;
  return Object.freeze({
    async run(request: unknown) {
      const wake = wakeOf(request);
      if (wake === undefined) return answer(400, { result: 'rejected', code: 'invalid_wake' });
      try {
        const plan: Plan | undefined = await plans.find(wake.organizationId, wake.planId);
        if (plan?.organizationId !== wake.organizationId || plan.status !== 'executing') {
          return answer(200, { result: 'ignored' });
        }
        const parent = await executions.find(wake.organizationId, plan.executionId);
        if (parent === undefined) return answer(200, { result: 'ignored' });
        let tenant;
        try {
          tenant = await resolveRuntimeTenant(
            parent.userId as UserId,
            plan.organizationId,
            tenancy,
          );
        } catch {
          // No member, no organization: nothing runs for nobody.
          return answer(200, { result: 'ignored', code: 'no_context' });
        }
        await advance(tenant, plan.id);
        return answer(200, { result: 'advanced' });
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        logger?.warn('plan wake-up failed', {
          planId: wake.planId,
          code: typeof code === 'string' ? code : 'error',
        });
        return answer(503, { result: 'retry' });
      }
    },
  });
}
