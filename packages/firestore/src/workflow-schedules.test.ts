import type {
  IsoTimestamp,
  OrganizationId,
  UserId,
  WorkflowId,
  WorkflowSchedule,
} from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { FirestoreWorkflowScheduleRepository } from './workflow-schedules.js';
import { emulatorFirestore, emulatorHost } from './testing.js';

const ORGANIZATION = '33333333-3333-4333-8333-333333333333' as OrganizationId;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const CLAIMED_AT = '2026-09-27T08:00:00.000Z' as IsoTimestamp;
const RECENT = '2026-09-27T11:55:00.000Z' as IsoTimestamp;
/** Now less the lease: a claim taken at or before it has lapsed. */
const LEASE_CUTOFF = '2026-09-27T11:40:00.000Z' as IsoTimestamp;

/** The n-th test workflow. Ids sort in n order, the order the store pages in. */
const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}` as WorkflowId;

/** A valid schedule whose last occurrence was claimed at `at`. */
function scheduleOf(
  workflowId: WorkflowId,
  status: WorkflowSchedule['status'],
  at: IsoTimestamp,
): WorkflowSchedule {
  return {
    workflowId,
    organizationId: ORGANIZATION,
    status,
    recurrence: { frequency: 'daily', time: '09:00' },
    timeZone: 'Europe/Madrid',
    workflowVersion: 1,
    confirmedBy: ALICE,
    confirmedAt: CLAIMED_AT,
    ...(status === 'on' ? { nextRunAt: '2026-09-28T07:00:00.000Z' as IsoTimestamp } : {}),
    last: { occurrence: CLAIMED_AT, outcome: 'claimed', at },
    revision: 1,
    updatedAt: at,
  };
}

async function put(
  repository: FirestoreWorkflowScheduleRepository,
  workflowId: WorkflowId,
  status: WorkflowSchedule['status'],
  at: IsoTimestamp,
): Promise<void> {
  await repository.update(ORGANIZATION, workflowId, () => ({
    schedule: scheduleOf(workflowId, status, at),
    events: [],
  }));
}

// The store's own query, read on the emulator. A missing filter here changes what a page holds.
describe.runIf(emulatorHost)('FirestoreWorkflowScheduleRepository.lapsedOff (emulator)', () => {
  it('lists only schedules that are off, even when on schedules fill the first page', async () => {
    const repository = new FirestoreWorkflowScheduleRepository(emulatorFirestore());
    for (let n = 1; n <= 25; n += 1) await put(repository, idOf(n), 'on', CLAIMED_AT);
    await put(repository, idOf(900), 'off', CLAIMED_AT);

    // The first page is full of on schedules: none is listed, and the walk goes on.
    const first = await repository.lapsedOff(LEASE_CUTOFF, 20);
    expect(first.schedules).toEqual([]);
    expect(first.next).toBe(idOf(20));

    const seen: string[] = [];
    let after: WorkflowId | undefined = first.next;
    do {
      const page = await repository.lapsedOff(LEASE_CUTOFF, 20, after);
      seen.push(...page.schedules.map((s) => s.workflowId));
      after = page.next;
    } while (after !== undefined);
    expect(seen).toEqual([idOf(900)]);
  });

  it('pages the lapsed schedules in workflow id order, and leaves out a claim within its lease', async () => {
    const repository = new FirestoreWorkflowScheduleRepository(emulatorFirestore());
    for (let n = 1; n <= 45; n += 1) await put(repository, idOf(n), 'off', CLAIMED_AT);
    await put(repository, idOf(46), 'off', RECENT);

    const seen: string[] = [];
    let after: WorkflowId | undefined;
    let pages = 0;
    do {
      const page = await repository.lapsedOff(LEASE_CUTOFF, 20, after);
      seen.push(...page.schedules.map((s) => s.workflowId));
      after = page.next;
      pages += 1;
    } while (after !== undefined);

    // 46 claims are read in pages of 20, so three pages; the last one is not full, so it ends the walk.
    expect(pages).toBe(3);
    expect(seen).toEqual(Array.from({ length: 45 }, (_, i) => idOf(i + 1)));
  });
});
