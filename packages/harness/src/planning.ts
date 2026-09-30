import { createHash } from 'node:crypto';
import type {
  Execution,
  OrganizationId,
  Plan,
  PlanVersion,
  SpecialistId,
} from '@melonoffice/domain';
import { executionIdFor, type ExecutionService } from '@melonoffice/execution';
import type { RiskPolicy } from '@melonoffice/guardrails';
import type { Planner, PlanService } from '@melonoffice/planning';
import type { SpecialistService } from '@melonoffice/specialists';
import type { TenantContext } from '@melonoffice/tenancy';
import type { HarnessPlanStep } from './limits.js';

/** What a planning execution made by the Harness points at: the request's digest, not its text. */
export const HARNESS_PLAN_INPUT = 'harness_plan';

/**
 * The plan validator's risk policy for plans the Harness asks for (ADR-0101): every plan waits for
 * a person's approval, whatever its risk, and critical work is refused. A model's plan runs nothing
 * until a person has seen it; approving it runs it through the existing conductor (ADR-0070).
 */
export const HARNESS_RISK_POLICY: RiskPolicy = Object.freeze({
  low: 'approval_required',
  medium: 'approval_required',
  high: 'approval_required',
  critical: 'denied',
});

export type HarnessPlanOutcome =
  | {
      readonly status: 'planned';
      readonly planId: string;
      readonly planStatus: Plan['status'];
      readonly version: number;
      readonly steps: readonly HarnessPlanStep[];
    }
  | { readonly status: 'failed'; readonly reason: string };

/** How the Harness asks for a multi-step plan. The planner and the plan service do the work. */
export interface HarnessPlanner {
  plan(
    tenant: TenantContext,
    input: {
      readonly request: string;
      readonly agentId: SpecialistId;
      readonly idempotencyKey?: string;
    },
  ): Promise<HarnessPlanOutcome>;
  /** Withdraws a plan the Harness will not let run. `reason` is a stable code. */
  cancel(tenant: TenantContext, planId: string, reason: string): Promise<void>;
}

export interface PlanningHarnessPlannerOptions {
  readonly executions: Pick<ExecutionService, 'create' | 'get' | 'changeStatus'>;
  readonly specialists: Pick<SpecialistService, 'get'>;
  /** The existing planner (ADR-0028): the only path from a request to a plan. */
  readonly planner: Planner;
  /** A plan service whose validator uses `HARNESS_RISK_POLICY`. */
  readonly plans: Pick<PlanService, 'get' | 'getVersion' | 'cancel'>;
}

const stepsOf = (version: PlanVersion): readonly HarnessPlanStep[] =>
  version.steps.map((s) =>
    Object.freeze({
      id: s.id,
      label: s.label,
      dependsOn: s.dependsOn,
      ...(s.specialist === undefined ? {} : { specialistId: s.specialist.id }),
    }),
  );

const digestOf = (request: string): string =>
  createHash('sha256').update(request, 'utf8').digest('hex').slice(0, 32);

/**
 * The Harness's planner over the existing planning engine (ADR-0101): a planning execution owned
 * by the routed agent, then `Planner.plan` (AI Gateway → proposal → validation pipeline → stored
 * plan). The same idempotency key is the same planning execution; the same key with another
 * request is `idempotency_conflict`.
 */
export function createPlanningHarnessPlanner({
  executions,
  specialists,
  planner,
  plans,
}: PlanningHarnessPlannerOptions): HarnessPlanner {
  async function planned(tenant: TenantContext, planId: string): Promise<HarnessPlanOutcome> {
    const plan = await plans.get(tenant, planId);
    const version = await plans.getVersion(tenant, plan.id, plan.version);
    return Object.freeze({
      status: 'planned',
      planId: plan.id,
      planStatus: plan.status,
      version: plan.version,
      steps: Object.freeze(stepsOf(version)),
    });
  }

  async function executionFor(
    tenant: TenantContext,
    input: { request: string; agentId: SpecialistId; idempotencyKey?: string },
  ): Promise<Execution> {
    const specialist = await specialists.get(tenant, input.agentId);
    const request = {
      mode: 'plan' as const,
      input: { type: HARNESS_PLAN_INPUT, id: digestOf(input.request) },
      specialistId: specialist.identity.id,
      specialistVersion: specialist.version,
      departmentId: specialist.configuration.departmentId,
      versionSnapshot: {
        schemaVersion: 1 as const,
        components: [
          { kind: 'specialist', id: specialist.identity.id, version: String(specialist.version) },
        ],
      },
      ...(input.idempotencyKey === undefined
        ? {}
        : { idempotencyKey: `harness_plan:${input.idempotencyKey}` }),
    };
    try {
      return await executions.create(tenant, request);
    } catch (error) {
      if (request.idempotencyKey === undefined) throw error;
      // A repeat of the same request: that execution is the plan's.
      const id = executionIdFor(tenant.organizationId as OrganizationId, request.idempotencyKey);
      return executions.get(tenant, id).catch(() => {
        throw error;
      });
    }
  }

  const harnessPlanner: HarnessPlanner = {
    async plan(tenant, input) {
      let execution = await executionFor(tenant, input);
      if (execution.input.type !== HARNESS_PLAN_INPUT) {
        return Object.freeze({ status: 'failed', reason: 'idempotency_conflict' });
      }
      if (execution.input.id !== digestOf(input.request)) {
        return Object.freeze({ status: 'failed', reason: 'idempotency_conflict' });
      }
      if (execution.status === 'pending') {
        execution = await executions.changeStatus(tenant, execution.id, {
          from: 'pending',
          to: 'planning',
        });
      }
      if (execution.status !== 'planning') {
        // Planned before (the plan's id is its planning execution's), or failed planning.
        return execution.status === 'failed'
          ? Object.freeze({
              status: 'failed',
              reason: execution.failure?.code ?? 'planning_failed',
            })
          : planned(tenant, execution.id);
      }
      const outcome = await planner.plan(tenant, {
        executionId: execution.id,
        requestId: `harness:${execution.id}`,
        objective: input.request,
        // Agent tasks read company data: never a provider limited to public data.
        sensitivity: 'confidential',
      });
      if (outcome.status === 'failed') return outcome;
      if (outcome.status === 'refused') {
        return Object.freeze({ status: 'failed', reason: outcome.reason });
      }
      return planned(tenant, outcome.plan.id);
    },
    async cancel(tenant, planId, reason) {
      // Only a plan still waiting for its approval: nothing was delegated, so no child to stop.
      const plan = await plans.cancel(tenant, planId, reason);
      const execution = await executions.get(tenant, plan.executionId);
      if (execution.status === 'waiting_approval' || execution.status === 'planning') {
        await executions.changeStatus(tenant, execution.id, {
          from: execution.status,
          to: 'cancelled',
          reason,
        });
      }
    },
  };
  return Object.freeze(harnessPlanner);
}
