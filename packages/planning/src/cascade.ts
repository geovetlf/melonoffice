import { actorOf, buildAuditEvent } from '@melonoffice/audit';
import type { Execution, ExecutionId, PlanId } from '@melonoffice/domain';
import type { CancellationCascade } from '@melonoffice/execution';
import type { TenantContext } from '@melonoffice/tenancy';
import { isPlanningError } from './errors.js';
import { isPlanTerminal } from './lifecycle.js';
import { applyPlanStatus, isPlanReason } from './model.js';
import type { PlanRepository } from './repository.js';

export interface PlanCancellationCascadeOptions {
  readonly repository: PlanRepository;
  /**
   * Withdraws what a cancelled plan still waits for a person on (ADR-0179): each step approval
   * nobody decided leaves the inbox with it. Absent: those approvals wait until they expire.
   */
  readonly approvals?: {
    cancel(tenant: TenantContext, approvalId: string, reason: string): Promise<unknown>;
  };
  readonly now?: () => Date;
  readonly requestId?: string;
}

/**
 * How a cancellation reaches what a plan delegated (ADR-0029). A planning execution's id is its
 * plan's id, so the children of a cancelled planning execution are exactly the plan's
 * delegations: their ids are fixed when the delegation is claimed, even before they exist. The
 * plan is cancelled with its execution, unless it already ended or its delegation is still being
 * created (that delegation fails on the cancelled execution and cancels its own children).
 *
 * It only reads and cancels plans. It never changes an execution: the execution service cancels
 * the children it returns.
 */
export function createPlanCancellationCascade({
  repository,
  approvals,
  now = () => new Date(),
  requestId,
}: PlanCancellationCascadeOptions): CancellationCascade {
  return Object.freeze({
    async cancelled(
      tenant: TenantContext,
      execution: Execution,
      reason: string,
    ): Promise<readonly ExecutionId[]> {
      if (execution.mode !== 'plan') return [];
      const planId = execution.id as string as PlanId;
      const plan = await repository.find(execution.organizationId, planId);
      if (plan === undefined) return [];
      if (!isPlanTerminal(plan.status) && plan.delegationState !== 'creating') {
        const at = now();
        await repository
          .update(execution.organizationId, planId, (current) => {
            const next = applyPlanStatus(
              current,
              current.status,
              'cancelled',
              at.toISOString() as typeof current.updatedAt,
            );
            return {
              plan: next,
              events: [
                buildAuditEvent(
                  {
                    action: 'plan.state_changed',
                    result: 'success',
                    actor: actorOf(tenant),
                    organizationId: execution.organizationId,
                    target: { type: 'plan', id: next.id },
                    transition: { from: current.status, to: 'cancelled' },
                    reason: isPlanReason(reason) ? reason : 'execution_cancelled',
                    ...(requestId === undefined ? {} : { requestId }),
                    source: 'api',
                  },
                  at,
                ),
              ],
            };
          })
          .catch((error: unknown) => {
            // Someone else moved the plan first (it ended, or its delegation started): the
            // children below are still cancelled.
            if (!isPlanningError(error)) throw error;
          });
      }
      // Every child the plan ever had: its delegations and each step's later attempts (ADR-0153),
      // read again once the plan ended, so an attempt recorded meanwhile is cancelled too.
      const ended = (await repository.find(execution.organizationId, planId)) ?? plan;
      if (approvals !== undefined && ended.status === 'cancelled') {
        for (const entry of ended.stepApprovals ?? []) {
          if (entry.declined !== undefined) continue;
          // Decided or withdrawn already, by a person or another call: nothing left to withdraw.
          await approvals.cancel(tenant, entry.approvalId, 'plan_cancelled').catch(() => undefined);
        }
      }
      return [
        ...ended.delegations.map((d) => d.executionId),
        ...(ended.attempts ?? []).map((a) => a.executionId),
      ];
    },
  });
}
