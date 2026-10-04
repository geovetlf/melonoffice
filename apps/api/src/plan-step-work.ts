import { isAfter, type TaskPosition } from '@melonoffice/agents';
import type { AgentTask, Execution, Plan, PlanVersion } from '@melonoffice/domain';
import type { AgentOutputStore, ExecutionService } from '@melonoffice/execution';
import type { PlanService } from '@melonoffice/planning';
import type { AuthorizationService } from '@melonoffice/rbac';
import type { TenantContext } from '@melonoffice/tenancy';
import { readPlanSteps, type PlanStepRead } from './plans.js';

/**
 * Plan steps run by agents, as the list of every agent's work reads them (ADR-0149). They stay
 * what they are, steps of a plan and the plan's child executions: nothing is copied into tasks
 * and nothing is stored. Each step is read with `plan.read`, through the plan service and the
 * plan engine's own step states (`readPlanSteps`), exactly as the plan's page reads it.
 *
 * A step's place in the list is when its plan was approved, the moment its execution was
 * created, with the execution id after it: an order the plans alone give, stable across pages.
 */

/** How many steps are read to fill one page narrowed by agent or state, at most, per page. */
const STEP_SCAN_ROUNDS = 5;

export interface PlanStepItem {
  readonly position: TaskPosition;
  readonly plan: Plan;
  readonly version: PlanVersion;
  readonly step: PlanVersion['steps'][number];
  readonly read: PlanStepRead;
  readonly execution?: Execution;
  /** The states of the plan's other steps, for the dependencies shown with it. */
  readonly siblings: readonly PlanStepRead[];
}

export interface PlanStepPage {
  readonly items: readonly PlanStepItem[];
  /** The last step read, when more remain after it: the list goes no further this page. */
  readonly horizon?: TaskPosition;
  /** The plan service lists the newest plans only (MAX_PLANS_LISTED): it returned that many. */
  readonly windowed: boolean;
}

/** A position as a list item has one, for comparing a task's with a step's. */
const asTask = (p: TaskPosition) => ({ createdAt: p.at, id: p.id }) as AgentTask;

/** Whether `a` comes before `b` in the list: newer, or the same instant and a greater id. */
export const newerThan = (a: TaskPosition, b: TaskPosition): boolean => isAfter(asTask(b), a);

export function createPlanStepSource(options: {
  readonly plans: Pick<PlanService, 'list' | 'getVersion'>;
  /** `plan.read`, checked here as the plan routes check it: the plan service lists for anyone. */
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly executions: Pick<ExecutionService, 'get'>;
  readonly outputs?: Pick<AgentOutputStore, 'find'>;
  /** How many plans the plan service lists at most. */
  readonly window: number;
}) {
  const { plans, authorization, executions, outputs, window } = options;
  return {
    async page(
      tenant: TenantContext,
      query: {
        readonly after?: TaskPosition;
        readonly since?: string;
        readonly limit: number;
        readonly specialistId?: string;
        readonly status?: string;
      },
    ): Promise<PlanStepPage> {
      const organizationId = tenant.organizationId;
      // The plan routes' own permission; another organization's plan is none.
      if (!authorization.authorize(tenant, 'plan.read').allowed) {
        throw Object.assign(new Error('plan.read not granted'), { code: 'permission_denied' });
      }
      const listed = await plans.list(tenant);
      const candidates = listed
        .filter((p) => p.organizationId === organizationId)
        .flatMap((plan) =>
          plan.delegations.map((d) => ({
            plan,
            stepId: d.stepId,
            position: {
              at: plan.decision?.decidedAt ?? plan.createdAt,
              id: d.executionId,
            } as TaskPosition,
          })),
        )
        .filter(
          (c) =>
            (query.after === undefined || newerThan(query.after, c.position)) &&
            (query.since === undefined || c.position.at >= query.since),
        )
        .sort((a, b) => (newerThan(a.position, b.position) ? -1 : 1));

      const read = new Map<
        string,
        Promise<{ version: PlanVersion; steps: Awaited<ReturnType<typeof readPlanSteps>> }>
      >();
      const stepsOf = (plan: Plan) => {
        let found = read.get(plan.id);
        if (found === undefined) {
          found = (async () => {
            const version = await plans.getVersion(tenant, plan.id, plan.version);
            const steps = await readPlanSteps(tenant, plan, version, {
              executions,
              ...(outputs === undefined ? {} : { outputs }),
            });
            return { version, steps };
          })();
          read.set(plan.id, found);
        }
        return found;
      };

      const items: PlanStepItem[] = [];
      const budget = query.limit * STEP_SCAN_ROUNDS;
      let scanned = 0;
      let horizon: TaskPosition | undefined;
      for (const [index, c] of candidates.entries()) {
        if (items.length === query.limit || scanned === budget) {
          // More remain: the page goes no further than the last one read.
          horizon = candidates[index - 1]?.position;
          break;
        }
        scanned += 1;
        const { version, steps } = await stepsOf(c.plan);
        const step = version.steps.find((s) => s.id === c.stepId);
        const own = steps.views.find((v) => v.stepId === c.stepId);
        if (step === undefined || own === undefined || step.kind !== 'specialist') continue;
        if (query.specialistId !== undefined && step.specialist?.id !== query.specialistId)
          continue;
        const execution = steps.children.get(c.stepId);
        if (query.status !== undefined && execution?.status !== query.status) continue;
        items.push({
          position: c.position,
          plan: c.plan,
          version,
          step,
          read: own,
          ...(execution === undefined ? {} : { execution }),
          siblings: steps.views,
        });
      }
      return {
        items,
        ...(horizon === undefined ? {} : { horizon }),
        windowed: listed.length >= window,
      };
    },
  };
}
