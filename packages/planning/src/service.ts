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
  OrganizationId,
  Plan,
  PlanId,
  PlanSource,
  PlanVersion,
} from '@melonoffice/domain';
import type { ExecutionService } from '@melonoffice/execution';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { PlanningError } from './errors.js';
import { applyPlanStatus, decidePlan, isPlanId, isPlanReason, newPlan } from './model.js';
import type { PlanPage, PlanPosition, PlanRepository } from './repository.js';
import type { PlanValidator, ValidationStage } from './validate.js';

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
  /** Every plan of the organization, newest first, a page at a time (ADR-0150). */
  page(
    tenant: TenantContext,
    request: { readonly after?: PlanPosition; readonly limit: number },
  ): Promise<PlanPage>;
  /** `plan_not_found` for an unknown id or another organization's plan alike. */
  get(tenant: TenantContext, id: string): Promise<Plan>;
  getVersion(tenant: TenantContext, id: string, version: number): Promise<PlanVersion>;
  propose(tenant: TenantContext, input: ProposeInput): Promise<ProposeOutcome>;
  approve(tenant: TenantContext, id: string, seen: PlanDecisionInput): Promise<Plan>;
  reject(tenant: TenantContext, id: string, seen: PlanDecisionInput): Promise<Plan>;
  /** Server side only. `reason` is a stable code. */
  cancel(tenant: TenantContext, id: string, reason: string): Promise<Plan>;
}

export interface PlanServiceOptions {
  readonly repository: PlanRepository;
  readonly executions: Pick<ExecutionService, 'get' | 'changeStatus'>;
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
        ...(requestId === undefined ? {} : { requestId }),
        source: 'api',
      },
      at,
    );

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

    async page(tenant: TenantContext, request: { after?: PlanPosition; limit: number }) {
      return repository.page(await organizationOf(tenant), request);
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
        // The execution waits on a human; nothing moves until a user decides.
        await executions.changeStatus(tenant, execution.id, {
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
  });
}
