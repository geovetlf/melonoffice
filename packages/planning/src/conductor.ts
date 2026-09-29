import { actorOf, buildAuditEvent } from '@melonoffice/audit';
import type {
  Execution,
  ExecutionId,
  IsoTimestamp,
  OrganizationId,
  Plan,
  PlanId,
  PlanStep,
  PlanVersion,
} from '@melonoffice/domain';
import { isExecutionError, isTerminal, type ExecutionService } from '@melonoffice/execution';
import type { Logger } from '@melonoffice/observability';
import { isResolvedTenant, type TenantContext } from '@melonoffice/tenancy';
import type { Delegation } from './delegation.js';
import { isPlanningError, PlanningError } from './errors.js';
import { applyPlanStatus, isPlanId } from './model.js';
import type { PlanRepository } from './repository.js';

/**
 * The plan conductor (WF-1, ADR-0070): an approved plan runs. It adds no engine: each specialist
 * step is the child execution delegation already creates, run by the existing runtime (one node
 * at a time, models only through the AI Gateway, tools only through the gate). The conductor only
 * decides when each child starts and when the plan is over.
 *
 * - `run` (the person who approved, right after approving): delegates the plan and starts the
 *   steps that depend on no other step.
 * - `advance` (the runtime, after one of the plan's steps ended): starts every step whose steps
 *   before it completed, mirrors the children on the planning execution's graph, and closes the
 *   plan: `completed` once every step completed with passing evidence, `failed` as soon as one
 *   step failed or was cancelled. A step never starts after the plan stopped.
 *
 * Both are idempotent and safe to call again at any point: every change names the state it
 * expects, and a change another call already made is read back, never made twice.
 */
export interface PlanConductor {
  run(tenant: TenantContext, planId: string): Promise<Plan>;
  advance(tenant: TenantContext, planId: string): Promise<Plan>;
}

/**
 * Starts one step's child execution and queues its first node: for a person, their own `start`;
 * for the runtime, the delegated start of that person's own execution. The app wires it to the
 * execution service and the runtime's `kickoff`.
 */
export interface StepStarter {
  start(tenant: TenantContext, executionId: ExecutionId): Promise<void>;
}

/** The step kinds a plan may have to run in WF-1. Anything else is refused before approval. */
export const RUNNABLE_STEP_KINDS: readonly PlanStep['kind'][] = ['specialist'];

/**
 * Why a plan version cannot run yet, or `undefined` when it can. WF-1 runs specialist steps only:
 * a tool, approval, verification, condition or parallel step has no defined behaviour in a plan
 * yet (ADR-0031), so such a plan is refused whole, never run in part.
 */
export function unrunnableStepOf(version: PlanVersion): string | undefined {
  const step = version.steps.find((s) => !RUNNABLE_STEP_KINDS.includes(s.kind));
  return step === undefined ? undefined : step.kind;
}

/** The plan step a child execution is for (`plan_step` input `{planId}:{stepId}`), if it is one. */
export function planStepOf(
  execution: Execution,
): { readonly planId: PlanId; readonly stepId: string } | undefined {
  if (execution.input.type !== 'plan_step' || execution.parentExecutionId === undefined) {
    return undefined;
  }
  const [planId, stepId, ...rest] = execution.input.id.split(':');
  if (rest.length > 0 || stepId === undefined || stepId.length === 0 || !isPlanId(planId)) {
    return undefined;
  }
  return Object.freeze({ planId, stepId });
}

/**
 * The steps with every step after the ones it depends on. The plan's graph was checked acyclic
 * when it was validated; a graph that is not is refused here too, never run in part.
 */
function inOrder(steps: readonly PlanStep[]): readonly PlanStep[] {
  const out: PlanStep[] = [];
  const placed = new Set<string>();
  let rest = [...steps];
  while (rest.length > 0) {
    const ready = rest.filter((s) => s.dependsOn.every((d) => placed.has(d)));
    if (ready.length === 0) throw new PlanningError('invalid_plan', 'dependsOn');
    for (const s of ready) {
      out.push(s);
      placed.add(s.id);
    }
    rest = rest.filter((s) => !placed.has(s.id));
  }
  return out;
}

export interface PlanConductorOptions {
  readonly plans: PlanRepository;
  /** Needed by `run` only: the worker advances plans, it never delegates one. */
  readonly delegation?: Pick<Delegation, 'delegate'>;
  readonly executions: Pick<
    ExecutionService,
    'get' | 'runtimePlanChangeStatus' | 'runtimePlanChangeNode' | 'recordVerification'
  >;
  readonly starter: StepStarter;
  readonly now?: () => Date;
  readonly requestId?: string;
  readonly logger?: Logger;
}

/** The planning execution's evidence that every step completed: its child execution. */
export const STEP_CHECK = 'step_execution_completed';

export function createPlanConductor(options: PlanConductorOptions): PlanConductor {
  const { plans, delegation, executions, starter, now = () => new Date(), requestId } = options;
  const logger = options.logger;

  const iso = (at: Date): IsoTimestamp => at.toISOString() as IsoTimestamp;

  function organizationOf(tenant: TenantContext): OrganizationId {
    if (!isResolvedTenant(tenant)) throw new PlanningError('unresolved_tenant');
    return tenant.organizationId;
  }

  async function load(
    organizationId: OrganizationId,
    planId: string,
  ): Promise<{ plan: Plan; version: PlanVersion }> {
    if (!isPlanId(planId)) throw new PlanningError('plan_not_found');
    const plan = await plans.find(organizationId, planId);
    if (plan === undefined) throw new PlanningError('plan_not_found');
    const version = await plans.findVersion(organizationId, plan.id, plan.version);
    if (version === undefined) throw new PlanningError('plan_not_found');
    return { plan, version };
  }

  /** Each specialist step with its child execution, every step after the steps it depends on. */
  async function stepsOf(
    tenant: TenantContext,
    plan: Plan,
    version: PlanVersion,
  ): Promise<readonly { step: PlanStep; child: Execution }[]> {
    const out: { step: PlanStep; child: Execution }[] = [];
    for (const step of inOrder(version.steps.filter((s) => s.kind === 'specialist'))) {
      const d = plan.delegations.find((x) => x.stepId === step.id);
      if (d === undefined) throw new PlanningError('delegation_conflict');
      out.push({ step, child: await executions.get(tenant, d.executionId) });
    }
    return out;
  }

  /** Starts every child that has not started and whose steps before it all completed. */
  async function startReady(
    tenant: TenantContext,
    steps: readonly { step: PlanStep; child: Execution }[],
  ): Promise<void> {
    const completed = new Set(
      steps.filter((s) => s.child.status === 'completed').map((s) => s.step.id),
    );
    for (const { step, child } of steps) {
      if (child.status !== 'pending' || child.startedAt !== undefined) continue;
      if (!step.dependsOn.every((d) => completed.has(d))) continue;
      await starter.start(tenant, child.id);
    }
  }

  /** A plan status change and its event, once: a change another call made is read back. */
  async function finishPlan(
    tenant: TenantContext,
    organizationId: OrganizationId,
    plan: Plan,
    to: 'completed' | 'failed',
    reason?: string,
  ): Promise<Plan> {
    const at = now();
    try {
      return await plans.update(organizationId, plan.id, (current) => {
        const next = applyPlanStatus(current, 'executing', to, iso(at));
        return {
          plan: next,
          events: [
            buildAuditEvent(
              {
                action: 'plan.state_changed',
                result: 'success',
                actor: actorOf(tenant),
                organizationId,
                target: { type: 'plan', id: next.id },
                transition: { from: current.status, to: next.status },
                ...(reason === undefined ? {} : { reason }),
                ...(requestId === undefined ? {} : { requestId }),
                source: 'api',
              },
              at,
            ),
          ],
        };
      });
    } catch (error) {
      if (!isPlanningError(error)) throw error;
      const fresh = await plans.find(organizationId, plan.id);
      if (fresh !== undefined && fresh.status !== 'executing') return fresh;
      throw error;
    }
  }

  /** Runs one change on the planning execution; one another call already made is not an error. */
  async function settle(change: () => Promise<unknown>): Promise<void> {
    try {
      await change();
    } catch (error) {
      if (!isExecutionError(error)) throw error;
      if (
        error.code !== 'execution_concurrency_conflict' &&
        error.code !== 'execution_already_terminal'
      ) {
        throw error;
      }
    }
  }

  /** The planning execution's graph follows its children: running, then completed. */
  async function mirror(
    tenant: TenantContext,
    parentId: ExecutionId,
    steps: readonly { step: PlanStep; child: Execution }[],
  ): Promise<Execution> {
    let parent = await executions.get(tenant, parentId);
    for (const { step, child } of steps) {
      const node = parent.nodes.find((n) => n.id === step.id);
      if (node === undefined) throw new PlanningError('delegation_conflict');
      if (
        child.startedAt === undefined ||
        child.status === 'failed' ||
        child.status === 'cancelled'
      ) {
        continue;
      }
      if (node.status === 'pending') {
        await settle(() =>
          executions.runtimePlanChangeNode(tenant, parentId, {
            nodeId: step.id,
            from: 'pending',
            to: 'running',
          }),
        );
      }
      if (child.status === 'completed' && node.status !== 'completed') {
        await settle(() =>
          executions.runtimePlanChangeNode(tenant, parentId, {
            nodeId: step.id,
            from: 'running',
            to: 'completed',
            output: { type: 'execution', id: child.id },
          }),
        );
      }
      parent = await executions.get(tenant, parentId);
    }
    return parent;
  }

  /** Every step completed: the planning execution is verified with its children and completes. */
  async function complete(
    tenant: TenantContext,
    parent: Execution,
    steps: readonly { step: PlanStep; child: Execution }[],
  ): Promise<void> {
    if (parent.status === 'running') {
      await settle(() =>
        executions.runtimePlanChangeStatus(tenant, parent.id, { from: 'running', to: 'verifying' }),
      );
    }
    let current = await executions.get(tenant, parent.id);
    if (current.status === 'verifying' && current.verification === undefined) {
      await settle(() =>
        executions.recordVerification(tenant, parent.id, {
          correlationId: `plan-${parent.id}`,
          nodes: steps.map(({ step, child }) => ({
            nodeId: step.id,
            policy: 'checks',
            checks: [
              {
                code: STEP_CHECK,
                result: child.status === 'completed' ? 'passed' : 'failed',
                evidence: { type: 'execution', id: child.id },
              },
            ],
          })),
        }),
      );
      current = await executions.get(tenant, parent.id);
    }
    if (current.status === 'verifying' && current.verification?.result === 'passed') {
      await settle(() =>
        executions.runtimePlanChangeStatus(tenant, parent.id, {
          from: 'verifying',
          to: 'completed',
        }),
      );
    }
  }

  /** A step failed or was cancelled: the plan stops, and no other step starts. */
  async function stop(tenant: TenantContext, parent: Execution, code: string): Promise<void> {
    if (isTerminal(parent.status)) return;
    await settle(() =>
      executions.runtimePlanChangeStatus(tenant, parent.id, {
        from: parent.status,
        to: 'failed',
        failure: { code },
      }),
    );
  }

  return Object.freeze({
    async run(tenant: TenantContext, planId: string) {
      const organizationId = organizationOf(tenant);
      if (tenant.actor !== 'user') throw new PlanningError('permission_denied', 'person_only');
      const { plan, version } = await load(organizationId, planId);
      const unrunnable = unrunnableStepOf(version);
      if (unrunnable !== undefined) throw new PlanningError('plan_not_runnable', unrunnable);
      if (plan.status !== 'approved' && plan.status !== 'executing') {
        throw new PlanningError('invalid_plan_transition');
      }
      if (delegation === undefined) throw new PlanningError('permission_denied', 'no_delegation');
      const { plan: delegated } = await delegation.delegate(tenant, plan.id);
      if (delegated.status !== 'executing') return delegated;
      await startReady(tenant, await stepsOf(tenant, delegated, version));
      logger?.info('plan started', { planId: delegated.id });
      return delegated;
    },

    async advance(tenant: TenantContext, planId: string) {
      const organizationId = organizationOf(tenant);
      if (tenant.actor !== 'runtime') throw new PlanningError('permission_denied', 'runtime_only');
      const { plan, version } = await load(organizationId, planId);
      if (plan.status !== 'executing' || plan.delegationState !== 'completed') return plan;
      const steps = await stepsOf(tenant, plan, version);
      const current = await executions.get(tenant, plan.executionId);
      if (current.status === 'cancelled') {
        return (await plans.find(organizationId, plan.id)) ?? plan;
      }

      const stopped = steps.find(
        (s) => s.child.status === 'failed' || s.child.status === 'cancelled',
      );
      if (stopped !== undefined) {
        await stop(tenant, await mirror(tenant, plan.executionId, steps), 'step_failed');
        logger?.info('plan stopped', { planId: plan.id, stepId: stopped.step.id });
        return finishPlan(tenant, organizationId, plan, 'failed', 'step_failed');
      }
      if (steps.every((s) => s.child.status === 'completed')) {
        await complete(tenant, await mirror(tenant, plan.executionId, steps), steps);
        const closed = await executions.get(tenant, plan.executionId);
        if (closed.status !== 'completed') return plan;
        logger?.info('plan completed', { planId: plan.id });
        return finishPlan(tenant, organizationId, plan, 'completed');
      }
      await startReady(tenant, steps);
      // The graph shows what just started too.
      await mirror(tenant, plan.executionId, await stepsOf(tenant, plan, version));
      return plan;
    },
  });
}
