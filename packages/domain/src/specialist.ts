import type {
  DepartmentId,
  HistoryEventId,
  IsoTimestamp,
  OrganizationId,
  PolicyId,
  RoleId,
  SkillId,
  SpecialistId,
  ToolId,
  UserId,
} from './ids.js';
import type { AutonomyLevel, ChannelType } from './conversation.js';

/** Permanent identity of a specialist. The id never changes; name and avatar are editable. */
export interface SpecialistIdentity {
  readonly id: SpecialistId;
  readonly displayName: string;
  readonly avatar?: string;
  readonly createdAt: IsoTimestamp;
  readonly createdBy: UserId;
}

/**
 * Where a specialist is in its life (ADR-0025). Only `active` specialists are eligible for new
 * executions. `draft` is being prepared, `paused` and `disabled` are stopped (paused for a
 * while, disabled until someone turns it back on), and `archived` is history and final. A
 * specialist with history is never deleted.
 */
export type SpecialistStatus = 'draft' | 'active' | 'paused' | 'disabled' | 'archived';

/** A pointer to one version of a definition kept elsewhere: a skill, a tool or a policy. */
export interface DefinitionRef<Id extends string = string> {
  readonly id: Id;
  readonly version: number;
}

/**
 * The policies a specialist runs under. X2 only references them; the engines that apply them
 * (model routing, context, budget, approval, verification) come in later phases.
 */
export type SpecialistPolicyKind = 'model' | 'context' | 'budget' | 'approval' | 'verification';

export type SpecialistPolicies = Readonly<
  Partial<Record<SpecialistPolicyKind, DefinitionRef<PolicyId>>>
>;

/**
 * What a specialist is and may use: its execution profile. Every change creates a new version,
 * so the configuration an execution used is never changed afterwards (ADR-0025).
 */
export interface SpecialistConfiguration {
  readonly departmentId: DepartmentId;
  /** Exactly one main specialty per specialist (D-29). */
  readonly mainRoleId: RoleId;
  readonly roleVersion: number;
  /** The company's own words for why this specialist exists and what it does. */
  readonly purpose?: string;
  readonly description?: string;
  /** Stable codes for what the specialist can do, e.g. `draft_documents`. */
  readonly capabilities: readonly string[];
  readonly skills: readonly DefinitionRef<SkillId>[];
  readonly tools: readonly DefinitionRef<ToolId>[];
  /**
   * RBAC permissions the specialist's work needs. A specialist never holds permissions of its
   * own: it acts for a user and is eligible only when that user holds all of these (D-25).
   */
  readonly permissions: readonly string[];
  readonly policies: SpecialistPolicies;
  /**
   * How this specialist attends customer conversations (CV-6B, ADR-0043), when it does. Absent:
   * it never handles a conversation. It grants nothing: tools, permissions and the model policy
   * still come from the fields above, and the organization's own level stays the outer limit.
   */
  readonly conversation?: ConversationAgentProfile;
  /**
   * How far the agent acts on its own (AE-4.4, ADR-0116). Absent: `controlled`, the default.
   * A restriction only: it never grants a tool, a permission or a skill, sensitive actions always
   * wait on a person, and the organization's own policy stays the outer limit.
   */
  readonly autonomy?: AgentAutonomy;
}

/**
 * How far an agent acts on its own (AE-4.4, ADR-0116):
 *
 * - `propose`: it reads, analyses and prepares, and proposes every change; a person decides each;
 * - `controlled` (the default): it makes low-risk changes inside MelonOffice by itself;
 * - `within_policy`: it makes every change its permissions, skills, tools and the organization's
 *   policy allow.
 *
 * At every level a sensitive action (ADR-0116 §2) waits on a person, and nothing denied is allowed.
 */
export type AgentAutonomy = 'propose' | 'controlled' | 'within_policy';

/**
 * A specialist's profile as a conversational agent (CV-6B, ADR-0043). A restriction only: it
 * says how far this agent may go, never more than its organization allows.
 */
export interface ConversationAgentProfile {
  /** The company's instructions to the agent: tone, what it may answer, what it must hand off. */
  readonly instructions: string;
  /** The channels it may answer on. */
  readonly channels: readonly ChannelType[];
  /**
   * The furthest this agent may go on its own: `supervised` (a person approves each reply) or
   * `autonomous` (it replies within its limits). The stricter of this and the organization's
   * level applies.
   */
  readonly autonomy: Extract<AutonomyLevel, 'supervised' | 'autonomous'>;
  /** How many replies it may send in one conversation before handing it to a person. */
  readonly maxRepliesPerConversation: number;
}

/** One version of a specialist's configuration. Written once and never changed. */
export interface SpecialistVersion {
  readonly specialistId: SpecialistId;
  readonly organizationId: OrganizationId;
  /** 1, 2, 3…: each new version is the previous one plus one. */
  readonly version: number;
  readonly configuration: SpecialistConfiguration;
  readonly createdAt: IsoTimestamp;
  readonly createdBy: UserId;
}

/**
 * A working instance with its own identity inside a department: the agent of MelonOffice.
 * SPECIALIST = AGENT, SPECIALIST ≠ DEPARTMENT and SPECIALIST ≠ SKILL (D-28). It is a record,
 * not a running AI: work happens in executions that reference one of its versions.
 */
export interface Specialist {
  readonly identity: SpecialistIdentity;
  readonly organizationId: OrganizationId;
  readonly status: SpecialistStatus;
  /** The current version and its configuration. */
  readonly version: number;
  readonly configuration: SpecialistConfiguration;
  /** Increases with every change; a write expecting an older revision is refused. */
  readonly revision: number;
  readonly updatedAt: IsoTimestamp;
  /**
   * Who last changed the status, when and why (AE-4, ADR-0115). Absent on specialists whose
   * status nobody has changed since it was introduced: their audit log still has it.
   */
  readonly lastStatusChange?: SpecialistStatusChangeRecord;
}

/** One status change, as the specialist keeps it (AE-4, ADR-0115). */
export interface SpecialistStatusChangeRecord {
  readonly from: SpecialistStatus;
  readonly to: SpecialistStatus;
  readonly at: IsoTimestamp;
  readonly by: UserId;
  /** The person's own words, when they gave a reason. Required to disable. */
  readonly reason?: string;
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
    | { readonly type: 'activated' }
    | { readonly type: 'paused' }
    | { readonly type: 'disabled' }
    | { readonly type: 'reactivated' }
    | { readonly type: 'archived' }
  );
