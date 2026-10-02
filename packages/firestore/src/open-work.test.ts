import { notificationIdOf } from '@melonoffice/agents';
import type {
  AgentNotification,
  IsoTimestamp,
  OrganizationId,
  SpecialistId,
  UserId,
} from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { FirestoreAgentNotificationRepository } from './agent-notifications.js';
import { EXECUTIONS, FirestoreExecutionRepository } from './executions.js';
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
});
