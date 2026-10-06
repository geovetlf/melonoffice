import { notificationIdOf } from '@melonoffice/agents';
import type {
  AgentNotification,
  Execution,
  ExecutionId,
  IsoTimestamp,
  OrganizationId,
  SpecialistId,
  UserId,
} from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { FirestoreAgentNotificationRepository } from './agent-notifications.js';
import { EXECUTIONS, FirestoreExecutionRepository, toExecutionDocument } from './executions.js';
import { FirestoreSweepLedger } from './sweeps.js';
import { emulatorFirestore, emulatorHost } from './testing.js';

/**
 * AE-6 (ADR-0119) on the emulator: an organization's open executions are counted with equality
 * filters only, never another organization's; and a plan's result notice keeps its plan.
 */

const ORG_A = '1b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b' as OrganizationId;
const ORG_B = '8b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b' as OrganizationId;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;

describe.runIf(emulatorHost)('open work and plan notices (ADR-0119, emulator)', () => {
  it('counts an organization’s open executions up to the limit, and only its own', async () => {
    const db = emulatorFirestore();
    const rows: [OrganizationId, string][] = [
      [ORG_A, 'pending'],
      [ORG_A, 'running'],
      [ORG_A, 'waiting_approval'],
      [ORG_A, 'completed'],
      [ORG_A, 'failed'],
      [ORG_A, 'cancelled'],
      [ORG_B, 'running'],
      [ORG_B, 'running'],
    ];
    await Promise.all(
      rows.map(([organizationId, status], i) =>
        db
          .collection(EXECUTIONS)
          .doc(`open-work-${String(i)}`)
          .set({ organizationId, status }),
      ),
    );
    const repository = new FirestoreExecutionRepository(db);
    expect(await repository.countOpenOfOrganization(ORG_A, 10)).toBe(3);
    expect(await repository.countOpenOfOrganization(ORG_A, 2)).toBe(2);
    expect(await repository.countOpenOfOrganization(ORG_B, 10)).toBe(2);
    expect(await repository.countOpenOfOrganization('not-an-org' as OrganizationId, 10)).toBe(0);
  });

  it('keeps a plan’s result notice with its plan and no agent, and reads older notices', async () => {
    const db = emulatorFirestore();
    const repository = new FirestoreAgentNotificationRepository(db);
    const at = new Date('2026-10-02T12:00:00Z');
    const base = {
      organizationId: ORG_A,
      recipientId: ALICE,
      code: null,
      otherSpecialistId: null,
      createdAt: at.toISOString() as IsoTimestamp,
      readAt: null,
      expiresAt: new Date(at.getTime() + 86_400_000).toISOString() as IsoTimestamp,
    };
    const result: AgentNotification = {
      ...base,
      id: notificationIdOf(at, 'plan-result'),
      kind: 'result_available',
      specialistId: null,
      taskId: 'exec-plan-1',
      planId: 'plan-1',
    };
    const task: AgentNotification = {
      ...base,
      id: notificationIdOf(at, 'task-finished'),
      kind: 'task_finished',
      specialistId: 'aaaaaaaa-aaaa-4aaa-8aaa-000000000001' as SpecialistId,
      taskId: 'exec-task-1',
      planId: null,
    };
    await repository.put(result);
    await repository.put(task);
    const page = await repository.page(ORG_A, ALICE, { limit: 10 });
    expect(page.items).toEqual(expect.arrayContaining([result, task]));
  });

  it('reads the sweep’s candidates: one status, older than the cutoff, oldest first (ADR-0121)', async () => {
    const db = emulatorFirestore();
    // Dates no other test uses, so other files' executions never show up here.
    const execution = (n: number, status: Execution['status'], updatedAt: string): Execution =>
      ({
        id: `00000000-0000-4000-8000-00000000${String(n).padStart(4, '0')}` as ExecutionId,
        organizationId: ORG_A,
        userId: ALICE,
        mode: 'execute',
        status,
        input: { type: 'agent_task', id: 'x' },
        versionSnapshot: { schemaVersion: 1, components: [] },
        nodes: [{ id: 'work', type: 'agent', label: 'work', status: 'pending', dependsOn: [] }],
        revision: 1,
        createdAt: '2000-01-01T00:00:00.000Z',
        updatedAt,
      }) as unknown as Execution;
    const rows = [
      execution(1, 'running', '2000-01-03T00:00:00.000Z'),
      execution(2, 'running', '2000-01-02T00:00:00.000Z'),
      execution(3, 'running', '2000-01-09T00:00:00.000Z'),
      execution(4, 'verifying', '2000-01-02T00:00:00.000Z'),
    ];
    await Promise.all(
      rows.map((e) => db.collection(EXECUTIONS).doc(e.id).set(toExecutionDocument(e))),
    );
    const missing: string[] = [];
    const repository = new FirestoreExecutionRepository(db, {
      onIndexMissing: (query) => missing.push(query),
    });
    const before = '2000-01-05T00:00:00.000Z' as IsoTimestamp;
    const found = await repository.openSince('running', before, 10);
    const mine = found.filter((e) => rows.some((r) => r.id === e.id)).map((e) => e.id);
    expect(mine).toEqual([rows[1]?.id, rows[0]?.id]);
    expect(await repository.openSince('completed', before, 10)).toEqual([]);
    expect(await repository.openSince('running', 'not a time' as IsoTimestamp, 10)).toEqual([]);
    // The emulator needs no composite index: nothing fell back.
    expect(missing).toEqual([]);
  });

  it('continues the sweep’s candidates after a position, by update then id, each once (ADR-0183)', async () => {
    const db = emulatorFirestore();
    // Dates no other test uses, so other files' executions never show up here.
    const execution = (n: number, updatedAt: string): Execution =>
      ({
        id: `00000000-0000-4000-8000-00000183${String(n).padStart(4, '0')}` as ExecutionId,
        organizationId: n % 2 === 0 ? ORG_A : ORG_B,
        userId: ALICE,
        mode: 'plan',
        status: 'running',
        input: { type: 'agent_task', id: 'x' },
        versionSnapshot: { schemaVersion: 1, components: [] },
        nodes: [{ id: 'work', type: 'agent', label: 'work', status: 'pending', dependsOn: [] }],
        revision: 1,
        createdAt: '1999-01-01T00:00:00.000Z',
        updatedAt,
      }) as unknown as Execution;
    // Three share one instant: their ids order them.
    const rows = [
      execution(3, '1999-01-02T00:00:00.000Z'),
      execution(1, '1999-01-02T00:00:00.000Z'),
      execution(2, '1999-01-02T00:00:00.000Z'),
      execution(4, '1999-01-01T00:00:00.000Z'),
      execution(5, '1999-01-03T00:00:00.000Z'),
    ];
    await Promise.all(
      rows.map((e) => db.collection(EXECUTIONS).doc(e.id).set(toExecutionDocument(e))),
    );
    const repository = new FirestoreExecutionRepository(db);
    const before = '1999-01-04T00:00:00.000Z' as IsoTimestamp;
    const seen: string[] = [];
    let after: { at: IsoTimestamp; id: ExecutionId } | undefined;
    for (let pages = 0; pages < 10; pages += 1) {
      const page = await repository.openSince('running', before, 2, after);
      seen.push(...page.map((e) => e.id));
      const last = page.at(-1);
      if (page.length < 2 || last === undefined) break;
      after = { at: last.updatedAt, id: last.id };
    }
    const mine = seen.filter((id) => rows.some((r) => r.id === id));
    expect(mine).toEqual([4, 1, 2, 3, 5].map((n) => execution(n, '').id));
    // A position that is not one reads nothing.
    expect(
      await repository.openSince('running', before, 2, {
        at: 'never' as IsoTimestamp,
        id: rows[0]?.id as ExecutionId,
      }),
    ).toEqual([]);
  });

  it('keeps one record per sweep slot, run once (ADR-0121)', async () => {
    const ledger = new FirestoreSweepLedger(emulatorFirestore());
    const slot = `sweep-2000010${String(Date.now() % 10)}t${String(Date.now() % 7).padStart(2, '0')}x${String(Math.random()).slice(2, 8)}`;
    const at = '2026-10-02T00:00:00.000Z' as IsoTimestamp;
    expect(await ledger.reserve(slot, at)).toBe(true);
    expect(await ledger.reserve(slot, at)).toBe(false);
    expect(await ledger.claim(slot, at, 60_000)).toBe('claimed');
    expect(await ledger.claim(slot, at, 60_000)).toBe('running');
    // A run that died long ago may be claimed again.
    expect(await ledger.claim(slot, '2026-10-02T01:00:00.000Z' as IsoTimestamp, 60_000)).toBe(
      'claimed',
    );
    await ledger.finish({ slotId: slot, counts: { closed: 0 }, closed: [], finishedAt: at });
    expect(await ledger.claim(slot, at, 60_000)).toBe('done');
    expect(await ledger.reserve(slot, at)).toBe(false);
    const other = `${slot}b`;
    expect(await ledger.reserve(other, at)).toBe(true);
    await ledger.unreserve(other);
    expect(await ledger.reserve(other, at)).toBe(true);
  });
});
