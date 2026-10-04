import type { ApprovalOperation, PlanToolInput, ToolRiskLevel } from '@melonoffice/domain';
import type { TenantContext } from '@melonoffice/tenancy';
import { digestOf, type ResolvedTool, type ToolRegistry } from '@melonoffice/tools';
import { ApprovalError, isApprovalError } from './errors.js';
import { checkApprovalUse } from './model.js';
import type { ApprovalService } from './service.js';

/**
 * Approvals for plan steps (ADR-0146): a specialist step marked "ask me before this step runs"
 * asks for an ordinary approval (ADR-0026) when it becomes ready, through this same service. It
 * is bound to exactly one plan version, step and child execution, so it can never be stretched
 * to another step, plan version or tool call, and only a person acting directly may decide it.
 * `plan_step` is reserved in the tool registry, so no tool approval shares its operations.
 *
 * A tool step's approval (ADR-0151) is asked for the same way when the specialist step that uses
 * the tool becomes ready, but it is an ordinary tool approval: bound to the exact operation the
 * Tool Gate rebuilds when the step runs (the child execution, its tool node, the tool's version
 * and action, the digest of the plan's input), so the gate accepts it and nothing else.
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
  /** On a tool step's approval (ADR-0151): the tool call, with the input fixed in the plan. */
  readonly tool?: {
    readonly stepId: string;
    readonly id: string;
    readonly version: number;
    readonly input: PlanToolInput;
  };
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

/**
 * The operation a tool step's approval is bound to: exactly the one the Tool Gate builds for
 * that tool node (`gate.ts`), from the plan's input and the registry's tool version.
 */
export function planToolOperation(
  ask: PlanStepApprovalAsk & { readonly tool: NonNullable<PlanStepApprovalAsk['tool']> },
  tool: ResolvedTool,
): ApprovalOperation {
  return {
    organizationId: ask.organizationId,
    executionId: ask.childExecutionId,
    nodeId: ask.tool.stepId,
    specialistId: ask.specialistId,
    specialistVersion: ask.specialistVersion,
    toolId: ask.tool.id,
    toolVersion: ask.tool.version,
    action: tool.version.action,
    inputDigest: digestOf(ask.tool.input),
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
  /** Needed for tool steps (ADR-0151). Absent: a tool step's approval is never asked or given. */
  tools?: Pick<ToolRegistry, 'resolve'>,
): PlanStepApprovals {
  /** The tool a tool step's ask names, as the registry has it now. */
  function toolOf(ask: PlanStepApprovalAsk): ResolvedTool | undefined {
    return ask.tool === undefined ? undefined : tools?.resolve(ask.tool.id, ask.tool.version);
  }

  /** The operation an ask's approval is bound to; undefined for a tool the registry lacks. */
  function operationOf(ask: PlanStepApprovalAsk): ApprovalOperation | undefined {
    if (ask.tool === undefined) return planStepOperation(ask);
    const tool = toolOf(ask);
    return tool === undefined ? undefined : planToolOperation({ ...ask, tool: ask.tool }, tool);
  }

  return Object.freeze({
    async request(tenant: TenantContext, ask: PlanStepApprovalAsk) {
      if (ask.tool !== undefined) {
        const tool = toolOf(ask);
        if (tool === undefined) throw new ApprovalError('invalid_approval', 'tool');
        // The same request the Tool Gate makes for this call, made before the step starts.
        const approval = await service.request(tenant, {
          operation: planToolOperation({ ...ask, tool: ask.tool }, tool),
          riskLevel: tool.version.riskLevel,
          reason: 'approval_required',
          impact: tool.version.mutating ? 'changes_data' : 'reads_data',
          ttlSeconds: tool.version.approvalTtlSeconds,
        });
        return approval.id;
      }
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
      const operation = operationOf(ask);
      if (operation === undefined) return { status: 'declined', reason: 'mismatch' } as const;
      const approval = await service.get(tenant, approvalId);
      const problem = checkApprovalUse(approval, operation, now());
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
