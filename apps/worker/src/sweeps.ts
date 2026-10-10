import {
  ABANDON_AFTER_MS,
  classifyOpenWork,
  taskOf,
  type OpenWorkState,
  type SweptApproval,
  type SweptJob,
} from '@melonoffice/agents';
import type { ApprovalRepository } from '@melonoffice/approvals';
import type {
  Execution,
  ExecutionStatus,
  IsoTimestamp,
  OrganizationId,
  Plan,
  PlanId,
  UserId,
} from '@melonoffice/domain';
import {
  MAX_NODE_ATTEMPTS,
  OPEN_STATUSES,
  type ExecutionRepository,
  type OpenPosition,
  type StaleExecutionIndex,
  type SweepLedger,
  type SweepRecord,
  type SweptExecution,
} from '@melonoffice/execution';
import { jobIdFor, type JobRepository } from '@melonoffice/jobs';
import { turnOf } from '@melonoffice/integrations';
import type { Logger } from '@melonoffice/observability';
import { planStepOf, stepApprovalEntriesOf } from '@melonoffice/planning';
import type { Runtime } from '@melonoffice/runtime';
import { resolveRuntimeTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';

/**
 * The automatic sweep of abandoned agent work (ADR-0121). Every 3 hours one Cloud Tasks task on
 * the execution jobs queue reaches this route, behind the same invoker check as every job. It
 * closes only agent tasks, plan steps and conversation turns (ADR-0122) that nothing moved for 24 hours and that no worker,
 * person or outside service is still holding. A plan step that has not started while its plan
 * runs is never closed; one waiting for a person has its plan advanced, so an expired approval
 * skips its branch (ADR-0146). It never starts anything, calls no model or tool
 * and charges no credits.
 */
export const RUN_SWEEP_PATH = '/internal/sweeps/run';

/** How often the sweep runs: 8 small runs a day, never a poll. */
export const SWEEP_EVERY_MS = 3 * 3_600_000;

/**
 * A running plan nothing moved for this long is advanced once by the sweep (ADR-0179): the same
 * idempotent call a step's end makes, so a plan whose step end was never told, whose wake-up
 * was lost, or whose decision could not resume it goes on. On a plan that is fine, it changes
 * nothing.
 */
export const PLAN_IDLE_MS = 30 * 60_000;

/**
 * Candidates are read `perStatus` at a time, oldest first, up to `readPerStatus` per status and
 * run (ADR-0183), so work that is rightly waiting never hides the work behind it. At most
 * `perRun` are acted on (closed, or their plan advanced) per run; the rest wait for the next run.
 * A run that died is claimed again after `staleRunMs`.
 */
export const SWEEP_LIMITS = Object.freeze({
  perStatus: 50,
  readPerStatus: 500,
  perRun: 100,
  staleRunMs: 30 * 60_000,
});

/** What the sweep did to a candidate, beyond reading it: closed it, or advanced its plan. */
const ACTED = new Set<string>(['closed', 'awaiting_approval', 'wait_over', 'plan_advanced']);

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
  /**
   * The plans steps belong to (ADR-0146). A step that never started while its plan runs is
   * never abandoned; when it waits for a person, its plan is advanced instead, so an approval
   * nobody decided in time skips that branch rather than failing the plan.
   */
  readonly plans?: {
    find(organizationId: OrganizationId, id: PlanId): Promise<Plan | undefined>;
    advance(tenant: TenantContext, planId: PlanId): Promise<unknown>;
  };
  /**
   * Workflow schedules whose occurrence's task did not run in time (ADR-0185): each sweep runs
   * them as their task would. Absent: nothing recovers a lost occurrence.
   */
  readonly schedules?: { recover(): Promise<number> };
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
  const {
    executions,
    jobs,
    approvals,
    tenancy,
    runtime,
    ledger,
    scheduler,
    logger,
    plans,
    schedules,
  } = options;

  /**
   * A plan step that never started while its plan runs is not abandoned work: it waits for the
   * steps before it, or for a person's approval (ADR-0146). It is left alone; when it waits for
   * a person, its plan is advanced, which records an approval nobody decided in time as expired
   * and skips that branch.
   */
  async function waitsInPlan(
    execution: Execution,
  ): Promise<'awaiting_approval' | 'wait_over' | 'waiting_in_plan' | 'no_context' | undefined> {
    const step = planStepOf(execution);
    if (plans === undefined || step === undefined || execution.startedAt !== undefined) {
      return undefined;
    }
    const plan = await plans.find(execution.organizationId as OrganizationId, step.planId);
    if (plan?.status !== 'executing') return undefined;
    // Its plan is advanced when the step waits for a person, or when one of the plan's waits
    // is over (ADR-0152), or when this is a step's next attempt whose backoff is over (ADR-0153):
    // a wake-up that was lost never leaves the steps after it waiting.
    const asked = stepApprovalEntriesOf(plan, step.stepId).length > 0;
    const waitOver =
      (plan.waits ?? []).some((w) => Date.parse(w.until) <= now().getTime()) ||
      (plan.attempts ?? []).some(
        (a) => a.executionId === execution.id && Date.parse(a.notBefore) <= now().getTime(),
      );
    if (!asked && !waitOver) return 'waiting_in_plan';
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
    await plans.advance(tenant, plan.id);
    return asked ? 'awaiting_approval' : 'wait_over';
  }

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

  type Outcome =
    | OpenWorkState
    | 'waiting_in_plan'
    | 'wait_over'
    | 'out_of_scope'
    | 'no_context'
    | 'moved'
    | 'plan_advanced'
    | 'error';

  /**
   * A running plan nothing moved for `PLAN_IDLE_MS` (ADR-0179). Its planning execution is the
   * plan's own (same id): it is advanced as its person's runtime, exactly as a step's end would.
   * Nothing here runs a step twice: advancing starts only steps that never started, and decides,
   * asks and waits each once.
   */
  async function recoverPlan(candidate: Execution): Promise<Outcome> {
    if (plans === undefined || candidate.mode !== 'plan') return 'out_of_scope';
    const organizationId = candidate.organizationId as OrganizationId;
    const plan = await plans.find(organizationId, candidate.id as string as PlanId);
    if (plan?.status !== 'executing' || plan.delegationState !== 'completed') return 'moved';
    let tenant;
    try {
      tenant = await resolveRuntimeTenant(
        candidate.userId as UserId,
        candidate.organizationId,
        tenancy,
      );
    } catch {
      return 'no_context';
    }
    await plans.advance(tenant, plan.id);
    return 'plan_advanced';
  }

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
    const inPlan = await waitsInPlan(execution);
    if (inPlan !== undefined) return inPlan;
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

  /**
   * One status's candidates, oldest first by update then id, a page at a time (ADR-0183), until
   * none remain or `readPerStatus` were read. Reaching that limit is logged: the rest are read by
   * the next run.
   */
  async function* candidatesOf(status: ExecutionStatus, before: IsoTimestamp) {
    let after: OpenPosition | undefined;
    for (let read = 0; read < SWEEP_LIMITS.readPerStatus;) {
      const page = await executions.openSince(status, before, SWEEP_LIMITS.perStatus, after);
      yield* page;
      read += page.length;
      const last = page.at(-1);
      if (page.length < SWEEP_LIMITS.perStatus || last === undefined) return;
      after = { at: last.updatedAt, id: last.id };
    }
    logger?.warn('sweep read limit reached', { status, limit: SWEEP_LIMITS.readPerStatus });
  }

  async function sweep(slotId: string): Promise<SweepRecord> {
    const before = new Date(now().getTime() - ABANDON_AFTER_MS).toISOString() as IsoTimestamp;
    const counts: Record<string, number> = {};
    const closed: SweptExecution[] = [];
    let acted = 0;
    // A paused execution waits on something outside the runtime: never a candidate.
    for (const status of OPEN_STATUSES.filter((s) => s !== 'paused')) {
      if (acted >= SWEEP_LIMITS.perRun) break;
      for await (const candidate of candidatesOf(status, before)) {
        if (acted >= SWEEP_LIMITS.perRun) break;
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
        if (ACTED.has(key)) acted += 1;
      }
    }
    // Running plans nothing moved for a while (ADR-0179): their own executions are `running`.
    // Their budget is their own, so closing abandoned work never leaves a stalled plan behind.
    if (plans !== undefined) {
      const idle = new Date(now().getTime() - PLAN_IDLE_MS).toISOString() as IsoTimestamp;
      let advanced = 0;
      for await (const candidate of candidatesOf('running', idle)) {
        if (advanced >= SWEEP_LIMITS.perRun) break;
        if (candidate.mode !== 'plan') continue;
        let outcome: Outcome;
        try {
          outcome = await recoverPlan(candidate);
        } catch (error) {
          const code = (error as { code?: unknown }).code;
          logger?.warn('sweep plan recovery failed', {
            planId: candidate.id,
            code: typeof code === 'string' ? code : 'error',
          });
          outcome = 'error';
        }
        counts[outcome] = (counts[outcome] ?? 0) + 1;
        if (ACTED.has(outcome)) advanced += 1;
      }
    }
    // Schedules whose occurrence never ran: a lost task, a deploy, a worker that was down.
    if (schedules !== undefined) {
      try {
        const recovered = await schedules.recover();
        if (recovered > 0) counts.schedules = recovered;
      } catch (error) {
        const code = (error as { code?: unknown }).code;
        logger?.warn('sweep schedule recovery failed', {
          code: typeof code === 'string' ? code : 'error',
        });
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
