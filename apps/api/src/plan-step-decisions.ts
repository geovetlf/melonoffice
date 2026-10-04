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
 */
export function createPlanStepDecisions(options: {
  readonly executions: Pick<ExecutionRepository, 'find'>;
  readonly tenancy: TenancyStore;
  readonly conductor: Pick<PlanConductor, 'resume'>;
  readonly logger?: Logger;
}): (approval: Approval) => Promise<void> {
  const { executions, tenancy, conductor, logger } = options;
  return async (approval) => {
    if (!isPlanStepApproval(approval) || approval.status === 'pending') return;
    try {
      const child = await executions.find(approval.organizationId, approval.operation.executionId);
      const step = child === undefined ? undefined : planStepOf(child);
      if (child === undefined || step === undefined || step.stepId !== approval.operation.nodeId) {
        return;
      }
      const tenant = await resolveRuntimeTenant(child.userId, child.organizationId, tenancy);
      await conductor.resume(tenant, step.planId);
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      logger?.warn('plan not resumed after a step decision', {
        approvalId: approval.id,
        code: typeof code === 'string' ? code : 'unexpected',
      });
    }
  };
}
