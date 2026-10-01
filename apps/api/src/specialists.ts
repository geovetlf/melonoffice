import type { Specialist } from '@melonoffice/domain';
import { PERMISSIONS, type Permission } from '@melonoffice/rbac';
import {
  AGENT_TEMPLATES,
  agentCapabilities,
  autonomyOf,
  isSpecialistError,
  skillAllowedIn,
  type AgentPolicyService,
  type SkillCatalogue,
  type SpecialistError,
  type SpecialistManagement,
  type SpecialistService,
  type ToolLookup,
} from '@melonoffice/specialists';
import { toolCanRun, type ToolRegistry } from '@melonoffice/tools';
import type { Context, Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

/**
 * Specialist routes (ADR-0025, ADR-0062). Tenancy picks the organization from the caller's
 * membership, RBAC checks the permission, and only then are specialists read or changed, from the
 * resolved tenant. A specialist of another organization answers exactly like one that does not
 * exist. Reading is `specialist.read`; creating an agent from a template, changing its
 * configuration and its status is `specialist.manage`, which the management service checks again.
 * No route runs an agent.
 */
export function registerSpecialistRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & {
    readonly specialists: SpecialistService;
    readonly management: SpecialistManagement;
    readonly skills: SkillCatalogue;
    readonly tools: ToolRegistry;
    /** The organization's rules for its agents (AE-4.4). Absent: its routes are not served. */
    readonly agentPolicies?: AgentPolicyService;
  },
): void {
  const { specialists, management, skills, authorization, agentPolicies } = dependencies;
  const tools = toolLookupOf(dependencies.tools);

  app.get(
    '/v1/organizations/:organizationId/agents/catalogue',
    withPermission('specialist.read', dependencies, async (c) =>
      c.json({
        templates: AGENT_TEMPLATES.map((t) => ({
          id: t.id,
          departmentTypeId: t.departmentTypeId,
          nameKey: t.nameKey,
          role: { id: t.mainRoleId, version: t.roleVersion },
          purpose: t.purpose,
          skills: t.skills.map(({ id, version }) => ({ id, version })),
        })),
        skills: skills.list().map((s) => ({
          id: s.id,
          version: s.version,
          nameKey: s.nameKey,
          descriptionKey: s.descriptionKey,
          tools: s.tools.map((t) => ({ id: t.id, versions: [...t.versions] })),
          actions: [...s.actions],
          reads: [...s.reads],
        })),
      }),
    ),
  );

  app.post(
    '/v1/organizations/:organizationId/specialists',
    withPermission('specialist.manage', dependencies, async (c, tenant) =>
      answer(c, 201, async () => management.create(tenant, await bodyOf(c))),
    ),
  );

  app.patch(
    '/v1/organizations/:organizationId/specialists/:specialistId',
    withPermission('specialist.manage', dependencies, async (c, tenant) =>
      answer(c, 200, async () =>
        management.revise(tenant, c.req.param('specialistId') ?? '', await bodyOf(c)),
      ),
    ),
  );

  app.post(
    '/v1/organizations/:organizationId/specialists/:specialistId/status',
    withPermission('specialist.manage', dependencies, async (c, tenant) =>
      answer(c, 200, async () =>
        management.setStatus(tenant, c.req.param('specialistId') ?? '', await bodyOf(c)),
      ),
    ),
  );

  // A newer version of one of the agent's skills, only when a person asks (ADR-0084).
  app.post(
    '/v1/organizations/:organizationId/specialists/:specialistId/skills/upgrade',
    withPermission('specialist.manage', dependencies, async (c, tenant) =>
      answer(c, 200, async () =>
        management.upgradeSkill(tenant, c.req.param('specialistId') ?? '', await bodyOf(c)),
      ),
    ),
  );

  app.post(
    '/v1/organizations/:organizationId/specialists/:specialistId/autonomy',
    withPermission('specialist.manage', dependencies, async (c, tenant) =>
      answer(c, 200, async () =>
        management.setAutonomy(tenant, c.req.param('specialistId') ?? '', await bodyOf(c)),
      ),
    ),
  );

  // The organization's rules for its agents (AE-4.4, ADR-0116): what else it counts as
  // sensitive, and the furthest any of its agents acts on its own.
  if (agentPolicies !== undefined) {
    const policyAnswer = async (c: Context<AuthEnv>, run: () => Promise<unknown>) => {
      try {
        return c.json(await run());
      } catch (error) {
        const status = isSpecialistError(error) ? STATUS[error.code] : undefined;
        if (status === undefined || !isSpecialistError(error)) throw error;
        return c.json(
          {
            error: error.code,
            ...(error.code === 'invalid_specialist' && error.detail !== undefined
              ? { field: error.detail }
              : {}),
          },
          status,
        );
      }
    };
    app.get(
      '/v1/organizations/:organizationId/agent-policy',
      withPermission('specialist.read', dependencies, async (c, tenant) =>
        policyAnswer(c, () => agentPolicies.read(tenant)),
      ),
    );
    app.put(
      '/v1/organizations/:organizationId/agent-policy',
      withPermission('specialist.manage', dependencies, async (c, tenant) =>
        policyAnswer(c, async () => agentPolicies.change(tenant, await bodyOf(c))),
      ),
    );
  }

  app.get(
    '/v1/organizations/:organizationId/specialists/:specialistId/capabilities',
    withPermission('specialist.read', dependencies, async (c, tenant) => {
      try {
        const specialist = await specialists.get(tenant, c.req.param('specialistId') ?? '');
        // What the caller holds: the agent acts for a person, never beyond what they may do.
        const held = new Set(
          (Object.keys(PERMISSIONS) as Permission[]).filter(
            (p) => authorization.authorize(tenant, p).allowed,
          ),
        );
        const found = agentCapabilities(specialist, { skills, tools, held });
        // A newer version of a skill the agent has: only a person moves it there (ADR-0084).
        // Only one its department may have (ADR-0104).
        const upgrades = specialist.configuration.skills.flatMap(({ id, version }) => {
          const latest = Math.max(
            ...skills
              .list()
              .filter(
                (s) => s.id === id && skillAllowedIn(s, specialist.configuration.departmentId),
              )
              .map((s) => s.version),
          );
          return latest > version ? [{ skillId: id, from: version, to: latest }] : [];
        });
        return c.json({
          id: specialist.identity.id,
          version: specialist.version,
          // How far it acts on its own (AE-4.4): a person with specialist.manage changes it.
          autonomy: autonomyOf(specialist.configuration),
          ...found,
          upgrades,
        });
      } catch (error) {
        if (isSpecialistError(error) && error.code === 'specialist_not_found') {
          return c.json({ error: 'specialist_not_found' }, 404);
        }
        throw error;
      }
    }),
  );

  app.get(
    '/v1/organizations/:organizationId/specialists',
    withPermission('specialist.read', dependencies, async (c, tenant) => {
      // One page (AE-4, ADR-0115) when the caller asks for one; without any of these parameters
      // the answer is the whole list, exactly as before, for the screens that still read it so.
      const params = Object.fromEntries(
        PAGE_PARAMS.map((name) => [name, c.req.query(name)] as const).filter(
          ([, value]) => value !== undefined,
        ),
      );
      if (Object.keys(params).length === 0) {
        return c.json({ specialists: (await specialists.list(tenant)).map(toSpecialistView) });
      }
      try {
        const page = await specialists.page(tenant, params);
        return c.json({
          specialists: page.items.map(toSpecialistView),
          nextCursor: page.nextCursor,
        });
      } catch (error) {
        if (isSpecialistError(error) && error.code === 'invalid_specialist') {
          return c.json({ error: error.code, field: error.detail ?? null }, 400);
        }
        throw error;
      }
    }),
  );

  app.get(
    '/v1/organizations/:organizationId/specialists/:specialistId',
    withPermission('specialist.read', dependencies, async (c, tenant) => {
      try {
        const specialist = await specialists.get(tenant, c.req.param('specialistId') ?? '');
        return c.json(toSpecialistView(specialist));
      } catch (error) {
        if (isSpecialistError(error) && error.code === 'specialist_not_found') {
          return c.json({ error: 'specialist_not_found' }, 404);
        }
        throw error;
      }
    }),
  );
}

/**
 * The public view: who the specialist is, where it works, its role, skills and version. Its
 * tools, required permissions and policies are internal execution configuration and are not
 * shown, nor are its creator, revision or storage details.
 */
export function toSpecialistView(specialist: Specialist) {
  const { identity, configuration } = specialist;
  return {
    id: identity.id,
    departmentId: configuration.departmentId,
    displayName: identity.displayName,
    avatar: identity.avatar ?? null,
    status: specialist.status,
    version: specialist.version,
    role: { id: configuration.mainRoleId, version: configuration.roleVersion },
    purpose: configuration.purpose ?? null,
    description: configuration.description ?? null,
    capabilities: [...configuration.capabilities],
    skills: configuration.skills.map(({ id, version }) => ({ id, version })),
    // How far it acts on its own (AE-4.4, ADR-0116): the default when it names none.
    autonomy: autonomyOf(configuration),
    createdAt: identity.createdAt,
    updatedAt: specialist.updatedAt,
    // Who last changed its status, when and why (AE-4): the person decided it, so it is shown.
    lastStatusChange:
      specialist.lastStatusChange === undefined
        ? null
        : {
            from: specialist.lastStatusChange.from,
            to: specialist.lastStatusChange.to,
            at: specialist.lastStatusChange.at,
            by: specialist.lastStatusChange.by,
            reason: specialist.lastStatusChange.reason ?? null,
          },
  };
}

/** What the capabilities resolver needs of a tool, from the one registry the tool gate uses. */
export const toolLookupOf =
  (registry: ToolRegistry): ToolLookup =>
  (id, version) => {
    const found = registry.resolve(id, version);
    if (found === undefined) return undefined;
    return {
      riskLevel: found.version.riskLevel,
      approval: found.version.approvalPolicy,
      permissions: found.version.permissions,
      active: toolCanRun(found.definition.status),
    };
  };

/** The query parameters of one page of agents (AE-4). */
const PAGE_PARAMS = [
  'limit',
  'cursor',
  'status',
  'departmentId',
  'q',
  'skill',
  'autonomy',
] as const;

const bodyOf = async (c: Context<AuthEnv>): Promise<Record<string, unknown>> => {
  const body: unknown = await c.req.json().catch(() => undefined);
  return (
    typeof body === 'object' && body !== null && !Array.isArray(body) ? body : null
  ) as Record<string, unknown>;
};

const STATUS: Partial<Record<SpecialistError['code'], 400 | 403 | 404 | 409>> = {
  invalid_specialist: 400,
  department_not_assignable: 400,
  permission_denied: 403,
  unresolved_tenant: 403,
  organization_inactive: 409,
  specialist_not_found: 404,
  invalid_specialist_transition: 409,
  specialist_archived: 409,
  specialist_concurrency_conflict: 409,
  specialist_not_ready: 409,
};

async function answer(
  c: Context<AuthEnv>,
  ok: 200 | 201,
  run: () => Promise<Specialist>,
): Promise<Response> {
  try {
    return c.json(toSpecialistView(await run()), ok);
  } catch (error) {
    const status = isSpecialistError(error) ? STATUS[error.code] : undefined;
    if (status === undefined || !isSpecialistError(error)) throw error;
    return c.json(
      {
        error: error.code,
        ...(error.code === 'invalid_specialist' && error.detail !== undefined
          ? { field: error.detail }
          : {}),
        // What stops activation, each a stable code a screen explains (AE-4).
        ...(error.code === 'specialist_not_ready' ? { problems: error.problems ?? [] } : {}),
      },
      status,
    );
  }
}
