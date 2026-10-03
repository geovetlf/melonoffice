import {
  ABANDON_AFTER_MS,
  classifyOpenWork,
  taskOf,
  type OpenWorkState,
  type SweptApproval,
  type SweptJob,
} from '@melonoffice/agents';
import type { ApprovalRepository } from '@melonoffice/approvals';
import type { Execution, IsoTimestamp, OrganizationId, UserId } from '@melonoffice/domain';
import {
  MAX_NODE_ATTEMPTS,
  OPEN_STATUSES,
  type ExecutionRepository,
  type StaleExecutionIndex,
  type SweepLedger,
  type SweepRecord,
  type SweptExecution,
} from '@melonoffice/execution';
import { jobIdFor, type JobRepository } from '@melonoffice/jobs';
import { turnOf } from '@melonoffice/integrations';
import type { Logger } from '@melonoffice/observability';
import { planStepOf } from '@melonoffice/planning';
import type { Runtime } from '@melonoffice/runtime';
import { resolveRuntimeTenant, type TenancyStore } from '@melonoffice/tenancy';

/**
 * The automatic sweep of abandoned agent work (ADR-0121). Every 3 hours one Cloud Tasks task on
 * the execution jobs queue reaches this route, behind the same invoker check as every job. It
 * closes only agent tasks, plan steps and conversation turns (ADR-0122) that nothing moved for 24 hours and that no worker,
 * person or outside service is still holding. It never starts anything, calls no model or tool
 * and charges no credits.
 */
export const RUN_SWEEP_PATH = '/internal/sweeps/run';

/** How often the sweep runs: 8 small runs a day, never a poll. */
export const SWEEP_EVERY_MS = 3 * 3_600_000;

/**
 * At most this many candidates are read per status and closed per run; the rest wait for the
 * next run. A run that died is claimed again after `staleRunMs`.
 */
export const SWEEP_LIMITS = Object.freeze({
  perStatus: 50,
  perRun: 100,
  staleRunMs: 30 * 60_000,
});

/** A slot is named by its UTC start: `sweep-20261002t03`. No colons, so it is a valid id. */
const SLOT = /^sweep-(\d{4})(\d{2})(\d{2})t(\d{2})$/;

/** The slot that starts at the latest 3-hour boundary at or before `at`. */
export function sweepSlotOf(at: Date): { readonly id: string; readonly at: Date } {
  const start = new Date(Math.floor(at.getTime() / SWEEP_EVERY_MS) * SWEEP_EVERY_MS);
  const iso = start.toISOString();
  const id = `sweep-${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}t${iso.slice(11, 13)}`;
  return Object.freeze({ id, at: start });
}

/** The first slot that starts after `at`. */
export const nextSweepSlot = (at: Date) =>
  sweepSlotOf(new Date(sweepSlotOf(at).at.getTime() + SWEEP_EVERY_MS));

/** A slot's start, or undefined when the id is not one. */
export function slotStartOf(id: string): Date | undefined {
  const m = SLOT.exec(id);
  if (m === null) return undefined;
  const start = new Date(`${m[1]}-${m[2]}-${m[3]}T${m[4]}:00:00.000Z`);
  if (Number.isNaN(start.getTime()) || sweepSlotOf(start).id !== id) return undefined;
  return start;
}

/**
 * The work the sweep may close: an agent's task, a step of an approved plan, or a conversation
 * agent's turn (ADR-0122), whose stop hook hands its conversation to a person.
 */
const inScope = (execution: Execution): boolean =>
  taskOf(execution) !== undefined ||
  planStepOf(execution) !== undefined ||
  turnOf(execution) !== undefined;

export interface ExecutionSweeperOptions {
  readonly executions: StaleExecutionIndex & Pick<ExecutionRepository, 'find'>;
  readonly jobs: Pick<JobRepository, 'find'>;
  readonly approvals: Pick<ApprovalRepository, 'find'>;
  readonly tenancy: TenancyStore;
  /** Closes one execution as the runtime of its person (`Runtime.abandon`). */
  readonly runtime: Pick<Runtime, 'abandon'>;
  readonly ledger: SweepLedger;
  /** Queues the next slot's task. Absent: the sweep runs only when its task is delivered. */
  readonly scheduler?: { schedule(body: object, at: Date): Promise<void> };
  readonly now?: () => Date;
  readonly logger?: Logger;
}

export interface SweepRunResult {
  readonly status: 200 | 400 | 503;
  readonly body: { readonly result: string; readonly code?: string };
}

export interface ExecutionSweeper {
  /** One run of one slot: claims it, queues the next one, then closes what is abandoned. */
  run(request: unknown): Promise<SweepRunResult>;
  /** Queues the next slot once, wherever the worker starts (a lost task never ends the chain). */
  ensureNext(): Promise<void>;
  /** The run itself, without the claim: what each test case checks. */
  sweep(slotId: string): Promise<SweepRecord>;
}

const answer = (status: SweepRunResult['status'], body: SweepRunResult['body']) =>
  Object.freeze({ status, body: Object.freeze(body) });

/** Exactly `{ "slot": "sweep-…" }`. */
function slotOf(request: unknown): string | undefined {
  if (typeof request !== 'object' || request === null || Array.isArray(request)) return undefined;
  if (Object.keys(request).join(',') !== 'slot') return undefined;
  const { slot } = request as { slot: unknown };
  return typeof slot === 'string' && slotStartOf(slot) !== undefined ? slot : undefined;
}

export function createExecutionSweeper(options: ExecutionSweeperOptions): ExecutionSweeper {
  const now = options.now ?? (() => new Date());
  const { executions, jobs, approvals, tenancy, runtime, ledger, scheduler, logger } = options;

  /** Every job of the execution that exists (ids are fixed by node and attempt), its own only. */
  async function jobsOf(execution: Execution): Promise<SweptJob[]> {
    const found: SweptJob[] = [];
    for (const node of execution.nodes) {
      for (let attempt = 1; attempt <= MAX_NODE_ATTEMPTS; attempt += 1) {
        const job = await jobs.find(
          jobIdFor(execution.organizationId, execution.id, node.id, attempt),
        );
        if (job === undefined || job.organizationId !== execution.organizationId) continue;
        found.push(job);
      }
    }
    return found;
  }

  async function approvalsOf(execution: Execution): Promise<SweptApproval[]> {
    const found: SweptApproval[] = [];
    for (const node of execution.nodes) {
      if (node.approvalId === undefined) continue;
      const approval = await approvals.find(execution.organizationId, node.approvalId);
      if (approval !== undefined) found.push(approval);
    }
    return found;
  }

  /** Why a stuck execution is abandoned, as recorded on its audit event. */
  const whyOf = (execution: Execution, swept: readonly SweptJob[], at: number): string =>
    swept.some((j) => j.state === 'leased' && Date.parse(j.lease?.expiresAt ?? '') <= at)
      ? 'lease_expired'
      : execution.status === 'waiting_approval'
        ? 'approval_expired'
        : 'no_progress';

  type Outcome = OpenWorkState | 'out_of_scope' | 'no_context' | 'moved' | 'error';

  async function visit(
    slotId: string,
    candidate: Execution,
    closed: SweptExecution[],
  ): Promise<Outcome> {
    if (!inScope(candidate)) return 'out_of_scope';
    // Read again in its own organization: the sweep trusts nothing from the query alone.
    const execution = await executions.find(
      candidate.organizationId as OrganizationId,
      candidate.id,
    );
    if (execution === undefined || execution.organizationId !== candidate.organizationId) {
      return 'moved';
    }
    const detectedAt = now();
    const [swept, waiting] = [await jobsOf(execution), await approvalsOf(execution)];
    const { state, lastProgressAt } = classifyOpenWork({
      execution,
      jobs: swept,
      approvals: waiting,
      now: detectedAt,
    });
    if (state !== 'stuck') return state;
    // Its person's runtime, as every runtime step: no member, no organization, no action.
    let tenant;
    try {
      tenant = await resolveRuntimeTenant(
        execution.userId as UserId,
        execution.organizationId,
        tenancy,
      );
    } catch {
      return 'no_context';
    }
    const why = whyOf(execution, swept, detectedAt.getTime());
    try {
      await runtime.abandon(tenant, execution.id, {
        from: execution.status,
        revision: execution.revision,
        sweepId: slotId,
        why,
      });
    } catch (error) {
      const code = (error as { code?: unknown }).code;
      // It moved, or ended, between the read and the close: it is not abandoned.
      if (code === 'execution_concurrency_conflict') return 'moved';
      logger?.warn('sweep close failed', {
        executionId: execution.id,
        code: typeof code === 'string' ? code : 'error',
      });
      return 'error';
    }
    closed.push(
      Object.freeze({
        executionId: execution.id,
        organizationId: execution.organizationId as OrganizationId,
        from: execution.status,
        why,
        lastProgressAt,
        detectedAt: detectedAt.toISOString() as IsoTimestamp,
        closedAt: now().toISOString() as IsoTimestamp,
      }),
    );
    return 'closed';
  }

  async function sweep(slotId: string): Promise<SweepRecord> {
    const before = new Date(now().getTime() - ABANDON_AFTER_MS).toISOString() as IsoTimestamp;
    const counts: Record<string, number> = {};
    const closed: SweptExecution[] = [];
    let visited = 0;
    // A paused execution waits on something outside the runtime: never a candidate.
    for (const status of OPEN_STATUSES.filter((s) => s !== 'paused')) {
      if (visited >= SWEEP_LIMITS.perRun) break;
      const candidates = await executions.openSince(status, before, SWEEP_LIMITS.perStatus);
      for (const candidate of candidates) {
        if (visited >= SWEEP_LIMITS.perRun) break;
        visited += 1;
        let outcome: Outcome;
        try {
          outcome = await visit(slotId, candidate, closed);
        } catch (error) {
          const code = (error as { code?: unknown }).code;
          logger?.warn('sweep read failed', {
            executionId: candidate.id,
            code: typeof code === 'string' ? code : 'error',
          });
          outcome = 'error';
        }
        const key = outcome === 'stuck' ? 'closed' : outcome;
        counts[key] = (counts[key] ?? 0) + 1;
      }
    }
    return Object.freeze({
      slotId,
      counts: Object.freeze(counts),
      closed: Object.freeze(closed),
      finishedAt: now().toISOString() as IsoTimestamp,
    });
  }

  /** Queues a slot's task once; a failed queue lets the next caller try again. */
  async function queue(slot: { readonly id: string; readonly at: Date }): Promise<void> {
    if (scheduler === undefined) return;
    if (!(await ledger.reserve(slot.id, now().toISOString() as IsoTimestamp))) return;
    try {
      await scheduler.schedule({ slot: slot.id }, slot.at);
    } catch (error) {
      await ledger.unreserve(slot.id);
      throw error;
    }
  }

  return Object.freeze({
    sweep,
    async ensureNext() {
      try {
        await queue(nextSweepSlot(now()));
      } catch (error) {
        logger?.warn('sweep not scheduled', {
          code: (error as { code?: unknown }).code ?? 'error',
        });
      }
    },
    async run(request: unknown) {
      const slotId = slotOf(request);
      if (slotId === undefined) return answer(400, { result: 'invalid_request', code: 'slot' });
      const start = slotStartOf(slotId) as Date;
      const at = now();
      // A task for a slot that has not started yet is early: the queue delivers it again.
      if (start.getTime() > at.getTime() + 60_000) {
        return answer(503, { result: 'not_due' });
      }
      const claim = await ledger.claim(
        slotId,
        at.toISOString() as IsoTimestamp,
        SWEEP_LIMITS.staleRunMs,
      );
      if (claim === 'done') return answer(200, { result: 'already_swept' });
      if (claim === 'running') return answer(200, { result: 'in_progress' });
      // The next run is queued first, so a run that fails never ends the chain.
      try {
        await queue(nextSweepSlot(at));
      } catch (error) {
        logger?.warn('sweep not scheduled', {
          code: (error as { code?: unknown }).code ?? 'error',
        });
      }
      const record = await sweep(slotId);
      await ledger.finish(record);
      logger?.info('sweep finished', { slotId, ...record.counts });
      return answer(200, { result: 'swept' });
    },
  });
}
