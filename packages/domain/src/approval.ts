import type { ExecutionId, ExecutionNodeId } from './execution.js';
import type { Brand, IsoTimestamp, OrganizationId, SpecialistId, ToolId, UserId } from './ids.js';
import type { ToolRiskLevel } from './tool.js';

export type ApprovalId = Brand<string, 'ApprovalId'>;

/**
 * Where a human approval is (ADR-0026). Only `pending` can change; `approved` lets exactly the
 * operation it was asked for run, and the other statuses are final refusals.
 */
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'expired' | 'cancelled';

/**
 * The exact operation an approval is for. Every field comes from verified context (the tenant,
 * the stored execution, the registry), never from a model or a client.
 */
export interface ApprovalOperation {
  readonly organizationId: OrganizationId;
  readonly executionId: ExecutionId;
  readonly nodeId: ExecutionNodeId;
  readonly specialistId: SpecialistId;
  readonly specialistVersion: number;
  readonly toolId: ToolId;
  readonly toolVersion: number;
  readonly action: string;
  /** SHA-256 of the canonical tool input: the approval covers this input and no other. */
  readonly inputDigest: string;
}

/**
 * A request for a human to allow one operation. It holds references, codes and digests only:
 * never the tool input, credentials or secrets.
 */
export interface Approval {
  readonly id: ApprovalId;
  readonly organizationId: OrganizationId;
  readonly operation: ApprovalOperation;
  /** SHA-256 of the canonical operation. A use must present an operation with the same digest. */
  readonly bindingDigest: string;
  /** The user the execution runs for. */
  readonly requestedBy: UserId;
  readonly riskLevel: ToolRiskLevel;
  /** Why it is needed, as a stable code, e.g. `risk_high` or `tool_policy`. */
  readonly reason: string;
  /** What approving would do, as a stable code, e.g. `sends_external_message`. */
  readonly impact: string;
  /** Credits it would cost, when known. */
  readonly estimatedCredits?: number;
  readonly status: ApprovalStatus;
  readonly requestedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
  readonly decidedAt?: IsoTimestamp;
  readonly decidedBy?: UserId;
  /**
   * Why it was withdrawn, once `cancelled` (ADR-0181), as a stable code: `plan_cancelled` when
   * the plan it belonged to was cancelled. Absent on approvals withdrawn before ADR-0181.
   */
  readonly cancelReason?: string;
  /** Increases with every change; a write expecting an older revision is refused. */
  readonly revision: number;
}
