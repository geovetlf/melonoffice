import { acceptsAssignments } from '@melonoffice/departments';
import type { Department, Specialist, SpecialistVersion, VersionRef } from '@melonoffice/domain';
import type { SpecialistAssignment } from '@melonoffice/execution';
import { canTakeNewWork } from './lifecycle.js';
import { sameConfiguration } from './model.js';

/** What a caller asks: may this specialist, in this department, take new work? */
export interface EligibilityRequest {
  readonly specialistId: string;
  readonly departmentId: string;
  /** The version the caller means. Absent: the current one. */
  readonly version?: number;
}

/**
 * Why a specialist is not eligible. `specialist_not_found` covers another organization's
 * specialist too, so the answer never reveals that one exists.
 */
export type IneligibleReason =
  | 'specialist_not_found'
  | 'specialist_not_active'
  | 'department_mismatch'
  | 'department_not_active'
  | 'version_not_current'
  | 'version_not_found'
  | 'permission_not_held';

export type EligibilityDecision =
  | {
      readonly eligible: true;
      readonly assignment: SpecialistAssignment;
      /**
       * The versions to record in the execution's version snapshot (ADR-0024): the specialist
       * version, its main role and its skills, tools and policies, as that version names them.
       */
      readonly components: readonly VersionRef[];
    }
  | { readonly eligible: false; readonly reason: IneligibleReason };

/** What the decision is made from, all read for the tenant's own organization. */
export interface EligibilityFacts {
  readonly request: EligibilityRequest;
  readonly specialist: Specialist | undefined;
  readonly version: SpecialistVersion | undefined;
  readonly department: Department | undefined;
  /** The permissions the tenant's user holds (RBAC `permissionsOf`). */
  readonly permissions: ReadonlySet<string>;
}

const no = (reason: IneligibleReason): EligibilityDecision =>
  Object.freeze({ eligible: false, reason });

/**
 * The deterministic eligibility rule (ADR-0025). No AI and no matching: a specialist is eligible
 * only when every check holds, in this order:
 *
 * 1. it exists in the tenant's organization;
 * 2. it is `active` (draft, paused, disabled and archived are not);
 * 3. it belongs to the requested department;
 * 4. that department exists in the organization and is `active`;
 * 5. the requested version is the current one, and that version is stored as the specialist says;
 * 6. the user it would act for holds every permission the version needs (D-25).
 */
export function decideEligibility(facts: EligibilityFacts): EligibilityDecision {
  const { request, specialist, version, department, permissions } = facts;
  if (specialist === undefined || specialist.identity.id !== request.specialistId) {
    return no('specialist_not_found');
  }
  if (!canTakeNewWork(specialist.status)) return no('specialist_not_active');
  if (specialist.configuration.departmentId !== request.departmentId) {
    return no('department_mismatch');
  }
  if (
    department === undefined ||
    department.id !== request.departmentId ||
    department.organizationId !== specialist.organizationId ||
    !acceptsAssignments(department)
  ) {
    return no('department_not_active');
  }
  if (request.version !== undefined && request.version !== specialist.version) {
    return no('version_not_current');
  }
  if (
    version === undefined ||
    version.specialistId !== specialist.identity.id ||
    version.organizationId !== specialist.organizationId ||
    version.version !== specialist.version ||
    !sameConfiguration(version.configuration, specialist.configuration)
  ) {
    return no('version_not_found');
  }
  const { configuration } = version;
  if (!configuration.permissions.every((p) => permissions.has(p))) {
    return no('permission_not_held');
  }
  const ref = (kind: string, id: string, v: number): VersionRef =>
    Object.freeze({ kind, id, version: String(v) });
  const components = [
    ref('specialist', specialist.identity.id, version.version),
    ref('role', configuration.mainRoleId, configuration.roleVersion),
    ...configuration.skills.map((s) => ref('skill', s.id, s.version)),
    ...configuration.tools.map((t) => ref('tool', t.id, t.version)),
    ...Object.entries(configuration.policies).map(([kind, p]) =>
      ref(`${kind}_policy`, p.id, p.version),
    ),
  ];
  return Object.freeze({
    eligible: true,
    assignment: Object.freeze({
      specialistId: specialist.identity.id,
      specialistVersion: version.version,
      departmentId: department.id,
    }),
    components: Object.freeze(components),
  });
}
