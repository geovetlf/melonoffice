import type { PlanStatus } from '@melonoffice/domain';

export const PLAN_STATUSES = [
  'draft',
  'ready',
  'approval_required',
  'approved',
  'rejected',
  'executing',
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly PlanStatus[];

/**
 * Every allowed plan status change (ADR-0028). Anything not listed is refused:
 *
 * - a validated plan is `ready`, or `approval_required` when any step or its risk needs a human;
 * - only a user acting directly moves `approval_required` to `approved` or `rejected`;
 * - only delegation moves a `ready` or `approved` plan to `executing`;
 * - `rejected`, `completed`, `failed` and `cancelled` are terminal; `cancelled` is reachable from
 *   every other status.
 */
export const PLAN_TRANSITIONS: Readonly<Record<PlanStatus, readonly PlanStatus[]>> = {
  draft: ['ready', 'approval_required', 'cancelled'],
  ready: ['executing', 'cancelled'],
  approval_required: ['approved', 'rejected', 'cancelled'],
  approved: ['executing', 'cancelled'],
  executing: ['completed', 'failed', 'cancelled'],
  rejected: [],
  completed: [],
  failed: [],
  cancelled: [],
};

export const isPlanStatus = (value: unknown): value is PlanStatus =>
  typeof value === 'string' && (PLAN_STATUSES as readonly string[]).includes(value);

export const canChangePlanStatus = (from: PlanStatus, to: PlanStatus): boolean =>
  PLAN_TRANSITIONS[from].includes(to);

export const isPlanTerminal = (status: PlanStatus): boolean =>
  PLAN_TRANSITIONS[status].length === 0;
