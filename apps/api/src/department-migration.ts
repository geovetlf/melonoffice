import { buildAuditEvent, type AuditEvent } from '@melonoffice/audit';
import type { UserDirectory } from '@melonoffice/auth';
import {
  applyDepartmentStatus,
  departmentIdOf,
  type DepartmentCatalogue,
} from '@melonoffice/departments';
import type {
  Department,
  IsoTimestamp,
  OrganizationId,
  Specialist,
  UserId,
} from '@melonoffice/domain';
import { reviseSpecialist, type SpecialistWrite } from '@melonoffice/specialists';
import { isOrganizationId } from '@melonoffice/tenancy';
import { OperatorError } from './operator.js';

/**
 * The catalogue migration (ADR-0047): an organization created before a department type was
 * retired still has a department of that type. For each retired type the organization holds,
 * the migration, in one transaction per organization:
 *
 * 1. moves every specialist of that department that is not archived to the department the type
 *    merged into, as a new configuration version (earlier versions stay as they were);
 * 2. archives the retired department (history, never deleted);
 * 3. records one audit event per change, in the same transaction.
 *
 * Nothing is deleted: conversations, executions, versions and audit events that name the old
 * department keep naming it. Running it again changes nothing. An organization whose target
 * department is not active is left untouched and reported, for a person to decide.
 */

/** What the migration reads of one organization, inside its transaction. */
export interface DepartmentMigrationState {
  readonly departments: readonly Department[];
  readonly specialists: readonly Specialist[];
}

/** What it writes for one organization: all of it, or nothing. */
export interface DepartmentMigrationWrite {
  readonly departments: readonly Department[];
  readonly specialists: readonly Required<SpecialistWrite>[];
  readonly events: readonly AuditEvent[];
}

export interface DepartmentMigrationStore {
  /** Every organization that has a department of one of these types, archived or not. */
  organizationsWith(typeIds: readonly string[]): Promise<readonly OrganizationId[]>;
  /** The organization's departments and specialists, read without writing. */
  read(organizationId: OrganizationId): Promise<DepartmentMigrationState>;
  /**
   * Reads the organization's departments and specialists and stores what `plan` returns, with
   * its events, in one transaction; a concurrent change in between makes it read and plan again.
   */
  apply(
    organizationId: OrganizationId,
    plan: (state: DepartmentMigrationState) => DepartmentMigrationWrite,
  ): Promise<DepartmentMigrationWrite>;
}

export type OrganizationOutcome =
  | {
      readonly organizationId: OrganizationId;
      readonly status: 'migrated' | 'planned';
      readonly archived: readonly string[];
      readonly specialistsMoved: number;
    }
  | { readonly organizationId: OrganizationId; readonly status: 'unchanged' }
  | {
      readonly organizationId: OrganizationId;
      readonly status: 'skipped';
      readonly reason: 'merge_target_unavailable' | 'specialist_not_movable';
      readonly department: string;
    };

class Skip extends Error {
  constructor(
    readonly reason: 'merge_target_unavailable' | 'specialist_not_movable',
    readonly department: string,
  ) {
    super(reason);
  }
}

/**
 * What the migration changes in one organization. Pure: it decides from `state` alone, so the
 * same plan runs as a dry run and inside the transaction.
 */
export function planDepartmentMigration(
  state: DepartmentMigrationState,
  input: {
    readonly organizationId: OrganizationId;
    readonly catalogue: DepartmentCatalogue;
    readonly by: UserId;
    readonly at: IsoTimestamp;
  },
): DepartmentMigrationWrite {
  const { organizationId, catalogue, by, at } = input;
  // Only this organization's records are ever considered, whatever the store returned.
  const departments = new Map(
    state.departments.filter((d) => d.organizationId === organizationId).map((d) => [d.id, d]),
  );
  const specialists = state.specialists.filter((s) => s.organizationId === organizationId);
  const writes: Department[] = [];
  const moves: Required<SpecialistWrite>[] = [];
  const events: AuditEvent[] = [];
  const actor = { type: 'user', userId: by, via: 'direct' } as const;

  for (const type of catalogue.retired) {
    if (type.retired === undefined) continue;
    const retiredId = departmentIdOf(organizationId, type.id);
    const retired = departments.get(retiredId);
    if (retired === undefined) continue;
    const staying = specialists.filter(
      (s) => s.configuration.departmentId === retiredId && s.status !== 'archived',
    );
    if (retired.status === 'archived' && staying.length === 0) continue;

    const targetId = departmentIdOf(organizationId, type.retired.mergedInto);
    const target = departments.get(targetId);
    if (target === undefined || target.status !== 'active') {
      throw new Skip('merge_target_unavailable', retiredId);
    }
    for (const specialist of staying) {
      let move: Required<SpecialistWrite>;
      try {
        move = reviseSpecialist(
          specialist,
          {
            fromVersion: specialist.version,
            configuration: { ...specialist.configuration, departmentId: targetId },
            department: target,
          },
          by,
          at,
        );
      } catch {
        throw new Skip('specialist_not_movable', retiredId);
      }
      moves.push(move);
      events.push(
        buildAuditEvent(
          {
            action: 'specialist.department_changed',
            result: 'success',
            actor,
            organizationId,
            target: { type: 'specialist', id: specialist.identity.id },
            targetVersion: move.version.version,
            reference: `department:${targetId}`,
            reason: 'department_type_retired',
            source: 'api',
          },
          new Date(at),
        ),
      );
    }
    if (retired.status !== 'archived') {
      writes.push(applyDepartmentStatus(retired, { from: retired.status, to: 'archived' }, at));
      events.push(
        buildAuditEvent(
          {
            action: 'department.archived',
            result: 'success',
            actor,
            organizationId,
            target: { type: 'department', id: retiredId },
            reference: `merged_into:${targetId}`,
            reason: 'department_type_retired',
            source: 'api',
          },
          new Date(at),
        ),
      );
    }
  }
  return Object.freeze({
    departments: Object.freeze(writes),
    specialists: Object.freeze(moves),
    events: Object.freeze(events),
  });
}

/**
 * Runs the migration over every organization that holds a retired type. A dry run (the default)
 * only reads and reports; `apply` writes, one organization per transaction. `approvedBy` must be
 * a MelonOffice user: the events and the new specialist versions name them.
 */
export async function migrateDepartmentCatalogue(input: {
  readonly catalogue: DepartmentCatalogue;
  readonly store: DepartmentMigrationStore;
  readonly users: Pick<UserDirectory, 'findById'>;
  readonly approvedBy: unknown;
  readonly apply: boolean;
  /** Limits the run to one organization. */
  readonly organizationId?: unknown;
  readonly now?: () => Date;
}): Promise<readonly OrganizationOutcome[]> {
  if (
    typeof input.approvedBy !== 'string' ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(input.approvedBy)
  ) {
    throw new OperatorError('invalid_input');
  }
  if (input.organizationId !== undefined && !isOrganizationId(input.organizationId)) {
    throw new OperatorError('invalid_input');
  }
  const approver = await input.users.findById(input.approvedBy as UserId);
  if (approver === undefined) throw new OperatorError('approver_not_found');
  const retired = input.catalogue.retired.map((t) => t.id);
  if (retired.length === 0) return [];
  const found = await input.store.organizationsWith(retired);
  const organizations =
    input.organizationId === undefined ? found : found.filter((id) => id === input.organizationId);

  const outcomes: OrganizationOutcome[] = [];
  for (const organizationId of [...new Set(organizations)].sort()) {
    const at = (input.now ?? (() => new Date()))().toISOString() as IsoTimestamp;
    const plan = (state: DepartmentMigrationState) =>
      planDepartmentMigration(state, {
        organizationId,
        catalogue: input.catalogue,
        by: approver.id,
        at,
      });
    try {
      const write = input.apply
        ? await input.store.apply(organizationId, plan)
        : plan(await input.store.read(organizationId));
      if (write.departments.length === 0 && write.specialists.length === 0) {
        outcomes.push({ organizationId, status: 'unchanged' });
      } else {
        outcomes.push({
          organizationId,
          status: input.apply ? 'migrated' : 'planned',
          archived: write.departments.map((d) => d.id),
          specialistsMoved: write.specialists.length,
        });
      }
    } catch (error) {
      if (!(error instanceof Skip)) throw error;
      outcomes.push({
        organizationId,
        status: 'skipped',
        reason: error.reason,
        department: error.department,
      });
    }
  }
  return Object.freeze(outcomes);
}

/**
 * For tests and local runs only: the same reads and writes over the in-memory repositories.
 * Memory has no transactions; the plan is still computed from one read and written whole.
 */
export class InMemoryDepartmentMigrationStore implements DepartmentMigrationStore {
  constructor(
    private readonly departments: {
      list(organizationId: OrganizationId): Promise<readonly Department[]>;
      put(department: Department): void;
    },
    private readonly specialists: {
      list(organizationId: OrganizationId): Promise<readonly Specialist[]>;
      update(
        organizationId: OrganizationId,
        id: Specialist['identity']['id'],
        change: (current: Specialist) => SpecialistWrite,
      ): Promise<Specialist>;
    },
    private readonly audit: { append(events: readonly AuditEvent[]): Promise<void> },
    private readonly organizations: () => Promise<readonly OrganizationId[]>,
  ) {}

  async organizationsWith(typeIds: readonly string[]): Promise<readonly OrganizationId[]> {
    const found: OrganizationId[] = [];
    for (const organizationId of await this.organizations()) {
      const departments = await this.departments.list(organizationId);
      if (
        departments.some((d) => d.origin.kind === 'catalog' && typeIds.includes(d.origin.typeId))
      ) {
        found.push(organizationId);
      }
    }
    return found;
  }

  async read(organizationId: OrganizationId): Promise<DepartmentMigrationState> {
    return {
      departments: await this.departments.list(organizationId),
      specialists: await this.specialists.list(organizationId),
    };
  }

  async apply(
    organizationId: OrganizationId,
    plan: (state: DepartmentMigrationState) => DepartmentMigrationWrite,
  ): Promise<DepartmentMigrationWrite> {
    const write = plan(await this.read(organizationId));
    for (const move of write.specialists) {
      await this.specialists.update(organizationId, move.specialist.identity.id, () => move);
    }
    for (const department of write.departments) this.departments.put(department);
    await this.audit.append(write.events);
    return write;
  }
}
