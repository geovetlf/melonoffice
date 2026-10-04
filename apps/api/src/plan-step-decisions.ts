import { isPlanStepApproval } from '@melonoffice/approvals';
import type { Approval } from '@melonoffice/domain';
import type { ExecutionRepository } from '@melonoffice/execution';
import type { Logger } from '@melonoffice/observability';
import { planStepOf, type PlanConductor } from '@melonoffice/planning';
import { resolveRuntimeTenant, type TenancyStore } from '@melonoffice/tenancy';

/**
 * Once a person decided a plan step's approval (ADR-0146), its plan goes on at once: approved,
 * the step starts; rejected, its branch is skipped and the plan closes when nothing else is
 * left. The plan goes on as the runtime of the person its step runs for, never as the one who
 * decided, and only within the approval's own organization. Other approvals are left alone, and
 * a failure here never changes the decision: the worker's next look at the plan catches up.
 *
 * The same goes for a tool step's approval asked before its step started (ADR-0151): an
 * ordinary tool approval on the tool node of a plan step's child that has not started. One on a
 * child already running is the Tool Gate's own, resumed like any other (`false` is returned).
 */
export function createPlanStepDecisions(options: {
  readonly executions: Pick<ExecutionRepository, 'find'>;
  readonly tenancy: TenancyStore;
  readonly conductor: Pick<PlanConductor, 'resume'>;
  readonly logger?: Logger;
}): (approval: Approval) => Promise<boolean> {
  const { executions, tenancy, conductor, logger } = options;
  return async (approval) => {
    const own = isPlanStepApproval(approval);
    try {
      const child = await executions.find(approval.organizationId, approval.operation.executionId);
      const step = child === undefined ? undefined : planStepOf(child);
      if (child === undefined || step === undefined) return own;
      const ours = own
        ? step.stepId === approval.operation.nodeId
        : child.startedAt === undefined &&
          child.nodes.some((n) => n.id === approval.operation.nodeId && n.type === 'tool');
      if (!ours) return own;
      if (approval.status === 'pending') return true;
      const tenant = await resolveRuntimeTenant(child.userId, child.organizationId, tenancy);
      await conductor.resume(tenant, step.planId);
      return true;
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      logger?.warn('plan not resumed after a step decision', {
        approvalId: approval.id,
        code: typeof code === 'string' ? code : 'unexpected',
      });
      return own;
    }
  };
}
