import {
  actorOf,
  buildAuditEvent,
  type AuditAction,
  type AuditEvent,
  type AuditService,
  type InMemoryAuditStore,
} from '@melonoffice/audit';
import { isLocalTime, localDateTime, plusDays, zonedInstant } from '@melonoffice/conversations';
import type {
  IsoTimestamp,
  OrganizationId,
  PlanId,
  UserId,
  WorkflowId,
  WorkflowRecurrence,
  WorkflowSchedule,
  WorkflowScheduleOutcome,
} from '@melonoffice/domain';
import type { AuthorizationService } from '@melonoffice/rbac';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { WorkflowError } from './errors.js';
import { isWorkflowId } from './model.js';
import type { WorkflowRepository } from './repository.js';

/**
 * Workflow schedules (ADR-0185): a person's standing approval to run one workflow, at the version
 * they confirmed, on a bounded recurrence in the business's time zone. Each occurrence is one
 * Cloud Tasks task on the existing queue; the runner (`schedule-runner.ts`) turns it into the
 * workflow's ordinary plan. Nothing here runs anything.
 */

/** An occurrence later than this past its time is `missed`: it never runs late. */
type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export const SCHEDULE_LATE_MS = 6 * 3_600_000;
/** The sweep recovers an occurrence its task did not run within this long (ADR-0185 §10). */
export const SCHEDULE_RECOVER_AFTER_MS = 15 * 60_000;
/** Cloud Tasks holds a task up to 30 days: a later occurrence is reached in hops. */
export const SCHEDULE_TASK_HORIZON_MS = 29 * 86_400_000;
/** At most this many schedules recovered per sweep run, and per page of the lapsed ones (ADR-0186). */
export const SCHEDULE_RECOVER_LIMIT = 50;
/** At most this many pages of lapsed schedules one sweep run reads (ADR-0186). */
export const SCHEDULE_RECOVER_PAGES = 10;
/**
 * How long a claimed occurrence is held by its worker. It outlasts a task's dispatch deadline (the
 * runtime's job lease, 15 min by default), so a retry never runs beside a live occurrence; once it
 * has lapsed, a crashed worker's occurrence is taken up (ADR-0185 §5).
 */
export const SCHEDULE_LEASE_MS = 20 * 60_000;

const WEEKDAYS = [1, 2, 3, 4, 5, 6, 7] as const;
/** Monday is 1 … Sunday is 7. */
const weekdayOf = (date: string) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

const exactKeys = (value: object, keys: readonly string[]): boolean =>
  Object.keys(value).length === keys.length && keys.every((k) => k in value);

/** A recurrence as stored and accepted: exact fields, no more than once a day. */
export function checkRecurrence(value: unknown): WorkflowRecurrence {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkflowError('invalid_schedule', 'recurrence');
  }
  const r = value as Record<string, unknown>;
  if (!isLocalTime(r.time)) throw new WorkflowError('invalid_schedule', 'time');
  if (r.frequency === 'daily' && exactKeys(r, ['frequency', 'time'])) {
    return Object.freeze({ frequency: 'daily', time: r.time });
  }
  if (r.frequency === 'weekly' && exactKeys(r, ['frequency', 'time', 'weekdays'])) {
    const days = r.weekdays;
    if (
      !Array.isArray(days) ||
      days.length === 0 ||
      days.length > 7 ||
      days.some((d) => !WEEKDAYS.includes(d as 1)) ||
      new Set(days).size !== days.length
    ) {
      throw new WorkflowError('invalid_schedule', 'weekdays');
    }
    const weekdays = Object.freeze([...(days as number[])].sort((a, b) => a - b));
    return Object.freeze({ frequency: 'weekly', time: r.time, weekdays });
  }
  if (r.frequency === 'monthly' && exactKeys(r, ['frequency', 'time', 'dayOfMonth'])) {
    const day = r.dayOfMonth;
    if (typeof day !== 'number' || !Number.isInteger(day) || day < 1 || day > 28) {
      throw new WorkflowError('invalid_schedule', 'dayOfMonth');
    }
    return Object.freeze({ frequency: 'monthly', time: r.time, dayOfMonth: day });
  }
  throw new WorkflowError('invalid_schedule', 'frequency');
}

/** Whether a string is an IANA time zone this runtime knows. */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value === '' || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

const matches = (r: WorkflowRecurrence, date: string): boolean =>
  r.frequency === 'daily' ||
  (r.frequency === 'weekly' && r.weekdays.includes(weekdayOf(date))) ||
  (r.frequency === 'monthly' && Number(date.slice(8, 10)) === r.dayOfMonth);

/** The first occurrence strictly after `after`, in the time zone. Never more than 62 days on. */
export function nextOccurrence(r: WorkflowRecurrence, timeZone: string, after: Date): Date {
  const today = localDateTime(after, timeZone).date;
  for (let i = 0; i <= 62; i += 1) {
    const date = plusDays(today, i);
    if (!matches(r, date)) continue;
    const at = zonedInstant(date, r.time, timeZone);
    if (at.getTime() > after.getTime()) return at;
  }
  throw new WorkflowError('invalid_schedule', 'recurrence');
}

/** The calendar day an instant falls on, in the time zone. */
export const localDay = (at: Date, timeZone: string): string => localDateTime(at, timeZone).date;

/**
 * The next occurrence a save leaves. Never on the local day the last run already took: a schedule
 * plans one day at most, so a time changed later that day waits for tomorrow (ADR-0185 §4).
 */
export function nextAfterRun(
  r: WorkflowRecurrence,
  timeZone: string,
  after: Date,
  last: WorkflowSchedule['last'],
): IsoTimestamp {
  const next = nextOccurrence(r, timeZone, after);
  const ranOn = last === undefined ? undefined : localDay(new Date(last.occurrence), timeZone);
  const onto =
    ranOn === undefined || localDay(next, timeZone) !== ranOn
      ? next
      : nextOccurrence(r, timeZone, next);
  return onto.toISOString() as IsoTimestamp;
}

/** A recurrence as a short code for audit: `daily-0900`, `weekly-1-3-0900`, `monthly-15-0900`. */
export function recurrenceCode(r: WorkflowRecurrence): string {
  const time = r.time.replace(':', '');
  if (r.frequency === 'daily') return `daily-${time}`;
  if (r.frequency === 'weekly') return `weekly-${r.weekdays.join('-')}-${time}`;
  return `monthly-${r.dayOfMonth}-${time}`;
}

/** A stored schedule, checked when read: anything that does not read as one is refused. */
export function checkStoredSchedule(value: WorkflowSchedule): WorkflowSchedule {
  checkRecurrence(value.recurrence);
  if (
    !isWorkflowId(value.workflowId) ||
    (value.status !== 'on' && value.status !== 'off') ||
    !isTimeZone(value.timeZone) ||
    !Number.isSafeInteger(value.workflowVersion) ||
    value.workflowVersion < 1 ||
    !Number.isSafeInteger(value.revision) ||
    value.revision < 1 ||
    (value.status === 'on') !== (value.nextRunAt !== undefined)
  ) {
    throw new WorkflowError('invalid_schedule', 'stored');
  }
  return value;
}

/** A schedule change and its audit events: stored together, or not at all. */
export interface WorkflowScheduleChange {
  readonly schedule: WorkflowSchedule;
  readonly events: readonly AuditEvent[];
}

/**
 * Where schedules live: `workflowSchedules/{workflowId}` in Firestore, memory in tests. One
 * schedule per workflow. Every write is one transaction: `change` sees the stored schedule (or
 * none) and returns the next one exactly one revision ahead, with its events; a throw writes
 * nothing.
 */
export interface WorkflowScheduleRepository {
  /** The schedule, only when it belongs to the organization. */
  find(
    organizationId: OrganizationId,
    workflowId: WorkflowId,
  ): Promise<WorkflowSchedule | undefined>;
  update(
    organizationId: OrganizationId,
    workflowId: WorkflowId,
    change: (current: WorkflowSchedule | undefined) => WorkflowScheduleChange,
  ): Promise<WorkflowSchedule>;
  /**
   * Schedules that are on and whose `nextRunAt` is at or before `before`, oldest first, across
   * organizations: the sweep's recovery (ADR-0185 §10). Server side only.
   */
  due(before: IsoTimestamp, limit: number): Promise<readonly WorkflowSchedule[]>;
  /**
   * One page of the schedules that are off, whose last occurrence was claimed and never finished
   * (ADR-0186): the sweep's look at an occurrence nothing may take up again. The page is the first
   * `limit` such records after `after`, in workflow id order; its schedules are those whose claim was
   * taken at or before `before` (its lease lapsed). `next` is where the following page starts, when this
   * one filled its limit. An on schedule is never listed: a later claim finishes its occurrence
   * (ADR-0185 §13). Server side only.
   */
  lapsedOff(before: IsoTimestamp, limit: number, after?: WorkflowId): Promise<LapsedSchedulePage>;
}

/** One page of the lapsed schedules (ADR-0186). */
export interface LapsedSchedulePage {
  readonly schedules: readonly WorkflowSchedule[];
  /** Set when the page filled its limit: the next page starts after this workflow. */
  readonly next?: WorkflowId;
}

/** The next schedule must be exactly one revision ahead of the stored one (or the first). */
export function checkNextSchedule(
  current: WorkflowSchedule | undefined,
  organizationId: OrganizationId,
  workflowId: WorkflowId,
  write: WorkflowScheduleChange,
): void {
  const next = write.schedule;
  if (
    next.organizationId !== organizationId ||
    next.workflowId !== workflowId ||
    next.revision !== (current?.revision ?? 0) + 1
  ) {
    throw new WorkflowError('workflow_concurrency_conflict');
  }
  if (write.events.some((e) => e.organizationId !== organizationId)) {
    throw new Error('a schedule change records events of its own organization only');
  }
  checkStoredSchedule(next);
}

/** For tests and local runs only. */
export class InMemoryWorkflowScheduleRepository implements WorkflowScheduleRepository {
  readonly #schedules = new Map<string, WorkflowSchedule>();

  constructor(private readonly audit?: InMemoryAuditStore) {}

  async find(organizationId: OrganizationId, workflowId: WorkflowId) {
    const found = this.#schedules.get(workflowId);
    return found?.organizationId === organizationId ? checkStoredSchedule(found) : undefined;
  }

  async update(
    organizationId: OrganizationId,
    workflowId: WorkflowId,
    change: (current: WorkflowSchedule | undefined) => WorkflowScheduleChange,
  ) {
    const stored = this.#schedules.get(workflowId);
    // Another organization's schedule for this id is never seen nor overwritten.
    if (stored !== undefined && stored.organizationId !== organizationId) {
      throw new WorkflowError('workflow_not_found');
    }
    const write = change(stored);
    checkNextSchedule(stored, organizationId, workflowId, write);
    if (this.#schedules.get(workflowId)?.revision !== stored?.revision) {
      throw new WorkflowError('workflow_concurrency_conflict');
    }
    if (write.events.length > 0) {
      if (this.audit === undefined) throw new Error('no audit store for schedule events');
      this.audit.appendNow(write.events);
    }
    const schedule = Object.freeze(structuredClone(write.schedule));
    this.#schedules.set(workflowId, schedule);
    return schedule;
  }

  async due(before: IsoTimestamp, limit: number) {
    return [...this.#schedules.values()]
      .filter((s) => s.status === 'on' && s.nextRunAt !== undefined && s.nextRunAt <= before)
      .sort((a, b) => ((a.nextRunAt ?? '') < (b.nextRunAt ?? '') ? -1 : 1))
      .slice(0, limit);
  }

  async lapsedOff(
    before: IsoTimestamp,
    limit: number,
    after?: WorkflowId,
  ): Promise<LapsedSchedulePage> {
    // The same page the store reads: the first `limit` records after `after`, in id order, then the
    // lease read from each of them.
    const page = [...this.#schedules.values()]
      .filter(
        (s) =>
          s.status === 'off' &&
          s.last?.outcome === 'claimed' &&
          (after === undefined || s.workflowId > after),
      )
      .sort((a, b) => (a.workflowId < b.workflowId ? -1 : 1))
      .slice(0, limit);
    const last = page[page.length - 1];
    return {
      schedules: page.filter((s) => s.last !== undefined && s.last.at <= before),
      ...(page.length === limit && last !== undefined ? { next: last.workflowId } : {}),
    };
  }
}

/** The task one occurrence is: queued on the execution jobs queue for its time (or a hop). */
export interface ScheduleTask {
  readonly organizationId: OrganizationId;
  readonly workflowId: WorkflowId;
  readonly occurrence: IsoTimestamp;
}

/** Queues an occurrence's task at its time, or at the horizon when it is further away. */
export async function queueOccurrence(
  scheduler: { schedule(body: object, at: Date): Promise<void> } | undefined,
  task: ScheduleTask,
  now: Date,
): Promise<void> {
  if (scheduler === undefined) return;
  const due = new Date(task.occurrence).getTime();
  const at = Math.min(due, now.getTime() + SCHEDULE_TASK_HORIZON_MS);
  await scheduler.schedule({ ...task }, new Date(Math.max(at, now.getTime())));
}

/** An audit event about a schedule, on its workflow. */
export function scheduleEvent(
  actor: { readonly actor: 'user' | 'gia' | 'runtime'; readonly userId: UserId },
  organizationId: OrganizationId,
  workflowId: WorkflowId,
  action: Extract<AuditAction, `workflow.schedule_${string}`>,
  fields: {
    readonly result?: 'success' | 'denied';
    readonly reason?: string;
    readonly reference?: string;
    readonly version?: number;
    readonly requestId?: string;
  },
  at: Date,
): AuditEvent {
  return buildAuditEvent(
    {
      action,
      result: fields.result ?? 'success',
      actor: actorOf(actor),
      organizationId,
      target: { type: 'workflow', id: workflowId },
      ...(fields.version === undefined ? {} : { targetVersion: fields.version }),
      ...(fields.reason === undefined ? {} : { reason: fields.reason }),
      ...(fields.reference === undefined ? {} : { reference: fields.reference }),
      ...(fields.requestId === undefined ? {} : { requestId: fields.requestId }),
      source: 'api',
    },
    at,
  );
}

/**
 * A person's schedules (ADR-0185). Reading needs `workflow.read`. Saving is a standing approval:
 * a person acting directly, holding `workflow.manage`, `plan.create` and `approval.approve`, on
 * an active workflow. Switching off needs `workflow.manage`. GIA and the runtime can do neither.
 */
export interface WorkflowScheduleService {
  get(tenant: TenantContext, workflowId: string): Promise<WorkflowSchedule | undefined>;
  save(
    tenant: TenantContext,
    workflowId: string,
    input: { readonly recurrence: unknown },
  ): Promise<WorkflowSchedule>;
  switchOff(tenant: TenantContext, workflowId: string): Promise<WorkflowSchedule>;
}

export interface WorkflowScheduleServiceOptions {
  readonly repository: WorkflowScheduleRepository;
  readonly workflows: Pick<WorkflowRepository, 'find'>;
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly authorization: Pick<AuthorizationService, 'authorize'>;
  /** The business's time zone, as the business profile has it. */
  readonly timeZone: (organizationId: OrganizationId) => Promise<string>;
  /** Queues an occurrence's task. Absent: the sweep recovers it (ADR-0185 §10). */
  readonly scheduler?: { schedule(body: object, at: Date): Promise<void> };
  /** Records refusals, which change nothing and so have no write of their own. */
  readonly audit: Pick<AuditService, 'record'>;
  readonly now?: () => Date;
  readonly requestId?: string;
}

/**
 * The three permissions a standing approval needs: to switch it on, and to be run as (ADR-0185 §3,
 * §6). The runner checks them again at every occurrence.
 */
export const STANDING_PERMISSIONS = ['workflow.manage', 'plan.create', 'approval.approve'] as const;

export function createWorkflowScheduleService({
  repository,
  workflows,
  organizations,
  authorization,
  timeZone,
  scheduler,
  audit,
  now = () => new Date(),
  requestId,
}: WorkflowScheduleServiceOptions): WorkflowScheduleService {
  async function organizationOf(tenant: TenantContext): Promise<OrganizationId> {
    if (!isResolvedTenant(tenant)) throw new WorkflowError('unresolved_tenant');
    const organization = await organizations.findOrganization(tenant.organizationId);
    if (organization?.id !== tenant.organizationId || organization.status !== 'active') {
      throw new WorkflowError('organization_inactive');
    }
    return organization.id;
  }

  const idOf = (id: string): WorkflowId => {
    if (!isWorkflowId(id)) throw new WorkflowError('workflow_not_found');
    return id;
  };

  async function refuse(
    tenant: TenantContext,
    organizationId: OrganizationId,
    workflowId: string,
    action: 'workflow.schedule_saved' | 'workflow.schedule_switched_off',
    reason: string,
  ): Promise<never> {
    await audit.record({
      action,
      result: 'denied',
      actor: actorOf(tenant),
      organizationId,
      ...(isWorkflowId(workflowId) ? { target: { type: 'workflow', id: workflowId } } : {}),
      reason,
      ...(requestId === undefined ? {} : { requestId }),
      source: 'api',
    });
    throw new WorkflowError('permission_denied', reason);
  }

  return Object.freeze({
    async get(tenant: TenantContext, workflowId: string) {
      const organizationId = await organizationOf(tenant);
      if (!authorization.authorize(tenant, 'workflow.read', { organizationId }).allowed) {
        throw new WorkflowError('permission_denied');
      }
      const id = idOf(workflowId);
      if ((await workflows.find(organizationId, id)) === undefined) {
        throw new WorkflowError('workflow_not_found');
      }
      return repository.find(organizationId, id);
    },

    async save(tenant: TenantContext, workflowId: string, input: { recurrence: unknown }) {
      const organizationId = await organizationOf(tenant);
      const action = 'workflow.schedule_saved';
      // A standing approval is a person's own act: never GIA's, never the runtime's.
      if (tenant.actor !== 'user') {
        return refuse(
          tenant,
          organizationId,
          workflowId,
          action,
          `${tenant.actor}_cannot_schedule`,
        );
      }
      for (const permission of STANDING_PERMISSIONS) {
        const decision = authorization.authorize(tenant, permission, { organizationId });
        if (!decision.allowed) {
          return refuse(tenant, organizationId, workflowId, action, 'permission_denied');
        }
      }
      const id = idOf(workflowId);
      const recurrence = checkRecurrence(input.recurrence);
      const workflow = await workflows.find(organizationId, id);
      if (workflow === undefined) throw new WorkflowError('workflow_not_found');
      if (workflow.status !== 'active') throw new WorkflowError('workflow_not_active');
      const zone = await timeZone(organizationId);
      if (!isTimeZone(zone)) throw new WorkflowError('invalid_schedule', 'timeZone');
      const at = now();
      const iso = at.toISOString() as IsoTimestamp;
      const saved = await repository.update(organizationId, id, (current) => ({
        schedule: Object.freeze({
          workflowId: id,
          organizationId,
          status: 'on',
          recurrence,
          timeZone: zone,
          workflowVersion: workflow.version,
          confirmedBy: tenant.userId,
          confirmedAt: iso,
          nextRunAt: nextAfterRun(recurrence, zone, at, current?.last),
          ...(current?.last === undefined ? {} : { last: current.last }),
          revision: (current?.revision ?? 0) + 1,
          updatedAt: iso,
        }),
        events: [
          scheduleEvent(
            tenant,
            organizationId,
            id,
            action,
            {
              reference: recurrenceCode(recurrence),
              version: workflow.version,
              ...(requestId === undefined ? {} : { requestId }),
            },
            at,
          ),
        ],
      }));
      // Its task; when it cannot be queued now, the sweep runs the occurrence (ADR-0185 §10).
      if (saved.nextRunAt !== undefined) {
        try {
          await queueOccurrence(
            scheduler,
            { organizationId, workflowId: id, occurrence: saved.nextRunAt },
            at,
          );
        } catch {
          // Recovered by the sweep.
        }
      }
      return saved;
    },

    async switchOff(tenant: TenantContext, workflowId: string) {
      const organizationId = await organizationOf(tenant);
      const action = 'workflow.schedule_switched_off';
      if (tenant.actor !== 'user') {
        return refuse(
          tenant,
          organizationId,
          workflowId,
          action,
          `${tenant.actor}_cannot_schedule`,
        );
      }
      if (!authorization.authorize(tenant, 'workflow.manage', { organizationId }).allowed) {
        return refuse(tenant, organizationId, workflowId, action, 'permission_denied');
      }
      const id = idOf(workflowId);
      if ((await workflows.find(organizationId, id)) === undefined) {
        throw new WorkflowError('workflow_not_found');
      }
      const at = now();
      return repository.update(organizationId, id, (current) => {
        if (current === undefined) throw new WorkflowError('schedule_not_found');
        return switchedOff(current, tenant, at, 'person', requestId);
      });
    },
  });
}

/** A schedule switched off: no next run; its history stays. */
export function switchedOff(
  current: WorkflowSchedule,
  actor: { readonly actor: 'user' | 'gia' | 'runtime'; readonly userId: UserId },
  at: Date,
  reason: 'person' | 'workflow_archived',
  requestId?: string,
): WorkflowScheduleChange {
  // Off has no next run: the copy's `nextRunAt` goes, and its history stays.
  const off: Mutable<WorkflowSchedule> = {
    ...current,
    status: 'off',
    revision: current.revision + 1,
    updatedAt: at.toISOString() as IsoTimestamp,
  };
  delete off.nextRunAt;
  return {
    schedule: Object.freeze(off),
    events: [
      scheduleEvent(
        actor,
        current.organizationId,
        current.workflowId,
        'workflow.schedule_switched_off',
        { reason, ...(requestId === undefined ? {} : { requestId }) },
        at,
      ),
    ],
  };
}

/** The run record a finished occurrence leaves on its schedule. */
export function withRun(
  current: WorkflowSchedule,
  run: {
    readonly occurrence: IsoTimestamp;
    readonly outcome: WorkflowScheduleOutcome;
    readonly planId?: PlanId;
  },
  at: Date,
): WorkflowSchedule {
  const iso = at.toISOString() as IsoTimestamp;
  return Object.freeze({
    ...current,
    last: Object.freeze({
      occurrence: run.occurrence,
      outcome: run.outcome,
      at: iso,
      ...(run.planId === undefined ? {} : { planId: run.planId }),
    }),
    revision: current.revision + 1,
    updatedAt: iso,
  });
}
