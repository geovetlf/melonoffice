import { actorOf, buildAuditEvent, type AuditEvent } from '@melonoffice/audit';
import type { DepartmentRepository } from '@melonoffice/departments';
import type {
  IsoTimestamp,
  OrganizationId,
  Specialist,
  Workflow,
  WorkflowId,
  WorkflowStatus,
  WorkflowStep,
  WorkflowVersion,
} from '@melonoffice/domain';
import type { PlanService, ProposeOutcome } from '@melonoffice/planning';
import type { AuthorizationService } from '@melonoffice/rbac';
import type { SpecialistService } from '@melonoffice/specialists';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { WorkflowError } from './errors.js';
import { applyWorkflowStatus, isWorkflowId, newWorkflow, newWorkflowVersion } from './model.js';
import type { WorkflowRepository } from './repository.js';

export const MAX_WORKFLOWS_LISTED = 100;

/**
 * Workflows of an organization (ADR-0028): reusable plan templates with write-once versions. A
 * workflow runs nothing: instantiating one produces a plan through the same validation as the
 * planner's, and that plan still needs its own approval and delegation. Reading needs
 * `workflow.read`; changing needs `workflow.manage`, server side only (no client route in X5).
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
}

export interface WorkflowServiceOptions {
  readonly repository: WorkflowRepository;
  readonly plans: Pick<PlanService, 'propose'>;
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
      const workflow = await find(organizationId, id);
      if (workflow.status !== 'active') throw new WorkflowError('workflow_not_active');
      const version = await repository.findVersion(organizationId, workflow.id, workflow.version);
      if (version === undefined) throw new WorkflowError('workflow_not_found');
      const all = await specialists.list(tenant);
      const steps: Record<string, unknown>[] = [];
      for (const step of version.steps) {
        const { assignee, ...template } = step;
        if (assignee === undefined) {
          steps.push({ ...template });
          continue;
        }
        const specialist = await bind(tenant, all, step);
        steps.push({ ...template, specialistId: specialist.identity.id });
      }
      // The same pipeline as the planner's: a workflow cannot skip any check a model would face.
      return plans.propose(tenant, {
        executionId: input.executionId,
        proposal: { summary: version.name, objective: version.name, steps },
        source: { kind: 'workflow', workflowId: workflow.id, workflowVersion: version.version },
      });
    },
  });
}
