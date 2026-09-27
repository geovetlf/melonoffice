import type {
  PlanBudget,
  PlanCondition,
  PlanRetry,
  PlanStepKind,
  PlanVerification,
  ToolRiskLevel,
  ToolSchema,
  VerificationPolicy,
} from '@melonoffice/domain';
import { looksLikeSecretText } from '@melonoffice/ai-gateway';
import { isForbiddenField, schemaProblem } from '@melonoffice/tools';

/** Limits that keep a plan small: its steps become at most this many execution nodes. */
export const MAX_STEPS = 50;
export const MAX_STEP_DEPENDENCIES = 20;
export const MAX_REQUIRED_CHECKS = 20;
export const MAX_LABEL_LENGTH = 120;
export const MAX_SUMMARY_LENGTH = 200;
export const MAX_OBJECTIVE_LENGTH = 1_000;
export const MAX_BUDGET_TOKENS = 1_000_000;
export const MAX_RETRY_ATTEMPTS = 5;
export const MAX_RETRY_BACKOFF_MS = 60_000;

export const PLAN_STEP_KINDS = [
  'specialist',
  'tool',
  'approval',
  'verification',
  'condition',
  'parallel',
] as const satisfies readonly PlanStepKind[];

export const VERIFICATION_POLICIES = [
  'output_schema',
  'human_review',
  'specialist_review',
  'checks',
] as const satisfies readonly VerificationPolicy[];

const RISK_LEVELS = ['low', 'medium', 'high', 'critical'] as const satisfies ToolRiskLevel[];

/**
 * One step as a proposal states it: what the model (or a workflow) may say, and nothing more
 * (ADR-0028). Who a specialist step's department is, whether a tool needs an approval and what
 * a tool's contracts are come from the system, never from here.
 */
export interface ProposalStep {
  readonly id: string;
  readonly kind: PlanStepKind;
  readonly label: string;
  readonly dependsOn: readonly string[];
  /** On `specialist` steps: which specialist, from the planning context. */
  readonly specialistId?: string;
  /** On `specialist` steps, optional: must be the specialist's own department. */
  readonly departmentId?: string;
  /** On `tool` steps: the specialist step that uses the tool. */
  readonly performedBy?: string;
  /** On `tool` steps. */
  readonly tool?: { readonly id: string; readonly version: number };
  readonly inputContract?: ToolSchema;
  readonly outputContract?: ToolSchema;
  readonly verification?: PlanVerification;
  readonly condition?: PlanCondition;
  readonly retry?: PlanRetry;
  /** A proposal may ask for a human approval. It can never remove one the system requires. */
  readonly approvalRequired?: boolean;
  readonly budget?: PlanBudget;
}

/** What a proposal says. Closed: any other field is refused. */
export interface PlanProposal {
  readonly summary: string;
  readonly objective: string;
  /** A proposal may raise the plan's risk above what its tools say, never lower it. */
  readonly riskLevel?: ToolRiskLevel;
  readonly steps: readonly ProposalStep[];
}

/**
 * Why a proposal is refused at the schema stage. `authority_in_proposal` (a field such as
 * `organizationId`, `approved` or `permissions`) and `secret_in_proposal` are security refusals.
 */
export type ProposalProblem = 'invalid_proposal' | 'authority_in_proposal' | 'secret_in_proposal';

export type ProposalCheck =
  | { readonly ok: true; readonly proposal: PlanProposal }
  | { readonly ok: false; readonly reason: ProposalProblem; readonly detail: string };

const PROPOSAL_KEYS = new Set(['summary', 'objective', 'riskLevel', 'steps']);
const STEP_KEYS = new Set([
  'id',
  'kind',
  'label',
  'dependsOn',
  'specialistId',
  'departmentId',
  'performedBy',
  'tool',
  'inputContract',
  'outputContract',
  'verification',
  'condition',
  'retry',
  'approvalRequired',
  'budget',
]);
const VERIFICATION_KEYS = new Set(['policy', 'expectedOutput', 'outputSchema', 'requiredChecks']);

/** Step ids become execution node ids, so they follow the same, stricter shape. */
export const STEP_ID = /^[a-z][a-z0-9_]{0,47}$/;
const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const REF_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const TOOL_ID = /^[a-z][a-z0-9_]{0,63}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

class Refusal {
  constructor(
    readonly reason: ProposalProblem,
    readonly detail: string,
  ) {}
}
const refuse = (reason: ProposalProblem, detail: string): never => {
  throw new Refusal(reason, detail);
};
const invalid = (detail: string): never => refuse('invalid_proposal', detail);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' &&
  value !== null &&
  !Array.isArray(value) &&
  Object.getPrototypeOf(value) === Object.prototype;

/** Unknown keys: an authority or credential name is smuggling; anything else is malformed. */
function closed(value: Record<string, unknown>, allowed: ReadonlySet<string>, field: string): void {
  for (const key of Object.keys(value)) {
    if (allowed.has(key)) continue;
    if (isForbiddenField(key)) refuse('authority_in_proposal', `${field}.${key}`);
    invalid(`${field}.${key}`);
  }
}

/** Every string anywhere in the proposal is checked for credentials before anything else. */
function scanSecrets(value: unknown, field: string, depth = 0): void {
  if (depth > 12) invalid(field);
  if (typeof value === 'string') {
    if (looksLikeSecretText(value)) refuse('secret_in_proposal', field);
  } else if (Array.isArray(value)) {
    value.forEach((item, i) => scanSecrets(item, `${field}.${i}`, depth + 1));
  } else if (isRecord(value)) {
    for (const [key, item] of Object.entries(value))
      scanSecrets(item, `${field}.${key}`, depth + 1);
  }
}

function text(value: unknown, max: number, field: string): string {
  if (typeof value !== 'string') return invalid(field);
  const t = value.normalize('NFC').trim();
  if (t.length === 0 || [...t].length > max || CONTROL.test(t)) return invalid(field);
  return t;
}

const int = (value: unknown, min: number, max: number, field: string): number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max
    ? value
    : invalid(field);

const oneOf = <T extends string>(list: readonly T[], value: unknown, field: string): T =>
  typeof value === 'string' && (list as readonly string[]).includes(value)
    ? (value as T)
    : invalid(field);

function contract(value: unknown, field: string): ToolSchema {
  if (schemaProblem(value) !== undefined) invalid(field);
  return structuredClone(value) as ToolSchema;
}

function verificationOf(value: unknown, field: string): PlanVerification {
  if (!isRecord(value)) return invalid(field);
  closed(value, VERIFICATION_KEYS, field);
  const { requiredChecks = [] } = value;
  if (
    !Array.isArray(requiredChecks) ||
    requiredChecks.length > MAX_REQUIRED_CHECKS ||
    requiredChecks.some((c) => typeof c !== 'string' || !CODE.test(c)) ||
    new Set(requiredChecks).size !== requiredChecks.length
  ) {
    invalid(`${field}.requiredChecks`);
  }
  const expectedOutput = value.expectedOutput;
  if (typeof expectedOutput !== 'string' || !CODE.test(expectedOutput)) {
    invalid(`${field}.expectedOutput`);
  }
  return {
    policy: oneOf(VERIFICATION_POLICIES, value.policy, `${field}.policy`),
    expectedOutput: expectedOutput as string,
    ...(value.outputSchema === undefined
      ? {}
      : { outputSchema: contract(value.outputSchema, `${field}.outputSchema`) }),
    requiredChecks: [...(requiredChecks as string[])],
  };
}

function stepOf(value: unknown, index: number): ProposalStep {
  const field = `steps.${index}`;
  if (!isRecord(value)) return invalid(field);
  closed(value, STEP_KEYS, field);
  const { id, dependsOn = [], tool, condition, retry, budget, approvalRequired } = value;
  if (typeof id !== 'string' || !STEP_ID.test(id)) invalid(`${field}.id`);
  if (
    !Array.isArray(dependsOn) ||
    dependsOn.length > MAX_STEP_DEPENDENCIES ||
    dependsOn.some((d) => typeof d !== 'string' || !STEP_ID.test(d)) ||
    new Set(dependsOn).size !== dependsOn.length
  ) {
    invalid(`${field}.dependsOn`);
  }
  if (
    value.specialistId !== undefined &&
    !(typeof value.specialistId === 'string' && UUID.test(value.specialistId))
  ) {
    invalid(`${field}.specialistId`);
  }
  if (
    value.departmentId !== undefined &&
    !(typeof value.departmentId === 'string' && REF_ID.test(value.departmentId))
  ) {
    invalid(`${field}.departmentId`);
  }
  if (
    value.performedBy !== undefined &&
    !(typeof value.performedBy === 'string' && STEP_ID.test(value.performedBy))
  ) {
    invalid(`${field}.performedBy`);
  }
  if (approvalRequired !== undefined && typeof approvalRequired !== 'boolean') {
    invalid(`${field}.approvalRequired`);
  }
  let toolRef: ProposalStep['tool'];
  if (tool !== undefined) {
    if (!isRecord(tool)) return invalid(`${field}.tool`);
    closed(tool, new Set(['id', 'version']), `${field}.tool`);
    if (typeof tool.id !== 'string' || !TOOL_ID.test(tool.id)) invalid(`${field}.tool.id`);
    toolRef = {
      id: tool.id as string,
      version: int(tool.version, 1, Number.MAX_SAFE_INTEGER, `${field}.tool.version`),
    };
  }
  let conditionOf: PlanCondition | undefined;
  if (condition !== undefined) {
    if (!isRecord(condition)) return invalid(`${field}.condition`);
    closed(condition, new Set(['step', 'outcome']), `${field}.condition`);
    if (typeof condition.step !== 'string' || !STEP_ID.test(condition.step)) {
      invalid(`${field}.condition.step`);
    }
    conditionOf = {
      step: condition.step as string,
      outcome: oneOf(['completed', 'failed'], condition.outcome, `${field}.condition.outcome`),
    };
  }
  let retryOf: PlanRetry | undefined;
  if (retry !== undefined) {
    if (!isRecord(retry)) return invalid(`${field}.retry`);
    closed(retry, new Set(['maxAttempts', 'backoffMs']), `${field}.retry`);
    retryOf = {
      maxAttempts: int(retry.maxAttempts, 1, MAX_RETRY_ATTEMPTS, `${field}.retry.maxAttempts`),
      backoffMs: int(retry.backoffMs, 0, MAX_RETRY_BACKOFF_MS, `${field}.retry.backoffMs`),
    };
  }
  let budgetOf: PlanBudget | undefined;
  if (budget !== undefined) {
    if (!isRecord(budget)) return invalid(`${field}.budget`);
    closed(budget, new Set(['inputTokens', 'outputTokens']), `${field}.budget`);
    budgetOf = {
      inputTokens: int(budget.inputTokens, 1, MAX_BUDGET_TOKENS, `${field}.budget.inputTokens`),
      outputTokens: int(budget.outputTokens, 1, MAX_BUDGET_TOKENS, `${field}.budget.outputTokens`),
    };
  }
  return {
    id: id as string,
    kind: oneOf(PLAN_STEP_KINDS, value.kind, `${field}.kind`),
    label: text(value.label, MAX_LABEL_LENGTH, `${field}.label`),
    dependsOn: [...(dependsOn as string[])],
    ...(value.specialistId === undefined ? {} : { specialistId: value.specialistId as string }),
    ...(value.departmentId === undefined ? {} : { departmentId: value.departmentId as string }),
    ...(value.performedBy === undefined ? {} : { performedBy: value.performedBy as string }),
    ...(toolRef === undefined ? {} : { tool: toolRef }),
    ...(value.inputContract === undefined
      ? {}
      : { inputContract: contract(value.inputContract, `${field}.inputContract`) }),
    ...(value.outputContract === undefined
      ? {}
      : { outputContract: contract(value.outputContract, `${field}.outputContract`) }),
    ...(value.verification === undefined
      ? {}
      : { verification: verificationOf(value.verification, `${field}.verification`) }),
    ...(conditionOf === undefined ? {} : { condition: conditionOf }),
    ...(retryOf === undefined ? {} : { retry: retryOf }),
    ...(approvalRequired === undefined ? {} : { approvalRequired: approvalRequired as boolean }),
    ...(budgetOf === undefined ? {} : { budget: budgetOf }),
  };
}

/**
 * The schema stage of the pipeline (ADR-0028): MODEL OUTPUT → **SCHEMA** → policy → permission
 * → plan validation → PLAN. It checks shape only and returns a clean copy with known fields; it
 * decides nothing about who may do what. Authority and credentials anywhere win over a merely
 * malformed field, so the refusal says why.
 */
export function checkProposal(value: unknown): ProposalCheck {
  try {
    if (!isRecord(value)) return invalid('proposal');
    scanSecrets(value, 'proposal');
    closed(value, PROPOSAL_KEYS, 'proposal');
    const { steps } = value;
    if (!Array.isArray(steps) || steps.length === 0 || steps.length > MAX_STEPS) {
      return invalid('steps');
    }
    // Authority anywhere in any step is found before the first malformed step stops the check.
    steps.forEach((step, i) => {
      if (isRecord(step)) {
        for (const key of Object.keys(step)) {
          if (!STEP_KEYS.has(key) && isForbiddenField(key)) {
            refuse('authority_in_proposal', `steps.${i}.${key}`);
          }
        }
      }
    });
    const proposal: PlanProposal = {
      summary: text(value.summary, MAX_SUMMARY_LENGTH, 'summary'),
      objective: text(value.objective, MAX_OBJECTIVE_LENGTH, 'objective'),
      ...(value.riskLevel === undefined
        ? {}
        : { riskLevel: oneOf(RISK_LEVELS, value.riskLevel, 'riskLevel') }),
      steps: steps.map((step, i) => stepOf(step, i)),
    };
    return { ok: true, proposal };
  } catch (error) {
    if (error instanceof Refusal) return { ok: false, reason: error.reason, detail: error.detail };
    throw error;
  }
}
