import {
  actorOf,
  buildAuditEvent,
  type AuditAction,
  type AuditEvent,
  type AuditService,
  type AuditTransition,
} from '@melonoffice/audit';
import type {
  Execution,
  IsoTimestamp,
  OrganizationId,
  Plan,
  PlanId,
  PlanSource,
  PlanVersion,
  WorkflowId,
} from '@melonoffice/domain';
import type { ExecutionService } from '@melonoffice/execution';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { PlanningError } from './errors.js';
import { applyPlanStatus, decidePlan, isPlanId, isPlanReason, newPlan } from './model.js';
import {
  pageOfPlans,
  type PlanPage,
  type PlanPosition,
  type PlanRepository,
} from './repository.js';
import type { PlanValidation, PlanValidator, ValidationStage } from './validate.js';

export const MAX_PLANS_LISTED = 100;

/** What was proposed, for which planning execution, and where it came from. */
export interface ProposeInput {
  readonly executionId: string;
  /** The raw proposal: the model's structured output, or a workflow's instantiation. */
  readonly proposal: unknown;
  readonly source: PlanSource;
}

export type ProposeOutcome =
  | { readonly status: 'planned'; readonly plan: Plan; readonly version: PlanVersion }
  | {
      readonly status: 'refused';
      readonly stage: ValidationStage;
      readonly reason: string;
      readonly detail?: string;
    };

/** What a schedule's person approved once for every occurrence (ADR-0185). */
export interface StandingApproval {
  readonly workflowId: WorkflowId;
  readonly workflowVersion: number;
}

/**
 * Why a schedule's open plan is closed, and the instant a live delivery's lease has lapsed by.
 * `schedule_abandoned`: the schedule moved past the plan's occurrence (ADR-0185 §13).
 * `schedule_off`: the schedule is off, so no occurrence supersedes the plan (ADR-0186).
 */
export interface AbandonScheduled {
  readonly workflowId: WorkflowId;
  readonly reason?: 'schedule_abandoned' | 'schedule_off';
  /**
   * The occurrence the schedule claimed next: the plan's own must be earlier. Only with
   * `schedule_abandoned`; with `schedule_off` nothing supersedes it.
   */
  readonly supersededBy?: IsoTimestamp;
  /** The plan must not have changed after this instant (ADR-0185 §13). */
  readonly untouchedBefore: IsoTimestamp;
}

/**
 * Whether a schedule's plan may be closed for `input` (ADR-0185 §13, ADR-0186): it is the
 * schedule's own, of this workflow, in its occurrence, approved and not yet started, and it has
 * not changed since `untouchedBefore`. `delegated` says whether the caller also wants a plan whose
 * delegation is `creating`; `input.reason` decides whether the next occurrence must supersede it.
 */
export function abandonableScheduled(
  plan: Plan,
  input: AbandonScheduled,
  options: { readonly delegated: boolean },
): boolean {
  const occurrence = plan.workflow?.occurrence;
  const reason = input.reason ?? 'schedule_abandoned';
  const delegation = options.delegated
    ? plan.delegationState === 'creating'
    : plan.delegationState === undefined && plan.delegations.length === 0;
  return (
    plan.decision?.via === 'schedule' &&
    plan.workflow?.id === input.workflowId &&
    occurrence !== undefined &&
    plan.status === 'approved' &&
    delegation &&
    Date.parse(plan.updatedAt) <= Date.parse(input.untouchedBefore) &&
    (reason === 'schedule_abandoned'
      ? input.supersededBy !== undefined && Date.parse(occurrence) < Date.parse(input.supersededBy)
      : input.supersededBy === undefined)
  );
}

/** The risks a standing approval covers (ADR-0185); above them a person decides each time. */
const STANDING_RISKS: ReadonlySet<string> = new Set(['low', 'medium']);

/** What the user saw when deciding: the exact version and its digest. */
export interface PlanDecisionInput {
  readonly version: number;
  readonly digest: string;
}

/**
 * Plans of an organization (ADR-0028). Every method works on the organization of a resolved
 * `TenantContext`, never on an id the caller passes. A plan runs nothing by existing.
 *
 * - `propose` is server side only (the planner and workflows): it needs `plan.create`.
 * - `approve` and `reject` need `approval.approve` and a user acting directly: GIA, the planner
 *   and the model can never decide a plan, and there is no self-approval path.
 */
export interface PlanService {
  list(tenant: TenantContext): Promise<readonly Plan[]>;
  /** One workflow's plans in the tenant's organization (ADR-0180), newest first. */
  listForWorkflow(tenant: TenantContext, workflowId: WorkflowId): Promise<readonly Plan[]>;
  /** Every plan of the organization, newest first, a page at a time (ADR-0150). */
  page(
    tenant: TenantContext,
    request: { readonly after?: PlanPosition; readonly limit: number },
  ): Promise<PlanPage>;
  /**
   * One workflow's plans in the tenant's organization, a page at a time in `page`'s order
   * (ADR-0182). They are read whole with ADR-0180's equality filters, then paged.
   */
  pageForWorkflow(
    tenant: TenantContext,
    workflowId: WorkflowId,
    request: { readonly after?: PlanPosition; readonly limit: number },
  ): Promise<PlanPage>;
  /** `plan_not_found` for an unknown id or another organization's plan alike. */
  get(tenant: TenantContext, id: string): Promise<Plan>;
  getVersion(tenant: TenantContext, id: string, version: number): Promise<PlanVersion>;
  propose(tenant: TenantContext, input: ProposeInput): Promise<ProposeOutcome>;
  /**
   * A dry run (ADR-0168): what `propose` would decide about this proposal, through the same
   * validator, now. Stores nothing, records nothing and needs no planning execution. Needs
   * `plan.create`, like proposing.
   */
  check(tenant: TenantContext, proposal: unknown): Promise<PlanValidation>;
  /** Whether a tool may be a tool step here, by the validator's own rule (ADR-0168). */
  toolUse: PlanValidator['toolUse'];
  approve(tenant: TenantContext, id: string, seen: PlanDecisionInput): Promise<Plan>;
  /**
   * The runtime applies a person's standing approval to one occurrence's plan (ADR-0185): only a
   * plan its own person's schedule made from this workflow and version, at version 1, with a risk
   * of at most `medium`, and only while that person still holds `approval.approve`. Anything
   * else is refused and the plan keeps waiting for a person.
   */
  approveScheduled(tenant: TenantContext, id: string, standing: StandingApproval): Promise<Plan>;
  reject(tenant: TenantContext, id: string, seen: PlanDecisionInput): Promise<Plan>;
  /** Server side only. `reason` is a stable code. */
  cancel(tenant: TenantContext, id: string, reason: string): Promise<Plan>;
  /**
   * Closes a plan its schedule approved and never started, from an occurrence the schedule has
   * moved past (ADR-0185 §13): no task can start it now. Runtime only. The guard is read again in
   * the plan's own transaction, so a plan started, delegated or changed within the lease is refused
   * with `plan_not_abandonable` and nothing changes.
   */
  abandonScheduled(tenant: TenantContext, id: string, input: AbandonScheduled): Promise<Plan>;
}

export interface PlanServiceOptions {
  readonly repository: PlanRepository;
  readonly executions: Pick<ExecutionService, 'get' | 'changeStatus'> &
    Partial<Pick<ExecutionService, 'runtimePlanChangeStatus'>>;
  readonly validator: PlanValidator;
  /** Only `findOrganization` is used, to refuse inactive organizations. */
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  /** Records refusals, which change nothing and so have no write of their own. */
  readonly audit: AuditService;
  readonly now?: () => Date;
  readonly requestId?: string;
}

/** An execution that is planning: mode `plan`, status `planning`, owned by a specialist. */
export const isPlanningExecution = (execution: Execution): boolean =>
  execution.mode === 'plan' &&
  execution.status === 'planning' &&
  execution.specialistId !== undefined;

/** Whether an execution may receive a plan from this source (ADR-0028). */
export function isPlannable(execution: Execution, source: PlanSource): boolean {
  if (!isPlanningExecution(execution)) return false;
  if (source.kind === 'planner') return execution.workflowId === undefined;
  // A workflow's plan belongs to an execution that recorded that exact workflow version.
  return (
    execution.workflowId === source.workflowId &&
    execution.versionSnapshot.components.some(
      (c) =>
        c.kind === 'workflow' &&
        c.id === source.workflowId &&
        c.version === String(source.workflowVersion),
    )
  );
}

export function createPlanService({
  repository,
  executions,
  validator,
  organizations,
  authorization,
  audit,
  now = () => new Date(),
  requestId,
}: PlanServiceOptions): PlanService {
  async function organizationOf(tenant: TenantContext): Promise<OrganizationId> {
    if (!isResolvedTenant(tenant)) throw new PlanningError('unresolved_tenant');
    const organization = await organizations.findOrganization(tenant.organizationId);
    if (organization?.id !== tenant.organizationId || organization.status !== 'active') {
      throw new PlanningError('organization_inactive');
    }
    return organization.id;
  }

  const idOf = (id: string): PlanId => {
    // A malformed id cannot exist: answered like any unknown id, without a lookup.
    if (!isPlanId(id)) throw new PlanningError('plan_not_found');
    return id;
  };

  const eventOf = (
    tenant: TenantContext,
    organizationId: OrganizationId,
    fields: {
      action: Extract<AuditAction, `plan.${string}`>;
      result: 'success' | 'denied';
      target: { type: 'plan' | 'execution'; id: string };
      transition?: AuditTransition;
      reason?: string;
      reference?: string;
    },
    at: Date,
  ): AuditEvent =>
    buildAuditEvent(
      {
        action: fields.action,
        result: fields.result,
        actor: actorOf(tenant),
        organizationId,
        target: fields.target,
        ...(fields.transition === undefined ? {} : { transition: fields.transition }),
        ...(fields.reason === undefined ? {} : { reason: fields.reason }),
        ...(fields.reference === undefined ? {} : { reference: fields.reference }),
        ...(requestId === undefined ? {} : { requestId }),
        source: 'api',
      },
      at,
    );

  /** A planning execution's status, moved by a person, or by the runtime for a schedule. */
  const move: ExecutionService['changeStatus'] = (tenant, id, change) => {
    if (tenant.actor !== 'runtime') return executions.changeStatus(tenant, id, change);
    if (executions.runtimePlanChangeStatus === undefined) {
      throw new PlanningError('permission_denied', 'runtime_only');
    }
    return executions.runtimePlanChangeStatus(tenant, id, change);
  };

  async function get(tenant: TenantContext, id: string): Promise<Plan> {
    const organizationId = await organizationOf(tenant);
    const plan = await repository.find(organizationId, idOf(id));
    if (plan === undefined) throw new PlanningError('plan_not_found');
    return plan;
  }

  async function decide(
    tenant: TenantContext,
    id: string,
    seen: PlanDecisionInput,
    to: 'approved' | 'rejected',
  ): Promise<Plan> {
    const organizationId = await organizationOf(tenant);
    const plan = await repository.find(organizationId, idOf(id));
    if (plan === undefined) throw new PlanningError('plan_not_found');
    const action = to === 'approved' ? 'plan.approved' : 'plan.rejected';
    const refuse = async (
      code: 'gia_cannot_decide' | 'runtime_cannot_decide' | 'permission_denied',
      reason: string,
    ) => {
      await audit.record({
        action,
        result: 'denied',
        actor: actorOf(tenant),
        organizationId,
        target: { type: 'plan', id: plan.id },
        reason,
        ...(requestId === undefined ? {} : { requestId }),
        source: 'api',
      });
      throw new PlanningError(code, reason);
    };
    // A user decides, directly. GIA may show a plan; it never approves or rejects one. The runtime
    // never takes a human decision either (ADR-0029).
    if (tenant.actor === 'runtime') return refuse('runtime_cannot_decide', 'runtime_cannot_decide');
    if (tenant.actor !== 'user') return refuse('gia_cannot_decide', 'gia_cannot_decide');
    const decision = authorization.authorize(tenant, 'approval.approve', { organizationId });
    if (!decision.allowed) return refuse('permission_denied', decision.reason);
    const at = now();
    const decided = await repository.update(organizationId, plan.id, (current, version) => {
      const next = decidePlan(
        current,
        version,
        to,
        seen,
        tenant.userId,
        at.toISOString() as Plan['updatedAt'],
      );
      return {
        plan: next,
        events: [
          eventOf(
            tenant,
            organizationId,
            {
              action,
              result: 'success',
              target: { type: 'plan', id: next.id },
              transition: { from: current.status, to: next.status },
            },
            at,
          ),
        ],
      };
    });
    if (to === 'rejected') {
      // A rejected plan ends the work it was made for; nothing of it ever runs.
      const execution = await executions.get(tenant, decided.executionId);
      if (execution.status === 'waiting_approval' || execution.status === 'planning') {
        await executions.changeStatus(tenant, execution.id, {
          from: execution.status,
          to: 'cancelled',
          reason: 'plan_rejected',
        });
      }
    }
    return decided;
  }

  return Object.freeze({
    async list(tenant: TenantContext) {
      return repository.list(await organizationOf(tenant), MAX_PLANS_LISTED);
    },

    async listForWorkflow(tenant: TenantContext, workflowId: WorkflowId) {
      return repository.listForWorkflow(await organizationOf(tenant), workflowId, MAX_PLANS_LISTED);
    },

    async page(tenant: TenantContext, request: { after?: PlanPosition; limit: number }) {
      return repository.page(await organizationOf(tenant), request);
    },

    async pageForWorkflow(
      tenant: TenantContext,
      workflowId: WorkflowId,
      request: { after?: PlanPosition; limit: number },
    ) {
      const organizationId = await organizationOf(tenant);
      const all = await repository.listForWorkflow(
        organizationId,
        workflowId,
        Number.MAX_SAFE_INTEGER,
      );
      return pageOfPlans(all, request);
    },

    get,

    async getVersion(tenant: TenantContext, id: string, version: number) {
      const plan = await get(tenant, id);
      const found =
        Number.isSafeInteger(version) && version >= 1 && version <= plan.version
          ? await repository.findVersion(plan.organizationId, plan.id, version)
          : undefined;
      if (found === undefined) throw new PlanningError('plan_not_found');
      return found;
    },

    toolUse: validator.toolUse,

    async check(tenant: TenantContext, proposal: unknown): Promise<PlanValidation> {
      const organizationId = await organizationOf(tenant);
      if (!authorization.authorize(tenant, 'plan.create', { organizationId }).allowed) {
        throw new PlanningError('permission_denied');
      }
      return validator.validate(tenant, proposal);
    },

    async propose(tenant: TenantContext, input: ProposeInput): Promise<ProposeOutcome> {
      const organizationId = await organizationOf(tenant);
      if (!authorization.authorize(tenant, 'plan.create', { organizationId }).allowed) {
        throw new PlanningError('permission_denied');
      }
      const execution = await executions.get(tenant, input.executionId);
      if (!isPlannable(execution, input.source)) {
        throw new PlanningError('execution_not_plannable');
      }
      const validation = await validator.validate(tenant, input.proposal);
      if (!validation.ok) {
        await audit.record({
          action: 'plan.proposal_refused',
          result: 'denied',
          actor: actorOf(tenant),
          organizationId,
          target: { type: 'execution', id: execution.id },
          reason: validation.reason,
          ...(requestId === undefined ? {} : { requestId }),
          source: 'api',
        });
        return Object.freeze({
          status: 'refused',
          stage: validation.stage,
          reason: validation.reason,
          ...(validation.detail === undefined ? {} : { detail: validation.detail }),
        });
      }
      const at = now();
      const write = newPlan(
        {
          organizationId,
          executionId: execution.id,
          validated: validation.plan,
          source: input.source,
        },
        tenant.userId,
        at.toISOString() as Plan['createdAt'],
      );
      await repository.create({
        ...write,
        events: [
          eventOf(
            tenant,
            organizationId,
            {
              action: 'plan.created',
              result: 'success',
              target: { type: 'plan', id: write.plan.id },
            },
            at,
          ),
        ],
      });
      if (write.plan.status === 'approval_required') {
        // The execution waits on a human; nothing moves until a user decides, or a schedule's
        // standing approval applies (ADR-0185).
        await move(tenant, execution.id, {
          from: 'planning',
          to: 'waiting_approval',
        });
      }
      return Object.freeze({ status: 'planned', plan: write.plan, version: write.version });
    },

    approve: (tenant: TenantContext, id: string, seen: PlanDecisionInput) =>
      decide(tenant, id, seen, 'approved'),
    reject: (tenant: TenantContext, id: string, seen: PlanDecisionInput) =>
      decide(tenant, id, seen, 'rejected'),

    async approveScheduled(tenant: TenantContext, id: string, standing: StandingApproval) {
      const organizationId = await organizationOf(tenant);
      const plan = await repository.find(organizationId, idOf(id));
      if (plan === undefined) throw new PlanningError('plan_not_found');
      const version = await repository.findVersion(organizationId, plan.id, plan.version);
      const refuse = async (reason: string): Promise<never> => {
        await audit.record({
          action: 'plan.approved',
          result: 'denied',
          actor: actorOf(tenant),
          organizationId,
          target: { type: 'plan', id: plan.id },
          reason,
          ...(requestId === undefined ? {} : { requestId }),
          source: 'api',
        });
        throw new PlanningError('permission_denied', reason);
      };
      if (tenant.actor !== 'runtime') return refuse('runtime_only');
      if (!authorization.authorize(tenant, 'approval.approve', { organizationId }).allowed) {
        return refuse('permission_denied');
      }
      const source = version?.source;
      if (
        version === undefined ||
        version.version !== 1 ||
        source?.kind !== 'workflow' ||
        source.occurrence === undefined ||
        source.workflowId !== standing.workflowId ||
        source.workflowVersion !== standing.workflowVersion ||
        plan.createdBy !== tenant.userId
      ) {
        return refuse('not_standing');
      }
      if (!STANDING_RISKS.has(version.riskLevel)) return refuse('risk_needs_person');
      const at = now();
      return repository.update(organizationId, plan.id, (current, latest) => {
        const next = decidePlan(
          current,
          latest,
          'approved',
          { version: version.version, digest: version.digest },
          tenant.userId,
          at.toISOString() as Plan['updatedAt'],
          'schedule',
        );
        return {
          plan: next,
          events: [
            eventOf(
              tenant,
              organizationId,
              {
                action: 'plan.approved',
                result: 'success',
                target: { type: 'plan', id: next.id },
                transition: { from: current.status, to: next.status },
                reason: 'schedule',
              },
              at,
            ),
          ],
        };
      });
    },

    async cancel(tenant: TenantContext, id: string, reason: string) {
      const organizationId = await organizationOf(tenant);
      if (!isPlanReason(reason)) throw new PlanningError('invalid_plan', 'reason');
      const at = now();
      return repository.update(organizationId, idOf(id), (current) => {
        // A delegation being created is finished or failed by delegating again, never left
        // half-made under a cancelled plan.
        if (current.delegationState === 'creating') {
          throw new PlanningError('delegation_in_progress');
        }
        const next = applyPlanStatus(
          current,
          current.status,
          'cancelled',
          at.toISOString() as Plan['updatedAt'],
        );
        return {
          plan: next,
          events: [
            eventOf(
              tenant,
              organizationId,
              {
                action: 'plan.state_changed',
                result: 'success',
                target: { type: 'plan', id: next.id },
                transition: { from: current.status, to: 'cancelled' },
                reason,
              },
              at,
            ),
          ],
        };
      });
    },

    async abandonScheduled(tenant: TenantContext, id: string, input: AbandonScheduled) {
      const organizationId = await organizationOf(tenant);
      if (tenant.actor !== 'runtime') throw new PlanningError('permission_denied', 'runtime_only');
      const at = now();
      return repository.update(organizationId, idOf(id), (current) => {
        const occurrence = current.workflow?.occurrence;
        // Read here, in the plan's transaction: a plan started or delegated meanwhile is refused,
        // and so is one a live delivery touched within the lease (ADR-0185 §13, ADR-0186).
        if (!abandonableScheduled(current, input, { delegated: false })) {
          throw new PlanningError('plan_not_abandonable');
        }
        const reason = input.reason ?? 'schedule_abandoned';
        const next = applyPlanStatus(
          current,
          'approved',
          'cancelled',
          at.toISOString() as Plan['updatedAt'],
        );
        return {
          plan: next,
          events: [
            eventOf(
              tenant,
              organizationId,
              {
                action: 'plan.state_changed',
                result: 'success',
                target: { type: 'plan', id: next.id },
                transition: { from: 'approved', to: 'cancelled' },
                reason,
                reference: `occurrence:${occurrence}`,
              },
              at,
            ),
          ],
        };
      });
    },
  });
}
