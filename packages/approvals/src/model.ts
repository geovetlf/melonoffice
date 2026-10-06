import type {
  Approval,
  ApprovalId,
  ApprovalOperation,
  ApprovalStatus,
  IsoTimestamp,
  ToolRiskLevel,
  UserId,
} from '@melonoffice/domain';
import { digestOf, isDigest, RISK_LEVELS, sameDigest } from '@melonoffice/tools';
import { randomUUID } from 'node:crypto';
import { ApprovalError } from './errors.js';

export const APPROVAL_STATUSES = [
  'pending',
  'approved',
  'rejected',
  'expired',
  'cancelled',
] as const satisfies readonly ApprovalStatus[];

/** Only `pending` moves; every other status is final (ADR-0026). */
export const APPROVAL_TRANSITIONS: Readonly<Record<ApprovalStatus, readonly ApprovalStatus[]>> =
  Object.freeze({
    pending: Object.freeze(['approved', 'rejected', 'expired', 'cancelled'] as const),
    approved: Object.freeze([] as const),
    rejected: Object.freeze([] as const),
    expired: Object.freeze([] as const),
    cancelled: Object.freeze([] as const),
  });

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const CODE = /^[a-z][a-z_]{0,63}$/;
const TOOL_ID = /^[a-z][a-z0-9_]{0,63}$/;
const NODE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export const isApprovalId = (value: unknown): value is ApprovalId =>
  typeof value === 'string' && UUID.test(value);

const invalid = (detail: string): never => {
  throw new ApprovalError('invalid_approval', detail);
};

const positive = (value: unknown): boolean =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 1;

/** Checks an operation and returns a frozen copy with exactly its fields, in a fixed shape. */
export function checkOperation(operation: ApprovalOperation): ApprovalOperation {
  const o = operation;
  if (!UUID.test(o.organizationId)) invalid('organizationId');
  if (!UUID.test(o.executionId)) invalid('executionId');
  if (!NODE_ID.test(o.nodeId)) invalid('nodeId');
  if (!UUID.test(o.specialistId)) invalid('specialistId');
  if (!positive(o.specialistVersion)) invalid('specialistVersion');
  if (!TOOL_ID.test(o.toolId)) invalid('toolId');
  if (!positive(o.toolVersion)) invalid('toolVersion');
  if (!TOOL_ID.test(o.action)) invalid('action');
  if (!isDigest(o.inputDigest)) invalid('inputDigest');
  return Object.freeze({
    organizationId: o.organizationId,
    executionId: o.executionId,
    nodeId: o.nodeId,
    specialistId: o.specialistId,
    specialistVersion: o.specialistVersion,
    toolId: o.toolId,
    toolVersion: o.toolVersion,
    action: o.action,
    inputDigest: o.inputDigest,
  });
}

/** The digest an approval is bound to: SHA-256 of the canonical operation. */
export const bindingDigestOf = (operation: ApprovalOperation): string =>
  digestOf(checkOperation(operation));

export interface ApprovalRequest {
  readonly operation: ApprovalOperation;
  readonly requestedBy: UserId;
  readonly riskLevel: ToolRiskLevel;
  readonly reason: string;
  readonly impact: string;
  readonly estimatedCredits?: number;
  readonly ttlSeconds: number;
}

/** Builds a new `pending` approval for exactly one operation. Pure apart from its random id. */
export function newApproval(request: ApprovalRequest, at: Date): Approval {
  const operation = checkOperation(request.operation);
  if (!(RISK_LEVELS as readonly string[]).includes(request.riskLevel)) invalid('riskLevel');
  if (!CODE.test(request.reason)) invalid('reason');
  if (!CODE.test(request.impact)) invalid('impact');
  if (
    request.estimatedCredits !== undefined &&
    (!Number.isSafeInteger(request.estimatedCredits) || request.estimatedCredits < 0)
  ) {
    invalid('estimatedCredits');
  }
  if (!positive(request.ttlSeconds)) invalid('ttlSeconds');
  return Object.freeze({
    id: randomUUID() as ApprovalId,
    organizationId: operation.organizationId,
    operation,
    bindingDigest: digestOf(operation),
    requestedBy: request.requestedBy,
    riskLevel: request.riskLevel,
    reason: request.reason,
    impact: request.impact,
    ...(request.estimatedCredits === undefined
      ? {}
      : { estimatedCredits: request.estimatedCredits }),
    status: 'pending',
    requestedAt: at.toISOString() as IsoTimestamp,
    expiresAt: new Date(at.getTime() + request.ttlSeconds * 1000).toISOString() as IsoTimestamp,
    revision: 1,
  });
}

export const hasExpired = (approval: Approval, now: Date): boolean =>
  now.getTime() >= Date.parse(approval.expiresAt);

/**
 * Moves a pending approval to a final status, or refuses without changing anything:
 *
 * - anything but `pending` is `approval_not_pending`: approved twice, approved after a
 *   rejection, or decided after a cancellation are all refused;
 * - approving or rejecting once `expiresAt` has passed is `approval_expired` (the caller then
 *   records the expiry instead);
 * - `expired` is only reachable once `expiresAt` has passed.
 */
export function decide(
  approval: Approval,
  to: Exclude<ApprovalStatus, 'pending'>,
  by: UserId | undefined,
  now: Date,
): Approval {
  if (approval.status !== 'pending') throw new ApprovalError('approval_not_pending');
  if (!APPROVAL_TRANSITIONS.pending.includes(to)) invalid('status');
  const expired = hasExpired(approval, now);
  if ((to === 'approved' || to === 'rejected') && expired) {
    throw new ApprovalError('approval_expired');
  }
  if (to === 'expired' && !expired) throw new ApprovalError('approval_not_pending', 'not_due');
  const at = now.toISOString() as IsoTimestamp;
  return Object.freeze({
    ...approval,
    status: to,
    decidedAt: at,
    ...(by === undefined ? {} : { decidedBy: by }),
    revision: approval.revision + 1,
  });
}

/** Why an approval cannot cover an operation. */
export type ApprovalUseProblem =
  | 'approval_pending'
  | 'approval_rejected'
  | 'approval_expired'
  | 'approval_cancelled'
  | 'approval_mismatch';

/**
 * Whether an approval covers exactly this operation, now (ADR-0026). The operation is rebuilt by
 * the caller from verified context and its digest compared, in constant time, with the one the
 * approval was bound to: another organization, execution, node, specialist version, tool,
 * tool version, action or input never matches. An approved approval also stops covering
 * anything once it expires.
 */
export function checkApprovalUse(
  approval: Approval,
  operation: ApprovalOperation,
  now: Date,
): ApprovalUseProblem | undefined {
  if (
    approval.organizationId !== operation.organizationId ||
    !sameDigest(approval.bindingDigest, bindingDigestOf(operation)) ||
    !sameDigest(approval.bindingDigest, digestOf(checkOperation(approval.operation)))
  ) {
    return 'approval_mismatch';
  }
  switch (approval.status) {
    case 'pending':
      return hasExpired(approval, now) ? 'approval_expired' : 'approval_pending';
    case 'rejected':
      return 'approval_rejected';
    case 'expired':
      return 'approval_expired';
    case 'cancelled':
      return 'approval_cancelled';
    case 'approved':
      return hasExpired(approval, now) ? 'approval_expired' : undefined;
  }
}

/** Checks a stored approval before it is trusted: a record that fails is refused, never repaired. */
export function checkStoredApproval(approval: Approval): Approval {
  if (!isApprovalId(approval.id)) invalid('id');
  const operation = checkOperation(approval.operation);
  if (operation.organizationId !== approval.organizationId) invalid('organizationId');
  if (!sameDigest(approval.bindingDigest, digestOf(operation))) invalid('bindingDigest');
  if (!(APPROVAL_STATUSES as readonly string[]).includes(approval.status)) invalid('status');
  if (!(RISK_LEVELS as readonly string[]).includes(approval.riskLevel)) invalid('riskLevel');
  if (!positive(approval.revision)) invalid('revision');
  if (Number.isNaN(Date.parse(approval.expiresAt))) invalid('expiresAt');
  if (
    approval.cancelReason !== undefined &&
    (approval.status !== 'cancelled' || !CODE.test(approval.cancelReason))
  ) {
    invalid('cancelReason');
  }
  return approval;
}

/** Withdraws a pending approval and keeps why (ADR-0181): a stable code. */
export function withdraw(approval: Approval, reason: string, now: Date): Approval {
  if (!CODE.test(reason)) invalid('cancelReason');
  return Object.freeze({ ...decide(approval, 'cancelled', undefined, now), cancelReason: reason });
}
