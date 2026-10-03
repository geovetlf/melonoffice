import type { Execution } from '@melonoffice/domain';
import { isTerminal } from '@melonoffice/execution';

/**
 * Agent work that stopped moving (ADR-0120). Nothing sweeps executions yet, so an execution whose
 * job was never delivered again, or whose node ended `outcome_unknown`, can stay open forever.
 * MelonOffice does not close it on its own: it reads it as stuck, so that it never counts toward
 * the agent's open-work limit (ADR-0119), and the person sees it and may stop it.
 *
 * - `afterMs`: an open execution not updated for this long is stuck. Well past the longest a job
 *   is retried (10 deliveries, at most 10 minutes apart, each with a lease of at most 30 minutes)
 *   and the Harness's 10 minutes of work.
 * - `approvalAfterMs`: one waiting for approval is stuck only after the longest an approval may
 *   wait (30 days), plus a day.
 */
export const STALE_WORK = Object.freeze({
  afterMs: 6 * 3_600_000,
  approvalAfterMs: 31 * 86_400_000,
});

/** Whether an open execution stopped moving, at `now`. An ended one never is. */
export function isStaleWork(
  execution: Pick<Execution, 'status' | 'updatedAt'>,
  now: Date,
): boolean {
  if (isTerminal(execution.status)) return false;
  const updated = Date.parse(execution.updatedAt);
  if (!Number.isFinite(updated)) return false;
  const after =
    execution.status === 'waiting_approval' ? STALE_WORK.approvalAfterMs : STALE_WORK.afterMs;
  return now.getTime() - updated > after;
}
