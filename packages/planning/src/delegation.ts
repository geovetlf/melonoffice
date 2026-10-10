import { actorOf, buildAuditEvent, type AuditEvent } from '@melonoffice/audit';
import type {
  Execution,
  ExecutionId,
  ExecutionStatus,
  IsoTimestamp,
  OrganizationId,
  Plan,
  PlanDelegation,
  PlanStep,
  PlanVersion,
  UserId,
  VersionRef,
} from '@melonoffice/domain';
import {
  executionIdFor,
  isExecutionError,
  isTerminal,
  type ExecutionService,
  type NodeInput,
} from '@melonoffice/execution';
import type { AuthorizationService } from '@melonoffice/rbac';
import type { SpecialistService } from '@melonoffice/specialists';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { isPlanningError, PlanningError } from './errors.js';
import {
  beginDelegation,
  completeDelegation,
  failDelegation,
  isPlanId,
  markDelegated,
} from './model.js';
import type { PlanRepository } from './repository.js';
import { abandonableScheduled, type AbandonScheduled, closureReason } from './service.js';

/** Which execution node type each non-tool step becomes. */
const NODE_TYPE: Readonly<Record<Exclude<PlanStep['kind'], 'tool'>, NodeInput['type']>> = {
  specialist: 'agent',
  approval: 'approval',
  verification: 'verification',
  condition: 'condition',
  parallel: 'parallel',
  wait: 'delay',
};

const specialistRef = (step: PlanStep): VersionRef | undefined =>
  step.specialist === undefined
    ? undefined
    : { kind: 'specialist', id: step.specialist.id, version: String(step.specialist.version) };

/**
 * The plan's own graph (ADR-0028): every step but tool steps, which live in the execution of the
 * specialist that uses them. X1 checks it again when the nodes are added.
 */
export function parentNodesOf(version: PlanVersion): readonly NodeInput[] {
  return version.steps
    .filter((s) => s.kind !== 'tool')
    .map((s): NodeInput => {
      const owner = specialistRef(s);
      return {
        id: s.id,
        type: NODE_TYPE[s.kind as Exclude<PlanStep['kind'], 'tool'>],
        label: s.label,
        dependsOn: s.dependsOn,
        ...(owner === undefined ? {} : { owner }),
      };
    });
}

/** A specialist step's own graph: its agent node, then the tool nodes it uses. */
export function childNodesOf(version: PlanVersion, step: PlanStep): readonly NodeInput[] {
  const owner = specialistRef(step);
  const tools = version.steps.filter((s) => s.kind === 'tool' && s.performedBy === step.id);
  return [
    { id: step.id, type: 'agent', label: step.label, ...(owner === undefined ? {} : { owner }) },
    ...tools.map((t): NodeInput => ({
      id: t.id,
      type: 'tool',
      label: t.label,
      dependsOn: t.dependsOn,
      ...(t.tool === undefined ? {} : { tool: t.tool }),
    })),
  ];
}

/**
 * The idempotency key of a specialist step's child execution. With the organization it makes
 * the child's id (`executionIdFor`): one organization, plan and step always name one child.
 */
export const delegationKey = (planId: string, stepId: string): string =>
  `plan:${planId}:step:${stepId}`;

/** The delegation set of a plan version: one deterministic child id per specialist step. */
export function delegationsOf(
  organizationId: OrganizationId,
  planId: string,
  version: PlanVersion,
): readonly PlanDelegation[] {
  return version.steps
    .filter((s) => s.kind === 'specialist')
    .map((s) => ({
      stepId: s.id,
      executionId: executionIdFor(organizationId, delegationKey(planId, s.id)),
    }));
}

/** A child that exists must be exactly the one this step would create. */
function checkChild(child: Execution, parent: Execution, plan: Plan, s: PlanStep): Execution {
  const specialist = s.specialist;
  if (
    child.mode !== 'execute' ||
    child.parentExecutionId !== parent.id ||
    child.input.type !== 'plan_step' ||
    child.input.id !== `${plan.id}:${s.id}` ||
    child.specialistId !== specialist?.id ||
    child.specialistVersion !== specialist?.version
  ) {
    throw new Permanent('delegation_conflict');
  }
  return child;
}

/**
 * What a specialist step's child is created with: the step, its graph, the versions it runs
 * under, and the key that fixes its id. Every attempt of the step is created the same way.
 */
function childRequestOf(
  plan: Plan,
  version: PlanVersion,
  parent: Execution,
  s: PlanStep,
  components: readonly VersionRef[],
  idempotencyKey: string,
): Parameters<ExecutionService['create']>[1] {
  const specialist = s.specialist as NonNullable<PlanStep['specialist']>;
  const planRef: VersionRef = { kind: 'plan', id: plan.id, version: String(version.version) };
  const workflowRef: VersionRef | undefined =
    version.source.kind === 'workflow'
      ? {
          kind: 'workflow',
          id: version.source.workflowId,
          version: String(version.source.workflowVersion),
        }
      : undefined;
  return {
    mode: 'execute',
    input: { type: 'plan_step', id: `${plan.id}:${s.id}` },
    versionSnapshot: {
      schemaVersion: 1,
      components: [...components, planRef, ...(workflowRef === undefined ? [] : [workflowRef])],
    },
    nodes: childNodesOf(version, s),
    parentExecutionId: parent.id,
    ...(version.source.kind === 'workflow' ? { workflowId: version.source.workflowId } : {}),
    specialistId: specialist.id,
    specialistVersion: specialist.version,
    departmentId: specialist.departmentId,
    idempotencyKey,
  };
}

/**
 * The key, and so the id, of a step's attempt after its first (ADR-0153). The first attempt keeps
 * the delegation's key, so plans delegated before retries existed read as they did.
 */
export const attemptKey = (planId: string, stepId: string, attempt: number): string =>
  `${delegationKey(planId, stepId)}:attempt:${attempt}`;

/** Creates another run of a delegated step, once (ADR-0153). */
export interface PlanStepAttempts {
  /**
   * The child execution of attempt `attempt` of `step`, `pending`, created under its
   * deterministic id unless it exists. `undefined` when it cannot be created: the specialist can
   * no longer take the step, or the plan's own execution is no longer running.
   */
  ensure(
    tenant: TenantContext,
    plan: Plan,
    version: PlanVersion,
    step: PlanStep,
    attempt: number,
  ): Promise<Execution | undefined>;
}

export function createPlanStepAttempts(options: {
  readonly executions: Pick<ExecutionService, 'get' | 'create'>;
  readonly specialists: Pick<SpecialistService, 'eligibility'>;
}): PlanStepAttempts {
  const { executions, specialists } = options;
  const find = async (tenant: TenantContext, id: ExecutionId) => {
    try {
      return await executions.get(tenant, id);
    } catch (error) {
      if (isExecutionError(error) && error.code === 'execution_not_found') return undefined;
      throw error;
    }
  };
  return Object.freeze({
    async ensure(
      tenant: TenantContext,
      plan: Plan,
      version: PlanVersion,
      step: PlanStep,
      attempt: number,
    ) {
      if (!isResolvedTenant(tenant) || tenant.organizationId !== plan.organizationId) {
        throw new PlanningError('unresolved_tenant');
      }
      const ref = step.specialist;
      if (step.kind !== 'specialist' || ref === undefined) return undefined;
      const key = attemptKey(plan.id, step.id, attempt);
      const id = executionIdFor(plan.organizationId, key);
      const parent = await executions.get(tenant, plan.executionId);
      const existing = await find(tenant, id);
      try {
        if (existing !== undefined) return checkChild(existing, parent, plan, step);
        if (parent.status !== 'running') return undefined;
        // The specialist must still take the step, at the version the plan names.
        const decision = await specialists.eligibility(tenant, {
          specialistId: ref.id,
          departmentId: ref.departmentId,
          version: ref.version,
        });
        if (!decision.eligible) return undefined;
        try {
          const child = await executions.create(
            tenant,
            childRequestOf(plan, version, parent, step, decision.components, key),
          );
          if (child.id !== id) throw new Permanent('delegation_conflict');
          return child;
        } catch (error) {
          if (isExecutionError(error) && error.code === 'specialist_not_eligible') return undefined;
          // Another attempt created it first: use it.
          const raced = await find(tenant, id);
          if (raced === undefined) throw error;
          return checkChild(raced, parent, plan, step);
        }
      } catch (error) {
        if (error instanceof Permanent) throw new PlanningError(error.code);
        throw error;
      }
    },
  });
}

export interface DelegationResult {
  readonly plan: Plan;
  /** One child execution per specialist step, `pending`: nothing has run. */
  readonly children: readonly Execution[];
}

/**
 * Delegation (ADR-0028): hands each specialist step of a `ready` or `approved` plan to its own
 * child execution. Server side only; no client route delegates. It runs nothing: the children
 * are `pending`, and each tool node still goes through the X3 tool gate, with its own approval
 * when its risk needs one.
 *
 * It is a saga of idempotent steps, recorded on the plan (`delegationState`), and safe to call
 * again at any point: after a failure, a retry resumes where the last attempt stopped, and
 * concurrent attempts converge on the same result.
 *
 * 1. Claim: the delegation set, with one deterministic child id per specialist step, is written
 *    on the plan (`creating`) in one revision-checked transaction.
 * 2. The plan's graph goes on its planning execution, unless it is already there.
 * 3. Each child is created under its deterministic id, unless it already exists. The store
 *    refuses a second create of the same id, so a step can never get two children.
 * 4. Plan `executing` (`created`) with `delegation.created` and `plan.state_changed`, in one
 *    transaction: recorded once, by the attempt that wins it.
 * 5. Planning execution `running`, then the delegation is `completed`.
 *
 * A specialist that can no longer take its step while the delegation is `creating` fails it:
 * the plan and its planning execution fail, and every child already created is cancelled.
 */
/**
 * What a release of a person's hand-made plan is checked against (ADR-0187, decision 6): the plan
 * must not have changed since this instant, the lease its live attempt is measured from.
 */
export interface ReleaseManual {
  readonly untouchedBefore: IsoTimestamp;
}

export interface Delegation {
  delegate(tenant: TenantContext, planId: string): Promise<DelegationResult>;
  /**
   * Runtime only, for a schedule's own plan (ADR-0186): fails its `creating` delegation when the
   * schedule moved past its occurrence or switched off, and the plan was not touched within the
   * lease. Nothing ran, since a `creating` delegation has no running child, so nothing is undone:
   * the children it made stay `pending`, as a schedule's always do (ADR-0185). A delegation this
   * method failed has its cleanup finished, and any other is refused with `plan_not_abandonable`.
   */
  abandon(tenant: TenantContext, planId: string, input: AbandonScheduled): Promise<Plan>;
  /**
   * Runtime only, for a plan its creator made by hand (ADR-0187, decision 6): fails its `creating`
   * delegation once the creator may no longer plan and the plan was not touched within the lease.
   * Only the creator's own runtime releases it, and never a schedule's plan. Nothing ran, so the
   * children it made stay `pending`, as the runtime leaves them (ADR-0029). A release already made
   * is read back, never made twice. Otherwise refused with `plan_not_abandonable`.
   */
  releaseManual(tenant: TenantContext, planId: string, input: ReleaseManual): Promise<Plan>;
  /**
   * Finishes the cleanup of a failed delegation whose attempt was interrupted before it ended
   * (ADR-0186). Idempotent: a finished cleanup changes nothing. It never starts or reactivates work.
   */
  closeFailed(tenant: TenantContext, planId: string): Promise<Plan>;
}

export interface DelegationOptions {
  readonly plans: PlanRepository;
  readonly executions: Pick<ExecutionService, 'get' | 'create' | 'addNodes' | 'changeStatus'> &
    Partial<Pick<ExecutionService, 'runtimePlanChangeStatus'>>;
  readonly specialists: Pick<SpecialistService, 'eligibility'>;
  /** Only `findOrganization` is used, to refuse inactive organizations. */
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly now?: () => Date;
  readonly requestId?: string;
}

/** The status the plan's execution is in before `running`, for each plan status delegated. */
const EXPECTED: Readonly<Partial<Record<Plan['status'], ExecutionStatus>>> = {
  ready: 'planning',
  approved: 'waiting_approval',
};

/** A permanent refusal: retrying cannot help, so a `creating` delegation fails on it. */
class Permanent extends Error {
  constructor(
    readonly code: 'specialist_not_eligible' | 'execution_not_plannable' | 'delegation_conflict',
  ) {
    super(code);
  }
}

const isConflict = (error: unknown): boolean =>
  isPlanningError(error) && error.code === 'plan_concurrency_conflict';

/** Another attempt moved an execution first: its change is refused against the stale state. */
const isExecutionRace = (error: unknown): boolean =>
  isExecutionError(error) &&
  (error.code === 'execution_concurrency_conflict' || error.code === 'execution_already_terminal');

/**
 * A schedule's plan that `abandon` failed for this workflow (ADR-0186). Only such a plan is closed
 * again here: a failure by any other cause is left to `closeFailed`, which never abandons anything.
 */
const isAbandonedBy = (plan: Plan, input: AbandonScheduled): boolean =>
  plan.delegationState === 'failed' &&
  plan.delegationFailure === 'delegation_abandoned' &&
  plan.decision?.via === 'schedule' &&
  plan.workflow?.id === input.workflowId;

/** A plan a person made by hand: no schedule made it, and `creator` is the person who did (ADR-0187). */
const isManualOf = (plan: Plan, creator: UserId): boolean =>
  plan.createdBy === creator &&
  plan.decision?.via !== 'schedule' &&
  plan.workflow?.occurrence === undefined;

/**
 * A hand-made plan `releaseManual` may fail: `creating` and never started, with the status a
 * `beginDelegation` leaves it in, and untouched since `untouchedBefore` (ADR-0187, decision 6).
 */
const releasableManual = (plan: Plan, creator: UserId, untouchedBefore: IsoTimestamp): boolean =>
  isManualOf(plan, creator) &&
  plan.delegationState === 'creating' &&
  (plan.status === 'ready' || plan.status === 'approved') &&
  Date.parse(plan.updatedAt) <= Date.parse(untouchedBefore);

/** A hand-made plan that `releaseManual` failed: only its cleanup can be left open. */
const isReleasedManual = (plan: Plan, creator: UserId): boolean =>
  plan.delegationState === 'failed' &&
  plan.delegationFailure === 'delegation_abandoned' &&
  isManualOf(plan, creator);

export function createDelegation({
  plans,
  executions,
  specialists,
  organizations,
  authorization,
  now = () => new Date(),
  requestId,
}: DelegationOptions): Delegation {
  /** The planning execution's status, moved by a person, or by the runtime for a schedule. */
  const moveParent: ExecutionService['changeStatus'] = (tenant, id, change) => {
    if (tenant.actor !== 'runtime') return executions.changeStatus(tenant, id, change);
    if (executions.runtimePlanChangeStatus === undefined) {
      throw new PlanningError('permission_denied', 'runtime_only');
    }
    return executions.runtimePlanChangeStatus(tenant, id, change);
  };

  async function organizationOf(tenant: TenantContext): Promise<OrganizationId> {
    if (!isResolvedTenant(tenant)) throw new PlanningError('unresolved_tenant');
    const organization = await organizations.findOrganization(tenant.organizationId);
    if (organization?.id !== tenant.organizationId || organization.status !== 'active') {
      throw new PlanningError('organization_inactive');
    }
    return organization.id;
  }

  const event = (
    tenant: TenantContext,
    organizationId: OrganizationId,
    fields: Pick<AuditEvent, 'action' | 'target'> &
      Partial<Pick<AuditEvent, 'transition' | 'reason' | 'reference'>>,
    at: Date,
  ): AuditEvent =>
    buildAuditEvent(
      {
        action: fields.action,
        result: 'success',
        actor: actorOf(tenant),
        organizationId,
        ...(fields.target === undefined ? {} : { target: fields.target }),
        ...(fields.transition === undefined ? {} : { transition: fields.transition }),
        ...(fields.reason === undefined ? {} : { reason: fields.reason }),
        ...(fields.reference === undefined ? {} : { reference: fields.reference }),
        ...(requestId === undefined ? {} : { requestId }),
        source: 'api',
      },
      at,
    );

  const iso = (at: Date): IsoTimestamp => at.toISOString() as IsoTimestamp;

  /** An execution of the tenant, or nothing when it does not exist. */
  async function findExecution(
    tenant: TenantContext,
    id: ExecutionId,
  ): Promise<Execution | undefined> {
    try {
      return await executions.get(tenant, id);
    } catch (error) {
      if (isExecutionError(error) && error.code === 'execution_not_found') return undefined;
      throw error;
    }
  }

  /**
   * Writes one saga step on the plan. When another attempt already moved the plan, the change
   * refuses (`plan_concurrency_conflict`) and the fresh plan is returned instead, for the caller
   * to go on from there: nothing is written twice.
   */
  async function step(
    organizationId: OrganizationId,
    plan: Plan,
    change: Parameters<PlanRepository['update']>[2],
  ): Promise<Plan> {
    try {
      return await plans.update(organizationId, plan.id, change);
    } catch (error) {
      if (!isConflict(error)) throw error;
      const fresh = await plans.find(organizationId, plan.id);
      if (fresh === undefined) throw new PlanningError('plan_not_found');
      return fresh;
    }
  }

  /** The planning execution's status before `running`: `planning`, or `waiting_approval`. */
  const expectedOf = (plan: Plan): ExecutionStatus =>
    plan.decision?.decision === 'approved' ? 'waiting_approval' : 'planning';

  /** How many of the plan's nodes the execution has, refusing any it has differently. */
  function presentNodes(execution: Execution, nodes: readonly NodeInput[]): number {
    let found = 0;
    for (const n of nodes) {
      const x = execution.nodes.find((e) => e.id === n.id);
      if (x === undefined) continue;
      if (x.type !== n.type || x.label !== n.label) throw new Permanent('delegation_conflict');
      found += 1;
    }
    return found;
  }

  /** Step 2: the plan's graph on its planning execution, exactly once. */
  async function ensureParentNodes(
    tenant: TenantContext,
    parent: Execution,
    nodes: readonly NodeInput[],
  ): Promise<void> {
    const found = presentNodes(parent, nodes);
    if (found === nodes.length) return;
    // `addNodes` is one transaction: a graph is there whole or not at all.
    if (found > 0) throw new Permanent('delegation_conflict');
    try {
      await executions.addNodes(tenant, parent.id, nodes);
    } catch (error) {
      if (!isExecutionError(error) || error.code === 'execution_not_found') throw error;
      // Another attempt added them first (the graph refuses taken node ids), or they clash.
      const fresh = await executions.get(tenant, parent.id);
      if (presentNodes(fresh, nodes) !== nodes.length) throw new Permanent('delegation_conflict');
    }
  }

  /** Step 3: one child per specialist step, under its deterministic id, created at most once. */
  async function ensureChild(
    tenant: TenantContext,
    plan: Plan,
    version: PlanVersion,
    parent: Execution,
    s: PlanStep,
    id: ExecutionId,
    components: readonly VersionRef[],
  ): Promise<Execution> {
    const existing = await findExecution(tenant, id);
    if (existing !== undefined) return checkChild(existing, parent, plan, s);
    try {
      const child = await executions.create(
        tenant,
        childRequestOf(plan, version, parent, s, components, delegationKey(plan.id, s.id)),
      );
      if (child.id !== id) throw new Permanent('delegation_conflict');
      return child;
    } catch (error) {
      if (isExecutionError(error) && error.code === 'specialist_not_eligible') {
        throw new Permanent('specialist_not_eligible');
      }
      // The store refused the id: another attempt created this child first. Use it.
      const raced = await findExecution(tenant, id);
      if (raced === undefined) throw error;
      return checkChild(raced, parent, plan, s);
    }
  }

  /**
   * A failed delegation's cleanup, idempotent: a person's children already created are cancelled,
   * and the planning execution fails. The runtime cancels nothing (ADR-0029). Any attempt that finds
   * the delegation failed runs it again, so a child created by a concurrent attempt is cleaned up too.
   */
  async function cleanUp(tenant: TenantContext, plan: Plan): Promise<void> {
    // The runtime never cancels (ADR-0029): a schedule's child that never started stays pending
    // under a failed parent, which no start accepts (ADR-0185). Only a person's children are closed.
    if (tenant.actor !== 'runtime') {
      for (const d of plan.delegations) {
        const child = await findExecution(tenant, d.executionId);
        if (child === undefined || isTerminal(child.status)) continue;
        await settle(tenant, child.id, () =>
          executions.changeStatus(tenant, child.id, {
            from: child.status,
            to: 'cancelled',
            reason: 'delegation_failed',
          }),
        );
      }
    }
    const parent = await findExecution(tenant, plan.executionId);
    if (parent !== undefined && !isTerminal(parent.status)) {
      await settle(tenant, parent.id, () =>
        moveParent(tenant, parent.id, {
          from: parent.status,
          to: 'failed',
          failure: { code: plan.delegationFailure ?? 'delegation_failed' },
        }),
      );
    }
  }

  /**
   * One cleanup change. When another attempt moved the execution first, the change is accepted if
   * the execution is now terminal, so an interrupted cleanup is finished once, never twice (ADR-0186).
   */
  async function settle(
    tenant: TenantContext,
    id: ExecutionId,
    change: () => Promise<unknown>,
  ): Promise<void> {
    try {
      await change();
    } catch (error) {
      if (!isExecutionRace(error)) throw error;
      const fresh = await findExecution(tenant, id);
      if (fresh === undefined || !isTerminal(fresh.status)) throw error;
    }
  }

  async function fail(
    tenant: TenantContext,
    organizationId: OrganizationId,
    plan: Plan,
    reason: Permanent['code'],
  ): Promise<DelegationResult> {
    const at = now();
    const failed = await step(organizationId, plan, (current) => {
      const next = failDelegation(current, reason, iso(at));
      return {
        plan: next,
        events: [
          event(
            tenant,
            organizationId,
            {
              action: 'plan.state_changed',
              target: { type: 'plan', id: next.id },
              transition: { from: current.status, to: next.status },
              reason,
            },
            at,
          ),
        ],
      };
    });
    if (failed.delegationState === 'failed') {
      await cleanUp(tenant, failed);
      throw new PlanningError('delegation_failed', failed.delegationFailure);
    }
    // Another attempt moved the delegation on while this one read a stale state: resume it.
    return delegate(tenant, failed.id);
  }

  async function childrenOf(tenant: TenantContext, plan: Plan): Promise<readonly Execution[]> {
    const children: Execution[] = [];
    for (const d of plan.delegations) children.push(await executions.get(tenant, d.executionId));
    return Object.freeze(children);
  }

  async function delegate(tenant: TenantContext, planId: string): Promise<DelegationResult> {
    const organizationId = await organizationOf(tenant);
    if (!authorization.authorize(tenant, 'plan.create', { organizationId }).allowed) {
      throw new PlanningError('permission_denied');
    }
    if (!isPlanId(planId)) throw new PlanningError('plan_not_found');
    let plan = await plans.find(organizationId, planId);
    if (plan === undefined) throw new PlanningError('plan_not_found');
    // The stored version, with its digest checked: exactly what was validated and approved.
    const version = await plans.findVersion(organizationId, plan.id, plan.version);
    if (version === undefined) throw new PlanningError('plan_not_found');

    if (plan.delegationState === 'failed') {
      await cleanUp(tenant, plan);
      throw new PlanningError('delegation_failed', plan.delegationFailure);
    }

    const intended = delegationsOf(organizationId, plan.id, version);
    const specialistSteps = version.steps.filter((s) => s.kind === 'specialist');

    if (plan.delegationState === undefined || plan.delegationState === 'creating') {
      const expected = EXPECTED[plan.status];
      if (expected === undefined) throw new PlanningError('invalid_plan_transition');
      if (
        plan.status === 'approved' &&
        (plan.decision?.version !== version.version || plan.decision.digest !== version.digest)
      ) {
        throw new PlanningError('plan_version_mismatch');
      }
      if (
        plan.delegationState === 'creating' &&
        (plan.delegations.length !== intended.length ||
          plan.delegations.some(
            (d, i) =>
              d.stepId !== intended[i]?.stepId || d.executionId !== intended[i]?.executionId,
          ))
      ) {
        throw new PlanningError('delegation_conflict');
      }
      const claimed = plan.delegationState === 'creating';
      try {
        const parent = await executions.get(tenant, plan.executionId);
        if (parent.status !== expected || parent.mode !== 'plan') {
          throw new Permanent('execution_not_plannable');
        }
        // Every specialist must still be eligible, at the version the plan names: before the
        // claim nothing is written, and on a retry nothing more is created for one that is not.
        const components = new Map<string, readonly VersionRef[]>();
        for (const s of specialistSteps) {
          const ref = s.specialist;
          if (ref === undefined) throw new PlanningError('invalid_plan', 'specialist');
          const decision = await specialists.eligibility(tenant, {
            specialistId: ref.id,
            departmentId: ref.departmentId,
            version: ref.version,
          });
          if (!decision.eligible) {
            if (!claimed) throw new PlanningError('specialist_not_eligible', decision.reason);
            throw new Permanent('specialist_not_eligible');
          }
          components.set(s.id, decision.components);
        }

        // 1. Claim. Before it, the plan's graph must not be on the execution at all.
        if (!claimed) {
          if (presentNodes(parent, parentNodesOf(version)) > 0) {
            throw new PlanningError('delegation_conflict');
          }
          const at = now();
          plan = await step(organizationId, plan, (current) => {
            // Firestore re-runs this on the fresh plan: one another attempt already claimed.
            if (current.delegationState !== undefined) {
              throw new PlanningError('plan_concurrency_conflict');
            }
            return { plan: beginDelegation(current, intended, iso(at)), events: [] };
          });
          if (plan.delegationState === undefined) throw new PlanningError('delegation_conflict');
          if (plan.delegationState !== 'creating') {
            // Another attempt claimed and moved on: resume from where it is.
            return delegate(tenant, planId);
          }
        }

        // 2. The plan's graph on its execution.
        await ensureParentNodes(tenant, parent, parentNodesOf(version));

        // 3. The children.
        for (const [i, s] of specialistSteps.entries()) {
          const id = (intended[i] as PlanDelegation).executionId;
          await ensureChild(tenant, plan, version, parent, s, id, components.get(s.id) ?? []);
        }
      } catch (error) {
        if (!(error instanceof Permanent)) throw error;
        if (plan.delegationState !== 'creating') throw new PlanningError(error.code);
        return fail(tenant, organizationId, plan, error.code);
      }

      // 4. The plan is `executing`: recorded once, with its audit events.
      const at = now();
      plan = await step(organizationId, plan, (current) => {
        const next = markDelegated(current, iso(at));
        return {
          plan: next,
          events: [
            ...next.delegations.map((d) =>
              event(
                tenant,
                organizationId,
                {
                  action: 'delegation.created',
                  target: { type: 'execution', id: d.executionId },
                },
                at,
              ),
            ),
            event(
              tenant,
              organizationId,
              {
                action: 'plan.state_changed',
                target: { type: 'plan', id: next.id },
                transition: { from: current.status, to: next.status },
              },
              at,
            ),
          ],
        };
      });
      if (plan.delegationState === 'failed') {
        // Another attempt failed it while this one created children: cancel them too.
        await cleanUp(tenant, plan);
        throw new PlanningError('delegation_failed', plan.delegationFailure);
      }
    }

    if (plan.delegationState === 'created') {
      if (plan.status !== 'executing') throw new PlanningError('invalid_plan_transition');
      // 5. The planning execution runs its graph (it runs nothing by itself).
      const parent = await executions.get(tenant, plan.executionId);
      if (parent.status !== 'running') {
        const from = expectedOf(plan);
        if (parent.status !== from) throw new PlanningError('execution_not_plannable');
        try {
          await moveParent(tenant, parent.id, { from, to: 'running' });
        } catch (error) {
          const fresh = await executions.get(tenant, parent.id);
          if (fresh.status !== 'running') throw error;
        }
      }
      const at = now();
      plan = await step(organizationId, plan, (current) => ({
        plan: completeDelegation(current, iso(at)),
        events: [],
      }));
    }

    if (plan.delegationState !== 'completed') throw new PlanningError('delegation_conflict');
    return Object.freeze({ plan, children: await childrenOf(tenant, plan) });
  }

  /**
   * The plan of a tenant, with the organization checked. A person must still hold `plan.create`; the
   * runtime does not need it to release a schedule's plan, which the schedule's own rules already bound
   * (ADR-0187). `mayPlan` is the person's current permission, for the audit reason.
   */
  async function planOf(
    tenant: TenantContext,
    planId: string,
  ): Promise<[OrganizationId, Plan, boolean]> {
    const organizationId = await organizationOf(tenant);
    const mayPlan = authorization.authorize(tenant, 'plan.create', { organizationId }).allowed;
    if (tenant.actor !== 'runtime' && !mayPlan) throw new PlanningError('permission_denied');
    if (!isPlanId(planId)) throw new PlanningError('plan_not_found');
    const plan = await plans.find(organizationId, planId);
    if (plan === undefined) throw new PlanningError('plan_not_found');
    return [organizationId, plan, mayPlan];
  }

  async function abandon(
    tenant: TenantContext,
    planId: string,
    input: AbandonScheduled,
  ): Promise<Plan> {
    if (tenant.actor !== 'runtime') throw new PlanningError('permission_denied', 'runtime_only');
    const [organizationId, found, mayPlan] = await planOf(tenant, planId);
    const at = now();
    // Another attempt that failed the plan first makes `step` return it fresh, and nothing is
    // written twice: only its cleanup runs below (ADR-0186).
    const current =
      found.delegationState === 'failed'
        ? found
        : await step(organizationId, found, (fresh) => {
            if (fresh.delegationState === 'failed') {
              throw new PlanningError('plan_concurrency_conflict');
            }
            if (!abandonableScheduled(fresh, input, { delegated: true })) {
              throw new PlanningError('plan_not_abandonable');
            }
            const next = failDelegation(fresh, 'delegation_abandoned', iso(at));
            return {
              plan: next,
              events: [
                event(
                  tenant,
                  organizationId,
                  {
                    action: 'plan.state_changed',
                    target: { type: 'plan', id: next.id },
                    transition: { from: fresh.status, to: next.status },
                    reason: closureReason(input.reason, 'schedule_abandoned', mayPlan),
                    reference: `occurrence:${fresh.workflow?.occurrence}`,
                  },
                  at,
                ),
              ],
            };
          });
    // Failed for another cause, or not this schedule's: refused, and its cleanup stays with `closeFailed`.
    if (!isAbandonedBy(current, input)) throw new PlanningError('plan_not_abandonable');
    await cleanUp(tenant, current);
    return current;
  }

  async function releaseManual(
    tenant: TenantContext,
    planId: string,
    input: ReleaseManual,
  ): Promise<Plan> {
    if (tenant.actor !== 'runtime') throw new PlanningError('permission_denied', 'runtime_only');
    const [organizationId, found, mayPlan] = await planOf(tenant, planId);
    // A person who may still plan keeps their plan: it is theirs to finish or to close.
    if (mayPlan) throw new PlanningError('plan_not_abandonable');
    const at = now();
    // Another attempt that released the plan first makes `step` return it fresh, and nothing is
    // written twice: only its cleanup runs below.
    const current = isReleasedManual(found, tenant.userId)
      ? found
      : await step(organizationId, found, (fresh) => {
          if (fresh.delegationState === 'failed') {
            throw new PlanningError('plan_concurrency_conflict');
          }
          if (!releasableManual(fresh, tenant.userId, input.untouchedBefore)) {
            throw new PlanningError('plan_not_abandonable');
          }
          const next = failDelegation(fresh, 'delegation_abandoned', iso(at));
          return {
            plan: next,
            events: [
              event(
                tenant,
                organizationId,
                {
                  action: 'plan.state_changed',
                  target: { type: 'plan', id: next.id },
                  transition: { from: fresh.status, to: next.status },
                  reason: 'permission_lost',
                },
                at,
              ),
            ],
          };
        });
    if (!isReleasedManual(current, tenant.userId)) throw new PlanningError('plan_not_abandonable');
    await cleanUp(tenant, current);
    return current;
  }

  async function closeFailed(tenant: TenantContext, planId: string): Promise<Plan> {
    const [, plan] = await planOf(tenant, planId);
    // The runtime closes only what a schedule made (ADR-0185); a person closes their own plans.
    if (tenant.actor === 'runtime' && plan.decision?.via !== 'schedule') {
      throw new PlanningError('permission_denied', 'runtime_only');
    }
    if (plan.delegationState === 'failed') await cleanUp(tenant, plan);
    return plan;
  }

  return Object.freeze({ delegate, abandon, releaseManual, closeFailed });
}
