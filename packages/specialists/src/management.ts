import { actorOf, buildAuditEvent, type AuditEvent } from '@melonoffice/audit';
import {
  activeOrganizationOf,
  departmentIdOf,
  isDepartmentError,
  type DepartmentRepository,
} from '@melonoffice/departments';
import type {
  IsoTimestamp,
  OrganizationId,
  Specialist,
  SpecialistConfiguration,
  SpecialistStatus,
} from '@melonoffice/domain';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import type { ToolLookup } from './capabilities.js';
import { SpecialistError } from './errors.js';
import {
  applySpecialistStatus,
  checkConfiguration,
  isSpecialistId,
  isVersionNumber,
  newSpecialist,
  reviseSpecialist,
  type SpecialistWrite,
} from './model.js';
import type { SpecialistRepository } from './repository.js';
import type { SkillCatalogue } from './skills.js';
import { AGENT_LOCALES, findAgentTemplate, type AgentLocale } from './templates.js';

/**
 * Managing an organization's agents (ADR-0062): create one from a template, change its
 * configuration as a new version, change its status. `specialist.manage`, a person directly:
 * never GIA and never the runtime. Every change is stored with its audit event, or nothing is.
 *
 * What an agent may reach outside MelonOffice (its tools and its conversation profile) is not
 * changed here: a new agent has none, and a new version keeps the current ones exactly. Those stay
 * an operator's step until each tool has its own rules (ADR-0062, AE-4).
 */
export interface SpecialistManagement {
  create(tenant: TenantContext, input: Record<string, unknown>): Promise<Specialist>;
  revise(tenant: TenantContext, id: string, input: Record<string, unknown>): Promise<Specialist>;
  setStatus(tenant: TenantContext, id: string, input: Record<string, unknown>): Promise<Specialist>;
}

export interface SpecialistManagementOptions {
  readonly repository: SpecialistRepository;
  readonly departments: DepartmentRepository;
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly skills: SkillCatalogue;
  readonly tools: ToolLookup;
  readonly now?: () => Date;
  readonly requestId?: string;
}

const bad = (detail: string): never => {
  throw new SpecialistError('invalid_specialist', detail);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const same = (a: unknown, b: unknown) => JSON.stringify(a ?? null) === JSON.stringify(b ?? null);

export function createSpecialistManagement(
  options: SpecialistManagementOptions,
): SpecialistManagement {
  const { repository, departments, organizations, authorization, skills, tools, requestId } =
    options;
  const now = options.now ?? (() => new Date());

  async function managerOf(tenant: TenantContext): Promise<OrganizationId> {
    if (!isResolvedTenant(tenant)) throw new SpecialistError('unresolved_tenant');
    // Changing an agent is a person's decision: GIA proposes, the runtime never decides.
    if (tenant.actor !== 'user' || !authorization.authorize(tenant, 'specialist.manage').allowed) {
      throw new SpecialistError('permission_denied');
    }
    try {
      return await activeOrganizationOf(tenant, organizations);
    } catch (error) {
      if (!isDepartmentError(error)) throw error;
      throw new SpecialistError(
        error.code === 'unresolved_tenant' ? 'unresolved_tenant' : 'organization_inactive',
      );
    }
  }

  const event = (
    tenant: TenantContext & { readonly userId: Specialist['identity']['createdBy'] },
    specialist: Specialist,
    action: 'specialist.created' | 'specialist.version_created' | 'specialist.status_changed',
    at: Date,
    transition?: { readonly from: SpecialistStatus; readonly to: SpecialistStatus },
  ): AuditEvent =>
    buildAuditEvent(
      {
        action,
        result: 'success',
        actor: actorOf(tenant),
        organizationId: specialist.organizationId,
        target: { type: 'specialist', id: specialist.identity.id },
        targetVersion: specialist.version,
        permission: 'specialist.manage',
        ...(transition === undefined ? {} : { transition }),
        ...(requestId === undefined ? {} : { requestId }),
        source: 'api',
      },
      at,
    );

  /**
   * The catalogues' rules on top of `checkConfiguration`: known skills and tools, every tool a
   * skill uses assigned, and every permission its skills and tools need listed, so that
   * eligibility (which checks the listed ones) checks them all.
   */
  function checkAgainstCatalogues(configuration: SpecialistConfiguration): void {
    const assigned = new Set(configuration.tools.map((t) => t.id as string));
    const listed = new Set(configuration.permissions);
    for (const { id, version } of configuration.skills) {
      const found = skills.resolve(id, version);
      if (found === undefined) bad('skills.unknown');
      for (const tool of found?.toolIds ?? []) if (!assigned.has(tool)) bad('skills.tools');
      for (const permission of found?.reads ?? []) if (!listed.has(permission)) bad('permissions');
    }
    for (const { id, version } of configuration.tools) {
      const found = tools(id, version);
      if (found === undefined) bad('tools.unknown');
      for (const permission of found?.permissions ?? []) {
        if (!listed.has(permission)) bad('permissions');
      }
    }
  }

  async function departmentOf(
    organizationId: OrganizationId,
    configuration: SpecialistConfiguration,
  ) {
    const department = await departments.find(organizationId, configuration.departmentId);
    if (department === undefined) throw new SpecialistError('department_not_assignable');
    return department;
  }

  const userOf = (tenant: TenantContext) => {
    if (!isResolvedTenant(tenant)) throw new SpecialistError('unresolved_tenant');
    return tenant;
  };

  async function update(
    organizationId: OrganizationId,
    id: string,
    change: (current: Specialist, at: Date) => SpecialistWrite,
  ): Promise<Specialist> {
    if (!isSpecialistId(id)) throw new SpecialistError('specialist_not_found');
    const at = now();
    return repository.update(organizationId, id, (current) => change(current, at));
  }

  return Object.freeze({
    async create(tenant, input) {
      const organizationId = await managerOf(tenant);
      const person = userOf(tenant);
      if (!isRecord(input)) bad('body');
      for (const key of Object.keys(input)) {
        if (!['templateId', 'displayName', 'locale'].includes(key)) bad(key);
      }
      const template = findAgentTemplate(input.templateId);
      if (template === undefined) return bad('templateId');
      const locale = (input.locale ?? 'es') as AgentLocale;
      if (!(AGENT_LOCALES as readonly unknown[]).includes(locale)) bad('locale');
      const reads = new Set<string>();
      for (const ref of template.skills) {
        for (const permission of skills.resolve(ref.id, ref.version)?.reads ?? []) {
          reads.add(permission);
        }
      }
      const configuration = checkConfiguration(
        {
          departmentId: departmentIdOf(organizationId, template.departmentTypeId),
          mainRoleId: template.mainRoleId,
          roleVersion: template.roleVersion,
          purpose: template.purpose[locale],
          capabilities: [],
          skills: template.skills,
          tools: [],
          permissions: [...reads].sort(),
          policies: template.policies,
        },
        organizationId,
      );
      checkAgainstCatalogues(configuration);
      const department = await departmentOf(organizationId, configuration);
      const at = now();
      const write = newSpecialist(
        {
          organizationId,
          displayName: input.displayName as string,
          configuration,
        },
        department,
        person.userId,
        at.toISOString() as IsoTimestamp,
      );
      await repository.create({
        ...write,
        events: [event(person, write.specialist, 'specialist.created', at)],
      });
      return write.specialist;
    },

    async revise(tenant, id, input) {
      const organizationId = await managerOf(tenant);
      const person = userOf(tenant);
      if (!isRecord(input)) bad('body');
      for (const key of Object.keys(input)) {
        if (!['fromVersion', 'configuration'].includes(key)) bad(key);
      }
      if (!isVersionNumber(input.fromVersion)) bad('fromVersion');
      const configuration = checkConfiguration(input.configuration, organizationId);
      checkAgainstCatalogues(configuration);
      const department = await departmentOf(organizationId, configuration);
      return update(organizationId, id, (current, at) => {
        // What reaches outside stays exactly as it is.
        if (!same(configuration.tools, current.configuration.tools)) bad('tools');
        if (!same(configuration.conversation, current.configuration.conversation)) {
          bad('conversation');
        }
        const write = reviseSpecialist(
          current,
          {
            fromVersion: input.fromVersion as number,
            configuration,
            department,
          },
          person.userId,
          at.toISOString() as IsoTimestamp,
        );
        return {
          ...write,
          events: [event(person, write.specialist, 'specialist.version_created', at)],
        };
      });
    },

    async setStatus(tenant, id, input) {
      const organizationId = await managerOf(tenant);
      const person = userOf(tenant);
      if (!isRecord(input)) bad('body');
      for (const key of Object.keys(input)) if (!['from', 'to'].includes(key)) bad(key);
      return update(organizationId, id, (current, at) => {
        const write = applySpecialistStatus(
          current,
          { from: input.from as SpecialistStatus, to: input.to as SpecialistStatus },
          at.toISOString() as IsoTimestamp,
        );
        return {
          ...write,
          events: [
            event(person, write.specialist, 'specialist.status_changed', at, {
              from: current.status,
              to: write.specialist.status,
            }),
          ],
        };
      });
    },
  } satisfies SpecialistManagement);
}
