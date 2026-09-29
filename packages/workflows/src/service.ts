import { actorOf, buildAuditEvent, type AuditEvent } from '@melonoffice/audit';
import type { DepartmentRepository } from '@melonoffice/departments';
import type {
  ExecutionId,
  IsoTimestamp,
  OrganizationId,
  Specialist,
  Workflow,
  WorkflowId,
  WorkflowStatus,
  WorkflowStep,
  WorkflowVersion,
} from '@melonoffice/domain';
import { executionIdFor, isExecutionError, type ExecutionService } from '@melonoffice/execution';
import { isPlanningError, type PlanService, type ProposeOutcome } from '@melonoffice/planning';
import type { AuthorizationService } from '@melonoffice/rbac';
import type { SpecialistService } from '@melonoffice/specialists';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { WorkflowError } from './errors.js';
import { applyWorkflowStatus, isWorkflowId, newWorkflow, newWorkflowVersion } from './model.js';
import type { WorkflowRepository } from './repository.js';

export const MAX_WORKFLOWS_LISTED = 100;

/** The input type of a planning execution a workflow started (ADR-0071). */
export const WORKFLOW_PLAN_INPUT = 'workflow';
/** The failure code of a planning execution whose workflow plan was refused. */
export const WORKFLOW_PLAN_REFUSED = 'plan_refused';
/** A caller's key for one request to plan a workflow: the same key is the same plan. */
const REQUEST_KEY = /^[A-Za-z0-9_-]{1,64}$/;

type Refusal = Extract<ProposeOutcome, { status: 'refused' }>;
const REFUSAL_ID = /^[A-Za-z0-9._:-]{1,128}$/;

/** Why a plan was refused, as its execution keeps it: `stage:reason[:detail]`, all codes. */
const refusalId = ({ stage, reason, detail }: Refusal): string => {
  const full = `${stage}:${reason}${detail === undefined ? '' : `:${detail}`}`;
  return REFUSAL_ID.test(full) ? full : `${stage}:${reason}`;
};

/** What planning a workflow gave: the plan, or why it was refused, and its execution. */
export type WorkflowPlanOutcome = ProposeOutcome & { readonly executionId: ExecutionId };

/**
 * Workflows of an organization (ADR-0028): reusable plan templates with write-once versions. A
 * workflow runs nothing: instantiating one produces a plan through the same validation as the
 * planner's, and that plan still needs its own approval and delegation. Reading needs
 * `workflow.read`; changing needs `workflow.manage`; planning one needs `plan.create` (ADR-0071).
 */
export interface WorkflowService {
  list(tenant: TenantContext): Promise<readonly Workflow[]>;
  /** `workflow_not_found` for an unknown id or another organization's workflow alike. */
  get(tenant: TenantContext, id: string): Promise<Workflow>;
  getVersion(tenant: TenantContext, id: string, version: number): Promise<WorkflowVersion>;
  create(tenant: TenantContext, input: { name: string; steps: unknown }): Promise<Workflow>;
  publishVersion(
    tenant: TenantContext,
    id: string,
    input: { name?: string; steps: unknown },
  ): Promise<Workflow>;
  changeStatus(
    tenant: TenantContext,
    id: string,
    change: { from: WorkflowStatus; to: WorkflowStatus },
  ): Promise<Workflow>;
  /**
   * Turns the workflow's current version into a plan for `executionId`, a planning execution
   * that recorded this workflow and version (`workflowId` and a `workflow` snapshot component).
   */
  instantiate(
    tenant: TenantContext,
    id: string,
    input: { executionId: string },
  ): Promise<ProposeOutcome>;
  /**
   * A person plans the workflow's current version (ADR-0071): its planning execution is created
   * for the agent of the first assigned step, then the workflow is instantiated on it. The plan
   * always waits for that person's approval; nothing runs here. The same `requestKey` for the
   * same version is the same plan: asking again returns it and creates nothing.
   */
  plan(
    tenant: TenantContext,
    id: string,
    input: { requestKey: string },
  ): Promise<WorkflowPlanOutcome>;
}

export interface WorkflowServiceOptions {
  readonly repository: WorkflowRepository;
  readonly plans: Pick<PlanService, 'propose' | 'get' | 'getVersion'>;
  /** Creates and moves the planning execution of `plan`. */
  readonly executions: Pick<ExecutionService, 'create' | 'get' | 'changeStatus'>;
  readonly specialists: Pick<SpecialistService, 'list' | 'eligibility'>;
  readonly departments: Pick<DepartmentRepository, 'find'>;
  /** Only `findOrganization` is used, to refuse inactive organizations. */
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly now?: () => Date;
  /** The request that asked, to correlate audit events and logs. */
  readonly requestId?: string;
}

export function createWorkflowService({
  repository,
  plans,
  executions,
  specialists,
  departments,
  organizations,
  authorization,
  now = () => new Date(),
  requestId,
}: WorkflowServiceOptions): WorkflowService {
  async function organizationOf(
    tenant: TenantContext,
    permission: 'workflow.read' | 'workflow.manage' | 'plan.create',
  ): Promise<OrganizationId> {
    if (!isResolvedTenant(tenant)) throw new WorkflowError('unresolved_tenant');
    const organization = await organizations.findOrganization(tenant.organizationId);
    if (organization?.id !== tenant.organizationId || organization.status !== 'active') {
      throw new WorkflowError('organization_inactive');
    }
    if (!authorization.authorize(tenant, permission, { organizationId: organization.id }).allowed) {
      throw new WorkflowError('permission_denied');
    }
    return organization.id;
  }

  const idOf = (id: string): WorkflowId => {
    if (!isWorkflowId(id)) throw new WorkflowError('workflow_not_found');
    return id;
  };

  /**
   * The audit event of a workflow change (ADR-0028): who, in which organization, which workflow
   * and version, and the status change when there is one. Never the steps or names.
   */
  const event = (
    tenant: TenantContext,
    workflow: Workflow,
    action: 'workflow.created' | 'workflow.version_created' | 'workflow.state_changed',
    at: Date,
    transition?: { from: WorkflowStatus; to: WorkflowStatus },
  ): AuditEvent =>
    buildAuditEvent(
      {
        action,
        result: 'success',
        actor: actorOf(tenant),
        organizationId: workflow.organizationId,
        target: { type: 'workflow', id: workflow.id },
        targetVersion: workflow.version,
        ...(transition === undefined ? {} : { transition }),
        ...(requestId === undefined ? {} : { requestId }),
        source: 'api',
      },
      at,
    );

  const iso = (at: Date): IsoTimestamp => at.toISOString() as IsoTimestamp;

  async function find(organizationId: OrganizationId, id: string): Promise<Workflow> {
    const workflow = await repository.find(organizationId, idOf(id));
    if (workflow === undefined) throw new WorkflowError('workflow_not_found');
    return workflow;
  }

  /**
   * The specialist a step's assignee resolves to: the eligible specialist with that main role in
   * a department of that type, the first by id when several fit. Deterministic; no AI.
   */
  async function bind(
    tenant: TenantContext,
    all: readonly Specialist[],
    step: WorkflowStep,
  ): Promise<Specialist> {
    const assignee = step.assignee;
    if (assignee === undefined) throw new WorkflowError('invalid_workflow', 'assignee');
    const sorted = [...all].sort((a, b) => (a.identity.id < b.identity.id ? -1 : 1));
    for (const s of sorted) {
      if (s.configuration.mainRoleId !== assignee.roleId) continue;
      const department = await departments.find(s.organizationId, s.configuration.departmentId);
      if (
        department?.origin.kind !== 'catalog' ||
        department.origin.typeId !== assignee.departmentTypeId
      ) {
        continue;
      }
      const decision = await specialists.eligibility(tenant, {
        specialistId: s.identity.id,
        departmentId: s.configuration.departmentId,
        version: s.version,
      });
      if (decision.eligible) return s;
    }
    throw new WorkflowError('assignee_unavailable', step.id);
  }

  async function activeVersionOf(
    organizationId: OrganizationId,
    id: string,
  ): Promise<{ workflow: Workflow; version: WorkflowVersion }> {
    const workflow = await find(organizationId, id);
    if (workflow.status !== 'active') throw new WorkflowError('workflow_not_active');
    const version = await repository.findVersion(organizationId, workflow.id, workflow.version);
    if (version === undefined) throw new WorkflowError('workflow_not_found');
    return { workflow, version };
  }

  /** The version's steps with each assignee bound, and the agent of the first assigned step. */
  async function bound(
    tenant: TenantContext,
    version: WorkflowVersion,
  ): Promise<{ steps: Record<string, unknown>[]; owner: Specialist | undefined }> {
    const all = await specialists.list(tenant);
    const steps: Record<string, unknown>[] = [];
    let owner: Specialist | undefined;
    for (const step of version.steps) {
      const { assignee, ...template } = step;
      if (assignee === undefined) {
        steps.push({ ...template });
        continue;
      }
      const specialist = await bind(tenant, all, step);
      owner ??= specialist;
      steps.push({ ...template, specialistId: specialist.identity.id });
    }
    return { steps, owner };
  }

  // The same pipeline as the planner's: a workflow cannot skip any check a model would face.
  const proposeOn = (
    tenant: TenantContext,
    workflow: Workflow,
    version: WorkflowVersion,
    steps: Record<string, unknown>[],
    executionId: string,
  ): Promise<ProposeOutcome> =>
    plans.propose(tenant, {
      executionId,
      proposal: { summary: version.name, objective: version.name, steps },
      source: { kind: 'workflow', workflowId: workflow.id, workflowVersion: version.version },
    });

  async function executionOf(tenant: TenantContext, id: ExecutionId) {
    try {
      return await executions.get(tenant, id);
    } catch (error) {
      if (isExecutionError(error) && error.code === 'execution_not_found') return undefined;
      throw error;
    }
  }

  /** Moves the planning execution, or reads it back when a repeat of the request moved it. */
  async function moveOrReread(
    tenant: TenantContext,
    id: ExecutionId,
    from: 'pending' | 'planning',
    to: 'planning' | 'failed',
    failure?: { code: string; ref: { type: string; id: string } },
  ) {
    try {
      return await executions.changeStatus(tenant, id, {
        from,
        to,
        ...(failure === undefined ? {} : { failure }),
      });
    } catch (error) {
      if (!isExecutionError(error)) throw error;
      const fresh = await executionOf(tenant, id);
      if (fresh === undefined || fresh.status === from) throw error;
      return fresh;
    }
  }

  /** What an earlier request gave: its plan, or the refusal its execution recorded. */
  async function outcomeOf(
    tenant: TenantContext,
    execution: Awaited<ReturnType<typeof executions.get>>,
  ): Promise<ProposeOutcome> {
    const refusal = execution.failure;
    if (refusal?.code === WORKFLOW_PLAN_REFUSED && refusal.ref !== undefined) {
      const [stage, reason, ...detail] = refusal.ref.id.split(':');
      return Object.freeze({
        status: 'refused',
        stage: stage as Refusal['stage'],
        reason: reason ?? WORKFLOW_PLAN_REFUSED,
        ...(detail.length === 0 ? {} : { detail: detail.join(':') }),
      });
    }
    let plan: Awaited<ReturnType<typeof plans.get>>;
    try {
      plan = await plans.get(tenant, execution.id);
    } catch (error) {
      // Ended without a plan (cancelled before planning): this request is over.
      if (isPlanningError(error) && error.code === 'plan_not_found') {
        throw new WorkflowError('workflow_plan_ended');
      }
      throw error;
    }
    return Object.freeze({
      status: 'planned',
      plan,
      version: await plans.getVersion(tenant, plan.id, plan.version),
    });
  }

  return Object.freeze({
    async list(tenant: TenantContext) {
      return repository.list(await organizationOf(tenant, 'workflow.read'), MAX_WORKFLOWS_LISTED);
    },

    async get(tenant: TenantContext, id: string) {
      return find(await organizationOf(tenant, 'workflow.read'), id);
    },

    async getVersion(tenant: TenantContext, id: string, version: number) {
      const organizationId = await organizationOf(tenant, 'workflow.read');
      const workflow = await find(organizationId, id);
      const found =
        Number.isSafeInteger(version) && version >= 1 && version <= workflow.version
          ? await repository.findVersion(organizationId, workflow.id, version)
          : undefined;
      if (found === undefined) throw new WorkflowError('workflow_not_found');
      return found;
    },

    async create(tenant: TenantContext, input: { name: string; steps: unknown }) {
      const organizationId = await organizationOf(tenant, 'workflow.manage');
      const when = now();
      const write = newWorkflow({ organizationId, ...input }, tenant.userId, iso(when));
      await repository.create({
        ...write,
        events: [event(tenant, write.workflow, 'workflow.created', when)],
      });
      return write.workflow;
    },

    async publishVersion(
      tenant: TenantContext,
      id: string,
      input: { name?: string; steps: unknown },
    ) {
      const organizationId = await organizationOf(tenant, 'workflow.manage');
      const when = now();
      return repository.update(organizationId, idOf(id), (current) => {
        const write = newWorkflowVersion(current, input, tenant.userId, iso(when));
        return {
          ...write,
          events: [event(tenant, write.workflow, 'workflow.version_created', when)],
        };
      });
    },

    async changeStatus(
      tenant: TenantContext,
      id: string,
      change: { from: WorkflowStatus; to: WorkflowStatus },
    ) {
      const organizationId = await organizationOf(tenant, 'workflow.manage');
      const when = now();
      return repository.update(organizationId, idOf(id), (current) => {
        const workflow = applyWorkflowStatus(current, change.from, change.to, iso(when));
        return {
          workflow,
          events: [
            event(tenant, workflow, 'workflow.state_changed', when, {
              from: current.status,
              to: workflow.status,
            }),
          ],
        };
      });
    },

    async instantiate(tenant: TenantContext, id: string, input: { executionId: string }) {
      const organizationId = await organizationOf(tenant, 'plan.create');
      const { workflow, version } = await activeVersionOf(organizationId, id);
      const { steps } = await bound(tenant, version);
      return proposeOn(tenant, workflow, version, steps, input.executionId);
    },

    async plan(tenant: TenantContext, id: string, input: { requestKey: string }) {
      const organizationId = await organizationOf(tenant, 'plan.create');
      // Planning a workflow is a person's request: never GIA's, never the runtime's.
      if (tenant.actor !== 'user') throw new WorkflowError('permission_denied');
      if (typeof input.requestKey !== 'string' || !REQUEST_KEY.test(input.requestKey)) {
        throw new WorkflowError('invalid_workflow', 'requestKey');
      }
      const { workflow, version } = await activeVersionOf(organizationId, id);
      const key = `workflow-plan:${workflow.id}:${version.version}:${input.requestKey}`;
      const executionId = executionIdFor(organizationId, key);

      // Asked before: the same plan, or the same refusal, and nothing new.
      const earlier = await executionOf(tenant, executionId);
      if (earlier !== undefined && earlier.status !== 'pending' && earlier.status !== 'planning') {
        return { ...(await outcomeOf(tenant, earlier)), executionId };
      }

      const { steps, owner } = await bound(tenant, version);
      if (owner === undefined) throw new WorkflowError('invalid_workflow', 'assignee');
      let execution = earlier;
      if (execution === undefined) {
        try {
          execution = await executions.create(tenant, {
            mode: 'plan',
            input: { type: WORKFLOW_PLAN_INPUT, id: workflow.id },
            workflowId: workflow.id,
            specialistId: owner.identity.id,
            specialistVersion: owner.version,
            departmentId: owner.configuration.departmentId,
            versionSnapshot: {
              schemaVersion: 1,
              components: [
                { kind: 'specialist', id: owner.identity.id, version: String(owner.version) },
                { kind: 'workflow', id: workflow.id, version: String(version.version) },
              ],
            },
            idempotencyKey: key,
            ...(requestId === undefined ? {} : { requestId }),
          });
        } catch (error) {
          // Created concurrently by a repeat of the same request: that one is the plan.
          const raced = await executionOf(tenant, executionId);
          if (raced === undefined) throw error;
          execution = raced;
        }
      }
      if (execution.status === 'pending') {
        execution = await moveOrReread(tenant, executionId, 'pending', 'planning');
      }
      if (execution.status !== 'planning') {
        return { ...(await outcomeOf(tenant, execution)), executionId };
      }

      let outcome: ProposeOutcome;
      try {
        outcome = await proposeOn(tenant, workflow, version, steps, executionId);
      } catch (error) {
        // A repeat stored the plan first: that one is the answer.
        const fresh = await executionOf(tenant, executionId);
        if (fresh === undefined || fresh.status === 'planning') throw error;
        return { ...(await outcomeOf(tenant, fresh)), executionId };
      }
      if (outcome.status === 'refused') {
        // A refused plan ends its execution, with why, so a repeat gives the same answer.
        await moveOrReread(tenant, executionId, 'planning', 'failed', {
          code: WORKFLOW_PLAN_REFUSED,
          ref: { type: 'plan_refusal', id: refusalId(outcome) },
        });
      }
      return { ...outcome, executionId };
    },
  });
}
