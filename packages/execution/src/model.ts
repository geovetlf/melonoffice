import type {
  ApprovalId,
  DepartmentId,
  Execution,
  ExecutionFailure,
  ExecutionId,
  ExecutionMode,
  ExecutionNode,
  ExecutionNodeId,
  ExecutionNodeStatus,
  ExecutionNodeType,
  ExecutionRef,
  ExecutionStatus,
  ExecutionVersionSnapshot,
  IsoTimestamp,
  OrganizationId,
  ExecutionToolRef,
  ExecutionVerification,
  NodeVerification,
  SpecialistId,
  ToolId,
  UserId,
  VerificationCheck,
  ExecutionVerificationPolicy,
  VerificationResult,
  VersionRef,
  WorkflowId,
} from '@melonoffice/domain';
import { createHash, randomUUID } from 'node:crypto';
import { ExecutionError } from './errors.js';
import {
  canTransition,
  isExecutionMode,
  isExecutionStatus,
  isNodeFinal,
  isNodeStatus,
  isTerminal,
  NODE_TRANSITIONS,
} from './lifecycle.js';

/** Limits that keep one execution document small and bounded. */
export const MAX_NODES = 200;
export const MAX_DEPENDENCIES = 50;
export const MAX_SNAPSHOT_COMPONENTS = 100;
export const MAX_LABEL_LENGTH = 120;
/** A node runs at most twice: its first attempt and one automatic retry (ADR-0029). */
export const MAX_NODE_ATTEMPTS = 2;
export const MAX_VERIFICATION_CHECKS = 20;

/** Policies a verification may use. `human_review` and `specialist_review` are not here yet. */
export const VERIFICATION_POLICIES = [
  'output_schema',
  'checks',
] as const satisfies readonly ExecutionVerificationPolicy[];

/**
 * Node types that have no external effect by construction: they only decide over data the
 * execution already holds. Only these are retried without an idempotency key (ADR-0029, rule A).
 */
export const EFFECT_FREE_NODE_TYPES: readonly ExecutionNodeType[] = [
  'condition',
  'parallel',
  'verification',
];

/**
 * Node failure codes that mean nobody knows whether the work happened: a timeout, a lost worker.
 * Such a node is never re-run automatically (ADR-0029, rule C).
 */
export const UNKNOWN_OUTCOME_CODES: readonly string[] = ['outcome_unknown', 'timeout'];

export const NODE_TYPES = [
  'agent',
  'workflow',
  'tool',
  'approval',
  'condition',
  'verification',
  'parallel',
  'delay',
  'event',
] as const satisfies readonly ExecutionNodeType[];

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
// Same shape as an audit reason, so any failure or cancellation code can be recorded there.
const CODE = /^[a-z][a-z_]{0,63}$/;
const KIND = /^[a-z][a-z0-9_]{0,63}$/;
const REF_ID = /^[A-Za-z0-9._:-]{1,128}$/;
const VERSION = /^[A-Za-z0-9._:-]{1,64}$/;
const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const REQUEST_ID = /^[\w-]{1,128}$/;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;

export const isExecutionId = (value: unknown): value is ExecutionId =>
  typeof value === 'string' && UUID.test(value);

const invalid = (detail: string): never => {
  throw new ExecutionError('invalid_execution', detail);
};

const IDEMPOTENCY_KEY = /^[A-Za-z0-9._:-]{1,200}$/;

export const isIdempotencyKey = (value: unknown): value is string =>
  typeof value === 'string' && IDEMPOTENCY_KEY.test(value);

/**
 * The one execution id an organization's idempotency key can ever have (ADR-0028): a name-based
 * UUID (version 8) from SHA-256 of the organization and the key. The same key in the same
 * organization always names the same execution, so creating it twice is refused by the store
 * instead of making a duplicate; another organization's key names another execution.
 */
export function executionIdFor(organizationId: OrganizationId, key: string): ExecutionId {
  if (!isIdempotencyKey(key)) invalid('idempotencyKey');
  const hex = createHash('sha256')
    .update(`melonoffice.execution\u0000${organizationId}\u0000${key}`)
    .digest('hex');
  const variant = ((parseInt(hex[16] as string, 16) & 0x3) | 0x8).toString(16);
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `8${hex.slice(13, 16)}`,
    `${variant}${hex.slice(17, 20)}`,
    hex.slice(20, 32),
  ].join('-') as ExecutionId;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Checks a reference and returns a frozen copy with only its known fields. */
export function checkRef(value: unknown, field: string): ExecutionRef {
  if (!isRecord(value)) return invalid(field);
  const { type, id } = value;
  if (typeof type !== 'string' || !KIND.test(type)) return invalid(`${field}.type`);
  if (typeof id !== 'string' || !REF_ID.test(id)) return invalid(`${field}.id`);
  return Object.freeze({ type, id });
}

export function checkVersionRef(value: unknown, field: string): VersionRef {
  if (!isRecord(value)) return invalid(field);
  const { kind, id, version } = value;
  if (typeof kind !== 'string' || !KIND.test(kind)) return invalid(`${field}.kind`);
  if (typeof id !== 'string' || !REF_ID.test(id)) return invalid(`${field}.id`);
  if (typeof version !== 'string' || !VERSION.test(version)) return invalid(`${field}.version`);
  return Object.freeze({ kind, id, version });
}

export function checkFailure(value: unknown, field: string): ExecutionFailure {
  if (!isRecord(value)) return invalid(field);
  const { code, ref } = value;
  if (typeof code !== 'string' || !CODE.test(code)) return invalid(`${field}.code`);
  return Object.freeze({
    code,
    ...(ref === undefined ? {} : { ref: checkRef(ref, `${field}.ref`) }),
  });
}

/**
 * Checks and freezes a version snapshot. Each component (kind + id) appears once, so the
 * snapshot says unambiguously which version was used.
 */
export function checkSnapshot(value: unknown): ExecutionVersionSnapshot {
  if (!isRecord(value) || value.schemaVersion !== 1) return invalid('versionSnapshot');
  const { components } = value;
  if (!Array.isArray(components) || components.length > MAX_SNAPSHOT_COMPONENTS) {
    return invalid('versionSnapshot.components');
  }
  const checked = components.map((c, i) => checkVersionRef(c, `versionSnapshot.components.${i}`));
  const keys = new Set(checked.map((c) => `${c.kind}\n${c.id}`));
  if (keys.size !== checked.length) return invalid('versionSnapshot.duplicate');
  // An execution runs with one Company Context version at most (ADR-0029).
  if (checked.filter((c) => c.kind === 'company_context').length > 1) {
    return invalid('versionSnapshot.company_context');
  }
  return Object.freeze({ schemaVersion: 1, components: Object.freeze(checked) });
}

/** A node as a caller describes it. Its status always starts at `pending`. */
export interface NodeInput {
  readonly id: string;
  readonly type: ExecutionNodeType;
  readonly label: string;
  readonly dependsOn?: readonly string[];
  readonly owner?: VersionRef;
  readonly input?: ExecutionRef;
  /** Required on `tool` nodes and refused on any other: the exact tool version to run. */
  readonly tool?: { readonly id: string; readonly version: number };
}

const TOOL_ID = /^[a-z][a-z0-9_]{0,63}$/;
const APPROVAL_ID = UUID;

/** Checks a node's tool reference: present exactly on `tool` nodes. */
function checkNodeTool(type: string, tool: unknown, field: string): ExecutionToolRef | undefined {
  if (type !== 'tool') {
    if (tool !== undefined) invalid(`${field}.tool`);
    return undefined;
  }
  if (!isRecord(tool)) return invalid(`${field}.tool`);
  const { id, version } = tool;
  if (typeof id !== 'string' || !TOOL_ID.test(id)) return invalid(`${field}.tool.id`);
  if (typeof version !== 'number' || !Number.isSafeInteger(version) || version < 1) {
    return invalid(`${field}.tool.version`);
  }
  return Object.freeze({ id: id as ToolId, version });
}

function checkNodeInput(value: unknown, index: number): ExecutionNode {
  const field = `nodes.${index}`;
  if (!isRecord(value)) return invalid(field);
  const { id, type, label, dependsOn = [], owner, input, tool } = value;
  if (typeof id !== 'string' || !NODE_ID.test(id)) return invalid(`${field}.id`);
  if (typeof type !== 'string' || !(NODE_TYPES as readonly string[]).includes(type)) {
    return invalid(`${field}.type`);
  }
  if (
    typeof label !== 'string' ||
    label.trim() === '' ||
    label.length > MAX_LABEL_LENGTH ||
    CONTROL.test(label)
  ) {
    return invalid(`${field}.label`);
  }
  if (
    !Array.isArray(dependsOn) ||
    dependsOn.length > MAX_DEPENDENCIES ||
    dependsOn.some((d) => typeof d !== 'string' || !NODE_ID.test(d)) ||
    new Set(dependsOn).size !== dependsOn.length
  ) {
    return invalid(`${field}.dependsOn`);
  }
  const toolRef = checkNodeTool(type, tool, field);
  return Object.freeze({
    id: id as ExecutionNodeId,
    type: type as ExecutionNodeType,
    label,
    status: 'pending',
    dependsOn: Object.freeze([...(dependsOn as ExecutionNodeId[])]),
    ...(owner === undefined ? {} : { owner: checkVersionRef(owner, `${field}.owner`) }),
    ...(input === undefined ? {} : { input: checkRef(input, `${field}.input`) }),
    ...(toolRef === undefined ? {} : { tool: toolRef }),
  });
}

/**
 * Checks a whole graph: ids are unique, every dependency is a node of the graph, no node
 * depends on itself and there are no cycles. The graph stays a DAG, so it can always be
 * serialized and replayed in order.
 */
export function checkGraph(nodes: readonly ExecutionNode[]): void {
  if (nodes.length > MAX_NODES) invalid('nodes.too_many');
  const ids = new Set(nodes.map((n) => n.id));
  if (ids.size !== nodes.length) invalid('nodes.duplicate_id');
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      if (dependency === node.id) invalid('nodes.self_dependency');
      if (!ids.has(dependency)) invalid('nodes.unknown_dependency');
    }
  }
  // Kahn's algorithm: every node must be reachable in dependency order.
  const remaining = new Map(nodes.map((n) => [n.id, n.dependsOn.length]));
  const dependents = new Map<string, string[]>();
  for (const node of nodes) {
    for (const dependency of node.dependsOn) {
      dependents.set(dependency, [...(dependents.get(dependency) ?? []), node.id]);
    }
  }
  const ready = nodes.filter((n) => n.dependsOn.length === 0).map((n) => n.id as string);
  let visited = 0;
  while (ready.length > 0) {
    const id = ready.pop() as string;
    visited += 1;
    for (const next of dependents.get(id) ?? []) {
      const left = (remaining.get(next as ExecutionNodeId) ?? 0) - 1;
      remaining.set(next as ExecutionNodeId, left);
      if (left === 0) ready.push(next);
    }
  }
  if (visited !== nodes.length) invalid('nodes.cycle');
}

/** What is needed to create an execution. The organization and user come from the tenant. */
export interface NewExecution {
  readonly organizationId: OrganizationId;
  readonly userId: UserId;
  readonly mode: ExecutionMode;
  readonly input: ExecutionRef;
  readonly versionSnapshot: ExecutionVersionSnapshot;
  readonly nodes?: readonly NodeInput[];
  readonly parentExecutionId?: string;
  readonly workflowId?: string;
  /** With `specialistVersion` and `departmentId`: all three or none (ADR-0025). */
  readonly specialistId?: string;
  readonly specialistVersion?: number;
  readonly departmentId?: string;
  readonly requestId?: string;
  /**
   * Makes the id deterministic: `executionIdFor(organizationId, idempotencyKey)`. A second
   * create with the same key is refused by the repository, never stored twice.
   */
  readonly idempotencyKey?: string;
}

/** Who should do the work an execution records: one specialist version, in its department. */
export interface SpecialistAssignment {
  readonly specialistId: SpecialistId;
  readonly specialistVersion: number;
  readonly departmentId: DepartmentId;
}

/**
 * The execution's assignment, when it has one. The three fields come together or not at all,
 * and the version snapshot must record the same specialist version, so the snapshot and the
 * assignment can never tell two different stories.
 */
export function assignmentOf(
  fields: Pick<NewExecution, 'specialistId' | 'specialistVersion' | 'departmentId'>,
  snapshot: ExecutionVersionSnapshot,
): SpecialistAssignment | undefined {
  const { specialistId, specialistVersion, departmentId } = fields;
  if (specialistId === undefined && specialistVersion === undefined && departmentId === undefined) {
    return undefined;
  }
  if (typeof specialistId !== 'string' || !REF_ID.test(specialistId)) invalid('specialistId');
  if (
    typeof specialistVersion !== 'number' ||
    !Number.isSafeInteger(specialistVersion) ||
    specialistVersion < 1
  ) {
    invalid('specialistVersion');
  }
  if (typeof departmentId !== 'string' || !REF_ID.test(departmentId)) invalid('departmentId');
  const recorded = snapshot.components.find(
    (c) => c.kind === 'specialist' && c.id === specialistId,
  );
  if (recorded?.version !== String(specialistVersion)) invalid('versionSnapshot.specialist');
  return Object.freeze({
    specialistId: specialistId as SpecialistId,
    specialistVersion: specialistVersion as number,
    departmentId: departmentId as DepartmentId,
  });
}

/**
 * Builds a new `pending` execution, checking every field. Pure apart from its random id; with an
 * idempotency key, pure.
 */
export function newExecution(request: NewExecution, at: IsoTimestamp): Execution {
  if (!isExecutionMode(request.mode)) invalid('mode');
  const nodes = (request.nodes ?? []).map((node, i) => checkNodeInput(node, i));
  checkGraph(nodes);
  const { parentExecutionId, workflowId, requestId } = request;
  if (parentExecutionId !== undefined && !isExecutionId(parentExecutionId)) {
    invalid('parentExecutionId');
  }
  if (workflowId !== undefined && (typeof workflowId !== 'string' || !REF_ID.test(workflowId))) {
    invalid('workflowId');
  }
  const versionSnapshot = checkSnapshot(request.versionSnapshot);
  const assignment = assignmentOf(request, versionSnapshot);
  return Object.freeze({
    id:
      request.idempotencyKey === undefined
        ? (randomUUID() as ExecutionId)
        : executionIdFor(request.organizationId, request.idempotencyKey),
    organizationId: request.organizationId,
    userId: request.userId,
    mode: request.mode,
    status: 'pending',
    input: checkRef(request.input, 'input'),
    nodes: Object.freeze(nodes),
    ...(parentExecutionId === undefined
      ? {}
      : { parentExecutionId: parentExecutionId as ExecutionId }),
    ...(workflowId === undefined ? {} : { workflowId: workflowId as WorkflowId }),
    ...assignment,
    // A malformed request id is dropped, as in the audit log: it only correlates logs.
    ...(requestId !== undefined && REQUEST_ID.test(requestId) ? { requestId } : {}),
    versionSnapshot,
    revision: 1,
    createdAt: at,
    updatedAt: at,
  });
}

/** A status change as a caller asks for it. `from` is the status the caller last saw. */
export interface StatusChange {
  readonly from: ExecutionStatus;
  readonly to: ExecutionStatus;
  /** For `completed`: where the result is. */
  readonly result?: ExecutionRef;
  /** Required for `failed`. */
  readonly failure?: ExecutionFailure;
  /** Required for `cancelled`: a stable code saying why. */
  readonly reason?: string;
}

const later = (execution: Execution, at: IsoTimestamp): IsoTimestamp =>
  Date.parse(at) >= Date.parse(execution.updatedAt) ? at : execution.updatedAt;

/**
 * Applies one status change, or refuses it without changing anything:
 *
 * - `execution_concurrency_conflict` when the execution is no longer in `from` (someone else
 *   changed it first), so a change is never applied over one the caller did not see;
 * - `execution_already_terminal` when it is completed, failed or cancelled;
 * - `invalid_execution_transition` when the table does not allow `from → to`.
 *
 * Ending an execution (failed or cancelled) cancels every node that has not finished.
 */
export function applyStatusChange(
  execution: Execution,
  change: StatusChange,
  by: UserId,
  now: IsoTimestamp,
): Execution {
  if (execution.status !== change.from) {
    throw new ExecutionError('execution_concurrency_conflict');
  }
  if (isTerminal(execution.status)) throw new ExecutionError('execution_already_terminal');
  if (!canTransition(execution.status, change.to)) {
    throw new ExecutionError('invalid_execution_transition');
  }
  const at = later(execution, now);
  const { to } = change;
  // Only a user's start moves an execution into `running` the first time (ADR-0029). A planning
  // execution is the exception: it runs its plan's graph once delegated, and runs nothing itself.
  if (to === 'running' && execution.startedAt === undefined) {
    const delegated =
      execution.mode === 'plan' &&
      (execution.status === 'planning' || execution.status === 'waiting_approval');
    if (!delegated) throw new ExecutionError('execution_not_started');
  }
  if (to === 'verifying') checkNodesFinished(execution);
  if (to === 'completed') checkVerified(execution);
  if (change.result !== undefined && to !== 'completed') invalid('result');
  if (change.failure !== undefined && to !== 'failed') invalid('failure');
  if (change.reason !== undefined && to !== 'cancelled') invalid('reason');
  if (to === 'failed' && change.failure === undefined) invalid('failure');
  if (to === 'cancelled' && (change.reason === undefined || !CODE.test(change.reason))) {
    invalid('reason');
  }
  const ending = to === 'failed' || to === 'cancelled';
  const nodes = ending
    ? execution.nodes.map((node) =>
        isNodeFinal(node.status)
          ? node
          : Object.freeze({ ...node, status: 'cancelled' as const, completedAt: at }),
      )
    : execution.nodes;
  // Each verifying pass is verified anew: evidence of an earlier pass never completes a later one.
  const { verification, ...rest } = execution;
  return Object.freeze({
    ...rest,
    ...(verification === undefined || to === 'verifying' ? {} : { verification }),
    status: to,
    nodes: Object.freeze(nodes),
    ...(to === 'running' && execution.startedAt === undefined ? { startedAt: at } : {}),
    ...(isTerminal(to) ? { completedAt: at } : {}),
    ...(change.result === undefined ? {} : { result: checkRef(change.result, 'result') }),
    ...(change.failure === undefined ? {} : { failure: checkFailure(change.failure, 'failure') }),
    ...(to === 'cancelled'
      ? { cancellation: Object.freeze({ at, by, reason: change.reason as string }) }
      : {}),
    revision: execution.revision + 1,
    updatedAt: at,
  });
}

/**
 * `running → verifying` needs every node finished with work done: completed or skipped. A node
 * still pending or running, or one that failed or was cancelled, keeps the execution out of
 * `verifying`, and so out of `completed` (ADR-0029).
 */
function checkNodesFinished(execution: Execution): void {
  for (const node of execution.nodes) {
    if (node.status === 'completed' || node.status === 'skipped') continue;
    throw new ExecutionError(
      'invalid_execution_transition',
      isNodeFinal(node.status) ? 'nodes_not_successful' : 'nodes_not_finished',
    );
  }
}

/**
 * `verifying → completed` needs a recorded verification of this pass that passed and covers
 * every completed node, on a graph that is still all completed or skipped. Nothing else
 * completes an execution: there is no bypass (ADR-0029).
 */
function checkVerified(execution: Execution): void {
  checkNodesFinished(execution);
  const { verification } = execution;
  if (verification === undefined) throw new ExecutionError('verification_required', 'missing');
  if (verification.executionId !== execution.id || verification.result !== 'passed') {
    throw new ExecutionError('verification_required', 'not_passed');
  }
  const completed = execution.nodes.filter((n) => n.status === 'completed').map((n) => n.id);
  const verified = new Set(
    verification.nodes.filter((n) => n.result === 'passed').map((n) => n.nodeId),
  );
  if (completed.length === 0 || !completed.every((id) => verified.has(id))) {
    throw new ExecutionError('verification_required', 'not_covered');
  }
}

/**
 * A user's start (ADR-0029): `pending → running`, once. It is the only way an execution that is
 * not a planning execution first runs; the service checks who asks.
 */
export function startExecution(execution: Execution, now: IsoTimestamp): Execution {
  if (isTerminal(execution.status)) throw new ExecutionError('execution_already_terminal');
  if (execution.status !== 'pending' || execution.startedAt !== undefined) {
    throw new ExecutionError('execution_concurrency_conflict');
  }
  if (execution.mode === 'plan') throw new ExecutionError('invalid_execution_transition', 'plan');
  const at = later(execution, now);
  return Object.freeze({
    ...execution,
    status: 'running',
    startedAt: at,
    revision: execution.revision + 1,
    updatedAt: at,
  });
}

/** What a verifier found, as it reports it. The results are computed, never taken as given. */
export interface VerificationInput {
  readonly correlationId: string;
  readonly nodes: readonly {
    readonly nodeId: string;
    readonly policy: string;
    readonly checks: readonly {
      readonly code: string;
      readonly result: string;
      readonly evidence: ExecutionRef;
    }[];
  }[];
}

const RESULTS: readonly VerificationResult[] = ['passed', 'failed'];

function checkVerificationCheck(value: unknown, field: string): VerificationCheck {
  if (!isRecord(value)) return invalid(field);
  const { code, result, evidence } = value;
  if (typeof code !== 'string' || !CODE.test(code)) return invalid(`${field}.code`);
  if (typeof result !== 'string' || !(RESULTS as readonly string[]).includes(result)) {
    return invalid(`${field}.result`);
  }
  return Object.freeze({
    code,
    result: result as VerificationResult,
    evidence: checkRef(evidence, `${field}.evidence`),
  });
}

function checkNodeVerification(
  value: unknown,
  field: string,
  computeResult: boolean,
): NodeVerification {
  if (!isRecord(value)) return invalid(field);
  const { nodeId, policy, checks, result } = value;
  if (typeof nodeId !== 'string' || !NODE_ID.test(nodeId)) return invalid(`${field}.nodeId`);
  if (typeof policy !== 'string') return invalid(`${field}.policy`);
  if (!(VERIFICATION_POLICIES as readonly string[]).includes(policy)) {
    throw new ExecutionError('verification_policy_not_available', policy.slice(0, 32));
  }
  if (!Array.isArray(checks) || checks.length === 0 || checks.length > MAX_VERIFICATION_CHECKS) {
    return invalid(`${field}.checks`);
  }
  const checked = checks.map((c, i) => checkVerificationCheck(c, `${field}.checks.${i}`));
  const passed: VerificationResult = checked.every((c) => c.result === 'passed')
    ? 'passed'
    : 'failed';
  if (!computeResult && result !== passed) return invalid(`${field}.result`);
  return Object.freeze({
    nodeId: nodeId as ExecutionNodeId,
    policy: policy as ExecutionVerificationPolicy,
    result: passed,
    checks: Object.freeze(checked),
  });
}

/**
 * Records the verification of the current `verifying` pass (ADR-0029), once. Every completed
 * node gets exactly one entry and no other node gets any; each entry has at least one check with
 * its evidence. A node passes only when every check passed, and the execution only when every
 * node passed. A failed verification is recorded too: it is evidence, and it never completes.
 */
export function recordVerification(
  execution: Execution,
  input: VerificationInput,
  now: IsoTimestamp,
): Execution {
  if (isTerminal(execution.status)) throw new ExecutionError('execution_already_terminal');
  if (execution.status !== 'verifying') throw new ExecutionError('invalid_execution_transition');
  if (execution.verification !== undefined) {
    throw new ExecutionError('execution_concurrency_conflict');
  }
  if (!isRecord(input)) return invalid('verification');
  const { correlationId, nodes } = input;
  if (typeof correlationId !== 'string' || !REQUEST_ID.test(correlationId)) {
    return invalid('verification.correlationId');
  }
  if (!Array.isArray(nodes) || nodes.length === 0 || nodes.length > MAX_NODES) {
    return invalid('verification.nodes');
  }
  const checked = nodes.map((n, i) => checkNodeVerification(n, `verification.nodes.${i}`, true));
  const ids = checked.map((n) => n.nodeId as string);
  const completed = execution.nodes.filter((n) => n.status === 'completed').map((n) => n.id);
  if (
    new Set(ids).size !== ids.length ||
    ids.length !== completed.length ||
    !completed.every((id) => ids.includes(id))
  ) {
    return invalid('verification.nodes.coverage');
  }
  const at = later(execution, now);
  const verification: ExecutionVerification = Object.freeze({
    schemaVersion: 1,
    executionId: execution.id,
    result: checked.every((n) => n.result === 'passed') ? 'passed' : 'failed',
    verifiedAt: at,
    correlationId,
    nodes: Object.freeze(checked),
  });
  return Object.freeze({
    ...execution,
    verification,
    revision: execution.revision + 1,
    updatedAt: at,
  });
}

/** Which rule allowed a retry: no effect at all, or an effect under a recorded idempotency key. */
export type RetryRule = 'effect_free' | 'idempotent_effect';

/**
 * Whether a failed node may run again automatically (ADR-0029). Never when its outcome is
 * unknown (rule C), never after its one retry, and only when a repeat cannot change anything
 * twice: a node with no external effect by construction (rule A), or a tool node whose effect
 * ran under an idempotency key recorded before it (rule B). Anything else is refused.
 */
export function retryRuleOf(node: ExecutionNode): RetryRule {
  if (node.status !== 'failed') throw new ExecutionError('retry_not_allowed', 'not_failed');
  if (node.error !== undefined && UNKNOWN_OUTCOME_CODES.includes(node.error.code)) {
    throw new ExecutionError('retry_not_allowed', 'outcome_unknown');
  }
  if ((node.attempt ?? 1) >= MAX_NODE_ATTEMPTS) {
    throw new ExecutionError('retry_not_allowed', 'attempts_exhausted');
  }
  if (EFFECT_FREE_NODE_TYPES.includes(node.type)) return 'effect_free';
  if (node.type === 'tool' && node.idempotencyKey !== undefined) return 'idempotent_effect';
  throw new ExecutionError('retry_not_allowed', 'external_effect');
}

/**
 * Puts a failed node back to `pending` as its next attempt, keeping its idempotency key so the
 * repeat is the same operation. The execution must be `running`.
 */
export function retryNode(execution: Execution, nodeId: string, now: IsoTimestamp): Execution {
  if (isTerminal(execution.status)) throw new ExecutionError('execution_already_terminal');
  if (execution.status !== 'running') throw new ExecutionError('invalid_execution_transition');
  const index = execution.nodes.findIndex((n) => n.id === nodeId);
  const node = execution.nodes[index];
  if (node === undefined) return invalid('nodeId');
  retryRuleOf(node);
  // The node as it was defined, without the last attempt's output, error or times.
  const updated: ExecutionNode = Object.freeze({
    id: node.id,
    type: node.type,
    label: node.label,
    status: 'pending',
    dependsOn: node.dependsOn,
    ...(node.owner === undefined ? {} : { owner: node.owner }),
    ...(node.input === undefined ? {} : { input: node.input }),
    ...(node.tool === undefined ? {} : { tool: node.tool }),
    ...(node.approvalId === undefined ? {} : { approvalId: node.approvalId }),
    ...(node.idempotencyKey === undefined ? {} : { idempotencyKey: node.idempotencyKey }),
    attempt: (node.attempt ?? 1) + 1,
  });
  return Object.freeze({
    ...execution,
    nodes: Object.freeze(execution.nodes.map((n, i) => (i === index ? updated : n))),
    revision: execution.revision + 1,
    updatedAt: later(execution, now),
  });
}

/**
 * Records that a running node's outcome is unknown (a lost worker, a deadline passed): it fails
 * with `outcome_unknown` and is never re-run automatically (ADR-0029, rule C).
 */
export function markOutcomeUnknown(
  execution: Execution,
  nodeId: string,
  now: IsoTimestamp,
): Execution {
  return applyNodeChange(
    execution,
    { nodeId, from: 'running', to: 'failed', error: { code: 'outcome_unknown' } },
    now,
  );
}

/** Adds nodes to the graph of an execution that has not ended. */
export function addNodes(
  execution: Execution,
  inputs: readonly NodeInput[],
  now: IsoTimestamp,
): Execution {
  if (isTerminal(execution.status)) throw new ExecutionError('execution_already_terminal');
  if (inputs.length === 0) invalid('nodes');
  const added = inputs.map((node, i) => checkNodeInput(node, execution.nodes.length + i));
  const nodes = [...execution.nodes, ...added];
  checkGraph(nodes);
  const at = later(execution, now);
  return Object.freeze({
    ...execution,
    nodes: Object.freeze(nodes),
    revision: execution.revision + 1,
    updatedAt: at,
  });
}

/** A node status change as a caller asks for it. */
export interface NodeChange {
  readonly nodeId: string;
  readonly from: ExecutionNodeStatus;
  readonly to: ExecutionNodeStatus;
  /** For `completed`: where the node's output is. */
  readonly output?: ExecutionRef;
  /** Required for `failed`. */
  readonly error?: ExecutionFailure;
  /**
   * For `running`: the idempotency key the node's external effect runs under. Once recorded it
   * never changes; a later attempt must start under the same key.
   */
  readonly idempotencyKey?: string;
}

/**
 * Moves one node. The execution must not have ended, the node must still be in `from`, the move
 * must be allowed, and a node starts only when every node it depends on has completed or been
 * skipped. A running node becomes the execution's current node.
 */
export function applyNodeChange(
  execution: Execution,
  change: NodeChange,
  now: IsoTimestamp,
): Execution {
  if (isTerminal(execution.status)) throw new ExecutionError('execution_already_terminal');
  const index = execution.nodes.findIndex((n) => n.id === change.nodeId);
  const node = execution.nodes[index];
  if (node === undefined) return invalid('nodeId');
  if (node.status !== change.from) throw new ExecutionError('execution_concurrency_conflict');
  if (!NODE_TRANSITIONS[node.status].includes(change.to)) {
    throw new ExecutionError('invalid_execution_transition');
  }
  if (change.output !== undefined && change.to !== 'completed') invalid('output');
  if (change.error !== undefined && change.to !== 'failed') invalid('error');
  if (change.to === 'failed' && change.error === undefined) invalid('error');
  const { idempotencyKey } = change;
  if (idempotencyKey !== undefined) {
    if (change.to !== 'running' || !isIdempotencyKey(idempotencyKey)) invalid('idempotencyKey');
    if (node.idempotencyKey !== undefined && node.idempotencyKey !== idempotencyKey) {
      invalid('idempotencyKey');
    }
  }
  if (change.to === 'running') {
    const done = new Set(
      execution.nodes
        .filter((n) => n.status === 'completed' || n.status === 'skipped')
        .map((n) => n.id),
    );
    if (!node.dependsOn.every((d) => done.has(d))) {
      throw new ExecutionError('invalid_execution_transition');
    }
  }
  const at = later(execution, now);
  const updated: ExecutionNode = Object.freeze({
    ...node,
    status: change.to,
    ...(change.to === 'running' ? { startedAt: at } : {}),
    ...(isNodeFinal(change.to) ? { completedAt: at } : {}),
    ...(change.output === undefined ? {} : { output: checkRef(change.output, 'output') }),
    ...(change.error === undefined ? {} : { error: checkFailure(change.error, 'error') }),
    ...(idempotencyKey === undefined ? {} : { idempotencyKey }),
  });
  const nodes = execution.nodes.map((n, i) => (i === index ? updated : n));
  return Object.freeze({
    ...execution,
    nodes: Object.freeze(nodes),
    ...(change.to === 'running' ? { currentNodeId: node.id } : {}),
    revision: execution.revision + 1,
    updatedAt: at,
  });
}

/**
 * Attaches a human approval to a pending `tool` node (ADR-0026). A node holds at most one
 * approval: attaching another is refused, so an approval can never be swapped for a different
 * one. Attaching the same one again changes nothing and is refused as a conflict.
 */
export function attachApproval(
  execution: Execution,
  nodeId: string,
  approvalId: string,
  now: IsoTimestamp,
): Execution {
  if (isTerminal(execution.status)) throw new ExecutionError('execution_already_terminal');
  if (!APPROVAL_ID.test(approvalId)) invalid('approvalId');
  const index = execution.nodes.findIndex((n) => n.id === nodeId);
  const node = execution.nodes[index];
  if (node === undefined || node.type !== 'tool') return invalid('nodeId');
  if (node.status !== 'pending' || node.approvalId !== undefined) {
    throw new ExecutionError('execution_concurrency_conflict');
  }
  const updated: ExecutionNode = Object.freeze({ ...node, approvalId: approvalId as ApprovalId });
  return Object.freeze({
    ...execution,
    nodes: Object.freeze(execution.nodes.map((n, i) => (i === index ? updated : n))),
    revision: execution.revision + 1,
    updatedAt: later(execution, now),
  });
}

/**
 * Checks a stored execution before it is trusted: a record that fails is refused, never
 * repaired or used.
 */
export function checkStoredExecution(execution: Execution): Execution {
  if (!isExecutionId(execution.id)) invalid('id');
  if (!isExecutionMode(execution.mode)) invalid('mode');
  if (!isExecutionStatus(execution.status)) invalid('status');
  checkRef(execution.input, 'input');
  assignmentOf(execution, checkSnapshot(execution.versionSnapshot));
  for (const node of execution.nodes) {
    if (!isNodeStatus(node.status)) invalid('nodes.status');
    if (!(NODE_TYPES as readonly string[]).includes(node.type)) invalid('nodes.type');
    checkNodeTool(node.type, node.tool, 'nodes');
    if (
      node.approvalId !== undefined &&
      (node.type !== 'tool' || !APPROVAL_ID.test(node.approvalId))
    ) {
      invalid('nodes.approvalId');
    }
    const { attempt, idempotencyKey } = node;
    if (
      attempt !== undefined &&
      (!Number.isSafeInteger(attempt) || attempt < 1 || attempt > MAX_NODE_ATTEMPTS)
    ) {
      invalid('nodes.attempt');
    }
    if (idempotencyKey !== undefined && !isIdempotencyKey(idempotencyKey)) {
      invalid('nodes.idempotencyKey');
    }
  }
  checkGraph(execution.nodes);
  if (execution.verification !== undefined) checkStoredVerification(execution);
  if (!Number.isSafeInteger(execution.revision) || execution.revision < 1) invalid('revision');
  return execution;
}

function checkStoredVerification(execution: Execution): void {
  const v = execution.verification as ExecutionVerification;
  if (!isRecord(v) || v.schemaVersion !== 1 || v.executionId !== execution.id) {
    invalid('verification');
  }
  if (!(RESULTS as readonly string[]).includes(v.result)) invalid('verification.result');
  if (typeof v.correlationId !== 'string' || !REQUEST_ID.test(v.correlationId)) {
    invalid('verification.correlationId');
  }
  if (!Array.isArray(v.nodes) || v.nodes.length === 0) invalid('verification.nodes');
  const nodes = v.nodes.map((n, i) => checkNodeVerification(n, `verification.nodes.${i}`, false));
  const passed = nodes.every((n) => n.result === 'passed') ? 'passed' : 'failed';
  if (v.result !== passed) invalid('verification.result');
}
