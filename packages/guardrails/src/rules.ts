import type {
  Department,
  DeploymentEnvironment,
  Execution,
  ExecutionMode,
  ExecutionNode,
  SpecialistVersion,
  ToolApprovalPolicy,
  ToolRiskLevel,
} from '@melonoffice/domain';
import type { EligibilityDecision } from '@melonoffice/specialists';
import { toolCanRun, validate, type ResolvedTool, type ToolExecutors } from '@melonoffice/tools';

/**
 * What a guardrail decides (ADR-0026). `deny` and `require_approval` carry a stable reason code,
 * safe to log and audit. Nothing is ever allowed by default: every check must pass.
 */
export type GuardrailDecision =
  | { readonly decision: 'allow' }
  | { readonly decision: 'deny'; readonly reason: GuardrailDenyReason }
  | { readonly decision: 'require_approval'; readonly reason: 'approval_required' };

export type GuardrailDenyReason =
  | 'execution_not_found'
  | 'execution_not_running'
  | 'node_not_found'
  | 'node_not_tool'
  | 'node_not_pending'
  | 'no_specialist'
  | 'specialist_not_eligible'
  | 'tool_not_found'
  | 'tool_not_active'
  | 'tool_not_assigned'
  | 'department_not_allowed'
  | 'permission_not_held'
  | 'environment_not_allowed'
  | 'mode_forbids_mutation'
  | 'executor_unavailable'
  | 'invalid_input'
  | 'tool_denied_by_policy';

/**
 * The approval policy each risk level gets by default. A tool's own policy can only make this
 * stricter, never looser. This is a safe default, not a product decision: it is configuration.
 */
export type RiskPolicy = Readonly<Record<ToolRiskLevel, ToolApprovalPolicy>>;

export const DEFAULT_RISK_POLICY: RiskPolicy = Object.freeze({
  low: 'auto',
  medium: 'auto',
  high: 'approval_required',
  critical: 'denied',
});

const STRICTNESS: Readonly<Record<ToolApprovalPolicy, number>> = {
  auto: 0,
  approval_required: 1,
  denied: 2,
};

/** The stricter of the tool's own policy and the one its risk level gets. */
export const effectivePolicy = (tool: ResolvedTool, policy: RiskPolicy): ToolApprovalPolicy => {
  const own = tool.version.approvalPolicy;
  const byRisk = policy[tool.version.riskLevel];
  return STRICTNESS[own] >= STRICTNESS[byRisk] ? own : byRisk;
};

/** Modes that only answer, plan or review: a tool that changes something never runs in them. */
export const READ_ONLY_MODES: readonly ExecutionMode[] = Object.freeze(['ask', 'plan', 'review']);

/** Execution statuses in which a tool node may run, or wait on its approval. */
const RUNNABLE: readonly Execution['status'][] = ['running', 'waiting_approval'];

/** Everything the pre-execution guardrails decide from, read for the tenant's organization. */
export interface PreExecutionFacts {
  readonly execution: Execution | undefined;
  readonly nodeId: string;
  /** The specialist's eligibility right now, from the specialists service. */
  readonly eligibility: EligibilityDecision | undefined;
  readonly specialistVersion: SpecialistVersion | undefined;
  readonly department: Department | undefined;
  readonly tool: ResolvedTool | undefined;
  /** The permissions the tenant's user holds (RBAC `permissionsOf`). GIA gets exactly these. */
  readonly permissions: ReadonlySet<string>;
  /** Where this server runs. Unknown means nothing runs. */
  readonly environment: DeploymentEnvironment | undefined;
  readonly executors: ToolExecutors;
  readonly riskPolicy: RiskPolicy;
  readonly input: unknown;
}

const deny = (reason: GuardrailDenyReason): GuardrailDecision =>
  Object.freeze({ decision: 'deny', reason });

const ALLOW: GuardrailDecision = Object.freeze({ decision: 'allow' });
const APPROVAL: GuardrailDecision = Object.freeze({
  decision: 'require_approval',
  reason: 'approval_required',
});

export const nodeOf = (
  execution: Execution | undefined,
  nodeId: string,
): ExecutionNode | undefined => execution?.nodes.find((n) => n.id === nodeId);

/**
 * The pre-execution guardrails (ADR-0026). Deterministic, and every check must hold, in this
 * order:
 *
 * 1. the execution exists in the tenant's organization;
 * 2. it is running, or waiting on this node's approval;
 * 3. the node exists, 4. is a `tool` node and 5. is still `pending`;
 * 6. the execution has a specialist, and 7. that specialist is still eligible (active, in its
 *    active department, at its current version, and the user holds its permissions);
 * 8. the node's exact tool version exists and 9. the tool is `active`;
 * 10. the specialist's version lists exactly that tool version;
 * 11. the tool allows the specialist's department type, when it restricts them;
 * 12. the user holds `tool.execute` and every permission the tool needs (GIA gets no more);
 * 13. the tool version allows this environment (an unknown one allows nothing);
 * 14. a tool that changes something does not run in a read-only mode;
 * 15. an executor for the tool's provider is available;
 * 16. the input matches the tool's closed schema, with no authority or credential in it;
 * 17. the policy: `denied` denies, `approval_required` requires an approval, `auto` allows.
 *
 * Whether an attached approval covers the call is checked by the gate, against the approval.
 */
export function evaluatePreExecution(facts: PreExecutionFacts): GuardrailDecision {
  const { execution, tool, specialistVersion } = facts;
  if (execution === undefined) return deny('execution_not_found');
  if (!RUNNABLE.includes(execution.status)) return deny('execution_not_running');
  const node = nodeOf(execution, facts.nodeId);
  if (node === undefined) return deny('node_not_found');
  if (node.type !== 'tool' || node.tool === undefined) return deny('node_not_tool');
  if (node.status !== 'pending') return deny('node_not_pending');
  if (execution.status === 'waiting_approval' && node.approvalId === undefined) {
    return deny('execution_not_running');
  }
  if (execution.specialistId === undefined || execution.specialistVersion === undefined) {
    return deny('no_specialist');
  }
  if (facts.eligibility?.eligible !== true || specialistVersion === undefined) {
    return deny('specialist_not_eligible');
  }
  if (
    specialistVersion.specialistId !== execution.specialistId ||
    specialistVersion.version !== execution.specialistVersion
  ) {
    return deny('specialist_not_eligible');
  }
  if (
    tool === undefined ||
    tool.version.toolId !== node.tool.id ||
    tool.version.version !== node.tool.version
  ) {
    return deny('tool_not_found');
  }
  if (!toolCanRun(tool.definition.status)) return deny('tool_not_active');
  const assigned = specialistVersion.configuration.tools.some(
    (t) => t.id === node.tool?.id && t.version === node.tool.version,
  );
  if (!assigned) return deny('tool_not_assigned');
  const { departmentTypes } = tool.version;
  if (departmentTypes !== undefined) {
    const department = facts.department;
    if (
      department === undefined ||
      department.id !== specialistVersion.configuration.departmentId ||
      department.origin.kind !== 'catalog' ||
      !departmentTypes.includes(department.origin.typeId)
    ) {
      return deny('department_not_allowed');
    }
  }
  if (
    !facts.permissions.has('tool.execute') ||
    !tool.version.permissions.every((p) => facts.permissions.has(p))
  ) {
    return deny('permission_not_held');
  }
  if (facts.environment === undefined || !tool.version.environments.includes(facts.environment)) {
    return deny('environment_not_allowed');
  }
  if (tool.version.mutating && READ_ONLY_MODES.includes(execution.mode)) {
    return deny('mode_forbids_mutation');
  }
  if (!Object.hasOwn(facts.executors, tool.version.provider.id)) {
    return deny('executor_unavailable');
  }
  if (!validate(tool.version.inputSchema, facts.input).valid) return deny('invalid_input');
  switch (effectivePolicy(tool, facts.riskPolicy)) {
    case 'denied':
      return deny('tool_denied_by_policy');
    case 'approval_required':
      return APPROVAL;
    case 'auto':
      return ALLOW;
  }
}

/** Why a tool's output was not accepted. */
export type PostExecutionProblem = 'output_rejected';

/**
 * The post-execution guardrails (ADR-0026): the output must match the tool's closed output
 * schema, carry no authority fields and no value that looks like a credential. An output that
 * fails is never passed on, and the node fails. Later phases add verification (X5) here.
 */
export function evaluatePostExecution(
  tool: ResolvedTool,
  output: unknown,
): PostExecutionProblem | undefined {
  return validate(tool.version.outputSchema, output).valid ? undefined : 'output_rejected';
}
