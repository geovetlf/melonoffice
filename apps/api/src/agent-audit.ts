import { auditAgents, type OutdatedPolicy } from '@melonoffice/agents';
import type { CompanyBrainService, FigureFact } from '@melonoffice/brain';
import type { DepartmentRepository } from '@melonoffice/departments';
import type {
  OrganizationId,
  Plan,
  PlanVersion,
  Workflow,
  WorkflowVersion,
} from '@melonoffice/domain';
import type { PlanRepository } from '@melonoffice/planning';
import { PERMISSIONS, type Permission } from '@melonoffice/rbac';
import type { SkillCatalogue, SpecialistService } from '@melonoffice/specialists';
import { isResolvedTenant, type TenantContext } from '@melonoffice/tenancy';
import { isModelInvocable, type ToolRegistry } from '@melonoffice/tools';
import type { WorkflowRepository } from '@melonoffice/workflows';
import type { Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';
import { toolLookupOf } from './specialists.js';

/** How many workflows and plans one review reads, newest first. */
export const AUDIT_READ_LIMIT = 200;

/** Facts a person confirmed, or that MelonOffice calculated or imported, count as confirmed. */
const CONFIRMED = new Set(['confirmed', 'calculated', 'imported']);

/**
 * `GET /v1/organizations/:org/agents/audit` (G-1, ADR-0131): the review of the organization's
 * agents, workflows and plans not yet handed out, as findings with evidence, severity and a
 * recommendation. `specialist.read`. Read-only: it changes nothing and asks no model.
 *
 * What the reader may not read is not reviewed, and the answer says so (`skipped`): Company Brain
 * needs `knowledge.read`, workflows `workflow.read` and plans `plan.read`, exactly as their own
 * routes do.
 */
export function registerAgentAuditRoute(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & {
    readonly specialists: Pick<SpecialistService, 'list'>;
    readonly departments: Pick<DepartmentRepository, 'list'>;
    readonly skills: SkillCatalogue;
    readonly tools: ToolRegistry;
    readonly outdatedPolicies: readonly OutdatedPolicy[];
    readonly brain?: Pick<CompanyBrainService, 'list'>;
    readonly workflows?: Pick<WorkflowRepository, 'list' | 'findVersion'>;
    readonly plans?: Pick<PlanRepository, 'list' | 'findVersion'>;
  },
): void {
  const { authorization, specialists, departments, skills, tools, brain, workflows, plans } =
    dependencies;
  const lookup = toolLookupOf(tools);
  const modelTool = (id: string, version: number): boolean => {
    const found = tools.resolve(id, version)?.version;
    return found !== undefined && isModelInvocable(found);
  };
  const can = (tenant: TenantContext, permission: Permission): boolean =>
    authorization.authorize(tenant, permission).allowed;

  async function figuresOf(tenant: TenantContext): Promise<readonly FigureFact[] | undefined> {
    if (brain === undefined || !can(tenant, 'knowledge.read')) return undefined;
    const items = await brain.list(tenant);
    return items.flatMap((item): FigureFact[] => {
      const label = item.label ?? item.subject?.id.replace(/_/g, ' ');
      if (label === undefined || item.status !== 'active') return [];
      if (item.value.type !== 'money' && item.value.type !== 'number') return [];
      return [
        {
          id: item.id,
          label,
          value: item.value,
          confirmed: CONFIRMED.has(item.verification),
        },
      ];
    });
  }

  async function workflowsOf(organizationId: OrganizationId, tenant: TenantContext) {
    if (workflows === undefined || !can(tenant, 'workflow.read')) return undefined;
    const all = await workflows.list(organizationId, AUDIT_READ_LIMIT);
    const read: { workflow: Workflow; version: WorkflowVersion }[] = [];
    for (const workflow of all) {
      if (workflow.status !== 'active') continue;
      const version = await workflows.findVersion(organizationId, workflow.id, workflow.version);
      if (version !== undefined) read.push({ workflow, version });
    }
    return read;
  }

  async function plansOf(organizationId: OrganizationId, tenant: TenantContext) {
    if (plans === undefined || !can(tenant, 'plan.read')) return undefined;
    const all = await plans.list(organizationId, AUDIT_READ_LIMIT);
    const read: { plan: Plan; version: PlanVersion }[] = [];
    for (const plan of all) {
      if (!['ready', 'approval_required', 'approved'].includes(plan.status)) continue;
      const version = await plans.findVersion(organizationId, plan.id, plan.version);
      if (version !== undefined) read.push({ plan, version });
    }
    return read;
  }

  app.get(
    '/v1/organizations/:organizationId/agents/audit',
    withPermission('specialist.read', dependencies, async (c, tenant) => {
      if (!isResolvedTenant(tenant)) return c.json({ error: 'unresolved_tenant' }, 403);
      const organizationId = tenant.organizationId as OrganizationId;
      const held = new Set(
        (Object.keys(PERMISSIONS) as Permission[]).filter((p) => can(tenant, p)),
      );
      const [agents, structure, figures, flows, open] = await Promise.all([
        specialists.list(tenant),
        departments.list(organizationId),
        figuresOf(tenant),
        workflowsOf(organizationId, tenant),
        plansOf(organizationId, tenant),
      ]);
      const audit = auditAgents({
        agents,
        departments: structure,
        skills,
        tools: lookup,
        modelTool,
        held,
        outdatedPolicies: dependencies.outdatedPolicies,
        ...(figures === undefined ? {} : { figures }),
        ...(flows === undefined ? {} : { workflows: flows }),
        ...(open === undefined ? {} : { plans: open }),
      });
      return c.json(audit);
    }),
  );
}
