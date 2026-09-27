import type {
  DeploymentEnvironment,
  ToolApprovalPolicy,
  ToolDefinition,
  ToolRiskLevel,
  ToolInvocationMode,
  ToolStatus,
  ToolVersion,
} from '@melonoffice/domain';
import { isPermission } from '@melonoffice/rbac';
import { ToolError } from './errors.js';
import { isForbiddenField, schemaProblem } from './schema.js';

export const TOOL_STATUSES = [
  'draft',
  'active',
  'paused',
  'disabled',
  'archived',
] as const satisfies readonly ToolStatus[];

/** Allowed status changes. `archived` is history and final; a tool with history is never deleted. */
export const TOOL_TRANSITIONS: Readonly<Record<ToolStatus, readonly ToolStatus[]>> = Object.freeze({
  draft: Object.freeze(['active', 'archived'] as const),
  active: Object.freeze(['paused', 'disabled', 'archived'] as const),
  paused: Object.freeze(['active', 'disabled', 'archived'] as const),
  disabled: Object.freeze(['active', 'archived'] as const),
  archived: Object.freeze([] as const),
});

export const RISK_LEVELS = [
  'low',
  'medium',
  'high',
  'critical',
] as const satisfies readonly ToolRiskLevel[];
export const APPROVAL_POLICIES = [
  'auto',
  'approval_required',
  'denied',
] as const satisfies readonly ToolApprovalPolicy[];
export const ENVIRONMENTS = [
  'dev',
  'staging',
  'prod',
] as const satisfies readonly DeploymentEnvironment[];

export const INVOCATION_MODES = [
  'runtime',
  'human',
] as const satisfies readonly ToolInvocationMode[];

/** Who may invoke a tool version (ADR-0034). Unset means the runtime only. */
export const invocationModesOf = (v: ToolVersion): readonly ToolInvocationMode[] =>
  v.invocationModes ?? ['runtime'];

/** Whether a person acting directly may invoke this version: only when it says so. */
export const isHumanInvocable = (v: ToolVersion): boolean => invocationModesOf(v).includes('human');

/** Whether the runtime may invoke this version: unless it names its modes without `runtime`. */
export const isRuntimeInvocable = (v: ToolVersion): boolean =>
  invocationModesOf(v).includes('runtime');

export const isDeploymentEnvironment = (value: unknown): value is DeploymentEnvironment =>
  typeof value === 'string' && (ENVIRONMENTS as readonly string[]).includes(value);

/** Only an active tool runs. */
export const toolCanRun = (status: ToolStatus): boolean => status === 'active';

export const MAX_TIMEOUT_MS = 10 * 60_000;
export const MAX_APPROVAL_TTL_SECONDS = 30 * 24 * 3600;

const TOOL_ID = /^[a-z][a-z0-9_]{0,63}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const KEY = /^[a-z][a-z0-9_.]{0,127}$/;

const invalid = (detail: string): never => {
  throw new ToolError('invalid_tool', detail);
};

const int = (value: unknown, min: number, max: number): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;

const codes = (value: unknown, field: string, pattern = CODE): void => {
  if (!Array.isArray(value) || value.some((v) => typeof v !== 'string' || !pattern.test(v))) {
    invalid(field);
  }
  if (new Set(value as string[]).size !== (value as string[]).length) invalid(`${field}.duplicate`);
};

/**
 * Checks one tool version. A definition that would put authority or credentials into a tool's
 * input, run everywhere by accident or run without bounds is refused at registration.
 */
export function checkToolVersion(v: ToolVersion): ToolVersion {
  if (!TOOL_ID.test(v.toolId)) invalid('toolId');
  if (!int(v.version, 1, Number.MAX_SAFE_INTEGER)) invalid('version');
  if (!KEY.test(v.nameKey)) invalid('nameKey');
  if (!KEY.test(v.descriptionKey)) invalid('descriptionKey');
  if (!CODE.test(v.category)) invalid('category');
  if (!CODE.test(v.action)) invalid('action');
  if (typeof v.mutating !== 'boolean') invalid('mutating');
  const inputProblem = schemaProblem(v.inputSchema);
  if (inputProblem !== undefined) invalid(`inputSchema:${inputProblem}`);
  if (v.inputSchema.type !== 'object') invalid('inputSchema:object');
  const outputProblem = schemaProblem(v.outputSchema);
  if (outputProblem !== undefined) invalid(`outputSchema:${outputProblem}`);
  if (!Array.isArray(v.permissions) || !v.permissions.every(isPermission)) invalid('permissions');
  if (new Set(v.permissions).size !== v.permissions.length) invalid('permissions.duplicate');
  if (!Array.isArray(v.credentials)) invalid('credentials');
  for (const [i, c] of v.credentials.entries()) {
    // A credential is a reference: provider and scopes, never a value.
    if (Object.keys(c).some((k) => k !== 'provider' && k !== 'scopes')) {
      invalid(`credentials.${i}`);
    }
    if (!CODE.test(c.provider) || isForbiddenField(c.provider))
      invalid(`credentials.${i}.provider`);
    codes(c.scopes, `credentials.${i}.scopes`, /^[A-Za-z0-9._:/-]{1,256}$/);
  }
  if (!(RISK_LEVELS as readonly string[]).includes(v.riskLevel)) invalid('riskLevel');
  if (!(APPROVAL_POLICIES as readonly string[]).includes(v.approvalPolicy)) {
    invalid('approvalPolicy');
  }
  if (!int(v.approvalTtlSeconds, 60, MAX_APPROVAL_TTL_SECONDS)) invalid('approvalTtlSeconds');
  if (!int(v.timeoutMs, 1, MAX_TIMEOUT_MS)) invalid('timeoutMs');
  if (!int(v.retryPolicy.maxAttempts, 1, 10) || !int(v.retryPolicy.backoffMs, 0, 60_000)) {
    invalid('retryPolicy');
  }
  if (!['internal', 'external'].includes(v.provider.kind) || !CODE.test(v.provider.id)) {
    invalid('provider');
  }
  codes(v.environments, 'environments');
  if (v.environments.length === 0 || !v.environments.every(isDeploymentEnvironment)) {
    invalid('environments');
  }
  if (v.departmentTypes !== undefined) {
    codes(v.departmentTypes, 'departmentTypes');
    if (v.departmentTypes.length === 0) invalid('departmentTypes');
  }
  if (v.invocationModes !== undefined) {
    codes(v.invocationModes, 'invocationModes');
    if (
      v.invocationModes.length === 0 ||
      !v.invocationModes.every((m) => (INVOCATION_MODES as readonly string[]).includes(m))
    ) {
      invalid('invocationModes');
    }
    // A person's call runs now, with nobody else to decide: it is never one that needs an
    // approval, and it acts for the person only, never for a specialist's department.
    if (v.invocationModes.includes('human')) {
      if (v.approvalPolicy !== 'auto') invalid('invocationModes.human_approval');
      if (v.departmentTypes !== undefined) invalid('invocationModes.human_department');
    }
  }
  return v;
}

/**
 * Checks a whole tool: a known status and versions numbered 1, 2, 3… for this tool. Versions
 * are only ever appended; a published version never changes (the registry refuses a
 * different definition under an existing number).
 */
export function checkToolDefinition(definition: ToolDefinition): ToolDefinition {
  if (!TOOL_ID.test(definition.id)) invalid('id');
  if (!(TOOL_STATUSES as readonly string[]).includes(definition.status)) invalid('status');
  if (definition.versions.length === 0) invalid('versions');
  definition.versions.forEach((v, i) => {
    if (v.toolId !== definition.id) invalid(`versions.${i}.toolId`);
    if (v.version !== i + 1) invalid(`versions.${i}.version`);
    checkToolVersion(v);
  });
  return definition;
}
