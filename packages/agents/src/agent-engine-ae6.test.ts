import { createAuditService, InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { openWallet } from '@melonoffice/credits';
import {
  DEFAULT_DEPARTMENT_CATALOGUE,
  InMemoryDepartmentRepository,
  provisionDepartments,
} from '@melonoffice/departments';
import type {
  InitialBilling,
  Organization,
  OrganizationId,
  Specialist,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import { createExecutionService, InMemoryExecutionRepository } from '@melonoffice/execution';
import { createAuthorizationService } from '@melonoffice/rbac';
import {
  createSkillCatalogue,
  createSpecialistManagement,
  createSpecialistService,
  InMemorySpecialistRepository,
} from '@melonoffice/specialists';
import { createOrganization, InMemoryTenancyStore, resolveTenant } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import {
  AGENT_WORK_LIMITS,
  createAgentHandoffService,
  createAgentNotificationSubscriber,
  createAgentNotifier,
  createAgentTaskService,
  createHandoffDirectory,
  createHandoffRecorder,
  durationOf,
  HANDOFF_LIMITS,
  handoffAsOf,
  inAppChannel,
  InMemoryAgentHandoffRepository,
  InMemoryAgentNotificationRepository,
  InMemoryAgentTaskRepository,
  isAgentTaskError,
  isHandoffExpired,
  type NotifiablePlan,
} from './index.js';

/**
 * AE-6 (ADR-0119): bounded open work per agent and per organization, handoffs that expire when
 * nobody decides them, a plan's result told to the person who made it, and durations in a trace.
 */

const T0 = new Date('2026-10-02T12:00:00Z');
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const DAY = 86_400_000;

const BILLING = (organization: Organization): InitialBilling => {
  const subscriptionId = `sub-${organization.id}` as SubscriptionId;
  const at = organization.createdAt;
  return {
    account: { organizationId: organization.id, subscriptionId, createdAt: at, updatedAt: at },
    subscription: {
      id: subscriptionId,
      organizationId: organization.id,
      plan: { id: 'test-plan', version: 1 },
      status: 'active',
      createdAt: at,
      updatedAt: at,
    },
  };
};

const as = (userId: UserId): AuthenticatedContext =>
  Object.freeze({ actor: 'user', userId, emailVerified: true });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isAgentTaskError(error)) return error.code;
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    throw error;
  }
  return 'accepted';
}

async function world(limits = { perAgent: 2, perOrganization: 3 }) {
  let clock = new Date(T0);
  const now = () => {
    clock = new Date(clock.getTime() + 1000);
    return clock;
  };
  const travel = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  const audit = new InMemoryAuditStore();
  const departments = new InMemoryDepartmentRepository();
  const tenancy = new InMemoryTenancyStore(now, audit, undefined, departments);
  const create = (user: UserId, name: string) =>
    createOrganization(as(user), { name }, tenancy, {
      billing: BILLING,
      credits: openWallet,
      departments: (o: Organization) => provisionDepartments(o, DEFAULT_DEPARTMENT_CATALOGUE),
    });
  const a = await create(ALICE, 'A');
  const b = await create(BOB, 'B');
  const authorization = createAuthorizationService();
  const repository = new InMemorySpecialistRepository(audit);
  const management = createSpecialistManagement({
    repository,
    departments,
    organizations: tenancy,
    authorization,
    skills: createSkillCatalogue(),
    tools: (id, version) =>
      id === 'follow_up_schedule' && version === 2
        ? { riskLevel: 'low', approval: 'approval_required', permissions: ['follow_up.manage'] }
        : undefined,
    now,
  });
  const specialists = createSpecialistService({
    repository,
    departments,
    organizations: tenancy,
    authorization,
  });
  const executionRepository = new InMemoryExecutionRepository(audit);
  const executions = createExecutionService({
    repository: executionRepository,
    organizations: tenancy,
    assignments: specialists.assignments,
    authorization,
    audit: createAuditService(audit, now),
    now,
  });
  const tasks = new InMemoryAgentTaskRepository();
  const service = createAgentTaskService({
    tasks,
    specialists: repository,
    executions,
    authorization,
    runtime: { kickoff: async () => undefined },
    openWork: executionRepository,
    limits,
    now,
  });
  const alice = await resolveTenant(as(ALICE), a.organization.id, tenancy);
  const bob = await resolveTenant(as(BOB), b.organization.id, tenancy);
  async function agent(
    templateId: string,
    name: string,
    tenant = alice,
    work: { collaboration?: boolean } = {},
  ): Promise<Specialist> {
    const created = await management.create(tenant, { templateId, displayName: name });
    let current = await management.setStatus(tenant, created.identity.id, {
      from: 'draft',
      to: 'active',
    });
    if (work.collaboration === true) {
      current = await management.setWorkSettings(tenant, current.identity.id, {
        fromVersion: current.version,
        collaboration: true,
      });
    }
    return current;
  }
  return {
    orgA: a.organization.id,
    orgB: b.organization.id,
    audit,
    departments,
    authorization,
    alice,
    bob,
    repository,
    tasks,
    service,
    executions,
    agent,
    now,
    travel,
  };
}

describe('Bounded open work (ADR-0119)', () => {
  it('has safety defaults', () => {
    expect(AGENT_WORK_LIMITS).toEqual({ perAgent: 10, perOrganization: 200 });
  });

  it('refuses a new task while the agent has too much open, never a repeat', async () => {
    const w = await world({ perAgent: 2, perOrganization: 50 });
    const lucia = await w.agent('commercial', 'Lucía');
    const mara = await w.agent('marketing', 'Mara');
    const first = await w.service.assign(w.alice, lucia.identity.id, {
      request: 'Uno',
      idempotencyKey: 'k-1',
    });
    await w.service.assign(w.alice, lucia.identity.id, { request: 'Dos' });
    expect(await codeOf(w.service.assign(w.alice, lucia.identity.id, { request: 'Tres' }))).toBe(
      'agent_busy',
    );
    // The same request again is the same task: never refused.
    const again = await w.service.assign(w.alice, lucia.identity.id, {
      request: 'Uno',
      idempotencyKey: 'k-1',
    });
    expect(again.task.id).toBe(first.task.id);
    // Another agent is not this one's work.
    await w.service.assign(w.alice, mara.identity.id, { request: 'Uno' });
    // Once one ends, the agent takes work again.
    await w.executions.cancel(w.alice, first.task.id, 'test');
    await w.service.assign(w.alice, lucia.identity.id, { request: 'Tres' });
  });

  it('refuses a new task while the organization has too much open, counting only its own', async () => {
    const w = await world({ perAgent: 10, perOrganization: 3 });
    const lucia = await w.agent('commercial', 'Lucía');
    const mara = await w.agent('marketing', 'Mara');
    const other = await w.agent('commercial', 'Otra', w.bob);
    for (const r of ['Uno', 'Dos'])
      await w.service.assign(w.alice, lucia.identity.id, { request: r });
    await w.service.assign(w.alice, mara.identity.id, { request: 'Tres' });
    expect(await codeOf(w.service.assign(w.alice, mara.identity.id, { request: 'Cuatro' }))).toBe(
      'organization_busy',
    );
    // Another organization's open work never counts.
    await w.service.assign(w.bob, other.identity.id, { request: 'Uno' });
  });

  it('checks nothing when no open-work index is given', async () => {
    const w = await world();
    const loose = createAgentTaskService({
      tasks: w.tasks,
      specialists: w.repository,
      executions: w.executions,
      authorization: w.authorization,
      now: w.now,
    });
    const lucia = await w.agent('commercial', 'Lucía');
    for (const r of ['1', '2', '3', '4'])
      await loose.assign(w.alice, lucia.identity.id, { request: r });
  });
});

describe('Handoffs expire when nobody decides (ADR-0119)', () => {
  async function setup() {
    const w = await world({ perAgent: 10, perOrganization: 50 });
    const handoffs = new InMemoryAgentHandoffRepository(w.audit);
    const directory = createHandoffDirectory({
      departments: w.departments,
      specialists: w.repository,
    });
    const lucia = await w.agent('commercial', 'Lucía', w.alice, { collaboration: true });
    await w.agent('marketing', 'Mara');
    const recorder = createHandoffRecorder({
      repository: handoffs,
      tasks: w.tasks,
      specialists: w.repository,
      directory,
      authorization: w.authorization,
      now: w.now,
    });
    const service = createAgentHandoffService({
      repository: handoffs,
      tasks: w.tasks,
      assign: w.service,
      specialists: w.repository,
      directory,
      authorization: w.authorization,
      spent: async () => 0,
      now: w.now,
    });
    const propose = async (request: string) => {
      const { task } = await w.service.assign(w.alice, lucia.identity.id, { request });
      await recorder.record(
        w.alice,
        {
          taskId: task.id,
          specialistId: lucia.identity.id,
          specialistVersion: task.specialistVersion,
        },
        {
          department: 'marketing',
          reason: 'next_step',
          request: 'Prepara el post',
          context: '',
        },
      );
      return task.id;
    };
    return { w, handoffs, service, propose };
  }

  it('reads as refused once it waited longer than its days, without a write', async () => {
    expect(HANDOFF_LIMITS.expiryDays).toBe(7);
    const createdAt = T0.toISOString() as never;
    const proposed = { state: 'proposed' as const, createdAt };
    expect(isHandoffExpired(proposed, new Date(T0.getTime() + 7 * DAY))).toBe(false);
    expect(isHandoffExpired(proposed, new Date(T0.getTime() + 7 * DAY + 1))).toBe(true);
    // Only a proposed handoff expires.
    expect(
      isHandoffExpired({ ...proposed, state: 'accepted' }, new Date(T0.getTime() + 30 * DAY)),
    ).toBe(false);

    const { w, handoffs, service, propose } = await setup();
    const taskId = await propose('Uno');
    w.travel(8 * DAY);
    expect(await service.get(w.alice, taskId)).toMatchObject({
      state: 'refused',
      refusal: 'expired',
    });
    // Reading it changed nothing stored.
    const stored = await handoffs.find(w.orgA, taskId);
    expect(stored?.state).toBe('proposed');
    if (stored !== undefined) expect(handoffAsOf(stored, T0).state).toBe('proposed');
  });

  it('refuses to accept or decline it once expired, records that, and starts nothing', async () => {
    const { w, handoffs, service, propose } = await setup();
    const one = await propose('Uno');
    const two = await propose('Dos');
    w.travel(8 * DAY);
    expect(await codeOf(service.accept(w.alice, one))).toBe('handoff_expired');
    expect(await codeOf(service.decline(w.alice, two))).toBe('handoff_expired');
    for (const id of [one, two]) {
      expect(await handoffs.find(w.orgA, id)).toMatchObject({
        state: 'refused',
        refusal: 'expired',
      });
    }
    expect(
      w.audit
        .events()
        .filter((e) => e.action === 'agent_handoff.refused' && e.reason === 'expired'),
    ).toHaveLength(2);
    // No receiving task was made.
    expect((await handoffs.find(w.orgA, one))?.childTaskId).toBeUndefined();
    // Deciding again says it is no longer pending.
    expect(await codeOf(service.accept(w.alice, one))).toBe('handoff_not_pending');
  });

  it('is accepted as before within its days', async () => {
    const { w, service, propose } = await setup();
    const taskId = await propose('Uno');
    w.travel(6 * DAY);
    expect((await service.accept(w.alice, taskId)).state).toBe('accepted');
  });
});

describe('A plan’s result is told to the person who made it (ADR-0119)', () => {
  const ORG_A = '0b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b' as OrganizationId;
  const ORG_B = '9b6f7c1e-8a0e-4d5a-9f0e-1c2d3e4f5a6b' as OrganizationId;
  const plan = (over: Partial<NotifiablePlan> = {}): NotifiablePlan => ({
    id: 'plan-1',
    organizationId: ORG_A,
    executionId: 'exec-plan-1',
    status: 'completed',
    createdBy: ALICE,
    ...over,
  });
  const event = (subjectId = 'plan-1', organizationId = ORG_A, data = {}) => ({
    id: `evt-${subjectId}-${organizationId.slice(0, 4)}`,
    type: 'plan.finished',
    organizationId,
    occurredAt: T0.toISOString(),
    subject: { type: 'plan', id: subjectId },
    data: { outcome: 'completed', ...data },
  });
  function setup(plans: readonly NotifiablePlan[] | undefined) {
    const repository = new InMemoryAgentNotificationRepository();
    const subscriber = createAgentNotificationSubscriber({
      tasks: new InMemoryAgentTaskRepository(),
      ...(plans === undefined
        ? {}
        : {
            plans: {
              find: async (organizationId, id) =>
                plans.find((p) => p.id === id && p.organizationId === organizationId),
            },
          }),
      notifier: createAgentNotifier({ channels: [inAppChannel(repository)] }),
    });
    return { repository, subscriber };
  }

  it('listens to plan.finished', () => {
    expect(setup([]).subscriber.types).toContain('plan.finished');
  });

  it('makes one "result available" notice for the plan’s maker, naming the plan', async () => {
    const { repository, subscriber } = setup([plan()]);
    await subscriber.handle(event());
    await subscriber.handle(event());
    expect(repository.all()).toEqual([
      expect.objectContaining({
        organizationId: ORG_A,
        recipientId: ALICE,
        kind: 'result_available',
        specialistId: null,
        taskId: 'exec-plan-1',
        planId: 'plan-1',
        code: null,
      }),
    ]);
  });

  it('tells a failed plan with its code, from the stored plan, not the event', async () => {
    const { repository, subscriber } = setup([plan({ status: 'failed' })]);
    // The event says completed; the stored plan says failed: the plan wins.
    await subscriber.handle(event('plan-1', ORG_A, { code: 'step_failed' }));
    expect(repository.all()).toEqual([
      expect.objectContaining({ kind: 'plan_failed', code: 'step_failed', planId: 'plan-1' }),
    ]);
  });

  it('makes nothing for another organization’s plan, an open plan, or without plans', async () => {
    const other = setup([plan({ organizationId: ORG_B, createdBy: BOB })]);
    await other.subscriber.handle(event('plan-1', ORG_A));
    expect(other.repository.all()).toEqual([]);
    const open = setup([plan({ status: 'executing' })]);
    await open.subscriber.handle(event());
    expect(open.repository.all()).toEqual([]);
    const none = setup(undefined);
    await none.subscriber.handle(event());
    expect(none.repository.all()).toEqual([]);
  });
});

describe('Durations in a task’s trace (ADR-0119)', () => {
  it('measures only what ended, in order', () => {
    expect(durationOf('2026-10-02T12:00:00.000Z', '2026-10-02T12:00:02.500Z')).toBe(2500);
    expect(durationOf('2026-10-02T12:00:00.000Z', null)).toBeNull();
    expect(durationOf(undefined, '2026-10-02T12:00:00.000Z')).toBeNull();
    expect(durationOf('2026-10-02T12:00:02.000Z', '2026-10-02T12:00:00.000Z')).toBeNull();
    expect(durationOf('not a time', '2026-10-02T12:00:00.000Z')).toBeNull();
  });
});
