import type {
  DepartmentId,
  HistoryEventId,
  IsoTimestamp,
  RoleId,
  SkillId,
  SpecialistId,
  UserId,
} from './ids.js';

/** Permanent identity of a specialist. The id never changes; name and avatar are editable. */
export interface SpecialistIdentity {
  readonly id: SpecialistId;
  readonly displayName: string;
  readonly avatar: string;
  readonly createdAt: IsoTimestamp;
  readonly createdBy: UserId;
}

export type SpecialistState = 'active' | 'paused' | 'archived';

/** Current configuration of a specialist. It changes over time; history records each change. */
export interface SpecialistConfiguration {
  readonly departmentId: DepartmentId;
  /** Exactly one main specialty per specialist (D-29). */
  readonly mainRoleId: RoleId;
  readonly roleVersion: number;
  readonly enabledSkillIds: readonly SkillId[];
  readonly state: SpecialistState;
}

/**
 * A working instance with its own identity inside a department.
 * SPECIALIST ≠ DEPARTMENT and SPECIALIST ≠ SKILL (D-28).
 */
export interface Specialist {
  readonly identity: SpecialistIdentity;
  readonly configuration: SpecialistConfiguration;
}

/**
 * Snapshot of the working context at a given moment. Every task, result and
 * history record keeps one, so a later role or department change never
 * reinterprets earlier work.
 */
export interface WorkContextSnapshot {
  readonly specialistId: SpecialistId;
  readonly departmentId: DepartmentId;
  readonly roleId: RoleId;
  readonly roleVersion: number;
  readonly skillIds: readonly SkillId[];
}

interface HistoryEventBase {
  readonly id: HistoryEventId;
  readonly specialistId: SpecialistId;
  readonly occurredAt: IsoTimestamp;
  readonly actor: UserId;
  /** Context as it was right before the event. */
  readonly context: WorkContextSnapshot;
}

/** Append-only specialist history. Events are never rewritten. */
export type SpecialistHistoryEvent = HistoryEventBase &
  (
    | { readonly type: 'created' }
    | { readonly type: 'renamed'; readonly from: string; readonly to: string }
    | { readonly type: 'avatar_changed'; readonly from: string; readonly to: string }
    | { readonly type: 'role_changed'; readonly fromRoleId: RoleId; readonly toRoleId: RoleId }
    | {
        readonly type: 'skills_changed';
        readonly added: readonly SkillId[];
        readonly removed: readonly SkillId[];
      }
    | {
        readonly type: 'department_changed';
        readonly fromDepartmentId: DepartmentId;
        readonly toDepartmentId: DepartmentId;
      }
    | { readonly type: 'paused' }
    | { readonly type: 'reactivated' }
    | { readonly type: 'archived' }
  );
