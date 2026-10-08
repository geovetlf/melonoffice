import type {
  IsoTimestamp,
  OrganizationId,
  Plan,
  PlanId,
  WorkflowId,
  WorkflowSchedule,
  WorkflowScheduleOutcome,
} from '@melonoffice/domain';
import {
  isPlanningError,
  isPlanTerminal,
  type PlanConductor,
  type PlanService,
} from '@melonoffice/planning';
import type { AuthorizationService } from '@melonoffice/rbac';
import {
  isOrganizationId,
  resolveRuntimeTenant,
  type TenancyStore,
  type TenantContext,
} from '@melonoffice/tenancy';
import { isWorkflowError, WorkflowError } from './errors.js';
import { isWorkflowId } from './model.js';
import type { WorkflowRepository } from './repository.js';
import {
  nextOccurrence,
  queueOccurrence,
  scheduleEvent,
  SCHEDULE_LATE_MS,
  SCHEDULE_LEASE_MS,
  SCHEDULE_RECOVER_AFTER_MS,
  SCHEDULE_RECOVER_LIMIT,
  STANDING_PERMISSIONS,
  switchedOff,
  withRun,
  type WorkflowScheduleRepository,
} from './schedule.js';
import type { WorkflowService } from './service.js';

/** The worker's route for one occurrence's task (ADR-0185). */
export const RUN_SCHEDULE_PATH = '/internal/workflow-schedules/run';

export interface ScheduleRunResult {
  readonly status: 200 | 400 | 503;
  readonly body: { readonly result: string; readonly code?: string };
}

/**
 * Runs workflow schedules' occurrences (ADR-0185), in the worker, on the paths that exist: the
 * workflow's own plan, the plan's decision, the conductor. It claims each occurrence once,
 * queues the next one first, and records what the occurrence did on the schedule and in audit.
 */
export interface ScheduleRunner {
  /** One occurrence's task, as Cloud Tasks delivers it. */
  run(request: unknown): Promise<ScheduleRunResult>;
  /** Occurrences their task did not run in time: the sweep's call (ADR-0185 §10). */
  recover(): Promise<number>;
}

export interface ScheduleRunnerOptions {
  readonly schedules: WorkflowScheduleRepository;
  readonly workflows: Pick<WorkflowRepository, 'find'>;
  readonly workflowService: Pick<WorkflowService, 'planOccurrence'>;
  readonly plans: Pick<PlanService, 'approveScheduled' | 'pageForWorkflow'>;
  readonly conductor: Pick<PlanConductor, 'run'>;
  readonly tenancy: TenancyStore;
  /** Checked for the person at every occurrence: the standing approval holds only while they can (ADR-0185 §6). */
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  /** Queues an occurrence's task. Absent: occurrences run only when the sweep recovers them. */
  readonly scheduler?: { schedule(body: object, at: Date): Promise<void> };
  readonly now?: () => Date;
  readonly logger?: {
    info(message: string, fields?: Record<string, unknown>): void;
    warn(message: string, fields?: Record<string, unknown>): void;
  };
}

/** Why a claim found nothing to do: an old, repeated or replaced task. */
class Unclaimed extends Error {
  constructor(readonly code: 'not_on' | 'not_this_occurrence' | 'early') {
    super(code);
  }
}

/** Another delivery holds the occurrence and is still within its lease: this one is retried later. */
class Busy extends Error {
  readonly code = 'in_progress';
  constructor() {
    super('in_progress');
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/** The code a retry reports: the domain's own, or `in_progress` for a held occurrence. */
const codeOf = (error: unknown): string => {
  if (error instanceof Busy) return error.code;
  return isWorkflowError(error) || isPlanningError(error) ? error.code : 'internal_error';
};

export function createScheduleRunner({
  schedules,
  workflows,
  workflowService,
  plans,
  conductor,
  tenancy,
  authorization,
  scheduler,
  now = () => new Date(),
  logger,
}: ScheduleRunnerOptions): ScheduleRunner {
  /** Takes the occurrence: once, by one caller. A claimed one is taken up again only after its lease. */
  async function claim(
    organizationId: OrganizationId,
    workflowId: WorkflowId,
    occurrence: IsoTimestamp,
  ): Promise<WorkflowSchedule> {
    const at = now();
    return schedules
      .update(organizationId, workflowId, (current) => {
        if (current?.status !== 'on') throw new Unclaimed('not_on');
        if (current.nextRunAt !== occurrence) {
          if (current.last?.occurrence === occurrence && current.last.outcome === 'claimed') {
            // Another delivery of this task holds it. Once its lease has lapsed, its worker died
            // before it finished, and the same task takes the occurrence up (ADR-0185 §5).
            if (Date.parse(current.last.at) + SCHEDULE_LEASE_MS > at.getTime()) throw new Busy();
            return {
              schedule: withRun(current, { occurrence, outcome: 'claimed' }, at),
              events: [],
            };
          }
          throw new Unclaimed('not_this_occurrence');
        }
        // Never run before its time; a task that arrived early (a hop) only queues itself again.
        if (at.getTime() < Date.parse(occurrence) - 60_000) throw new Unclaimed('early');
        // The next one is after now: late occurrences collapse into this one, never a burst.
        const from = new Date(Math.max(at.getTime(), Date.parse(occurrence)));
        const next = nextOccurrence(current.recurrence, current.timeZone, from);
        return {
          schedule: {
            ...withRun(current, { occurrence, outcome: 'claimed' }, at),
            nextRunAt: next.toISOString() as IsoTimestamp,
          },
          events: [],
        };
      })
      .catch((error: unknown) => {
        // Another organization's workflow, or none: nothing of this organization to claim.
        if (isWorkflowError(error) && error.code === 'workflow_not_found') {
          throw new Unclaimed('not_on');
        }
        throw error;
      });
  }

  /** What the occurrence did, recorded once on the schedule and in audit. */
  async function finish(
    schedule: WorkflowSchedule,
    occurrence: IsoTimestamp,
    outcome: Exclude<WorkflowScheduleOutcome, 'claimed'>,
    planId?: PlanId,
  ): Promise<WorkflowScheduleOutcome> {
    const at = now();
    await schedules
      .update(schedule.organizationId, schedule.workflowId, (current) => {
        if (current === undefined) throw new WorkflowError('schedule_not_found');
        if (current.last?.occurrence !== occurrence || current.last.outcome !== 'claimed') {
          // Recorded already by another delivery of the same task.
          throw new Unclaimed('not_this_occurrence');
        }
        return {
          schedule: withRun(
            current,
            { occurrence, outcome, ...(planId === undefined ? {} : { planId }) },
            at,
          ),
          events: [
            scheduleEvent(
              { actor: 'runtime', userId: current.confirmedBy },
              current.organizationId,
              current.workflowId,
              'workflow.schedule_run',
              {
                reason: outcome,
                reference: `occurrence:${occurrence}`,
                version: current.workflowVersion,
              },
              at,
            ),
          ],
        };
      })
      .catch((error: unknown) => {
        if (!(error instanceof Unclaimed)) throw error;
      });
    logger?.info('workflow schedule ran', {
      workflowId: schedule.workflowId,
      occurrence,
      outcome,
    });
    return outcome;
  }

  /**
   * A plan this schedule made that is still open, other than this occurrence's. Every plan of the
   * workflow is read, not only the newest page: an old plan that is still open blocks the run too.
   */
  async function overlapping(
    tenant: TenantContext,
    schedule: WorkflowSchedule,
    occurrence: string,
  ) {
    const { items } = await plans.pageForWorkflow(tenant, schedule.workflowId, {
      limit: Number.MAX_SAFE_INTEGER,
    });
    return items.some(
      (p) =>
        p.workflow?.occurrence !== undefined &&
        p.workflow.occurrence !== occurrence &&
        !isPlanTerminal(p.status),
    );
  }

  /** Plans the occurrence, applies the standing approval when it may, and starts it. */
  async function planAndStart(
    tenant: TenantContext,
    schedule: WorkflowSchedule,
    occurrence: IsoTimestamp,
  ): Promise<{ outcome: Exclude<WorkflowScheduleOutcome, 'claimed'>; planId?: PlanId }> {
    let planned;
    try {
      planned = await workflowService.planOccurrence(tenant, schedule.workflowId, {
        occurrence,
        workflowVersion: schedule.workflowVersion,
      });
    } catch (error) {
      if (!isWorkflowError(error)) throw error;
      if (error.code === 'workflow_version_changed') return { outcome: 'version_changed' };
      if (error.code === 'workflow_not_active' || error.code === 'workflow_not_found') {
        return { outcome: 'workflow_not_active' };
      }
      if (error.code === 'permission_denied') return { outcome: 'not_allowed' };
      if (error.code === 'assignee_unavailable' || error.code === 'workflow_plan_ended') {
        return { outcome: 'refused' };
      }
      throw error;
    }
    if (planned.status === 'refused') return { outcome: 'refused' };
    let plan: Plan = planned.plan;
    if (plan.status === 'approval_required') {
      try {
        plan = await plans.approveScheduled(tenant, plan.id, {
          workflowId: schedule.workflowId,
          workflowVersion: schedule.workflowVersion,
        });
      } catch (error) {
        // A risk above the standing approval: the plan waits for a person, as a workflow's plan
        // always did (ADR-0071). A person who no longer may approve: the occurrence is not allowed.
        if (isPlanningError(error) && error.code === 'permission_denied') {
          return error.detail === 'permission_denied'
            ? { outcome: 'not_allowed', planId: plan.id }
            : { outcome: 'awaiting_person', planId: plan.id };
        }
        throw error;
      }
    }
    if (plan.status === 'approved' || plan.status === 'executing') {
      if (plan.decision?.via !== 'schedule') return { outcome: 'planned', planId: plan.id };
      await conductor.run(tenant, plan.id);
      return { outcome: 'planned', planId: plan.id };
    }
    // Rejected or cancelled by a person meanwhile, or already over: nothing to start.
    return { outcome: 'planned', planId: plan.id };
  }

  async function occur(
    organizationId: OrganizationId,
    workflowId: WorkflowId,
    occurrence: IsoTimestamp,
  ): Promise<string> {
    let schedule: WorkflowSchedule;
    try {
      schedule = await claim(organizationId, workflowId, occurrence);
    } catch (error) {
      if (!(error instanceof Unclaimed)) throw error;
      if (error.code === 'early') {
        await queueOccurrence(scheduler, { organizationId, workflowId, occurrence }, now());
      }
      return error.code;
    }
    // The next task first, so a failure below never ends the chain.
    if (schedule.nextRunAt !== undefined && schedule.nextRunAt !== occurrence) {
      try {
        await queueOccurrence(
          scheduler,
          { organizationId, workflowId, occurrence: schedule.nextRunAt },
          now(),
        );
      } catch (error) {
        // The sweep recovers it.
        logger?.warn('workflow schedule could not queue its next task', {
          workflowId,
          code: (error as { code?: unknown }).code,
        });
      }
    }

    if (now().getTime() - Date.parse(occurrence) > SCHEDULE_LATE_MS) {
      return finish(schedule, occurrence, 'missed');
    }
    const workflow = await workflows.find(organizationId, workflowId);
    if (workflow === undefined || workflow.status === 'archived') {
      // An archived workflow never runs again: its schedule is switched off.
      await finish(schedule, occurrence, 'workflow_not_active');
      await schedules
        .update(organizationId, workflowId, (current) => {
          if (current?.status !== 'on') throw new Unclaimed('not_on');
          return switchedOff(
            current,
            { actor: 'runtime', userId: current.confirmedBy },
            now(),
            'workflow_archived',
          );
        })
        .catch((error: unknown) => {
          if (!(error instanceof Unclaimed)) throw error;
        });
      return 'workflow_not_active';
    }
    if (workflow.status !== 'active') return finish(schedule, occurrence, 'workflow_not_active');
    if (workflow.version !== schedule.workflowVersion) {
      return finish(schedule, occurrence, 'version_changed');
    }
    let tenant: TenantContext;
    try {
      tenant = await resolveRuntimeTenant(schedule.confirmedBy, organizationId, tenancy);
    } catch {
      // The person left, was suspended, or the organization is no longer active.
      return finish(schedule, occurrence, 'not_allowed');
    }
    // The standing approval holds only while its person keeps all three permissions (ADR-0185 §6).
    const standing = STANDING_PERMISSIONS.every(
      (permission) => authorization.authorize(tenant, permission, { organizationId }).allowed,
    );
    if (!standing) return finish(schedule, occurrence, 'not_allowed');
    if (await overlapping(tenant, schedule, occurrence)) {
      return finish(schedule, occurrence, 'overlap');
    }
    const { outcome, planId } = await planAndStart(tenant, schedule, occurrence);
    return finish(schedule, occurrence, outcome, planId);
  }

  return Object.freeze({
    async run(request: unknown): Promise<ScheduleRunResult> {
      const body = request as Record<string, unknown> | null;
      if (
        typeof body !== 'object' ||
        body === null ||
        Object.keys(body).length !== 3 ||
        !isOrganizationId(body.organizationId) ||
        !isWorkflowId(body.workflowId) ||
        typeof body.occurrence !== 'string' ||
        !ISO.test(body.occurrence) ||
        Number.isNaN(Date.parse(body.occurrence))
      ) {
        return { status: 400, body: { result: 'invalid_request' } };
      }
      try {
        const result = await occur(
          body.organizationId as OrganizationId,
          body.workflowId as WorkflowId,
          body.occurrence as IsoTimestamp,
        );
        return { status: 200, body: { result } };
      } catch (error) {
        // Delivered again by Cloud Tasks: every step is idempotent.
        logger?.warn('workflow schedule occurrence failed', {
          workflowId: body.workflowId,
          code: (error as { code?: unknown }).code ?? 'error',
        });
        return {
          status: 503,
          body: { result: 'retry', code: codeOf(error) },
        };
      }
    },

    async recover(): Promise<number> {
      const before = new Date(
        now().getTime() - SCHEDULE_RECOVER_AFTER_MS,
      ).toISOString() as IsoTimestamp;
      const due = await schedules.due(before, SCHEDULE_RECOVER_LIMIT);
      let ran = 0;
      for (const schedule of due) {
        if (schedule.nextRunAt === undefined) continue;
        try {
          await occur(schedule.organizationId, schedule.workflowId, schedule.nextRunAt);
          ran += 1;
        } catch (error) {
          logger?.warn('workflow schedule recovery failed', {
            workflowId: schedule.workflowId,
            code: (error as { code?: unknown }).code ?? 'error',
          });
        }
      }
      return ran;
    },
  });
}
