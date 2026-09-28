import type { Department, DepartmentId, OrganizationId } from '@melonoffice/domain';
import { checkStoredDepartment, organizationOfDepartmentId } from './model.js';

/**
 * Where departments live: Firestore in the API (ADR-0025), memory in tests. Departments are
 * created with their organization, in the same write (see `@melonoffice/tenancy`), so the port
 * only reads. Status changes arrive with the first route that makes them, together with their
 * audit events.
 */
export interface DepartmentRepository {
  /** The department, only when it belongs to the organization. Another organization's is absent. */
  find(organizationId: OrganizationId, id: DepartmentId): Promise<Department | undefined>;
  /** Every department of the organization, in any status. */
  list(organizationId: OrganizationId): Promise<readonly Department[]>;
}

/** For tests and local runs only. Receives new organizations' departments from the tenancy memory store. */
export class InMemoryDepartmentRepository implements DepartmentRepository {
  readonly #departments = new Map<string, Department>();

  async find(organizationId: OrganizationId, id: DepartmentId): Promise<Department | undefined> {
    // The id names its organization: another organization's id is absent without a lookup.
    if (organizationOfDepartmentId(id) !== organizationId) return undefined;
    const department = this.#departments.get(id);
    return department?.organizationId === organizationId
      ? checkStoredDepartment(department)
      : undefined;
  }

  async list(organizationId: OrganizationId): Promise<readonly Department[]> {
    return [...this.#departments.values()]
      .filter((d) => d.organizationId === organizationId)
      .map(checkStoredDepartment)
      .sort((a, b) => (a.id < b.id ? -1 : 1));
  }

  /** Stores a new organization's departments; refuses an id that already exists. */
  openNow(departments: readonly Department[]): void {
    for (const d of departments) {
      if (this.#departments.has(d.id)) throw new Error('department already exists');
    }
    for (const d of departments) this.#departments.set(d.id, d);
  }

  /** Test hook: every organization that holds a department here. */
  organizationIds(): readonly OrganizationId[] {
    return [...new Set([...this.#departments.values()].map((d) => d.organizationId))];
  }

  /** Test hook: stores a record as given, e.g. archived, or corrupted the way bad data would look. */
  put(department: Department): void {
    this.#departments.set(department.id, department);
  }
}
