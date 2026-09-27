import type { Department, OrganizationId } from '@melonoffice/domain';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { DepartmentError } from './errors.js';
import { isDepartmentId } from './model.js';
import type { DepartmentRepository } from './repository.js';

/**
 * Departments of an organization (ADR-0025). Every method works on the organization of a
 * resolved `TenantContext`, never on an id the caller passes. Read only: there is no route that
 * creates, changes or archives a department yet.
 */
export interface DepartmentService {
  list(tenant: TenantContext): Promise<readonly Department[]>;
  /** `department_not_found` for an unknown id or another organization's department alike. */
  get(tenant: TenantContext, id: string): Promise<Department>;
}

export interface DepartmentServiceOptions {
  readonly repository: DepartmentRepository;
  /** Only `findOrganization` is used, to refuse inactive organizations. */
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
}

/** The organization a resolved tenant may act in, or a refusal. Shared with specialists. */
export async function activeOrganizationOf(
  tenant: TenantContext,
  organizations: Pick<TenancyStore, 'findOrganization'>,
): Promise<OrganizationId> {
  if (!isResolvedTenant(tenant)) throw new DepartmentError('unresolved_tenant');
  const organization = await organizations.findOrganization(tenant.organizationId);
  if (organization?.id !== tenant.organizationId || organization.status !== 'active') {
    throw new DepartmentError('organization_inactive');
  }
  return organization.id;
}

export function createDepartmentService({
  repository,
  organizations,
}: DepartmentServiceOptions): DepartmentService {
  return Object.freeze({
    async list(tenant: TenantContext) {
      return repository.list(await activeOrganizationOf(tenant, organizations));
    },

    async get(tenant: TenantContext, id: string) {
      const organizationId = await activeOrganizationOf(tenant, organizations);
      // A malformed id cannot exist: answered like any unknown id, without a lookup.
      if (!isDepartmentId(id)) throw new DepartmentError('department_not_found');
      const department = await repository.find(organizationId, id);
      if (department === undefined) throw new DepartmentError('department_not_found');
      return department;
    },
  });
}
