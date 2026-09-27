import {
  DEFAULT_DEPARTMENT_CATALOGUE,
  isDepartmentError,
  type DepartmentCatalogue,
  type DepartmentService,
} from '@melonoffice/departments';
import type { Department } from '@melonoffice/domain';
import type { Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

/**
 * Department routes (ADR-0025). Read only: departments are created with their organization, and
 * no route changes them yet. Tenancy picks the organization from the caller's membership, RBAC
 * checks `department.read`, and only then are departments read, from the resolved tenant. A
 * department of another organization answers exactly like one that does not exist.
 */
export function registerDepartmentRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & {
    readonly departments: DepartmentService;
    readonly catalogue?: DepartmentCatalogue;
  },
): void {
  const { departments, catalogue = DEFAULT_DEPARTMENT_CATALOGUE } = dependencies;
  const view = (department: Department) => toDepartmentView(department, catalogue);

  app.get(
    '/v1/organizations/:organizationId/departments',
    withPermission('department.read', dependencies, async (c, tenant) =>
      c.json({ departments: (await departments.list(tenant)).map(view) }),
    ),
  );

  app.get(
    '/v1/organizations/:organizationId/departments/:departmentId',
    withPermission('department.read', dependencies, async (c, tenant) => {
      try {
        return c.json(view(await departments.get(tenant, c.req.param('departmentId') ?? '')));
      } catch (error) {
        if (isDepartmentError(error) && error.code === 'department_not_found') {
          return c.json({ error: 'department_not_found' }, 404);
        }
        throw error;
      }
    }),
  );
}

/**
 * The public view. A catalogue department is named by message keys, which the app translates
 * (D-17); a custom one by its own name. No revision or storage detail.
 */
export function toDepartmentView(department: Department, catalogue: DepartmentCatalogue) {
  const { origin } = department;
  const type = origin.kind === 'catalog' ? catalogue.find(origin.typeId) : undefined;
  return {
    id: department.id,
    origin: origin.kind,
    typeId: origin.kind === 'catalog' ? origin.typeId : null,
    nameKey: type?.nameKey ?? null,
    shortNameKey: type?.shortNameKey ?? null,
    name: origin.kind === 'custom' ? origin.name : null,
    status: department.status,
    purpose: department.purpose ?? null,
    description: department.description ?? null,
    createdAt: department.createdAt,
    updatedAt: department.updatedAt,
  };
}
