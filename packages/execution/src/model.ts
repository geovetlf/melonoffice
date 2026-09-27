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
  SpecialistId,
  ToolId,
  UserId,
  VersionRef,
  WorkflowId,
} from '@melonoffice/domain';
import { randomUUID } from 'node:crypto';
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

/** Builds a new `pending` execution, checking every field. Pure apart from its random id. */
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
    id: randomUUID() as ExecutionId,
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
  return Object.freeze({
    ...execution,
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
  }
  checkGraph(execution.nodes);
  if (!Number.isSafeInteger(execution.revision) || execution.revision < 1) invalid('revision');
  return execution;
}
