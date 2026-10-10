import { createAuditService } from '@melonoffice/audit';
import type { IsoTimestamp, Workflow, WorkflowId, WorkflowSchedule } from '@melonoffice/domain';
import type { TenantContext } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
// The planning package's own test world, reused rather than rebuilt.
import { ALICE, world } from '../../planning/src/testkit.js';
import { isWorkflowError } from './errors.js';
import {
  checkRecurrence,
  createWorkflowScheduleService,
  InMemoryWorkflowScheduleRepository,
  isTimeZone,
  nextOccurrence,
  queueOccurrence,
  recurrenceCode,
  SCHEDULE_TASK_HORIZON_MS,
} from './schedule.js';

const codeOf = async (work: Promise<unknown> | (() => unknown)): Promise<string> => {
  try {
    await (typeof work === 'function' ? work() : work);
  } catch (error) {
    if (isWorkflowError(error)) return `${error.code}${error.detail ? `:${error.detail}` : ''}`;
    throw error;
  }
  return 'accepted';
};

const at = (iso: string) => new Date(iso);
const next = (recurrence: unknown, zone: string, after: string) =>
  nextOccurrence(checkRecurrence(recurrence), zone, at(after)).toISOString();

describe('a recurrence (ADR-0185)', () => {
  it('accepts daily, weekly and monthly at a local time, with exact fields', () => {
    expect(checkRecurrence({ frequency: 'daily', time: '09:00' })).toEqual({
      frequency: 'daily',
      time: '09:00',
    });
    expect(checkRecurrence({ frequency: 'weekly', time: '18:30', weekdays: [5, 1] })).toEqual({
      frequency: 'weekly',
      time: '18:30',
      weekdays: [1, 5],
    });
    expect(checkRecurrence({ frequency: 'monthly', time: '07:15', dayOfMonth: 28 })).toEqual({
      frequency: 'monthly',
      time: '07:15',
      dayOfMonth: 28,
    });
  });

  it('refuses anything more often than daily, or anything it cannot hold', async () => {
    for (const [value, code] of [
      [null, 'invalid_schedule:recurrence'],
      [[], 'invalid_schedule:recurrence'],
      [{ frequency: 'minutely', time: '09:00' }, 'invalid_schedule:frequency'],
      [{ frequency: 'daily', time: '24:00' }, 'invalid_schedule:time'],
      [{ frequency: 'daily', time: '09:00', interval: 2 }, 'invalid_schedule:frequency'],
      [{ frequency: 'weekly', time: '09:00', weekdays: [0] }, 'invalid_schedule:weekdays'],
      [{ frequency: 'weekly', time: '09:00', weekdays: [1, 1] }, 'invalid_schedule:weekdays'],
      [{ frequency: 'weekly', time: '09:00', weekdays: '1' }, 'invalid_schedule:weekdays'],
      [{ frequency: 'monthly', time: '09:00', dayOfMonth: 29 }, 'invalid_schedule:dayOfMonth'],
      [{ frequency: 'monthly', time: '09:00', dayOfMonth: 1.5 }, 'invalid_schedule:dayOfMonth'],
    ] as const) {
      expect(await codeOf(() => checkRecurrence(value))).toBe(code);
    }
  });

  it('finds the next occurrence strictly after a moment, in the time zone', () => {
    const daily = { frequency: 'daily', time: '09:00' };
    // 07:00 in Lima: today at 09:00; at 09:00 exactly: tomorrow.
    expect(next(daily, 'America/Lima', '2026-10-05T12:00:00Z')).toBe('2026-10-05T14:00:00.000Z');
    expect(next(daily, 'America/Lima', '2026-10-05T14:00:00Z')).toBe('2026-10-06T14:00:00.000Z');
    // Madrid leaves summer time on 2026-10-25.
    expect(next(daily, 'Europe/Madrid', '2026-10-24T08:00:00Z')).toBe('2026-10-25T08:00:00.000Z');
    expect(next(daily, 'Europe/Madrid', '2026-10-23T08:00:00Z')).toBe('2026-10-24T07:00:00.000Z');
    // Weekly on Monday and Thursday (2026-10-05 is a Monday).
    const weekly = { frequency: 'weekly', time: '09:00', weekdays: [1, 4] };
    expect(next(weekly, 'UTC', '2026-10-05T10:00:00Z')).toBe('2026-10-08T09:00:00.000Z');
    expect(next(weekly, 'UTC', '2026-10-08T10:00:00Z')).toBe('2026-10-12T09:00:00.000Z');
    // Monthly on the 28th, across February.
    const monthly = { frequency: 'monthly', time: '09:00', dayOfMonth: 28 };
    expect(next(monthly, 'UTC', '2027-01-28T10:00:00Z')).toBe('2027-02-28T09:00:00.000Z');
  });

  it('names a recurrence by a short code for audit', () => {
    expect(recurrenceCode(checkRecurrence({ frequency: 'daily', time: '09:00' }))).toBe(
      'daily-0900',
    );
    expect(
      recurrenceCode(checkRecurrence({ frequency: 'weekly', time: '18:30', weekdays: [3, 1] })),
    ).toBe('weekly-1-3-1830');
    expect(
      recurrenceCode(checkRecurrence({ frequency: 'monthly', time: '07:05', dayOfMonth: 15 })),
    ).toBe('monthly-15-0705');
  });

  it('knows a time zone only when the runtime does', () => {
    expect(isTimeZone('America/Lima')).toBe(true);
    expect(isTimeZone('Mars/Olympus')).toBe(false);
    expect(isTimeZone('')).toBe(false);
  });

  it("queues an occurrence's task at its time, or in hops beyond the queue's horizon", async () => {
    const queued: { body: object; at: Date }[] = [];
    const scheduler = {
      schedule: async (body: object, when: Date) => void queued.push({ body, at: when }),
    };
    const now = at('2026-10-05T12:00:00Z');
    const task = {
      organizationId: 'org' as never,
      workflowId: 'wf' as never,
      occurrence: '2026-10-06T14:00:00.000Z' as IsoTimestamp,
    };
    await queueOccurrence(scheduler, task, now);
    await queueOccurrence(
      scheduler,
      { ...task, occurrence: '2027-01-01T14:00:00.000Z' as IsoTimestamp },
      now,
    );
    expect(queued.map((q) => q.at.toISOString())).toEqual([
      '2026-10-06T14:00:00.000Z',
      new Date(now.getTime() + SCHEDULE_TASK_HORIZON_MS).toISOString(),
    ]);
    // Without a queue, nothing is queued and nothing fails: the sweep recovers it.
    await queueOccurrence(undefined, task, now);
  });
});

describe('a workflow schedule service (ADR-0185)', () => {
  async function setup(denied: readonly string[] = []) {
    const w = await world();
    const workflow = {
      id: '33333333-3333-4333-8333-333333333333' as WorkflowId,
      organizationId: w.orgA,
      status: 'active',
      version: 2,
    } as unknown as Workflow;
    const repository = new InMemoryWorkflowScheduleRepository(w.audit);
    const queued: object[] = [];
    let clock = at('2026-10-05T12:00:00Z');
    const authorization = {
      authorize: (tenant: TenantContext, permission: string, scope: { organizationId: string }) =>
        denied.includes(permission)
          ? { allowed: false as const, reason: 'missing_permission' }
          : w.authorization.authorize(tenant, permission as never, scope as never),
    };
    const service = createWorkflowScheduleService({
      repository,
      workflows: {
        find: async (org, id) =>
          org === workflow.organizationId && id === workflow.id ? workflow : undefined,
      },
      organizations: w.tenancy,
      authorization: authorization as never,
      timeZone: async () => 'America/Lima',
      scheduler: { schedule: async (body) => void queued.push(body) },
      audit: createAuditService(w.audit),
      now: () => (clock = new Date(clock.getTime() + 1)),
    });
    return { w, workflow, service, queued, repository };
  }

  const DAILY = { recurrence: { frequency: 'daily', time: '09:00' } };

  it('saves a standing approval for the current version and queues its first occurrence', async () => {
    const { w, workflow, service, queued } = await setup();
    const saved = await service.save(w.tenantA, workflow.id, DAILY);
    expect(saved).toMatchObject({
      organizationId: w.orgA,
      status: 'on',
      workflowVersion: 2,
      confirmedBy: ALICE,
      timeZone: 'America/Lima',
      nextRunAt: '2026-10-05T14:00:00.000Z',
      revision: 1,
    });
    expect(queued).toEqual([
      { organizationId: w.orgA, workflowId: workflow.id, occurrence: '2026-10-05T14:00:00.000Z' },
    ]);
    expect(await service.get(w.tenantA, workflow.id)).toEqual(saved);
  });

  it('needs workflow.manage, plan.create and approval.approve, from a person acting directly', async () => {
    for (const permission of ['workflow.manage', 'plan.create', 'approval.approve']) {
      const { w, workflow, service } = await setup([permission]);
      expect(await codeOf(service.save(w.tenantA, workflow.id, DAILY))).toBe(
        'permission_denied:permission_denied',
      );
      expect(w.events('workflow.schedule_saved').map((e) => e.result)).toEqual(['denied']);
    }
    const { w, workflow, service } = await setup();
    expect(await codeOf(service.save(w.giaA, workflow.id, DAILY))).toBe(
      'permission_denied:gia_cannot_schedule',
    );
    expect(await codeOf(service.save(w.runtimeA, workflow.id, DAILY))).toBe(
      'permission_denied:runtime_cannot_schedule',
    );
    expect(await codeOf(service.switchOff(w.giaA, workflow.id))).toBe(
      'permission_denied:gia_cannot_schedule',
    );
    expect(await service.get(w.tenantA, workflow.id)).toBeUndefined();
  });

  it("never shows nor changes another organization's workflow", async () => {
    const { w, workflow, service } = await setup();
    await service.save(w.tenantA, workflow.id, DAILY);
    expect(await codeOf(service.get(w.tenantB, workflow.id))).toBe('workflow_not_found');
    expect(await codeOf(service.save(w.tenantB, workflow.id, DAILY))).toBe('workflow_not_found');
    expect(await codeOf(service.switchOff(w.tenantB, workflow.id))).toBe('workflow_not_found');
    expect(await codeOf(service.get(w.tenantA, 'not-an-id'))).toBe('workflow_not_found');
  });

  it('switches off: no next run, its history kept; switching off nothing is refused', async () => {
    const { w, workflow, service } = await setup();
    expect(await codeOf(service.switchOff(w.tenantA, workflow.id))).toBe('schedule_not_found');
    await service.save(w.tenantA, workflow.id, DAILY);
    const off = await service.switchOff(w.tenantA, workflow.id);
    expect(off.status).toBe('off');
    expect(off.nextRunAt).toBeUndefined();
    expect(off.revision).toBe(2);
    expect(w.events('workflow.schedule_switched_off')).toMatchObject([
      { result: 'success', reason: 'person', target: { type: 'workflow', id: workflow.id } },
    ]);
  });
});

describe('the sweep reads the lapsed claims of schedules that are off (ADR-0187)', () => {
  const CLAIMED = '2026-09-27T08:00:00.000Z' as IsoTimestamp;
  /** Now less the lease: a claim taken at or before it has lapsed. */
  const LEASE_CUTOFF = '2026-09-27T11:40:00.000Z' as IsoTimestamp;
  /** The n-th test workflow. Ids sort in n order, the order the store pages in. */
  const idOf = (n: number) =>
    `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as WorkflowId;

  it('lists only the schedules that are off, even when on schedules fill the first page', async () => {
    const w = await world();
    const repository = new InMemoryWorkflowScheduleRepository(w.audit);
    // A schedule whose last claim was taken and never finished, and that is on or off.
    const claimed = (n: number, status: WorkflowSchedule['status']) =>
      repository.update(w.orgA, idOf(n), () => ({
        schedule: {
          workflowId: idOf(n),
          organizationId: w.orgA,
          status,
          recurrence: { frequency: 'daily', time: '09:00' },
          timeZone: 'Europe/Madrid',
          workflowVersion: 1,
          confirmedBy: ALICE,
          confirmedAt: CLAIMED,
          ...(status === 'on' ? { nextRunAt: '2026-09-28T07:00:00.000Z' as IsoTimestamp } : {}),
          last: { occurrence: CLAIMED, outcome: 'claimed', at: CLAIMED },
          revision: 1,
          updatedAt: CLAIMED,
        },
        events: [],
      }));
    for (let n = 1; n <= 25; n += 1) await claimed(n, 'on');
    await claimed(900, 'off');

    // The first page is full of schedules that are on: none is listed, and the walk goes on.
    const first = await repository.lapsedOff(LEASE_CUTOFF, 20);
    expect(first.schedules).toEqual([]);
    expect(first.next).toBe(idOf(20));
    const seen: WorkflowId[] = [];
    let after: WorkflowId | undefined = first.next;
    do {
      const page = await repository.lapsedOff(LEASE_CUTOFF, 20, after);
      seen.push(...page.schedules.map((s) => s.workflowId));
      after = page.next;
    } while (after !== undefined);
    expect(seen).toEqual([idOf(900)]);
  });
});
