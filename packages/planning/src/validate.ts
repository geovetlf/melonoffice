import type { DepartmentRepository } from '@melonoffice/departments';
import type {
  Department,
  DepartmentId,
  DeploymentEnvironment,
  ExecutionNode,
  ExecutionNodeId,
  PlanEstimate,
  PlanRequest,
  PlanStep,
  SpecialistId,
  SpecialistVersion,
  ToolId,
  ToolRiskLevel,
  ToolSchema,
} from '@melonoffice/domain';
import { checkGraph, isExecutionError } from '@melonoffice/execution';
import { DEFAULT_RISK_POLICY, effectivePolicy, type RiskPolicy } from '@melonoffice/guardrails';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isSpecialistError, type SpecialistService } from '@melonoffice/specialists';
import type { TenantContext } from '@melonoffice/tenancy';
import {
  isRuntimeInvocable,
  toolCanRun,
  validate as validateInput,
  type ResolvedTool,
  type ToolRegistry,
} from '@melonoffice/tools';
import { totalEstimate, UNKNOWN_ESTIMATE, type PlanEstimator } from './estimate.js';
import { checkProposal, type PlanProposal, type ProposalStep } from './proposal.js';

/**
 * The stages of the pipeline, in order (ADR-0028):
 *
 *   MODEL OUTPUT → SCHEMA → POLICY → PERMISSION → PLAN VALIDATION → PLAN
 */
export type ValidationStage = 'schema' | 'policy' | 'permission' | 'plan';

/** A plan the system checked: every decision in it was made here, not by the proposal. */
export interface ValidatedPlan {
  readonly request: PlanRequest;
  readonly steps: readonly PlanStep[];
  readonly riskLevel: ToolRiskLevel;
  readonly approvalRequired: boolean;
  readonly estimate: PlanEstimate;
}

export type PlanValidation =
  | { readonly ok: true; readonly plan: ValidatedPlan }
  | {
      readonly ok: false;
      readonly stage: ValidationStage;
      /** A stable code, safe to audit. */
      readonly reason: string;
      /** Which step or field, as a path. Never user text. */
      readonly detail?: string;
    };

export interface PlanValidator {
  validate(tenant: TenantContext, proposal: unknown): Promise<PlanValidation>;
}

export interface PlanValidatorOptions {
  readonly specialists: Pick<SpecialistService, 'get' | 'getVersion' | 'eligibility'>;
  readonly departments: Pick<DepartmentRepository, 'find'>;
  readonly tools: ToolRegistry;
  readonly authorization: Pick<AuthorizationService, 'permissionsOf'>;
  /** Where this server runs. Undefined: no tool step is allowed (fail closed). */
  readonly environment: DeploymentEnvironment | undefined;
  readonly riskPolicy?: RiskPolicy;
  readonly estimator?: PlanEstimator;
}

class Refusal {
  constructor(
    readonly stage: ValidationStage,
    readonly reason: string,
    readonly detail?: string,
  ) {}
}
const refuse = (stage: ValidationStage, reason: string, detail?: string): never => {
  throw new Refusal(stage, reason, detail);
};

const RISK_ORDER: readonly ToolRiskLevel[] = ['low', 'medium', 'high', 'critical'];
const higher = (a: ToolRiskLevel, b: ToolRiskLevel): ToolRiskLevel =>
  RISK_ORDER.indexOf(a) >= RISK_ORDER.indexOf(b) ? a : b;

/** Fields each kind may carry; everything else on that kind is refused. */
const FIELDS: Readonly<Record<PlanStep['kind'], readonly (keyof ProposalStep)[]>> = {
  specialist: [
    'specialistId',
    'departmentId',
    'inputContract',
    'outputContract',
    'verification',
    'retry',
    'approvalRequired',
    'budget',
  ],
  tool: ['performedBy', 'tool', 'input', 'inputFrom', 'retry', 'approvalRequired'],
  approval: [],
  verification: ['verification', 'outputContract', 'approvalRequired'],
  condition: ['condition', 'decision', 'approvalRequired'],
  parallel: [],
  wait: ['wait'],
};
const OPTIONAL_FIELDS = new Set<keyof ProposalStep>(['id', 'kind', 'label', 'dependsOn']);

/**
 * Schema stage, second half: each kind carries exactly what it needs. A workflow's specialist step
 * names who does it later, when the workflow is planned (`boundLater`), never a specialist now.
 */
function checkShape(step: ProposalStep, field: string, boundLater = false): void {
  const allowed = new Set<keyof ProposalStep>([...OPTIONAL_FIELDS, ...FIELDS[step.kind]]);
  for (const key of Object.keys(step) as (keyof ProposalStep)[]) {
    if (!allowed.has(key)) refuse('schema', 'invalid_proposal', `${field}.${key}`);
  }
  const need = (present: boolean, name: string) => {
    if (!present) refuse('schema', 'invalid_proposal', `${field}.${name}`);
  };
  switch (step.kind) {
    case 'specialist':
      if (!boundLater) need(step.specialistId !== undefined, 'specialistId');
      break;
    case 'tool':
      need(step.performedBy !== undefined, 'performedBy');
      need(step.tool !== undefined, 'tool');
      break;
    case 'verification':
      need(step.dependsOn.length > 0, 'dependsOn');
      break;
    case 'condition':
      // Either how another step ended, or a decision (WF-4), never both. A decision is made on
      // the plan's progress: it waits on at least one step.
      need((step.condition === undefined) !== (step.decision === undefined), 'condition');
      if (step.decision !== undefined) need(step.dependsOn.length > 0, 'dependsOn');
      break;
    case 'wait':
      // A wait delays what follows the steps before it (ADR-0152): it waits on at least one.
      need(step.wait !== undefined, 'wait');
      need(step.dependsOn.length > 0, 'dependsOn');
      break;
    case 'approval':
    case 'parallel':
      break;
  }
}

/** Plan stage: dependencies, conditions and the graph, with X1's own graph check. */
function checkPlanShape(steps: readonly ProposalStep[]): void {
  const byId = new Map(steps.map((s) => [s.id, s]));
  if (byId.size !== steps.length) refuse('plan', 'duplicate_step');
  for (const [i, step] of steps.entries()) {
    const field = `steps.${i}`;
    for (const dependency of step.dependsOn) {
      const target = byId.get(dependency);
      if (target === undefined) continue; // the graph check names it
      if (step.kind === 'tool') {
        // A tool step lives in its specialist's own execution: it can only wait on that
        // specialist's step or on the same specialist's other tool steps.
        const sameWork =
          dependency === step.performedBy ||
          (target.kind === 'tool' && target.performedBy === step.performedBy);
        if (!sameWork) refuse('plan', 'invalid_tool_dependency', field);
      } else if (target.kind === 'tool') {
        // Other steps wait on the specialist step that uses the tool, which ends with it.
        refuse('plan', 'invalid_dependency', field);
      }
    }
    if (step.kind === 'tool') {
      const performer = byId.get(step.performedBy as string);
      if (performer?.kind !== 'specialist') refuse('plan', 'invalid_performer', field);
    }
    if (step.condition !== undefined && !step.dependsOn.includes(step.condition.step)) {
      refuse('plan', 'invalid_condition', field);
    }
  }
  const nodes = steps.map(
    (s): ExecutionNode =>
      ({
        id: s.id as ExecutionNodeId,
        type: 'agent',
        label: s.label,
        status: 'pending',
        dependsOn: s.dependsOn as ExecutionNodeId[],
      }) satisfies ExecutionNode,
  );
  try {
    checkGraph(nodes);
  } catch (error) {
    if (!isExecutionError(error)) throw error;
    const problem = error.detail ?? '';
    const reason =
      problem === 'nodes.cycle'
        ? 'plan_cycle'
        : problem === 'nodes.self_dependency'
          ? 'self_dependency'
          : problem === 'nodes.too_many'
            ? 'too_many_steps'
            : problem === 'nodes.duplicate_id'
              ? 'duplicate_step'
              : 'unknown_dependency';
    refuse('plan', reason);
  }
  steps.forEach((step, i) => checkInputRefs(step, byId, `steps.${i}`));
}

/** Every step a step waits for, directly or through others. */
function ancestorsOf(step: ProposalStep, byId: ReadonlyMap<string, ProposalStep>): Set<string> {
  const seen = new Set<string>();
  const visit = (id: string) => {
    if (seen.has(id)) return;
    seen.add(id);
    byId.get(id)?.dependsOn.forEach(visit);
  };
  step.dependsOn.forEach(visit);
  return seen;
}

/**
 * A tool step's input references (ADR-0161) name results that exist before it runs: the answer
 * of its own specialist step or of one it waits for, a field of a tool step it waits for in the
 * same work, or a field of a tool step an earlier specialist step used (that work ended with it).
 * A key is either fixed or referenced, never both.
 */
function checkInputRefs(
  step: ProposalStep,
  byId: ReadonlyMap<string, ProposalStep>,
  field: string,
): void {
  if (step.inputFrom === undefined) return;
  const before = ancestorsOf(step, byId);
  for (const [key, ref] of Object.entries(step.inputFrom)) {
    const at = `${field}.inputFrom.${key}`;
    if (step.input !== undefined && Object.hasOwn(step.input, key)) {
      refuse('plan', 'invalid_input_ref', at);
    }
    const source = byId.get(ref.step);
    const ready =
      source?.kind === 'specialist'
        ? ref.field === undefined && before.has(source.id)
        : source?.kind === 'tool' &&
          ref.field !== undefined &&
          (before.has(source.id) ||
            (source.performedBy !== step.performedBy && before.has(source.performedBy as string)));
    if (!ready) refuse('plan', 'invalid_input_ref', at);
  }
}

/**
 * The structure a plan must have whatever organization it is for (ADR-0156): each step carries
 * exactly what its kind needs, tool steps wait only on their own specialist's work, and the
 * dependencies form one graph with no cycle. A workflow is checked with it when a version is
 * saved, so a template every plan would refuse is never stored. Reads nothing, decides nothing
 * about specialists, tools or permissions: those stay with the validator, per organization.
 */
export function checkStepStructure(
  steps: readonly ProposalStep[],
  options: { readonly boundLater?: boolean } = {},
):
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: string; readonly detail?: string } {
  try {
    steps.forEach((step, i) => checkShape(step, `steps.${i}`, options.boundLater === true));
    checkPlanShape(steps);
    return { ok: true };
  } catch (error) {
    if (!(error instanceof Refusal)) throw error;
    return {
      ok: false,
      reason: error.reason,
      ...(error.detail === undefined ? {} : { detail: error.detail }),
    };
  }
}

/** A tool's input schema as the fixed input must satisfy it: the referenced keys come later. */
function fixedPartOf(schema: ToolSchema, step: ProposalStep): ToolSchema {
  if (step.inputFrom === undefined || schema.type !== 'object') return schema;
  const later = new Set(Object.keys(step.inputFrom));
  return {
    ...schema,
    ...(schema.required === undefined
      ? {}
      : { required: schema.required.filter((k) => !later.has(k)) }),
  };
}

/** Two schemas hold the same kind of value: the same type, and for lists, the same items. */
function sameShape(a: ToolSchema, b: ToolSchema): boolean {
  if (a.type === 'array' && b.type === 'array') return sameShape(a.items, b.items);
  if (a.type === 'integer' && b.type === 'number') return true;
  return a.type === b.type;
}

interface ResolvedSpecialist {
  readonly version: SpecialistVersion;
  readonly department: Department | undefined;
}

/**
 * Builds the validator (ADR-0028). The proposal proposes; this decides. It reuses what exists:
 * X2 eligibility for specialists, the X3 registry and risk policy for tools, X1's graph check,
 * and the AI Gateway's router for estimates. It creates nothing and runs nothing.
 */
export function createPlanValidator(options: PlanValidatorOptions): PlanValidator {
  const {
    specialists,
    departments,
    tools,
    authorization,
    environment,
    riskPolicy = DEFAULT_RISK_POLICY,
    estimator,
  } = options;

  async function resolveSpecialist(
    tenant: TenantContext,
    step: ProposalStep,
    field: string,
  ): Promise<ResolvedSpecialist> {
    const id = step.specialistId as string;
    let specialist;
    try {
      specialist = await specialists.get(tenant, id);
    } catch (error) {
      if (isSpecialistError(error) && error.code === 'specialist_not_found') {
        return refuse('permission', 'specialist_not_eligible', `${field}.specialist_not_found`);
      }
      throw error;
    }
    const own = specialist.configuration.departmentId;
    // A proposal never moves a specialist: Marketing does not become Finance.
    if (step.departmentId !== undefined && step.departmentId !== own) {
      refuse('permission', 'department_mismatch', field);
    }
    const decision = await specialists.eligibility(tenant, {
      specialistId: id,
      departmentId: own,
      version: specialist.version,
    });
    if (!decision.eligible) {
      return refuse('permission', 'specialist_not_eligible', `${field}.${decision.reason}`);
    }
    const version = await specialists.getVersion(tenant, id, decision.assignment.specialistVersion);
    const department = await departments.find(specialist.organizationId, own as DepartmentId);
    return { version, department };
  }

  /** Policy stage for one tool step: what the tool is and whether it may be used at all. */
  function toolPolicy(
    step: ProposalStep,
    performer: ResolvedSpecialist,
    field: string,
  ): { readonly tool: ResolvedTool; readonly approval: boolean } {
    const ref = step.tool as { id: string; version: number };
    const tool = tools.resolve(ref.id, ref.version);
    if (tool === undefined) return refuse('policy', 'tool_not_found', field);
    if (!toolCanRun(tool.definition.status)) refuse('policy', 'tool_not_active', field);
    // A plan's steps run on the runtime: a tool only a person may invoke is never planned (ADR-0034).
    if (!isRuntimeInvocable(tool.version)) refuse('policy', 'tool_not_runtime_invocable', field);
    if (environment === undefined || !tool.version.environments.includes(environment)) {
      refuse('policy', 'environment_not_allowed', field);
    }
    const { departmentTypes } = tool.version;
    if (departmentTypes !== undefined) {
      const { department } = performer;
      if (
        department === undefined ||
        department.origin.kind !== 'catalog' ||
        !departmentTypes.includes(department.origin.typeId)
      ) {
        refuse('policy', 'department_not_allowed', field);
      }
    }
    const policy = effectivePolicy(tool, riskPolicy);
    if (policy === 'denied') refuse('policy', 'tool_denied_by_policy', field);
    // Tool steps read only, inside MelonOffice (ADR-0159): no tool that changes anything, reaches
    // an external provider or needs a credential is ever planned.
    if (
      tool.version.mutating ||
      tool.version.provider.kind !== 'internal' ||
      tool.version.credentials.length > 0
    ) {
      refuse('policy', 'tool_not_read_only', field);
    }
    // The input is fixed now (ADR-0151): it must already satisfy the tool's own schema, but for
    // the keys read from earlier steps when it runs (ADR-0161). The Tool Gate checks the whole
    // input again, with everything else, when the step runs.
    if (!validateInput(fixedPartOf(tool.version.inputSchema, step), step.input ?? {}).valid) {
      refuse('policy', 'invalid_tool_input', `${field}.input`);
    }
    const approval = policy === 'approval_required';
    // A person approves a tool call with its exact input (ADR-0151): an input only known when the
    // step runs is never put to them, so a tool step that needs an approval takes fixed input only.
    if (step.inputFrom !== undefined && (approval || step.approvalRequired === true)) {
      refuse('policy', 'input_ref_needs_fixed_input', `${field}.inputFrom`);
    }
    return { tool, approval };
  }

  /**
   * Policy stage for a tool step's references (ADR-0161): each names an input the tool has, and
   * what it reads has that input's type. An agent's answer is model text, so it reaches only a
   * text input of a low-risk tool: a model never writes the arguments of a riskier one (D3).
   */
  function toolRefPolicy(
    step: ProposalStep,
    tool: ResolvedTool,
    sources: ReadonlyMap<string, { tool: ResolvedTool }>,
    byId: ReadonlyMap<string, ProposalStep>,
    field: string,
  ): void {
    const schema = tool.version.inputSchema;
    for (const [key, ref] of Object.entries(step.inputFrom ?? {})) {
      const at = `${field}.inputFrom.${key}`;
      const target = schema.type === 'object' ? schema.properties[key] : undefined;
      if (target === undefined) return refuse('policy', 'invalid_tool_input_ref', at);
      const source = byId.get(ref.step);
      if (source?.kind === 'specialist') {
        if (target.type !== 'string') refuse('policy', 'invalid_tool_input_ref', at);
        if (tool.version.riskLevel !== 'low') refuse('policy', 'tool_input_from_model', at);
        continue;
      }
      const from = sources.get(ref.step)?.tool.version.outputSchema;
      // A missing source, or one named without its field, is the plan stage's to name.
      if (from === undefined || ref.field === undefined) continue;
      const read = from.type === 'object' ? from.properties[ref.field] : undefined;
      if (read === undefined || !sameShape(read, target)) {
        refuse('policy', 'invalid_tool_input_ref', at);
      }
    }
  }

  /** Permission stage for one tool step: the specialist version lists it, the user may use it. */
  function toolPermission(
    tool: ResolvedTool,
    performer: ResolvedSpecialist,
    permissions: ReadonlySet<string>,
    field: string,
  ): void {
    const listed = performer.version.configuration.tools.some(
      (t) => t.id === tool.version.toolId && t.version === tool.version.version,
    );
    if (!listed) refuse('permission', 'tool_not_assigned', field);
    if (
      !permissions.has('tool.execute') ||
      !tool.version.permissions.every((p) => permissions.has(p))
    ) {
      refuse('permission', 'permission_not_held', field);
    }
  }

  return Object.freeze({
    async validate(tenant: TenantContext, value: unknown): Promise<PlanValidation> {
      try {
        // 1. Schema.
        const checked = checkProposal(value);
        if (!checked.ok) return refuse('schema', checked.reason, checked.detail);
        const proposal: PlanProposal = checked.proposal;
        proposal.steps.forEach((step, i) => checkShape(step, `steps.${i}`));

        // Facts, read for this tenant only. Reading decides nothing.
        const resolved = new Map<string, ResolvedSpecialist>();
        const failures: Refusal[] = [];
        for (const [i, step] of proposal.steps.entries()) {
          if (step.kind !== 'specialist') continue;
          try {
            resolved.set(step.id, await resolveSpecialist(tenant, step, `steps.${i}`));
          } catch (error) {
            if (!(error instanceof Refusal)) throw error;
            failures.push(error);
          }
        }
        const permissions = authorization.permissionsOf(tenant);

        // 2. Policy: tools, verification, and the plan's risk.
        let riskLevel: ToolRiskLevel = proposal.riskLevel ?? 'low';
        const toolsOf = new Map<string, { tool: ResolvedTool; approval: boolean }>();
        for (const [i, step] of proposal.steps.entries()) {
          const field = `steps.${i}`;
          if ((step.kind === 'specialist' || step.kind === 'verification') && !step.verification) {
            refuse('policy', 'verification_missing', field);
          }
          if (step.kind !== 'tool') continue;
          const performer = resolved.get(step.performedBy as string);
          if (performer === undefined) {
            // The performer is missing or ineligible: that is the refusal, at its own stage.
            if (failures.length > 0) break;
            return refuse('plan', 'invalid_performer', field);
          }
          const found = toolPolicy(step, performer, field);
          toolsOf.set(step.id, found);
          riskLevel = higher(riskLevel, found.tool.version.riskLevel);
        }
        const byId = new Map(proposal.steps.map((s) => [s.id, s]));
        for (const [i, step] of proposal.steps.entries()) {
          const found = toolsOf.get(step.id);
          if (found !== undefined) toolRefPolicy(step, found.tool, toolsOf, byId, `steps.${i}`);
        }
        if (riskPolicy[riskLevel] === 'denied') refuse('policy', 'plan_denied_by_policy');

        // 3. Permission: eligibility (already decided above), tool assignment, user permissions.
        const [firstFailure] = failures;
        if (firstFailure !== undefined) throw firstFailure;
        for (const [i, step] of proposal.steps.entries()) {
          const found = toolsOf.get(step.id);
          const performer = resolved.get(step.performedBy ?? '');
          if (found === undefined || performer === undefined) continue;
          toolPermission(found.tool, performer, permissions, `steps.${i}`);
        }

        // 4. Plan: dependencies, conditions, graph.
        checkPlanShape(proposal.steps);

        // The plan, with every decision made by the system.
        const estimates: PlanEstimate[] = [];
        const steps = proposal.steps.map((step): PlanStep => {
          const found = toolsOf.get(step.id);
          const specialist = resolved.get(step.id);
          const approvalRequired =
            step.kind === 'approval' || step.approvalRequired === true || found?.approval === true;
          const estimate =
            specialist === undefined
              ? undefined
              : (estimator?.estimate(specialist.version, step.budget) ?? UNKNOWN_ESTIMATE);
          if (estimate !== undefined) estimates.push(estimate);
          return {
            id: step.id,
            kind: step.kind,
            label: step.label,
            dependsOn: step.dependsOn,
            ...(specialist === undefined
              ? {}
              : {
                  specialist: {
                    id: specialist.version.specialistId as SpecialistId,
                    version: specialist.version.version,
                    departmentId: specialist.version.configuration.departmentId,
                  },
                }),
            ...(step.performedBy === undefined ? {} : { performedBy: step.performedBy }),
            ...(found === undefined
              ? {}
              : {
                  tool: {
                    id: found.tool.version.toolId as ToolId,
                    version: found.tool.version.version,
                  },
                  input: structuredClone(step.input ?? {}),
                  ...(step.inputFrom === undefined
                    ? {}
                    : { inputFrom: structuredClone(step.inputFrom) }),
                  inputContract: found.tool.version.inputSchema,
                  outputContract: found.tool.version.outputSchema,
                }),
            ...(found === undefined && step.inputContract !== undefined
              ? { inputContract: step.inputContract }
              : {}),
            ...(found === undefined && step.outputContract !== undefined
              ? { outputContract: step.outputContract }
              : {}),
            ...(step.verification === undefined ? {} : { verification: step.verification }),
            ...(step.condition === undefined ? {} : { condition: step.condition }),
            ...(step.decision === undefined ? {} : { decision: step.decision }),
            ...(step.wait === undefined ? {} : { wait: step.wait }),
            ...(step.retry === undefined ? {} : { retry: step.retry }),
            approvalRequired,
            ...(step.budget === undefined ? {} : { budget: step.budget }),
            ...(estimate === undefined ? {} : { estimate }),
          };
        });
        const approvalRequired =
          steps.some((s) => s.approvalRequired) || riskPolicy[riskLevel] === 'approval_required';
        return {
          ok: true,
          plan: {
            request: { summary: proposal.summary, objective: proposal.objective },
            steps,
            riskLevel,
            approvalRequired,
            estimate: totalEstimate(estimates),
          },
        };
      } catch (error) {
        if (!(error instanceof Refusal)) throw error;
        return {
          ok: false,
          stage: error.stage,
          reason: error.reason,
          ...(error.detail === undefined ? {} : { detail: error.detail }),
        };
      }
    },
  });
}
