import {
  activeOrganizationOf,
  isDepartmentError,
  isDepartmentId,
  type DepartmentRepository,
} from '@melonoffice/departments';
import type { Specialist, SpecialistVersion } from '@melonoffice/domain';
import { ExecutionError, type AssignmentGuard } from '@melonoffice/execution';
import type { AuthorizationService } from '@melonoffice/rbac';
import type { TenancyStore, TenantContext } from '@melonoffice/tenancy';
import {
  decideEligibility,
  type EligibilityDecision,
  type EligibilityRequest,
} from './eligibility.js';
import { SpecialistError } from './errors.js';
import { checkAgentListQuery, pageOfAgents, type AgentListPage } from './listing.js';
import { isSpecialistId, isVersionNumber } from './model.js';
import type { SpecialistRepository } from './repository.js';

/**
 * Specialists of an organization (ADR-0025). Every method works on the organization of a
 * resolved `TenantContext`, never on an id the caller passes. It reads and decides; it runs
 * nothing, and there is no route that creates, changes or runs a specialist yet.
 */
/** How many of an agent's versions its history shows (ADR-0142). */
export const AGENT_HISTORY_LIMIT = 20;

export interface SpecialistService {
  list(tenant: TenantContext): Promise<readonly Specialist[]>;
  /**
   * One page of the organization's agents (AE-4): `limit`, `cursor`, `status`, `departmentId`,
   * `q` (name) and `skill`, as a list request's query parameters. Never reads every agent.
   */
  page(
    tenant: TenantContext,
    params: Readonly<Record<string, string | undefined>>,
  ): Promise<AgentListPage>;
  /** `specialist_not_found` for an unknown id or another organization's specialist alike. */
  get(tenant: TenantContext, id: string): Promise<Specialist>;
  /**
   * A page of its versions, newest first (ADR-0142): `limit` of them (at most
   * `AGENT_HISTORY_LIMIT`) older than `before`, or the most recent ones, each as it was stored and
   * never rewritten, with the version just before the oldest so its change can be told. Reads each
   * version by number, so no index is needed.
   */
  history(
    tenant: TenantContext,
    id: string,
    page?: { readonly before?: number; readonly limit?: number },
  ): Promise<{
    readonly versions: readonly SpecialistVersion[];
    readonly previous?: SpecialistVersion;
  }>;
  /** One stored version of a specialist, for rebuilding what an execution used. */
  getVersion(tenant: TenantContext, id: string, version: number): Promise<SpecialistVersion>;
  /** May this specialist take new work for this tenant? Deterministic; see `decideEligibility`. */
  eligibility(tenant: TenantContext, request: EligibilityRequest): Promise<EligibilityDecision>;
  /** The guard the execution service asks before it records an assignment. */
  readonly assignments: AssignmentGuard;
}

export interface SpecialistServiceOptions {
  readonly repository: SpecialistRepository;
  readonly departments: DepartmentRepository;
  /** Only `findOrganization` is used, to refuse inactive organizations. */
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  /** The permissions of the user a specialist would act for. */
  readonly authorization: Pick<AuthorizationService, 'permissionsOf'>;
}

export function createSpecialistService({
  repository,
  departments,
  organizations,
  authorization,
}: SpecialistServiceOptions): SpecialistService {
  async function organizationOf(tenant: TenantContext) {
    try {
      return await activeOrganizationOf(tenant, organizations);
    } catch (error) {
      if (!isDepartmentError(error)) throw error;
      throw new SpecialistError(
        error.code === 'unresolved_tenant' ? 'unresolved_tenant' : 'organization_inactive',
      );
    }
  }

  async function get(tenant: TenantContext, id: string): Promise<Specialist> {
    const organizationId = await organizationOf(tenant);
    // A malformed id cannot exist: answered like any unknown id, without a lookup.
    if (!isSpecialistId(id)) throw new SpecialistError('specialist_not_found');
    const specialist = await repository.find(organizationId, id);
    if (specialist === undefined) throw new SpecialistError('specialist_not_found');
    return specialist;
  }

  async function eligibility(
    tenant: TenantContext,
    request: EligibilityRequest,
  ): Promise<EligibilityDecision> {
    const organizationId = await organizationOf(tenant);
    const { specialistId, departmentId } = request;
    const specialist = isSpecialistId(specialistId)
      ? await repository.find(organizationId, specialistId)
      : undefined;
    const department = isDepartmentId(departmentId)
      ? await departments.find(organizationId, departmentId)
      : undefined;
    const version =
      specialist === undefined
        ? undefined
        : await repository.findVersion(organizationId, specialist.identity.id, specialist.version);
    return decideEligibility({
      request,
      specialist,
      version,
      department,
      permissions: authorization.permissionsOf(tenant),
    });
  }

  return Object.freeze({
    async list(tenant: TenantContext) {
      return repository.list(await organizationOf(tenant));
    },
    async page(tenant: TenantContext, params: Readonly<Record<string, string | undefined>>) {
      const organizationId = await organizationOf(tenant);
      return pageOfAgents(repository, organizationId, checkAgentListQuery(params, organizationId));
    },
    get,
    async history(tenant: TenantContext, id: string, page = {}) {
      const specialist = await get(tenant, id);
      const { before, limit } = page as { before?: number; limit?: number };
      const from = Math.min(specialist.version, (before ?? specialist.version + 1) - 1);
      const size = Math.max(1, Math.min(AGENT_HISTORY_LIMIT, limit ?? AGENT_HISTORY_LIMIT));
      // One more than the page: the version before the oldest, to tell what that one changed.
      const numbers = Array.from(
        { length: Math.min(size + 1, Math.max(0, from)) },
        (_, i) => from - i,
      );
      const found = await Promise.all(
        numbers.map((n) =>
          repository.findVersion(specialist.organizationId, specialist.identity.id, n),
        ),
      );
      const read = found.filter((v): v is SpecialistVersion => v !== undefined);
      const versions = read.slice(0, size);
      const previous = read[size];
      return Object.freeze({
        versions: Object.freeze(versions),
        ...(previous === undefined ? {} : { previous }),
      });
    },
    async getVersion(tenant: TenantContext, id: string, version: number) {
      const specialist = await get(tenant, id);
      const found = isVersionNumber(version)
        ? await repository.findVersion(specialist.organizationId, specialist.identity.id, version)
        : undefined;
      if (found === undefined) throw new SpecialistError('specialist_not_found');
      return found;
    },
    eligibility,
    assignments: Object.freeze({
      async confirm(tenant, assignment) {
        const decision = await eligibility(tenant, {
          specialistId: assignment.specialistId,
          departmentId: assignment.departmentId,
          version: assignment.specialistVersion,
        });
        if (!decision.eligible) {
          throw new ExecutionError('specialist_not_eligible', decision.reason);
        }
      },
    } satisfies AssignmentGuard),
  });
}
