import { isAfter, type TaskPosition } from '@melonoffice/agents';
import type { AgentTask, Execution, Plan, PlanVersion } from '@melonoffice/domain';
import type { AgentOutputStore, ExecutionService } from '@melonoffice/execution';
import type { PlanPosition, PlanService } from '@melonoffice/planning';
import type { AuthorizationService } from '@melonoffice/rbac';
import type { TenantContext } from '@melonoffice/tenancy';
import { readPlanSteps, type PlanStepRead } from './plans.js';

/**
 * Plan steps run by agents, as the list of every agent's work reads them (ADR-0149). They stay
 * what they are, steps of a plan and the plan's child executions: nothing is copied into tasks
 * and nothing is stored. Each step is read with `plan.read`, through the plan service and the
 * plan engine's own step states (`readPlanSteps`), exactly as the plan's page reads it.
 *
 * A step's place in the list is when its plan was created, with the execution id after it
 * (ADR-0150): the order Firestore's plan index gives, so every plan is reached a page at a time,
 * however many the organization has, and the order is stable across pages.
 */

/** How many steps are read to fill one page narrowed by agent or state, at most, per page. */
const STEP_SCAN_ROUNDS = 5;
/** How many plans are read from storage at a time. */
const PLAN_BATCH = 25;

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
}

interface Candidate {
  readonly plan: Plan;
  readonly stepId: string;
  readonly position: TaskPosition;
}

/** A position as a list item has one, for comparing a task's with a step's. */
const asTask = (p: TaskPosition) => ({ createdAt: p.at, id: p.id }) as AgentTask;

/** Whether `a` comes before `b` in the list: newer, or the same instant and a greater id. */
export const newerThan = (a: TaskPosition, b: TaskPosition): boolean => isAfter(asTask(b), a);

const newestFirst = (a: Candidate, b: Candidate) => (newerThan(a.position, b.position) ? -1 : 1);

export function createPlanStepSource(options: {
  readonly plans: Pick<PlanService, 'page' | 'getVersion'>;
  /** `plan.read`, checked here as the plan routes check it: the plan service lists for anyone. */
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly executions: Pick<ExecutionService, 'get'>;
  readonly outputs?: Pick<AgentOutputStore, 'find'>;
}) {
  const { plans, authorization, executions, outputs } = options;

  /**
   * The organization's delegated steps, newest first, after `after` and not before `since`.
   * Plans come newest first a batch at a time. Steps of plans created at the same instant are
   * held until no later batch can add one, so their order by execution id is exact.
   */
  async function* candidatesOf(
    tenant: TenantContext,
    after: TaskPosition | undefined,
    since: string | undefined,
  ): AsyncGenerator<Candidate> {
    const organizationId = tenant.organizationId;
    // Plans created at the cursor's instant are read again: some of their steps may remain.
    let cursor: PlanPosition | undefined =
      after === undefined ? undefined : { at: after.at, id: '~' };
    let held: Candidate[] = [];
    for (;;) {
      const page = await plans.page(tenant, {
        ...(cursor === undefined ? {} : { after: cursor }),
        limit: PLAN_BATCH,
      });
      let reachedSince = false;
      for (const plan of page.items) {
        if (since !== undefined && plan.createdAt < since) {
          reachedSince = true;
          break;
        }
        // Another organization's plan is none.
        if (plan.organizationId !== organizationId) continue;
        for (const d of plan.delegations) {
          const position = { at: plan.createdAt, id: d.executionId } as TaskPosition;
          if (after === undefined || newerThan(after, position)) {
            held.push({ plan, stepId: d.stepId, position });
          }
        }
      }
      const last = page.items.at(-1);
      const done = reachedSince || !page.hasMore || last === undefined;
      held.sort(newestFirst);
      // A later batch only holds plans created at or before the last one read.
      const ready = done ? held : held.filter((c) => c.position.at > last.createdAt);
      held = done ? [] : held.filter((c) => c.position.at <= last.createdAt);
      yield* ready;
      if (done) return;
      cursor = { at: last.createdAt, id: last.id };
    }
  }

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
      // The plan routes' own permission; another organization's plan is none.
      if (!authorization.authorize(tenant, 'plan.read').allowed) {
        throw Object.assign(new Error('plan.read not granted'), { code: 'permission_denied' });
      }
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
      let previous: TaskPosition | undefined;
      let horizon: TaskPosition | undefined;
      for await (const c of candidatesOf(tenant, query.after, query.since)) {
        if (items.length === query.limit || scanned === budget) {
          // More remain: the page goes no further than the last one read.
          horizon = previous;
          break;
        }
        scanned += 1;
        previous = c.position;
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
      return { items, ...(horizon === undefined ? {} : { horizon }) };
    },
  };
}
