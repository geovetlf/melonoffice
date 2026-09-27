import type { ApprovalId } from './approval.js';
import type { VerificationPolicy } from './plan.js';
import type {
  Brand,
  DepartmentId,
  IsoTimestamp,
  OrganizationId,
  SpecialistId,
  ToolId,
  UserId,
} from './ids.js';

/** Globally unique id of one execution (a UUID). */
export type ExecutionId = Brand<string, 'ExecutionId'>;
/** Id of a node inside one execution's graph; unique within that execution. */
export type ExecutionNodeId = Brand<string, 'ExecutionNodeId'>;
/** Id of a workflow definition. Workflows do not exist yet; executions can already point at one. */
export type WorkflowId = Brand<string, 'WorkflowId'>;

/**
 * Where an execution is in its life (ADR-0024). `completed`, `failed` and `cancelled` are
 * terminal: nothing moves an execution out of them.
 */
export type ExecutionStatus =
  | 'pending'
  | 'planning'
  | 'waiting_approval'
  | 'running'
  | 'verifying'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'paused'
  | 'retrying';

/**
 * What kind of work an execution is. Internal execution modes, not UI buttons: `ask` never acts
 * outside MelonOffice, `plan` only produces a plan, `execute` acts, `review` checks results,
 * `debug` diagnoses and recovers, `delegate` hands work to a specialist, department or workflow.
 */
export type ExecutionMode = 'ask' | 'plan' | 'execute' | 'review' | 'debug' | 'delegate';

/** What a node of the graph stands for. X1 records them; the engines behind them come later. */
export type ExecutionNodeType =
  | 'agent'
  | 'workflow'
  | 'tool'
  | 'approval'
  | 'condition'
  | 'verification'
  | 'parallel'
  | 'delay'
  | 'event';

export type ExecutionNodeStatus =
  'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'cancelled';

/**
 * A pointer to data kept elsewhere (a task, a document, a message, a stored result), never the
 * data itself. Executions stay small and never carry prompts, bodies or secrets.
 */
export interface ExecutionRef {
  /** A stable code for what is referenced, e.g. `task` or `document`. */
  readonly type: string;
  readonly id: string;
}

/** One versioned thing an execution used, e.g. `{ kind: 'role', id: 'meta_ads', version: '3' }`. */
export interface VersionRef {
  /** What it is: `specialist`, `role`, `skill`, `workflow`, `tool`, `policy`, `model`… */
  readonly kind: string;
  readonly id: string;
  readonly version: string;
}

/**
 * The versions an execution ran with, recorded when it is created and never changed, so a later
 * change to a definition never changes what an earlier execution meant. It is a list of
 * versioned references rather than one field per component: components that do not exist yet
 * are added as new kinds without changing stored executions.
 */
export interface ExecutionVersionSnapshot {
  readonly schemaVersion: 1;
  readonly components: readonly VersionRef[];
}

/** Why an execution failed, as a stable code, with an optional pointer to details. */
export interface ExecutionFailure {
  readonly code: string;
  readonly ref?: ExecutionRef;
}

export interface ExecutionCancellation {
  readonly at: IsoTimestamp;
  readonly by: UserId;
  readonly reason: string;
}

/** One exact version of a tool, as a `tool` node names it. */
export interface ExecutionToolRef {
  readonly id: ToolId;
  readonly version: number;
}

export interface ExecutionNode {
  readonly id: ExecutionNodeId;
  readonly type: ExecutionNodeType;
  /** A short name for people reading the graph. */
  readonly label: string;
  readonly status: ExecutionNodeStatus;
  /** Nodes that must finish before this one starts. */
  readonly dependsOn: readonly ExecutionNodeId[];
  /** Who or what runs the node: a specialist, a tool, a workflow… */
  readonly owner?: VersionRef;
  readonly input?: ExecutionRef;
  /**
   * For `tool` nodes, and only them: the exact tool version the node runs (ADR-0026). The input
   * itself is never stored here; `input` may point at it.
   */
  readonly tool?: ExecutionToolRef;
  /** The human approval this tool node waits on or ran with (ADR-0026). */
  readonly approvalId?: ApprovalId;
  readonly output?: ExecutionRef;
  readonly error?: ExecutionFailure;
  readonly startedAt?: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  /**
   * Which run of the node this is, from 1 (ADR-0029). Absent means 1. It grows only through an
   * allowed retry, at most once, and never for an outcome that is unknown.
   */
  readonly attempt?: number;
  /**
   * The idempotency key the node's external effect runs under, recorded when the node starts,
   * before the effect (ADR-0029). It never includes the attempt, so a retry repeats the same key
   * and the provider applies the effect once. A node with an external effect and no key is never
   * retried automatically.
   */
  readonly idempotencyKey?: string;
}

/**
 * How a node's output was checked (ADR-0029). Only deterministic policies exist: `human_review`
 * and `specialist_review` are not policies yet and are refused, so nothing completes on a review
 * that never happened.
 */
export type ExecutionVerificationPolicy = Extract<VerificationPolicy, 'output_schema' | 'checks'>;

export type VerificationResult = 'passed' | 'failed';

/** One deterministic check and where its evidence is. The evidence itself is kept elsewhere. */
export interface VerificationCheck {
  /** A stable code naming the check, e.g. `schema_valid`. */
  readonly code: string;
  readonly result: VerificationResult;
  readonly evidence: ExecutionRef;
}

/** The verification of one completed node. `passed` only when every check passed. */
export interface NodeVerification {
  readonly nodeId: ExecutionNodeId;
  readonly policy: ExecutionVerificationPolicy;
  readonly result: VerificationResult;
  readonly checks: readonly VerificationCheck[];
}

/**
 * The evidence that an execution's work was verified (ADR-0029): one entry per completed node,
 * recorded once while the execution is `verifying`. `verifying → completed` needs it, `passed`,
 * covering every completed node. There is no bypass.
 */
export interface ExecutionVerification {
  readonly schemaVersion: 1;
  readonly executionId: ExecutionId;
  readonly result: VerificationResult;
  readonly verifiedAt: IsoTimestamp;
  /** Correlates the verification with the logs and the audit event that recorded it. */
  readonly correlationId: string;
  readonly nodes: readonly NodeVerification[];
}

/**
 * One unit of work MelonOffice runs for an organization (ADR-0024). It holds references and
 * states, never payloads: its meaning is rebuilt from the execution, its graph, the node states
 * and the audit log.
 */
export interface Execution {
  readonly id: ExecutionId;
  readonly organizationId: OrganizationId;
  /** The user the execution runs for. */
  readonly userId: UserId;
  readonly mode: ExecutionMode;
  readonly status: ExecutionStatus;
  /** What was asked: a pointer to the task or message. */
  readonly input: ExecutionRef;
  readonly nodes: readonly ExecutionNode[];
  readonly currentNodeId?: ExecutionNodeId;
  readonly parentExecutionId?: ExecutionId;
  readonly workflowId?: WorkflowId;
  /**
   * The specialist that should do the work, the version of it, and its department (ADR-0025).
   * The three are present together or not at all, and the version snapshot holds the same
   * `specialist` version, so the execution names exactly who was meant to run it.
   */
  readonly specialistId?: SpecialistId;
  readonly specialistVersion?: number;
  readonly departmentId?: DepartmentId;
  /** The request that created it, to correlate logs. */
  readonly requestId?: string;
  readonly versionSnapshot: ExecutionVersionSnapshot;
  readonly result?: ExecutionRef;
  readonly failure?: ExecutionFailure;
  readonly cancellation?: ExecutionCancellation;
  /** The verification of the current `verifying` pass, once recorded (ADR-0029). */
  readonly verification?: ExecutionVerification;
  /** Increases with every change; a write expecting an older revision is refused. */
  readonly revision: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly startedAt?: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
}
