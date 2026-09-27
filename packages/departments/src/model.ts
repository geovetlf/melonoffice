import type {
  Department,
  DepartmentId,
  DepartmentStatus,
  DepartmentTypeId,
  IsoTimestamp,
  Organization,
  OrganizationId,
} from '@melonoffice/domain';
import { isOrganizationId } from '@melonoffice/tenancy';
import type { DepartmentCatalogue } from './catalogue.js';
import { isDepartmentTypeId } from './catalogue.js';
import { DepartmentError } from './errors.js';

export const DEPARTMENT_STATUSES = [
  'active',
  'paused',
  'archived',
] as const satisfies readonly DepartmentStatus[];

/**
 * Allowed status changes (ADR-0025). `archived` is final: the department stays as history and is
 * never deleted.
 */
export const DEPARTMENT_TRANSITIONS: Readonly<
  Record<DepartmentStatus, readonly DepartmentStatus[]>
> = Object.freeze({
  active: Object.freeze(['paused', 'archived'] as const),
  paused: Object.freeze(['active', 'archived'] as const),
  archived: Object.freeze([] as const),
});

export const isDepartmentStatus = (value: unknown): value is DepartmentStatus =>
  typeof value === 'string' && (DEPARTMENT_STATUSES as readonly string[]).includes(value);

/** Only an active department takes new specialists or new work. */
export const acceptsAssignments = (department: Department): boolean =>
  department.status === 'active';

export const MAX_TEXT_LENGTH = 500;
export const MAX_NAME_LENGTH = 100;

/**
 * A catalogue department's id is derived from its organization and type, so an organization can
 * never hold two departments of one type, and provisioning twice creates nothing new.
 */
export const departmentIdOf = (
  organizationId: OrganizationId,
  typeId: DepartmentTypeId,
): DepartmentId => `${organizationId}_${typeId}` as DepartmentId;

/**
 * Whether a value can be a department id at all, and of which organization. It says nothing about
 * access: it only keeps arbitrary strings away from storage lookups.
 */
export function organizationOfDepartmentId(value: unknown): OrganizationId | undefined {
  if (typeof value !== 'string') return undefined;
  const separator = value.indexOf('_');
  const organizationId = value.slice(0, separator);
  if (separator < 0 || !isOrganizationId(organizationId)) return undefined;
  return isDepartmentTypeId(value.slice(separator + 1)) ? organizationId : undefined;
}

export const isDepartmentId = (value: unknown): value is DepartmentId =>
  organizationOfDepartmentId(value) !== undefined;

const invalid = (detail: string): never => {
  throw new DepartmentError('invalid_department', detail);
};

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

function checkText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') return invalid(field);
  const text = value.normalize('NFC').trim();
  if (text.length === 0 || [...text].length > max || CONTROL.test(text)) return invalid(field);
  return text;
}

/**
 * The departments a new organization starts with: one `active` department per catalogue type
 * (ADR-0025). Pure and deterministic, so it can run inside the organization's creation.
 */
export function provisionDepartments(
  organization: Pick<Organization, 'id' | 'createdAt'>,
  catalogue: DepartmentCatalogue,
): readonly Department[] {
  return Object.freeze(
    catalogue.types.map((type) =>
      Object.freeze({
        id: departmentIdOf(organization.id, type.id),
        organizationId: organization.id,
        origin: Object.freeze({
          kind: 'catalog' as const,
          typeId: type.id,
          typeVersion: type.version,
        }),
        status: 'active' as const,
        revision: 1,
        createdAt: organization.createdAt,
        updatedAt: organization.createdAt,
      }),
    ),
  );
}

/** A status change as a caller asks for it. `from` is the status the caller last saw. */
export interface DepartmentStatusChange {
  readonly from: DepartmentStatus;
  readonly to: DepartmentStatus;
}

/**
 * Applies one status change, or refuses it without changing anything. A department no longer in
 * `from` is a concurrency conflict; a change the table does not allow is refused.
 */
export function applyDepartmentStatus(
  department: Department,
  change: DepartmentStatusChange,
  now: IsoTimestamp,
): Department {
  if (department.status !== change.from) {
    throw new DepartmentError('department_concurrency_conflict');
  }
  if (!DEPARTMENT_TRANSITIONS[department.status].includes(change.to)) {
    throw new DepartmentError('invalid_department_transition');
  }
  const at = Date.parse(now) >= Date.parse(department.updatedAt) ? now : department.updatedAt;
  return Object.freeze({
    ...department,
    status: change.to,
    revision: department.revision + 1,
    updatedAt: at,
  });
}

/**
 * Checks a stored department before it is trusted: a record that fails is refused, never
 * repaired. A catalogue department must carry the id its organization and type give it.
 */
export function checkStoredDepartment(department: Department): Department {
  const owner = organizationOfDepartmentId(department.id);
  if (owner === undefined || owner !== department.organizationId) invalid('id');
  if (!isDepartmentStatus(department.status)) invalid('status');
  const { origin } = department;
  if (origin.kind === 'catalog') {
    if (!isDepartmentTypeId(origin.typeId)) invalid('origin.typeId');
    if (department.id !== departmentIdOf(department.organizationId, origin.typeId)) invalid('id');
    if (!Number.isSafeInteger(origin.typeVersion) || origin.typeVersion < 1) {
      invalid('origin.typeVersion');
    }
  } else if (origin.kind === 'custom') {
    checkText(origin.name, 'origin.name', MAX_NAME_LENGTH);
  } else {
    invalid('origin');
  }
  if (department.purpose !== undefined) checkText(department.purpose, 'purpose', MAX_TEXT_LENGTH);
  if (department.description !== undefined) {
    checkText(department.description, 'description', MAX_TEXT_LENGTH);
  }
  if (!Number.isSafeInteger(department.revision) || department.revision < 1) invalid('revision');
  return department;
}
