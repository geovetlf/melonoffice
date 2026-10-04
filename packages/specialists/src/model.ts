import type { AuditEvent } from '@melonoffice/audit';
import { acceptsAssignments, organizationOfDepartmentId } from '@melonoffice/departments';
import type {
  AgentAutonomy,
  AgentWorkSettings,
  ConversationAgentProfile,
  DefinitionRef,
  Department,
  DepartmentId,
  IsoTimestamp,
  OrganizationId,
  PolicyId,
  RoleId,
  SkillId,
  Specialist,
  SpecialistConfiguration,
  SpecialistId,
  SpecialistPolicies,
  SpecialistPolicyKind,
  SpecialistStatus,
  SpecialistVersion,
  ToolId,
  UserId,
} from '@melonoffice/domain';
import { isPermission } from '@melonoffice/rbac';
import { randomUUID } from 'node:crypto';
import { SpecialistError } from './errors.js';
import { canChangeSpecialistStatus, isSpecialistStatus } from './lifecycle.js';

/** Limits that keep one specialist document small and bounded. */
// 2 + 2 × 40 + 5 policies stays under the execution snapshot limit of 100 components.
export const MAX_REFERENCES = 40;
export const MAX_TEXT_LENGTH = 500;
export const MAX_NAME_LENGTH = 100;

export const POLICY_KINDS = [
  'model',
  'context',
  'budget',
  'approval',
  'verification',
] as const satisfies readonly SpecialistPolicyKind[];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const REF_ID = /^[A-Za-z0-9._:-]{1,128}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export const isSpecialistId = (value: unknown): value is SpecialistId =>
  typeof value === 'string' && UUID.test(value);

export const isVersionNumber = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

const invalid = (detail: string): never => {
  throw new SpecialistError('invalid_specialist', detail);
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function checkText(value: unknown, field: string, max: number): string {
  if (typeof value !== 'string') return invalid(field);
  const text = value.normalize('NFC').trim();
  if (text.length === 0 || [...text].length > max || CONTROL.test(text)) return invalid(field);
  return text;
}

function checkList<T>(
  value: unknown,
  field: string,
  check: (item: unknown, field: string) => T,
  key: (item: T) => string,
): readonly T[] {
  if (!Array.isArray(value) || value.length > MAX_REFERENCES) return invalid(field);
  const items = value.map((item, i) => check(item, `${field}.${i}`));
  if (new Set(items.map(key)).size !== items.length) return invalid(`${field}.duplicate`);
  return Object.freeze(items);
}

function checkDefinitionRef<Id extends string>(value: unknown, field: string): DefinitionRef<Id> {
  if (!isRecord(value)) return invalid(field);
  const { id, version } = value;
  if (typeof id !== 'string' || !REF_ID.test(id)) return invalid(`${field}.id`);
  if (!isVersionNumber(version)) return invalid(`${field}.version`);
  return Object.freeze({ id: id as Id, version });
}

const checkCode = (value: unknown, field: string): string =>
  typeof value === 'string' && CODE.test(value) ? value : invalid(field);

const checkPermission = (value: unknown, field: string): string =>
  isPermission(value) ? value : invalid(field);

function checkPolicies(value: unknown): SpecialistPolicies {
  if (!isRecord(value)) return invalid('policies');
  const policies: Partial<Record<SpecialistPolicyKind, DefinitionRef<PolicyId>>> = {};
  for (const [kind, ref] of Object.entries(value)) {
    if (!(POLICY_KINDS as readonly string[]).includes(kind)) invalid(`policies.${kind}`);
    if (ref === undefined) continue;
    policies[kind as SpecialistPolicyKind] = checkDefinitionRef<PolicyId>(ref, `policies.${kind}`);
  }
  return Object.freeze(policies);
}

/** The longest instructions a conversation profile may carry (CV-6B). */
export const MAX_INSTRUCTIONS_LENGTH = 4_000;
/** The channels an agent may answer on: the ones MelonOffice has an adapter for. */
export const AGENT_CHANNELS = ['whatsapp'] as const;
export const AGENT_AUTONOMY_LEVELS = ['supervised', 'autonomous'] as const;
export const MAX_REPLIES_PER_CONVERSATION = 50;

// Instructions keep their line breaks; other control characters are refused.
// eslint-disable-next-line no-control-regex
const INSTRUCTIONS_CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/**
 * Checks a conversation profile (CV-6B, ADR-0043): instructions, at least one known channel, how
 * far it may go on its own (never below `supervised`: `manual` and `assisted` are not agents), and
 * a reply limit. Nothing in it grants a tool, a permission or a model.
 */
function checkConversationProfile(value: unknown): ConversationAgentProfile {
  if (!isRecord(value)) return invalid('conversation');
  const keys = ['instructions', 'channels', 'autonomy', 'maxRepliesPerConversation'];
  if (Object.keys(value).some((k) => !keys.includes(k))) invalid('conversation.fields');
  const { instructions, channels, autonomy, maxRepliesPerConversation } = value;
  if (typeof instructions !== 'string') return invalid('conversation.instructions');
  const text = instructions.normalize('NFC').trim();
  if (
    text.length === 0 ||
    [...text].length > MAX_INSTRUCTIONS_LENGTH ||
    INSTRUCTIONS_CONTROL.test(text)
  ) {
    invalid('conversation.instructions');
  }
  const list = checkList(
    channels,
    'conversation.channels',
    (v, f) =>
      typeof v === 'string' && (AGENT_CHANNELS as readonly string[]).includes(v)
        ? (v as ConversationAgentProfile['channels'][number])
        : invalid(f),
    (c) => c,
  );
  if (list.length === 0) invalid('conversation.channels');
  if (
    typeof autonomy !== 'string' ||
    !(AGENT_AUTONOMY_LEVELS as readonly string[]).includes(autonomy)
  ) {
    invalid('conversation.autonomy');
  }
  if (
    typeof maxRepliesPerConversation !== 'number' ||
    !Number.isSafeInteger(maxRepliesPerConversation) ||
    maxRepliesPerConversation < 1 ||
    maxRepliesPerConversation > MAX_REPLIES_PER_CONVERSATION
  ) {
    invalid('conversation.maxRepliesPerConversation');
  }
  return Object.freeze({
    instructions: text,
    channels: list,
    autonomy: autonomy as ConversationAgentProfile['autonomy'],
    maxRepliesPerConversation: maxRepliesPerConversation as number,
  });
}

/** An agent's levels of autonomy (AE-4.4, ADR-0116), from the most to the least careful. */
export const AGENT_WORK_AUTONOMY = ['propose', 'controlled', 'within_policy'] as const;
/** The level of an agent that names none: the default for every agent. */
export const DEFAULT_AGENT_AUTONOMY: AgentAutonomy = 'controlled';

export const isAgentAutonomy = (value: unknown): value is AgentAutonomy =>
  typeof value === 'string' && (AGENT_WORK_AUTONOMY as readonly string[]).includes(value);

/** The level an agent's configuration acts at: its own, or the default when it names none. */
export const autonomyOf = (
  configuration: Pick<SpecialistConfiguration, 'autonomy'>,
): AgentAutonomy => configuration.autonomy ?? DEFAULT_AGENT_AUTONOMY;

/**
 * The furthest an agent's conversation replies may go at its level (AE-4.4): an agent that only
 * proposes never sends a reply by itself, whatever its conversation profile says; the other levels
 * leave the profile and the organization's level to decide (ADR-0043).
 */
export const conversationCeilingOf = (
  configuration: Pick<SpecialistConfiguration, 'autonomy'>,
): ConversationAgentProfile['autonomy'] =>
  autonomyOf(configuration) === 'propose' ? 'supervised' : 'autonomous';

/**
 * Checks a configuration and returns a frozen copy with only its known fields. Its department
 * must belong to `organizationId`, and every permission must exist in the RBAC catalogue.
 */
export function checkConfiguration(
  value: unknown,
  organizationId: OrganizationId,
): SpecialistConfiguration {
  if (!isRecord(value)) return invalid('configuration');
  const { departmentId, mainRoleId, roleVersion, purpose, description } = value;
  if (organizationOfDepartmentId(departmentId) !== organizationId) invalid('departmentId');
  if (typeof mainRoleId !== 'string' || !REF_ID.test(mainRoleId)) invalid('mainRoleId');
  if (!isVersionNumber(roleVersion)) invalid('roleVersion');
  return Object.freeze({
    departmentId: departmentId as DepartmentId,
    mainRoleId: mainRoleId as RoleId,
    roleVersion: roleVersion as number,
    ...(purpose === undefined ? {} : { purpose: checkText(purpose, 'purpose', MAX_TEXT_LENGTH) }),
    ...(description === undefined
      ? {}
      : { description: checkText(description, 'description', MAX_TEXT_LENGTH) }),
    capabilities: checkList(value.capabilities ?? [], 'capabilities', checkCode, (c) => c),
    skills: checkList(
      value.skills ?? [],
      'skills',
      (v, f) => checkDefinitionRef<SkillId>(v, f),
      (r) => r.id,
    ),
    tools: checkList(
      value.tools ?? [],
      'tools',
      (v, f) => checkDefinitionRef<ToolId>(v, f),
      (r) => r.id,
    ),
    permissions: checkList(value.permissions ?? [], 'permissions', checkPermission, (p) => p),
    policies: checkPolicies(value.policies ?? {}),
    ...(value.conversation === undefined
      ? {}
      : { conversation: checkConversationProfile(value.conversation) }),
    ...(value.autonomy === undefined
      ? {}
      : { autonomy: isAgentAutonomy(value.autonomy) ? value.autonomy : invalid('autonomy') }),
    ...(value.work === undefined ? {} : { work: checkWorkSettings(value.work) }),
  });
}

/** What a person writes about an agent (ADR-0140): its purpose and its description. */
export const AGENT_PROFILE_FIELDS = Object.freeze(['purpose', 'description'] as const);
export type AgentProfileField = (typeof AGENT_PROFILE_FIELDS)[number];

/** An agent's work settings (ADR-0117), by name. */
export const AGENT_WORK_SETTINGS = Object.freeze([
  'memory',
  'aiVerification',
  'collaboration',
] as const);
export type AgentWorkSetting = (typeof AGENT_WORK_SETTINGS)[number];

/** Whether a work setting is on for this configuration: off unless a person switched it on. */
export const workSettingOf = (
  configuration: Pick<SpecialistConfiguration, 'work'>,
  setting: AgentWorkSetting,
): boolean => configuration.work?.[setting] === true;

/** Every work setting, each on or off. */
export const workSettingsOf = (
  configuration: Pick<SpecialistConfiguration, 'work'>,
): Readonly<Record<AgentWorkSetting, boolean>> =>
  Object.freeze(
    Object.fromEntries(
      AGENT_WORK_SETTINGS.map((s) => [s, workSettingOf(configuration, s)]),
    ) as Record<AgentWorkSetting, boolean>,
  );

function checkWorkSettings(value: unknown): AgentWorkSettings {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) invalid('work');
  const entries = Object.entries(value as Record<string, unknown>);
  for (const [key, on] of entries) {
    if (!(AGENT_WORK_SETTINGS as readonly string[]).includes(key) || typeof on !== 'boolean') {
      invalid(`work.${key}`);
    }
  }
  return Object.freeze(Object.fromEntries(entries)) as AgentWorkSettings;
}

/** Whether two configurations say the same thing. Lists compare in order. */
export function sameConfiguration(a: SpecialistConfiguration, b: SpecialistConfiguration): boolean {
  return canonical(a) === canonical(b);
}

// Keys sorted at every level, so field order never makes two equal configurations differ.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .filter((k) => value[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function checkAssignable(department: Department, configuration: SpecialistConfiguration): void {
  if (department.id !== configuration.departmentId) invalid('departmentId');
  if (!acceptsAssignments(department)) throw new SpecialistError('department_not_assignable');
}

/** A specialist and, when its configuration changed, the new version to store with it. */
export interface SpecialistWrite {
  readonly specialist: Specialist;
  readonly version?: SpecialistVersion;
  /** The audit events of the change (ADR-0062): stored with it, or nothing is. */
  readonly events?: readonly AuditEvent[];
}

export interface NewSpecialist {
  readonly organizationId: OrganizationId;
  readonly displayName: string;
  readonly avatar?: string;
  readonly configuration: unknown;
}

/**
 * Builds a new specialist in `draft`, at version 1, in `department`, which must be the
 * configuration's department and active: an archived or paused department takes no new
 * specialists. Pure apart from its random id.
 */
export function newSpecialist(
  request: NewSpecialist,
  department: Department,
  by: UserId,
  at: IsoTimestamp,
): Required<Omit<SpecialistWrite, 'events'>> {
  const configuration = checkConfiguration(request.configuration, request.organizationId);
  checkAssignable(department, configuration);
  const id = randomUUID() as SpecialistId;
  const specialist: Specialist = Object.freeze({
    identity: Object.freeze({
      id,
      displayName: checkText(request.displayName, 'displayName', MAX_NAME_LENGTH),
      ...(request.avatar === undefined
        ? {}
        : { avatar: checkText(request.avatar, 'avatar', MAX_TEXT_LENGTH) }),
      createdAt: at,
      createdBy: by,
    }),
    organizationId: request.organizationId,
    status: 'draft',
    version: 1,
    configuration,
    revision: 1,
    updatedAt: at,
  });
  const version: SpecialistVersion = Object.freeze({
    specialistId: id,
    organizationId: request.organizationId,
    version: 1,
    configuration,
    createdAt: at,
    createdBy: by,
  });
  return { specialist, version };
}

const later = (specialist: Specialist, at: IsoTimestamp): IsoTimestamp =>
  Date.parse(at) >= Date.parse(specialist.updatedAt) ? at : specialist.updatedAt;

/** A configuration change as a caller asks for it. `fromVersion` is the version the caller last saw. */
export interface ConfigurationChange {
  readonly fromVersion: number;
  readonly configuration: unknown;
  /** The department the configuration moves to, as read by the caller. Needed only for a move. */
  readonly department?: Department;
  /** The earlier version this one restores (ADR-0143), kept with the new version. */
  readonly restoredFrom?: number;
}

/**
 * Creates the next version of a specialist's configuration (ADR-0025). Versions are never
 * edited: an execution that used version 3 keeps meaning version 3. A change that says nothing
 * new creates no version and is refused. Moving to another department needs that department to
 * be active. An archived specialist is history and cannot change.
 */
export function reviseSpecialist(
  current: Specialist,
  change: ConfigurationChange,
  by: UserId,
  now: IsoTimestamp,
): Required<Omit<SpecialistWrite, 'events'>> {
  if (current.status === 'archived') throw new SpecialistError('specialist_archived');
  if (current.version !== change.fromVersion) {
    throw new SpecialistError('specialist_concurrency_conflict');
  }
  if (
    change.restoredFrom !== undefined &&
    (!isVersionNumber(change.restoredFrom) || change.restoredFrom >= current.version)
  ) {
    invalid('version');
  }
  const configuration = checkConfiguration(change.configuration, current.organizationId);
  if (sameConfiguration(configuration, current.configuration)) invalid('configuration.unchanged');
  if (configuration.departmentId !== current.configuration.departmentId) {
    if (change.department === undefined) invalid('department');
    checkAssignable(change.department as Department, configuration);
  }
  const at = later(current, now);
  const next = current.version + 1;
  return {
    specialist: Object.freeze({
      ...current,
      version: next,
      configuration,
      revision: current.revision + 1,
      updatedAt: at,
    }),
    version: Object.freeze({
      specialistId: current.identity.id,
      organizationId: current.organizationId,
      version: next,
      configuration,
      createdAt: at,
      createdBy: by,
      ...(change.restoredFrom === undefined ? {} : { restoredFrom: change.restoredFrom }),
    }),
  };
}

/** A status change as a caller asks for it. `from` is the status the caller last saw. */
export interface SpecialistStatusChange {
  readonly from: SpecialistStatus;
  readonly to: SpecialistStatus;
  /** Why, in the person's words (AE-4). A person must give one to disable an agent. */
  readonly reason?: unknown;
}

/** The longest reason a status change may carry. */
export const MAX_STATUS_REASON_LENGTH = 500;

/**
 * A status change's reason: trimmed text, or absent (AE-4, ADR-0115). Whether one is required is
 * the caller's rule: a person disabling an agent must give one (`SpecialistManagement`).
 */
export function checkStatusReason(value: unknown): string | undefined {
  if (value === undefined || value === null || (typeof value === 'string' && !value.trim())) {
    return undefined;
  }
  return checkText(value, 'reason', MAX_STATUS_REASON_LENGTH);
}

/**
 * Applies one status change, or refuses it without changing anything. A status is not part of
 * the configuration, so it creates no version. The specialist keeps who changed it, when and why
 * (AE-4): the audit log has every change, the specialist shows the last one.
 */
export function applySpecialistStatus(
  current: Specialist,
  change: SpecialistStatusChange,
  now: IsoTimestamp,
  by?: UserId,
): SpecialistWrite {
  if (current.status !== change.from) {
    throw new SpecialistError('specialist_concurrency_conflict');
  }
  if (current.status === 'archived') throw new SpecialistError('specialist_archived');
  if (!isSpecialistStatus(change.to) || !canChangeSpecialistStatus(current.status, change.to)) {
    throw new SpecialistError('invalid_specialist_transition');
  }
  const reason = checkStatusReason(change.reason);
  const at = later(current, now);
  return {
    specialist: Object.freeze({
      ...current,
      status: change.to,
      revision: current.revision + 1,
      updatedAt: at,
      ...(by === undefined
        ? {}
        : {
            lastStatusChange: Object.freeze({
              from: current.status,
              to: change.to,
              at,
              by,
              ...(reason === undefined ? {} : { reason }),
            }),
          }),
    }),
  };
}

/**
 * Checks what a write would store against the current specialist: the same specialist, one
 * revision ahead; and a new version exactly when the configuration changed, numbered one more
 * than the current one and holding that configuration. Anything else would rewrite history.
 */
export function checkSpecialistWrite(
  current: Specialist | undefined,
  write: SpecialistWrite,
): void {
  const { specialist, version } = write;
  const conflict = () => {
    throw new SpecialistError('specialist_concurrency_conflict');
  };
  if (current === undefined) {
    if (specialist.revision !== 1 || specialist.version !== 1 || version?.version !== 1) {
      conflict();
    }
  } else {
    if (
      specialist.identity.id !== current.identity.id ||
      specialist.organizationId !== current.organizationId ||
      specialist.revision !== current.revision + 1
    ) {
      conflict();
    }
    const expected = version === undefined ? current.version : current.version + 1;
    if (specialist.version !== expected) conflict();
    if (
      version === undefined &&
      !sameConfiguration(specialist.configuration, current.configuration)
    ) {
      conflict();
    }
  }
  if (version !== undefined) {
    if (
      version.specialistId !== specialist.identity.id ||
      version.organizationId !== specialist.organizationId ||
      version.version !== specialist.version ||
      !sameConfiguration(version.configuration, specialist.configuration)
    ) {
      conflict();
    }
  }
}

/** Checks a stored specialist before it is trusted: a record that fails is refused, never repaired. */
export function checkStoredSpecialist(specialist: Specialist): Specialist {
  if (!isSpecialistId(specialist.identity.id)) invalid('id');
  checkText(specialist.identity.displayName, 'displayName', MAX_NAME_LENGTH);
  if (!isSpecialistStatus(specialist.status)) invalid('status');
  if (!isVersionNumber(specialist.version)) invalid('version');
  if (!isVersionNumber(specialist.revision)) invalid('revision');
  checkConfiguration(specialist.configuration, specialist.organizationId);
  const change = specialist.lastStatusChange;
  if (change !== undefined) {
    if (
      !isSpecialistStatus(change.from) ||
      change.to !== specialist.status ||
      typeof change.by !== 'string' ||
      change.by.length === 0 ||
      Number.isNaN(Date.parse(change.at))
    ) {
      invalid('lastStatusChange');
    }
    if (change.reason !== undefined) {
      checkText(change.reason, 'lastStatusChange.reason', MAX_STATUS_REASON_LENGTH);
    }
  }
  return specialist;
}

export function checkStoredVersion(version: SpecialistVersion): SpecialistVersion {
  if (!isSpecialistId(version.specialistId)) invalid('specialistId');
  if (!isVersionNumber(version.version)) invalid('version');
  checkConfiguration(version.configuration, version.organizationId);
  if (
    version.restoredFrom !== undefined &&
    (!isVersionNumber(version.restoredFrom) || version.restoredFrom >= version.version)
  ) {
    invalid('restoredFrom');
  }
  return version;
}
