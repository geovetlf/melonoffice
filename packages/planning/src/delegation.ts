import { actorOf, buildAuditEvent, type AuditEvent } from '@melonoffice/audit';
import type {
  Execution,
  ExecutionStatus,
  OrganizationId,
  Plan,
  PlanDelegation,
  PlanStep,
  PlanVersion,
  VersionRef,
} from '@melonoffice/domain';
import { isExecutionError, type ExecutionService, type NodeInput } from '@melonoffice/execution';
import type { AuthorizationService } from '@melonoffice/rbac';
import type { SpecialistService } from '@melonoffice/specialists';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { PlanningError } from './errors.js';
import { isPlanId, recordDelegations } from './model.js';
import type { PlanRepository } from './repository.js';

/** Which execution node type each non-tool step becomes. */
const NODE_TYPE: Readonly<Record<Exclude<PlanStep['kind'], 'tool'>, NodeInput['type']>> = {
  specialist: 'agent',
  approval: 'approval',
  verification: 'verification',
  condition: 'condition',
  parallel: 'parallel',
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
 */
export interface Delegation {
  delegate(tenant: TenantContext, planId: string): Promise<DelegationResult>;
}

export interface DelegationOptions {
  readonly plans: PlanRepository;
  readonly executions: Pick<ExecutionService, 'get' | 'create' | 'addNodes' | 'changeStatus'>;
  readonly specialists: Pick<SpecialistService, 'eligibility'>;
  /** Only `findOrganization` is used, to refuse inactive organizations. */
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly now?: () => Date;
  readonly requestId?: string;
}

/** The status the plan's execution must be in for each plan status that can be delegated. */
const EXPECTED: Readonly<Partial<Record<Plan['status'], ExecutionStatus>>> = {
  ready: 'planning',
  approved: 'waiting_approval',
};

export function createDelegation({
  plans,
  executions,
  specialists,
  organizations,
  authorization,
  now = () => new Date(),
  requestId,
}: DelegationOptions): Delegation {
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
    fields: Pick<AuditEvent, 'action' | 'target'> & Partial<Pick<AuditEvent, 'transition'>>,
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
        ...(requestId === undefined ? {} : { requestId }),
        source: 'api',
      },
      at,
    );

  return Object.freeze({
    async delegate(tenant: TenantContext, planId: string): Promise<DelegationResult> {
      const organizationId = await organizationOf(tenant);
      if (!authorization.authorize(tenant, 'plan.create', { organizationId }).allowed) {
        throw new PlanningError('permission_denied');
      }
      if (!isPlanId(planId)) throw new PlanningError('plan_not_found');
      const plan = await plans.find(organizationId, planId);
      if (plan === undefined) throw new PlanningError('plan_not_found');
      const expected = EXPECTED[plan.status];
      if (expected === undefined || plan.delegations.length > 0) {
        throw new PlanningError('invalid_plan_transition');
      }
      // The stored version, with its digest checked: exactly what was validated and approved.
      const version = await plans.findVersion(organizationId, plan.id, plan.version);
      if (version === undefined) throw new PlanningError('plan_not_found');
      if (
        plan.status === 'approved' &&
        (plan.decision?.version !== version.version || plan.decision.digest !== version.digest)
      ) {
        throw new PlanningError('plan_version_mismatch');
      }
      const parent = await executions.get(tenant, plan.executionId);
      if (parent.status !== expected || parent.mode !== 'plan') {
        throw new PlanningError('execution_not_plannable');
      }

      // Every specialist must still be eligible, at the version the plan names, before anything
      // is written: a specialist paused or changed since planning stops the whole delegation.
      const specialistSteps = version.steps.filter((s) => s.kind === 'specialist');
      const components = new Map<string, readonly VersionRef[]>();
      for (const step of specialistSteps) {
        const s = step.specialist;
        if (s === undefined) throw new PlanningError('invalid_plan', 'specialist');
        const decision = await specialists.eligibility(tenant, {
          specialistId: s.id,
          departmentId: s.departmentId,
          version: s.version,
        });
        if (!decision.eligible) throw new PlanningError('specialist_not_eligible', decision.reason);
        components.set(step.id, decision.components);
      }

      // The plan's graph goes on its execution first. It also serves as the lock: a second
      // delegation of the same plan finds the node ids taken and stops before creating anything.
      try {
        await executions.addNodes(tenant, parent.id, parentNodesOf(version));
      } catch (error) {
        if (isExecutionError(error) && error.code !== 'execution_not_found') {
          throw new PlanningError('delegation_conflict');
        }
        throw error;
      }

      const planRef: VersionRef = { kind: 'plan', id: plan.id, version: String(version.version) };
      const workflowRef: VersionRef | undefined =
        version.source.kind === 'workflow'
          ? {
              kind: 'workflow',
              id: version.source.workflowId,
              version: String(version.source.workflowVersion),
            }
          : undefined;
      const children: Execution[] = [];
      for (const step of specialistSteps) {
        const s = step.specialist as NonNullable<PlanStep['specialist']>;
        children.push(
          await executions.create(tenant, {
            mode: 'execute',
            input: { type: 'plan_step', id: `${plan.id}:${step.id}` },
            versionSnapshot: {
              schemaVersion: 1,
              components: [
                ...(components.get(step.id) ?? []),
                planRef,
                ...(workflowRef === undefined ? [] : [workflowRef]),
              ],
            },
            nodes: childNodesOf(version, step),
            parentExecutionId: parent.id,
            ...(version.source.kind === 'workflow'
              ? { workflowId: version.source.workflowId }
              : {}),
            specialistId: s.id,
            specialistVersion: s.version,
            departmentId: s.departmentId,
          }),
        );
      }

      const at = now();
      const delegations: PlanDelegation[] = specialistSteps.map((step, i) => ({
        stepId: step.id,
        executionId: (children[i] as Execution).id,
      }));
      const updated = await plans.update(organizationId, plan.id, (current) => {
        const next = recordDelegations(current, delegations, at.toISOString() as Plan['updatedAt']);
        return {
          plan: next,
          events: [
            ...delegations.map((d) =>
              event(
                tenant,
                organizationId,
                { action: 'delegation.created', target: { type: 'execution', id: d.executionId } },
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
      await executions.changeStatus(tenant, parent.id, { from: expected, to: 'running' });
      return Object.freeze({ plan: updated, children: Object.freeze(children) });
    },
  });
}
