import type { Specialist } from '@melonoffice/domain';
import { isSpecialistError, type SpecialistService } from '@melonoffice/specialists';
import type { Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

/**
 * Specialist routes (ADR-0025). Read only: there is no route that creates, changes or runs a
 * specialist yet. Tenancy picks the organization from the caller's membership, RBAC checks
 * `specialist.read`, and only then are specialists read, from the resolved tenant. A specialist
 * of another organization answers exactly like one that does not exist.
 */
export function registerSpecialistRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & { readonly specialists: SpecialistService },
): void {
  const { specialists } = dependencies;

  app.get(
    '/v1/organizations/:organizationId/specialists',
    withPermission('specialist.read', dependencies, async (c, tenant) =>
      c.json({ specialists: (await specialists.list(tenant)).map(toSpecialistView) }),
    ),
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
    createdAt: identity.createdAt,
    updatedAt: specialist.updatedAt,
  };
}
