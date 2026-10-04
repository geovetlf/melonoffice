import type { ApprovalOperation, ToolRiskLevel } from '@melonoffice/domain';
import type { TenantContext } from '@melonoffice/tenancy';
import { digestOf } from '@melonoffice/tools';
import { isApprovalError } from './errors.js';
import { checkApprovalUse } from './model.js';
import type { ApprovalService } from './service.js';

/**
 * Approvals for plan steps (ADR-0146): a specialist step marked "ask me before this step runs"
 * asks for an ordinary approval (ADR-0026) when it becomes ready, through this same service. It
 * is bound to exactly one plan version, step and child execution, so it can never be stretched
 * to another step, plan version or tool call, and only a person acting directly may decide it.
 * `plan_step` is reserved in the tool registry, so no tool approval shares its operations.
 */

/** The operation's tool id and action for a plan step. Never a tool (`RESERVED_TOOL_IDS`). */
export const PLAN_STEP_TOOL = 'plan_step';
export const PLAN_STEP_ACTION = 'start_step';
/** How long a person has to decide a step before it counts as declined: one day. */
export const PLAN_STEP_APPROVAL_TTL_SECONDS = 86_400;

/** What a step's approval binds to. Every field comes from the stored plan, never a request. */
export interface PlanStepApprovalAsk {
  readonly organizationId: string;
  readonly planId: string;
  readonly planVersion: number;
  /** The digest of the plan version the person approved. */
  readonly planDigest: string;
  /** The plan's own execution, whose node for this step is `stepId`. */
  readonly executionId: string;
  readonly stepId: string;
  readonly specialistId: string;
  readonly specialistVersion: number;
  /** The child execution the step will start. */
  readonly childExecutionId: string;
  readonly riskLevel: ToolRiskLevel;
}

/**
 * Where a step's approval is: `approved` only when it still covers exactly this step now; any
 * rejection, expiry, withdrawal or mismatch is `declined`, so the step never runs.
 */
export type PlanStepApprovalState =
  | { readonly status: 'pending' }
  | { readonly status: 'approved' }
  | {
      readonly status: 'declined';
      readonly reason: 'rejected' | 'expired' | 'cancelled' | 'mismatch';
    };

/** The operation a step's approval is bound to, rebuilt the same way every time. */
export function planStepOperation(ask: PlanStepApprovalAsk): ApprovalOperation {
  return {
    organizationId: ask.organizationId,
    // The step's own child execution, so a decision finds its plan and step (`planStepOf`).
    executionId: ask.childExecutionId,
    nodeId: ask.stepId,
    specialistId: ask.specialistId,
    specialistVersion: ask.specialistVersion,
    toolId: PLAN_STEP_TOOL,
    toolVersion: ask.planVersion,
    action: PLAN_STEP_ACTION,
    inputDigest: digestOf({
      planId: ask.planId,
      planVersion: ask.planVersion,
      planDigest: ask.planDigest,
      planExecutionId: ask.executionId,
      stepId: ask.stepId,
      childExecutionId: ask.childExecutionId,
    }),
  } as ApprovalOperation;
}

/** Whether an approval is a plan step's, not a tool call's. */
export const isPlanStepApproval = (approval: {
  readonly operation: Pick<ApprovalOperation, 'toolId'>;
}): boolean => approval.operation.toolId === PLAN_STEP_TOOL;

export interface PlanStepApprovals {
  /** Asks for the step's approval; returns its id. */
  request(tenant: TenantContext, ask: PlanStepApprovalAsk): Promise<string>;
  /** Reads where it is. A pending approval found past its time is recorded as expired. */
  state(
    tenant: TenantContext,
    approvalId: string,
    ask: PlanStepApprovalAsk,
  ): Promise<PlanStepApprovalState>;
  /** Withdraws a pending one, e.g. a duplicate a concurrent request lost to. */
  cancel(tenant: TenantContext, approvalId: string, reason: string): Promise<void>;
}

export function createPlanStepApprovals(
  service: Pick<ApprovalService, 'request' | 'get' | 'expire' | 'cancel'>,
  now: () => Date = () => new Date(),
): PlanStepApprovals {
  return Object.freeze({
    async request(tenant: TenantContext, ask: PlanStepApprovalAsk) {
      const approval = await service.request(tenant, {
        operation: planStepOperation(ask),
        riskLevel: ask.riskLevel,
        reason: 'plan_step_approval',
        impact: 'starts_step',
        ttlSeconds: PLAN_STEP_APPROVAL_TTL_SECONDS,
      });
      return approval.id;
    },

    async state(tenant: TenantContext, approvalId: string, ask: PlanStepApprovalAsk) {
      const approval = await service.get(tenant, approvalId);
      const problem = checkApprovalUse(approval, planStepOperation(ask), now());
      switch (problem) {
        case undefined:
          return { status: 'approved' } as const;
        case 'approval_pending':
          return { status: 'pending' } as const;
        case 'approval_rejected':
          return { status: 'declined', reason: 'rejected' } as const;
        case 'approval_cancelled':
          return { status: 'declined', reason: 'cancelled' } as const;
        case 'approval_expired':
          if (approval.status === 'pending') {
            // Nobody decided in time: recorded as expired, audited, then treated as declined.
            try {
              await service.expire(tenant, approval.id);
            } catch (error) {
              if (!isApprovalError(error)) throw error;
            }
          }
          return { status: 'declined', reason: 'expired' } as const;
        default:
          return { status: 'declined', reason: 'mismatch' } as const;
      }
    },

    async cancel(tenant: TenantContext, approvalId: string, reason: string) {
      try {
        await service.cancel(tenant, approvalId, reason);
      } catch (error) {
        if (!isApprovalError(error)) throw error;
      }
    },
  });
}
