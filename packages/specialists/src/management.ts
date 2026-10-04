import { actorOf, buildAuditEvent, type AuditEvent } from '@melonoffice/audit';
import {
  acceptsAssignments,
  activeOrganizationOf,
  departmentIdOf,
  isDepartmentError,
  type DepartmentRepository,
} from '@melonoffice/departments';
import type {
  DefinitionRef,
  IsoTimestamp,
  OrganizationId,
  PolicyId,
  Specialist,
  SpecialistConfiguration,
  SpecialistId,
  SpecialistStatus,
} from '@melonoffice/domain';
import { PERMISSIONS, type AuthorizationService, type Permission } from '@melonoffice/rbac';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import type { ToolLookup } from './capabilities.js';
import { SpecialistError } from './errors.js';
import {
  applySpecialistStatus,
  autonomyOf,
  checkConfiguration,
  checkStatusReason,
  AGENT_PROFILE_FIELDS,
  AGENT_WORK_SETTINGS,
  type AgentProfileField,
  isAgentAutonomy,
  isSpecialistId,
  isVersionNumber,
  newSpecialist,
  reviseSpecialist,
  type SpecialistWrite,
  workSettingsOf,
} from './model.js';
import { agentReadiness } from './readiness.js';
import type { SpecialistRepository } from './repository.js';
import { grantsOf, skillAllowedIn, toolKey, type SkillCatalogue } from './skills.js';
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
  /**
   * Moves one of the agent's skills to a newer version of the catalogue, as a new version of the
   * agent: `{ fromVersion, skillId, version }` (ADR-0084). The tools the new version grants at one
   * exact version are assigned, the tools no skill grants any more are removed, and the
   * permissions they need are listed. It is the only way an agent gains what a newer skill
   * version grants: nothing is upgraded by itself.
   */
  upgradeSkill(
    tenant: TenantContext,
    id: string,
    input: Record<string, unknown>,
  ): Promise<Specialist>;
  /**
   * Changes how far the agent acts on its own, as a new version of the agent:
   * `{ fromVersion, autonomy }` (AE-4.4, ADR-0116). It grants nothing: the agent's skills, tools
   * and permissions stay exactly as they are, and sensitive actions still wait on a person.
   */
  setAutonomy(
    tenant: TenantContext,
    id: string,
    input: Record<string, unknown>,
  ): Promise<Specialist>;
  /**
   * Switches the agent's work settings on or off, as a new version of the agent:
   * `{ fromVersion, memory?, aiVerification?, collaboration? }` (ADR-0117). It grants nothing.
   */
  setWorkSettings(
    tenant: TenantContext,
    id: string,
    input: Record<string, unknown>,
  ): Promise<Specialist>;
  /**
   * Changes what the agent is for, in a person's words, as a new version of the agent:
   * `{ fromVersion, purpose?, description? }`, each a text or `null` to clear it (ADR-0140). The
   * server keeps the rest of the configuration as it is, so a browser never sends or sees the
   * agent's tools, permissions, policies or conversation. It grants nothing.
   */
  setProfile(
    tenant: TenantContext,
    id: string,
    input: Record<string, unknown>,
  ): Promise<Specialist>;
}

/** Why an agent's work in progress was stopped (AE-4): the code its executions are cancelled with. */
export type SpecialistStopReason = 'agent_paused' | 'agent_disabled' | 'agent_archived';

export const STOP_REASON_OF: Readonly<Partial<Record<SpecialistStatus, SpecialistStopReason>>> =
  Object.freeze({
    paused: 'agent_paused',
    disabled: 'agent_disabled',
    archived: 'agent_archived',
  });

/**
 * Stops the work an agent has in progress once it stops (AE-4, ADR-0115), the way a person's
 * cancellation does (ADR-0029): cooperative, nothing is killed, a late result is discarded. It
 * never throws: whatever it could not stop is still stopped at its next step, where the Harness
 * finds the agent is no longer active and no model is asked.
 */
export interface SpecialistWorkStop {
  stop(
    tenant: TenantContext,
    specialistId: SpecialistId,
    reason: SpecialistStopReason,
  ): Promise<{ readonly cancelled: number; readonly more: boolean }>;
}

export interface SpecialistManagementOptions {
  readonly repository: SpecialistRepository;
  readonly departments: DepartmentRepository;
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  readonly skills: SkillCatalogue;
  readonly tools: ToolLookup;
  /** Whether the AI Gateway knows a model policy (activation readiness). Absent: not checked. */
  readonly modelPolicyKnown?: (ref: DefinitionRef<PolicyId>) => boolean;
  /** Stops the agent's work in progress when it is paused, disabled or archived (AE-4). */
  readonly work?: SpecialistWorkStop;
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
  const { modelPolicyKnown, work } = options;
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
    action:
      | 'specialist.created'
      | 'specialist.version_created'
      | 'specialist.status_changed'
      | 'specialist.autonomy_changed'
      | 'specialist.settings_changed',
    at: Date,
    transition?: { readonly from: string; readonly to: string },
    reason?: string,
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
        ...(reason === undefined ? {} : { reason }),
        ...(requestId === undefined ? {} : { requestId }),
        source: 'api',
      },
      at,
    );

  /**
   * The catalogues' rules on top of `checkConfiguration`: known skills and tools; every tool a
   * skill uses assigned, at one of the versions it grants; every tool assigned granted by one of
   * the agent's skills at that exact version (SK-1, ADR-0069); and every permission its skills
   * and tools need listed, so that eligibility (which checks the listed ones) checks them all.
   */
  function checkAgainstCatalogues(configuration: SpecialistConfiguration): void {
    const assigned = new Set(configuration.tools.map((t) => toolKey(t.id, t.version)));
    const listed = new Set(configuration.permissions);
    for (const { id, version } of configuration.skills) {
      const found = skills.resolve(id, version);
      if (found === undefined) bad('skills.unknown');
      // A skill for some departments only (ADR-0104) is never given to an agent of another.
      if (found !== undefined && !skillAllowedIn(found, configuration.departmentId)) {
        bad('skills.department');
      }
      for (const grant of found?.tools ?? []) {
        if (!grant.versions.some((v) => assigned.has(toolKey(grant.id, v)))) bad('skills.tools');
      }
      for (const permission of found?.reads ?? []) if (!listed.has(permission)) bad('permissions');
    }
    const granted = grantsOf(configuration.skills, skills).tools;
    for (const { id, version } of configuration.tools) {
      const found = tools(id, version);
      if (found === undefined) bad('tools.unknown');
      if (!granted.has(toolKey(id, version))) bad('tools.not_granted');
      for (const permission of found?.permissions ?? []) {
        if (!listed.has(permission)) bad('permissions');
      }
    }
  }

  /**
   * What skills give an agent without a person choosing: each tool a skill grants at one exact
   * version (a grant at several versions, like the reply's supervised or autonomous one, is a
   * person's choice and is never made here), and the permissions the skills read and those tools
   * need.
   */
  function derivedFrom(refs: SpecialistConfiguration['skills']) {
    const assigned: { id: string; version: number }[] = [];
    const permissions = new Set<string>();
    for (const ref of refs) {
      const found = skills.resolve(ref.id, ref.version);
      for (const permission of found?.reads ?? []) permissions.add(permission);
      for (const grant of found?.tools ?? []) {
        const [version] = grant.versions;
        if (grant.versions.length !== 1 || version === undefined) continue;
        assigned.push({ id: grant.id, version });
        for (const permission of tools(grant.id, version)?.permissions ?? []) {
          permissions.add(permission);
        }
      }
    }
    return { tools: assigned, permissions };
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
      const derived = derivedFrom(template.skills);
      const configuration = checkConfiguration(
        {
          departmentId: departmentIdOf(organizationId, template.departmentTypeId),
          mainRoleId: template.mainRoleId,
          roleVersion: template.roleVersion,
          purpose: template.purpose[locale],
          capabilities: [],
          skills: template.skills,
          tools: derived.tools,
          permissions: [...derived.permissions].sort(),
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
        // Autonomy changes only through `setAutonomy`, its own audited step; omitted, it is kept.
        const autonomy = current.configuration.autonomy;
        if (configuration.autonomy !== undefined && configuration.autonomy !== autonomy) {
          bad('autonomy');
        }
        // So do the work settings, through `setWorkSettings` (ADR-0117).
        const work = current.configuration.work;
        if (configuration.work !== undefined && !same(configuration.work, work)) bad('work');
        const write = reviseSpecialist(
          current,
          {
            fromVersion: input.fromVersion as number,
            configuration: Object.freeze({
              ...configuration,
              ...(autonomy === undefined ? {} : { autonomy }),
              ...(work === undefined ? {} : { work }),
            }),
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

    async upgradeSkill(tenant, id, input) {
      const organizationId = await managerOf(tenant);
      const person = userOf(tenant);
      if (!isRecord(input)) bad('body');
      for (const key of Object.keys(input)) {
        if (!['fromVersion', 'skillId', 'version'].includes(key)) bad(key);
      }
      if (!isVersionNumber(input.fromVersion)) bad('fromVersion');
      if (typeof input.skillId !== 'string') bad('skillId');
      if (!isVersionNumber(input.version)) bad('version');
      const target = skills.resolve(input.skillId as string, input.version as number);
      if (target === undefined) return bad('version');
      if (!isSpecialistId(id)) throw new SpecialistError('specialist_not_found');
      const read = await repository.find(organizationId, id);
      if (read === undefined) throw new SpecialistError('specialist_not_found');
      const department = await departmentOf(organizationId, read.configuration);
      return update(organizationId, id, (current, at) => {
        const { configuration } = current;
        const held = configuration.skills.find((s) => s.id === target.id);
        // Only forward, and only a skill the agent already has: a new skill is a revision.
        if (held === undefined) bad('skillId');
        if ((held?.version ?? 0) >= target.version) bad('version');
        if (configuration.departmentId !== read.configuration.departmentId) bad('departmentId');
        const nextSkills = configuration.skills.map((s) =>
          s.id === target.id ? { id: target.id, version: target.version } : s,
        );
        const granted = grantsOf(nextSkills, skills).tools;
        const derived = derivedFrom(nextSkills);
        const kept = configuration.tools.filter((t) => granted.has(toolKey(t.id, t.version)));
        const keptKeys = new Set(kept.map((t) => toolKey(t.id, t.version)));
        const added = derived.tools.filter((t) => !keptKeys.has(toolKey(t.id, t.version)));
        const next = checkConfiguration(
          {
            ...configuration,
            skills: nextSkills,
            tools: [...kept, ...added],
            permissions: [
              ...new Set([...configuration.permissions, ...derived.permissions]),
            ].sort(),
          },
          organizationId,
        );
        checkAgainstCatalogues(next);
        const write = reviseSpecialist(
          current,
          { fromVersion: input.fromVersion as number, configuration: next, department },
          person.userId,
          at.toISOString() as IsoTimestamp,
        );
        return {
          ...write,
          events: [event(person, write.specialist, 'specialist.version_created', at)],
        };
      });
    },

    async setAutonomy(tenant, id, input) {
      const organizationId = await managerOf(tenant);
      const person = userOf(tenant);
      if (!isRecord(input)) bad('body');
      for (const key of Object.keys(input)) {
        if (!['fromVersion', 'autonomy'].includes(key)) bad(key);
      }
      if (!isVersionNumber(input.fromVersion)) bad('fromVersion');
      if (!isAgentAutonomy(input.autonomy)) return bad('autonomy');
      const level = input.autonomy;
      if (!isSpecialistId(id)) throw new SpecialistError('specialist_not_found');
      const read = await repository.find(organizationId, id);
      if (read === undefined) throw new SpecialistError('specialist_not_found');
      const department = await departmentOf(organizationId, read.configuration);
      return update(organizationId, id, (current, at) => {
        const before = autonomyOf(current.configuration);
        // Nothing to change is a mistake, not a new version.
        if (before === level) bad('autonomy');
        const write = reviseSpecialist(
          current,
          {
            fromVersion: input.fromVersion as number,
            configuration: Object.freeze({ ...current.configuration, autonomy: level }),
            department,
          },
          person.userId,
          at.toISOString() as IsoTimestamp,
        );
        return {
          ...write,
          events: [
            event(person, write.specialist, 'specialist.autonomy_changed', at, {
              from: before,
              to: level,
            }),
          ],
        };
      });
    },

    async setProfile(tenant, id, input) {
      const organizationId = await managerOf(tenant);
      const person = userOf(tenant);
      if (!isRecord(input)) bad('body');
      const changes: [AgentProfileField, string | null][] = [];
      for (const [key, value] of Object.entries(input)) {
        if (key === 'fromVersion') continue;
        if (!(AGENT_PROFILE_FIELDS as readonly string[]).includes(key)) bad(key);
        if (value !== null && typeof value !== 'string') bad(key);
        // An empty text clears the field, like `null`.
        const text = typeof value === 'string' && value.trim() !== '' ? value : null;
        changes.push([key as AgentProfileField, text]);
      }
      if (!isVersionNumber(input.fromVersion)) bad('fromVersion');
      if (changes.length === 0) bad('profile');
      if (!isSpecialistId(id)) throw new SpecialistError('specialist_not_found');
      const read = await repository.find(organizationId, id);
      if (read === undefined) throw new SpecialistError('specialist_not_found');
      const department = await departmentOf(organizationId, read.configuration);
      return update(organizationId, id, (current, at) => {
        const cleared = new Set(changes.filter(([, v]) => v === null).map(([k]) => k));
        const rest = Object.fromEntries(
          Object.entries(current.configuration).filter(
            ([key]) => !cleared.has(key as AgentProfileField),
          ),
        );
        // Only the profile changes; the same checks as any version (length, control characters).
        const next = checkConfiguration(
          {
            ...rest,
            ...Object.fromEntries(changes.filter(([, v]) => v !== null)),
          },
          organizationId,
        );
        if (next.departmentId !== read.configuration.departmentId) bad('departmentId');
        const write = reviseSpecialist(
          current,
          { fromVersion: input.fromVersion as number, configuration: next, department },
          person.userId,
          at.toISOString() as IsoTimestamp,
        );
        return {
          ...write,
          events: [event(person, write.specialist, 'specialist.version_created', at)],
        };
      });
    },

    async setWorkSettings(tenant, id, input) {
      const organizationId = await managerOf(tenant);
      const person = userOf(tenant);
      if (!isRecord(input)) bad('body');
      const changes: [string, boolean][] = [];
      for (const [key, value] of Object.entries(input)) {
        if (key === 'fromVersion') continue;
        if (!(AGENT_WORK_SETTINGS as readonly string[]).includes(key)) bad(key);
        if (typeof value !== 'boolean') bad(key);
        changes.push([key, value as boolean]);
      }
      if (!isVersionNumber(input.fromVersion)) bad('fromVersion');
      if (changes.length === 0) bad('work');
      if (!isSpecialistId(id)) throw new SpecialistError('specialist_not_found');
      const read = await repository.find(organizationId, id);
      if (read === undefined) throw new SpecialistError('specialist_not_found');
      const department = await departmentOf(organizationId, read.configuration);
      return update(organizationId, id, (current, at) => {
        const before = workSettingsOf(current.configuration);
        const after = Object.freeze({ ...before, ...Object.fromEntries(changes) });
        // Nothing to change is a mistake, not a new version.
        if (AGENT_WORK_SETTINGS.every((s) => before[s] === after[s])) bad('work');
        // Only what is on is stored: an agent with everything off reads like one from before.
        const on = Object.fromEntries(
          AGENT_WORK_SETTINGS.filter((s) => after[s]).map((s) => [s, true]),
        );
        const rest = Object.fromEntries(
          Object.entries(current.configuration).filter(([key]) => key !== 'work'),
        ) as unknown as SpecialistConfiguration;
        const write = reviseSpecialist(
          current,
          {
            fromVersion: input.fromVersion as number,
            configuration: Object.freeze(
              Object.keys(on).length === 0 ? rest : { ...rest, work: Object.freeze(on) },
            ),
            department,
          },
          person.userId,
          at.toISOString() as IsoTimestamp,
        );
        // As audit codes: `memory_and_ai_verification`, or `none` with everything off.
        const codes = (settings: Readonly<Record<string, boolean>>) =>
          AGENT_WORK_SETTINGS.filter((s) => settings[s])
            .map((s) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`))
            .join('_and_') || 'none';
        return {
          ...write,
          events: [
            event(person, write.specialist, 'specialist.settings_changed', at, {
              from: codes(before),
              to: codes(after),
            }),
          ],
        };
      });
    },

    async setStatus(tenant, id, input) {
      const organizationId = await managerOf(tenant);
      const person = userOf(tenant);
      if (!isRecord(input)) bad('body');
      for (const key of Object.keys(input)) {
        if (!['from', 'to', 'reason'].includes(key)) bad(key);
      }
      const to = input.to as SpecialistStatus;
      // Disabling is the strong stop: who, when and why are kept, so a reason is required.
      if (to === 'disabled' && checkStatusReason(input.reason) === undefined) bad('reason');
      // Activation readiness (AE-4): what the first task would find missing is refused now, with
      // every problem named. Read before the write; the write checks the status did not move.
      if (to === 'active') {
        if (!isSpecialistId(id)) throw new SpecialistError('specialist_not_found');
        const read = await repository.find(organizationId, id);
        if (read === undefined) throw new SpecialistError('specialist_not_found');
        const department = await departments.find(organizationId, read.configuration.departmentId);
        const held = new Set<string>(
          (Object.keys(PERMISSIONS) as Permission[]).filter(
            (p) => authorization.authorize(tenant, p).allowed,
          ),
        );
        const readiness = agentReadiness(read, {
          skills,
          tools,
          held,
          departmentActive: department !== undefined && acceptsAssignments(department),
          ...(modelPolicyKnown === undefined ? {} : { modelPolicyKnown }),
        });
        if (!readiness.ready) {
          throw new SpecialistError('specialist_not_ready', undefined, readiness.problems);
        }
      }
      const updated = await update(organizationId, id, (current, at) => {
        const write = applySpecialistStatus(
          current,
          { from: input.from as SpecialistStatus, to, reason: input.reason },
          at.toISOString() as IsoTimestamp,
          person.userId,
        );
        return {
          ...write,
          events: [
            event(
              person,
              write.specialist,
              'specialist.status_changed',
              at,
              { from: current.status, to: write.specialist.status },
              // The person's words stay on the specialist; the audit log never holds free text.
              write.specialist.lastStatusChange?.reason === undefined ? undefined : 'reason_given',
            ),
          ],
        };
      });
      // Its work in progress stops with it (AE-4): after the status is stored, so nothing new
      // can start in between, and never undoing the change if stopping fails.
      const reason = STOP_REASON_OF[updated.status];
      if (reason !== undefined && work !== undefined) {
        await work.stop(tenant, updated.identity.id, reason);
      }
      return updated;
    },
  } satisfies SpecialistManagement);
}
