import type { Execution } from '@melonoffice/domain';
import { isTerminal } from '@melonoffice/execution';

/**
 * Agent work that stopped moving (ADR-0120). An execution whose job was never delivered again, or
 * whose node ended `outcome_unknown`, can stay open. It is read as stuck, so that it never counts
 * toward the agent's open-work limit (ADR-0119), and the person sees it and may stop it. Only the
 * automatic sweep (ADR-0121, below) closes it, after 24 hours that nothing holds it.
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

// ---------------------------------------------------------------------------------------------
// The automatic sweep (ADR-0121)

/**
 * Where one open execution stands for the automatic sweep. Only `stuck` is ever closed.
 *
 * - `closed`: it already ended; nothing to do, ever again.
 * - `active`: a worker holds a live lease on one of its jobs, or it moved within `afterMs`.
 * - `awaiting_approval`: a person has an approval to decide that has not expired.
 * - `awaiting_external`: it is held (`paused`) on something outside the runtime.
 * - `no_progress`: nothing moved for more than `afterMs`, but less than `abandonAfterMs`: shown as
 *   stuck to its person (ADR-0120), never closed.
 * - `stuck`: none of the above, and nothing moved for more than `abandonAfterMs` (24 hours).
 */
export type OpenWorkState =
  'closed' | 'active' | 'awaiting_approval' | 'awaiting_external' | 'no_progress' | 'stuck';

/** 24 hours without any progress: the most a really abandoned execution is left open. */
export const ABANDON_AFTER_MS = 24 * 3_600_000;

/** The part of a job the sweep reads: its state, lease and last change. */
export interface SweptJob {
  readonly state: string;
  readonly lease?: { readonly acquiredAt: string; readonly expiresAt: string };
  readonly updatedAt: string;
}

/** The part of an approval the sweep reads. */
export interface SweptApproval {
  readonly status: string;
  readonly expiresAt: string;
  readonly decidedAt?: string;
}

const latest = (times: readonly (string | undefined)[]): number =>
  times.reduce((max, t) => {
    const ms = t === undefined ? Number.NaN : Date.parse(t);
    return Number.isFinite(ms) && ms > max ? ms : max;
  }, Number.NEGATIVE_INFINITY);

/**
 * Classifies one execution with what the sweep read about it: its jobs (every node's current
 * attempt) and the approvals its nodes wait on. The last progress is the latest change of the
 * execution, its nodes, its jobs and its leases: the heartbeat the runtime already writes.
 */
export function classifyOpenWork(input: {
  readonly execution: Pick<Execution, 'status' | 'updatedAt' | 'nodes'>;
  readonly jobs: readonly SweptJob[];
  readonly approvals: readonly SweptApproval[];
  readonly now: Date;
}): { readonly state: OpenWorkState; readonly lastProgressAt: string | null } {
  const { execution, jobs, approvals, now } = input;
  const at = now.getTime();
  const progress = latest([
    execution.updatedAt,
    ...execution.nodes.flatMap((n) => [n.startedAt, n.completedAt]),
    ...jobs.flatMap((j) => [j.updatedAt, j.lease?.acquiredAt]),
    ...approvals.map((a) => a.decidedAt),
  ]);
  const lastProgressAt = Number.isFinite(progress) ? new Date(progress).toISOString() : null;
  const result = (state: OpenWorkState) => Object.freeze({ state, lastProgressAt });
  if (isTerminal(execution.status)) return result('closed');
  // A worker holds it now: whatever the clock says, it is running.
  if (jobs.some((j) => j.state === 'leased' && Date.parse(j.lease?.expiresAt ?? '') > at)) {
    return result('active');
  }
  if (
    execution.status === 'waiting_approval' &&
    approvals.some((a) => a.status === 'pending' && Date.parse(a.expiresAt) > at)
  ) {
    return result('awaiting_approval');
  }
  if (execution.status === 'paused') return result('awaiting_external');
  // No time readable at all: never read as abandoned.
  if (!Number.isFinite(progress)) return result('active');
  const idle = at - progress;
  if (idle <= STALE_WORK.afterMs) return result('active');
  if (idle <= ABANDON_AFTER_MS) return result('no_progress');
  return result('stuck');
}
