import type { ExecutionId, OrganizationId, SpecialistId } from '@melonoffice/domain';
import type { ExecutionService, OpenExecutionIndex } from '@melonoffice/execution';
import type { SpecialistStopReason, SpecialistWorkStop } from '@melonoffice/specialists';
import { isResolvedTenant, type TenantContext } from '@melonoffice/tenancy';

/**
 * What happens to an agent's work in progress when it stops (AE-4, ADR-0115). Pausing, disabling
 * or archiving an agent cancels every execution of it that has not ended, as the person who
 * changed its status, with the existing cooperative cancellation (ADR-0029): nothing is killed,
 * children its plans delegated are cancelled with it, and a late result is discarded. The approval
 * a cancelled execution was waiting on is withdrawn, so nobody is asked to approve work that will
 * never run. Nothing here throws: what it could not reach (beyond `limit`, or a failed write) is
 * still stopped at its next step, where the Harness finds the agent inactive and asks no model.
 */

/** How many executions one status change cancels directly; the rest stop at their next step. */
export const AGENT_STOP_LIMIT = 200;

export interface AgentWorkStopOptions {
  readonly executions: Pick<ExecutionService, 'cancel'>;
  readonly open: OpenExecutionIndex;
  /** Withdraws a pending approval (ADR-0026). Absent: approvals expire on their own. */
  readonly approvals?: {
    cancel(tenant: TenantContext, id: string, reason: string): Promise<unknown>;
  };
  readonly limit?: number;
  /**
   * Told of each execution it cancelled (ADR-0117): the API tells the task's person their agent
   * was stopped. Its failure changes nothing.
   */
  readonly onCancelled?: (
    tenant: TenantContext,
    execution: { readonly id: ExecutionId },
    reason: SpecialistStopReason,
  ) => Promise<void>;
  readonly logger?: {
    warn(message: string, fields?: Readonly<Record<string, unknown>>): void;
  };
}

export function createAgentWorkStop(options: AgentWorkStopOptions): SpecialistWorkStop {
  const { executions, open, approvals, onCancelled, logger } = options;
  const limit = options.limit ?? AGENT_STOP_LIMIT;
  return Object.freeze({
    async stop(tenant: TenantContext, specialistId: SpecialistId, reason: SpecialistStopReason) {
      if (!isResolvedTenant(tenant)) return { cancelled: 0, more: false };
      const organizationId = tenant.organizationId as OrganizationId;
      let found: { readonly ids: readonly ExecutionId[]; readonly more: boolean };
      try {
        found = await open.openOfSpecialist(organizationId, specialistId, limit);
      } catch {
        logger?.warn('agent work not found', { specialistId, reason });
        return { cancelled: 0, more: true };
      }
      let cancelled = 0;
      for (const id of found.ids) {
        try {
          const execution = await executions.cancel(tenant, id, reason);
          cancelled += 1;
          for (const node of execution.nodes) {
            if (node.approvalId === undefined || approvals === undefined) continue;
            // Only a pending approval is withdrawn; a decided or expired one refuses, harmlessly.
            await approvals.cancel(tenant, node.approvalId, reason).catch(() => undefined);
          }
          await onCancelled?.(tenant, execution, reason).catch(() => undefined);
        } catch {
          // Another cancellation, or the end, came first; or the write failed: the Harness stops
          // it at its next step either way.
          logger?.warn('agent work not cancelled', { executionId: id, reason });
        }
      }
      return { cancelled, more: found.more };
    },
  });
}
