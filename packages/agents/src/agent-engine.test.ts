import type { AIRequest, AIResponse } from '@melonoffice/ai-gateway';
import { createAuditService, InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { openWallet } from '@melonoffice/credits';
import {
  DEFAULT_DEPARTMENT_CATALOGUE,
  InMemoryDepartmentRepository,
  provisionDepartments,
} from '@melonoffice/departments';
import type {
  Execution,
  ExecutionId,
  ExecutionNodeId,
  InitialBilling,
  Organization,
  Specialist,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import {
  createAgentOutputStore,
  createExecutionService,
  InMemoryAgentOutputRepository,
  InMemoryExecutionRepository,
} from '@melonoffice/execution';
import { createAuthorizationService } from '@melonoffice/rbac';
import {
  createSkillCatalogue,
  createSpecialistManagement,
  createSpecialistService,
  InMemorySpecialistRepository,
  pageOfAgents,
} from '@melonoffice/specialists';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveRuntimeTenant,
  resolveTenant,
} from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import {
  AGENT_TASK_NODE,
  AI_REVIEW_NODE,
  createAgentAnswerReviewer,
  createAgentHandoffService,
  createAgentMemoryContext,
  createAgentMemoryRecorder,
  createAgentMemoryService,
  createAgentNotificationService,
  createAgentNotificationSubscriber,
  createAgentNotifier,
  createAgentTaskService,
  createAgentTaskVerifier,
  createHandoffDirectory,
  createHandoffRecorder,
  createHandoffSettler,
  creditsSpentBy,
  inAppChannel,
  InMemoryAgentHandoffRepository,
  InMemoryAgentMemoryRepository,
  InMemoryAgentNotificationRepository,
  InMemoryAgentTaskRepository,
  isAgentTaskError,
  memoryTextProblem,
  notificationOfTaskEnd,
  readAgentTaskTrace,
} from './index.js';

/**
 * The Agent Engine block (ADR-0117): agents' own memory, handoffs between agents, in-app
 * notifications, the optional AI review, a task's trace and credits, and listing 1000+ agents.
 * Every part is checked for tenant isolation and for permissions that are never inherited.
 */

const T0 = new Date('2026-10-01T12:00:00Z');
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;

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

const as = (userId: UserId, actor: 'user' | 'gia' = 'user'): AuthenticatedContext =>
  Object.freeze({ actor, userId, emailVerified: true });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isAgentTaskError(error)) return error.detail ? `${error.code}:${error.detail}` : error.code;
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    throw error;
  }
  return 'accepted';
}

async function world() {
  let clock = new Date(T0);
  const now = () => {
    clock = new Date(clock.getTime() + 1000);
    return clock;
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
  const executions = createExecutionService({
    repository: new InMemoryExecutionRepository(audit),
    organizations: tenancy,
    assignments: specialists.assignments,
    authorization,
    audit: createAuditService(audit, now),
    now,
  });
  const tasks = new InMemoryAgentTaskRepository();
  const kicked: string[] = [];
  const service = createAgentTaskService({
    tasks,
    specialists: repository,
    executions,
    authorization,
    runtime: { kickoff: async (_t, id) => void kicked.push(id) },
    now,
  });
  const alice = await resolveTenant(as(ALICE), a.organization.id, tenancy);
  const bob = await resolveTenant(as(BOB), b.organization.id, tenancy);
  async function agent(
    templateId = 'commercial',
    name = 'Lucía',
    tenant = alice,
    work: { memory?: boolean; collaboration?: boolean; aiVerification?: boolean } = {},
  ): Promise<Specialist> {
    const created = await management.create(tenant, { templateId, displayName: name });
    let current = await management.setStatus(tenant, created.identity.id, {
      from: 'draft',
      to: 'active',
    });
    if (Object.values(work).some(Boolean)) {
      current = await management.setWorkSettings(tenant, current.identity.id, {
        fromVersion: current.version,
        ...work,
      });
    }
    return current;
  }
  const outputs = createAgentOutputStore(new InMemoryAgentOutputRepository(), now);
  return {
    orgA: a.organization.id,
    orgB: b.organization.id,
    audit,
    departments,
    tenancy,
    authorization,
    alice,
    bob,
    gia: await resolveTenant(as(ALICE, 'gia'), a.organization.id, tenancy),
    runtime: await resolveRuntimeTenant(ALICE, a.organization.id, tenancy),
    runtimeB: await resolveRuntimeTenant(BOB, b.organization.id, tenancy),
    repository,
    management,
    tasks,
    service,
    executions,
    outputs,
    kicked,
    agent,
    now,
  };
}

type World = Awaited<ReturnType<typeof world>>;

const answerOf = async (w: World, executionId: string, credits: number, node = AGENT_TASK_NODE) =>
  w.outputs.record(w.runtime, {
    executionId: executionId as ExecutionId,
    nodeId: node as ExecutionNodeId,
    requestId: `req-${node}-${executionId.slice(0, 8)}`,
    output: { structured: { answer: 'Respuesta del agente', missing: [] } },
    ai: {
      provider: 'vertex_ai',
      model: 'gemini-2.5-flash-lite',
      strategy: null,
      fallbackFrom: null,
      estimatedMicroUsd: null,
      actualMicroUsd: null,
      creditsEstimated: null,
      creditsConsumed: credits,
      maxCredits: null,
      escalation: null,
      attempts: 1,
    },
  });

// ---------------------------------------------------------------------------------------------

describe('Agent memory (ADR-0117)', () => {
  const memoryOf = (w: World) =>
    createAgentMemoryService({
      repository: new InMemoryAgentMemoryRepository(w.audit),
      specialists: w.repository,
      authorization: w.authorization,
      now: w.now,
    });

  it('keeps no secret and no contact details', () => {
    expect(memoryTextProblem('Prefieren respuestas cortas')).toBeUndefined();
    expect(memoryTextProblem('')).toBe('empty');
    expect(memoryTextProblem('x'.repeat(301))).toBe('too_long');
    expect(memoryTextProblem('la contraseña es hunter2')).toBe('secret');
    expect(memoryTextProblem(`api_key: sk-${'7'.repeat(24)}`)).toBe('secret');
    expect(memoryTextProblem('Escribir a ana@example.com')).toBe('contact_details');
    expect(memoryTextProblem('Llamar al +51 987 654 321')).toBe('contact_details');
  });

  it('lets a person add, read, forget and clear an agent’s notes, audited', async () => {
    const w = await world();
    const memory = memoryOf(w);
    const lucia = await w.agent('commercial', 'Lucía', w.alice, { memory: true });
    const note = await memory.remember(w.alice, lucia.identity.id, { text: 'Tutear al cliente' });
    expect(note).toMatchObject({ kind: 'note', text: 'Tutear al cliente', source: 'person' });
    expect(await memory.list(w.alice, lucia.identity.id)).toMatchObject({
      enabled: true,
      items: [{ id: note.id }],
    });
    expect(
      await codeOf(memory.remember(w.alice, lucia.identity.id, { text: 'clave: 1234 password' })),
    ).toBe('invalid_memory:secret');
    expect(await codeOf(memory.remember(w.alice, lucia.identity.id, { text: 'x', y: 1 }))).toBe(
      'invalid_memory:y',
    );
    await memory.forget(w.alice, lucia.identity.id, note.id);
    expect((await memory.list(w.alice, lucia.identity.id)).items).toEqual([]);
    await memory.remember(w.alice, lucia.identity.id, { text: 'Uno' });
    await memory.remember(w.alice, lucia.identity.id, { text: 'Dos' });
    expect(await memory.clear(w.alice, lucia.identity.id)).toBe(2);
    const actions = w.audit.events().map((e) => e.action);
    expect(actions).toEqual(
      expect.arrayContaining([
        'agent_memory.recorded',
        'agent_memory.forgotten',
        'agent_memory.cleared',
        'specialist.settings_changed',
      ]),
    );
  });

  it('changes nothing for GIA, the runtime or another organization', async () => {
    const w = await world();
    const memory = memoryOf(w);
    const lucia = await w.agent('commercial', 'Lucía', w.alice, { memory: true });
    expect(await codeOf(memory.remember(w.gia, lucia.identity.id, { text: 'Hola' }))).toBe(
      'permission_denied',
    );
    expect(await codeOf(memory.remember(w.runtime, lucia.identity.id, { text: 'Hola' }))).toBe(
      'permission_denied',
    );
    // Another organization's agent is not found, exactly like a missing one.
    expect(await codeOf(memory.list(w.bob, lucia.identity.id))).toBe('specialist_not_found');
    expect(await codeOf(memory.clear(w.bob, lucia.identity.id))).toBe('specialist_not_found');
  });

  it('keeps what a task proposed only when its version has memory on, once, for that agent', async () => {
    const w = await world();
    const repo = new InMemoryAgentMemoryRepository(w.audit);
    const recorder = createAgentMemoryRecorder({
      repository: repo,
      specialists: w.repository,
      now: w.now,
    });
    const context = createAgentMemoryContext({ repository: repo, now: w.now });
    const off = await w.agent('commercial', 'Sin memoria');
    const on = await w.agent('marketing', 'Con memoria', w.alice, { memory: true });
    const facts = (s: Specialist, taskId: string) => ({
      taskId: taskId as ExecutionId,
      specialistId: s.identity.id,
      specialistVersion: s.version,
    });
    const proposed = [{ kind: 'preference' as const, text: 'Prefieren tono cercano' }];
    expect(
      await recorder.record(
        w.runtime,
        facts(off, '00000000-0000-4000-8000-000000000001'),
        proposed,
      ),
    ).toBe(0);
    const task = facts(on, '00000000-0000-4000-8000-000000000002');
    expect(await recorder.record(w.runtime, task, proposed)).toBe(1);
    // The same task again keeps nothing twice.
    expect(await recorder.record(w.runtime, task, proposed)).toBe(0);
    const read = await context.read(w.runtime, {
      specialistId: on.identity.id,
      configuration: on.configuration,
    });
    expect(read?.text).toContain('Prefieren tono cercano');
    // Another agent, even of the same organization, reads none of it.
    const other = await context.read(w.runtime, {
      specialistId: off.identity.id,
      configuration: on.configuration,
    });
    expect(other?.text).not.toContain('Prefieren');
    // Another organization reads nothing of it.
    expect(await repo.list(w.orgB, on.identity.id)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------

describe('Handoffs between agents (ADR-0117)', () => {
  async function setup(work = { collaboration: true }) {
    const w = await world();
    const handoffs = new InMemoryAgentHandoffRepository(w.audit);
    const directory = createHandoffDirectory({
      departments: w.departments,
      specialists: w.repository,
    });
    const lucia = await w.agent('commercial', 'Lucía', w.alice, work);
    const mara = await w.agent('marketing', 'Mara');
    const recorder = createHandoffRecorder({
      repository: handoffs,
      tasks: w.tasks,
      specialists: w.repository,
      directory,
      authorization: w.authorization,
      now: w.now,
    });
    const spentBy = new Map<string, number>();
    const service = createAgentHandoffService({
      repository: handoffs,
      tasks: w.tasks,
      assign: w.service,
      specialists: w.repository,
      directory,
      authorization: w.authorization,
      spent: async (_tenant, taskId) => spentBy.get(taskId) ?? 0,
      now: w.now,
    });
    return { w, handoffs, directory, lucia, mara, recorder, service, spentBy };
  }

  const proposal = {
    department: 'marketing',
    reason: 'needs_specialist' as const,
    request: 'Prepara un post para el lanzamiento',
    context: 'El cliente quiere lanzar el combo familiar',
  };

  it('records a proposal only when the agent collaborates, for a department with an agent', async () => {
    const { w, lucia, recorder } = await setup();
    const { task } = await w.service.assign(w.alice, lucia.identity.id, {
      request: 'Lanza el combo',
      maxCredits: 10,
    });
    const facts = {
      taskId: task.id,
      specialistId: lucia.identity.id,
      specialistVersion: task.specialistVersion,
    };
    // No agent in Finanzas: not offered, so nothing is recorded.
    expect(
      await recorder.record(w.runtime, facts, { ...proposal, department: 'finance' }),
    ).toBeUndefined();
    const recorded = await recorder.record(w.runtime, facts, proposal);
    expect(recorded).toMatchObject({
      state: 'proposed',
      parentTaskId: task.id,
      department: 'marketing',
    });
  });

  it('records nothing for an agent that does not collaborate', async () => {
    const { w, lucia, recorder } = await setup({ collaboration: false });
    const { task } = await w.service.assign(w.alice, lucia.identity.id, { request: 'Hola' });
    const facts = {
      taskId: task.id,
      specialistId: lucia.identity.id,
      specialistVersion: task.specialistVersion,
    };
    expect(await recorder.record(w.runtime, facts, proposal)).toBeUndefined();
  });

  it('gives the receiving agent its own task, its own permissions and what is left of the budget', async () => {
    const { w, lucia, mara, recorder, service, spentBy } = await setup();
    const { task } = await w.service.assign(w.alice, lucia.identity.id, {
      request: 'Lanza el combo',
      maxCredits: 10,
    });
    await recorder.record(
      w.runtime,
      {
        taskId: task.id,
        specialistId: lucia.identity.id,
        specialistVersion: task.specialistVersion,
      },
      proposal,
    );
    spentBy.set(task.id, 4);
    // Only a person decides: never GIA or the runtime; another organization finds nothing.
    expect(await codeOf(service.accept(w.gia, task.id))).toBe('permission_denied');
    expect(await codeOf(service.accept(w.runtime, task.id))).toBe('permission_denied');
    expect(await codeOf(service.accept(w.bob, task.id))).toBe('handoff_not_found');
    const accepted = await service.accept(w.alice, task.id);
    expect(accepted).toMatchObject({
      state: 'accepted',
      receivingAgent: { specialistId: mara.identity.id },
      maxCredits: 6,
      decision: { by: ALICE },
    });
    // The receiving agent's own permissions, never the first agent's.
    expect(accepted.permissions).toEqual(mara.configuration.permissions);
    expect(accepted.permissions).not.toEqual(lucia.configuration.permissions);
    const child = await w.tasks.find(w.orgA, accepted.childTaskId as ExecutionId);
    expect(child).toMatchObject({
      specialistId: mara.identity.id,
      parentTaskId: task.id,
      maxCredits: 6,
      request: proposal.request,
    });
    // Accepting again starts nothing new.
    expect((await service.accept(w.alice, task.id)).childTaskId).toBe(accepted.childTaskId);
    expect(w.kicked.filter((id) => id === accepted.childTaskId)).toHaveLength(1);
  });

  it('a handed task never hands on again', async () => {
    const { w, lucia, mara, recorder, service } = await setup();
    await w.management.setWorkSettings(w.alice, mara.identity.id, {
      fromVersion: mara.version,
      collaboration: true,
    });
    const { task } = await w.service.assign(w.alice, lucia.identity.id, { request: 'Lanza' });
    await recorder.record(
      w.runtime,
      {
        taskId: task.id,
        specialistId: lucia.identity.id,
        specialistVersion: task.specialistVersion,
      },
      proposal,
    );
    const accepted = await service.accept(w.alice, task.id);
    const child = await w.tasks.find(w.orgA, accepted.childTaskId as ExecutionId);
    expect(
      await recorder.record(
        w.runtime,
        {
          taskId: child?.id as ExecutionId,
          specialistId: mara.identity.id,
          specialistVersion: child?.specialistVersion as number,
        },
        { ...proposal, department: 'sales' },
      ),
    ).toBeUndefined();
  });

  it('refuses when the budget is spent, and a person may decline', async () => {
    const { w, lucia, recorder, service, spentBy } = await setup();
    const first = await w.service.assign(w.alice, lucia.identity.id, {
      request: 'Uno',
      maxCredits: 3,
    });
    const second = await w.service.assign(w.alice, lucia.identity.id, { request: 'Dos' });
    for (const { task } of [first, second]) {
      await recorder.record(
        w.runtime,
        {
          taskId: task.id,
          specialistId: lucia.identity.id,
          specialistVersion: task.specialistVersion,
        },
        proposal,
      );
    }
    spentBy.set(first.task.id, 3);
    // No agent gets round a budget through another.
    expect(await codeOf(service.accept(w.alice, first.task.id))).toBe('budget_exhausted');
    expect((await service.get(w.alice, first.task.id))?.state).toBe('refused');
    expect((await service.decline(w.alice, second.task.id)).state).toBe('declined');
    expect(await codeOf(service.accept(w.alice, second.task.id))).toBe('handoff_not_pending');
  });

  it('settles when the handed task ends, with what it spent', async () => {
    const { w, handoffs, lucia, recorder, service } = await setup();
    const { task } = await w.service.assign(w.alice, lucia.identity.id, { request: 'Lanza' });
    await recorder.record(
      w.runtime,
      {
        taskId: task.id,
        specialistId: lucia.identity.id,
        specialistVersion: task.specialistVersion,
      },
      proposal,
    );
    const accepted = await service.accept(w.alice, task.id);
    const settler = createHandoffSettler({
      repository: handoffs,
      tasks: w.tasks,
      spent: async () => 2,
      now: w.now,
    });
    const execution = (await w.executions.get(
      w.alice,
      accepted.childTaskId as string,
    )) as Execution;
    const settled = await settler.settle(w.runtime, { ...execution, status: 'completed' });
    expect(settled).toMatchObject({ state: 'completed', creditsConsumed: 2 });
  });
});

// ---------------------------------------------------------------------------------------------

describe('In-app notifications (ADR-0117)', () => {
  it('turns a task’s end into one notice for the person who asked, as codes', () => {
    expect(notificationOfTaskEnd({ outcome: 'completed', handoff: null, code: null })).toEqual({
      kind: 'task_finished',
      code: null,
    });
    expect(
      notificationOfTaskEnd({ outcome: 'completed', handoff: 'missing_information', code: null }),
    ).toEqual({ kind: 'needs_info', code: null });
    expect(
      notificationOfTaskEnd({ outcome: 'failed', handoff: 'policy', code: 'agent_paused' }),
    ).toEqual({ kind: 'agent_stopped', code: 'agent_paused' });
    expect(
      notificationOfTaskEnd({
        outcome: 'failed',
        handoff: 'authorization_required',
        code: 'tool_not_permitted',
      }),
    ).toEqual({ kind: 'task_blocked', code: 'tool_not_permitted' });
    expect(
      notificationOfTaskEnd({ outcome: 'failed', handoff: 'repeated_error', code: 'x' }),
    ).toEqual({ kind: 'task_failed', code: 'x' });
    // A person rejected it themselves: nothing new to tell them.
    expect(
      notificationOfTaskEnd({ outcome: 'failed', handoff: null, code: 'approval_rejected' }),
    ).toBeNull();
  });

  it('delivers events once, only to their person, readable only by them', async () => {
    const w = await world();
    const lucia = await w.agent();
    const { task } = await w.service.assign(w.alice, lucia.identity.id, { request: 'Hola' });
    const repository = new InMemoryAgentNotificationRepository();
    const subscriber = createAgentNotificationSubscriber({
      tasks: w.tasks,
      notifier: createAgentNotifier({ channels: [inAppChannel(repository)], now: w.now }),
    });
    const event = (id: string, type: string, data: Record<string, string>, minute = 30) => ({
      id,
      type,
      organizationId: w.orgA,
      occurredAt: `2026-10-01T12:${String(minute)}:00.000Z`,
      subject: { type: 'execution', id: task.id },
      data,
    });
    await subscriber.handle(
      event('evt_1', 'agent_task.approval_required', { specialistId: lucia.identity.id }),
    );
    const finished = event(
      'evt_2',
      'agent_task.finished',
      { specialistId: lucia.identity.id, outcome: 'completed' },
      31,
    );
    await subscriber.handle(finished);
    // A repeated delivery is the same notice.
    await subscriber.handle(finished);
    // An event naming a task of another organization makes nothing.
    await subscriber.handle({ ...finished, id: 'evt_3', organizationId: w.orgB });
    expect(repository.all().map((n) => [n.kind, n.recipientId, n.taskId])).toEqual(
      expect.arrayContaining([
        ['approval_required', ALICE, task.id],
        ['task_finished', ALICE, task.id],
      ]),
    );
    expect(repository.all()).toHaveLength(2);
    const notices = createAgentNotificationService({ repository, now: w.now });
    const page = await notices.list(w.alice);
    expect(page.unread).toBe(2);
    // Newest first.
    expect(page.items.map((n) => n.kind)).toEqual(['task_finished', 'approval_required']);
    // Another organization's person sees none and cannot mark one.
    expect((await notices.list(w.bob)).items).toEqual([]);
    expect(await codeOf(notices.markRead(w.bob, page.items[0]?.id))).toBe('notification_not_found');
    // Only a person reads their notices.
    expect(await codeOf(notices.list(w.runtime))).toBe('permission_denied');
    await notices.markRead(w.alice, page.items[0]?.id);
    expect((await notices.list(w.alice)).unread).toBe(1);
    expect(await notices.markAllRead(w.alice)).toBe(1);
    expect((await notices.list(w.alice)).unread).toBe(0);
  });

  it('pages a person’s notices with a cursor', async () => {
    const w = await world();
    const repository = new InMemoryAgentNotificationRepository();
    const notifier = createAgentNotifier({ channels: [inAppChannel(repository)], now: w.now });
    for (let i = 0; i < 7; i += 1) {
      await notifier.notify({
        organizationId: w.orgA,
        recipientId: ALICE,
        kind: 'task_finished',
        specialistId: 'spec_x' as Specialist['identity']['id'],
        taskId: `task-${i}`,
        key: `k-${i}`,
      });
    }
    const notices = createAgentNotificationService({ repository, now: w.now });
    const first = await notices.list(w.alice, { limit: 5 });
    expect(first.items).toHaveLength(5);
    const second = await notices.list(w.alice, { limit: 5, cursor: first.nextCursor });
    expect(second.items).toHaveLength(2);
    expect(second.nextCursor).toBeNull();
    expect(new Set([...first.items, ...second.items].map((n) => n.taskId)).size).toBe(7);
    expect(await codeOf(notices.list(w.alice, { cursor: 'nope' }))).toBe('invalid_task:cursor');
  });

  it('tells the person when another agent received the work', async () => {
    const w = await world();
    const handoffs = new InMemoryAgentHandoffRepository(w.audit);
    const directory = createHandoffDirectory({
      departments: w.departments,
      specialists: w.repository,
    });
    const lucia = await w.agent('commercial', 'Lucía', w.alice, { collaboration: true });
    const mara = await w.agent('marketing', 'Mara');
    const repository = new InMemoryAgentNotificationRepository();
    const { task } = await w.service.assign(w.alice, lucia.identity.id, { request: 'Lanza' });
    await createHandoffRecorder({
      repository: handoffs,
      tasks: w.tasks,
      specialists: w.repository,
      directory,
      authorization: w.authorization,
      now: w.now,
    }).record(
      w.runtime,
      {
        taskId: task.id,
        specialistId: lucia.identity.id,
        specialistVersion: task.specialistVersion,
      },
      { department: 'marketing', reason: 'next_step', request: 'Haz el post', context: 'Combo' },
    );
    await createAgentHandoffService({
      repository: handoffs,
      tasks: w.tasks,
      assign: w.service,
      specialists: w.repository,
      directory,
      authorization: w.authorization,
      spent: async () => 0,
      notifier: createAgentNotifier({ channels: [inAppChannel(repository)], now: w.now }),
      now: w.now,
    }).accept(w.alice, task.id);
    expect(repository.all()).toMatchObject([
      {
        kind: 'task_received',
        recipientId: ALICE,
        specialistId: mara.identity.id,
        otherSpecialistId: lucia.identity.id,
      },
    ]);
  });
});

// ---------------------------------------------------------------------------------------------

describe('Optional AI verification (ADR-0117)', () => {
  function gateway(response: (request: AIRequest) => AIResponse) {
    const calls: AIRequest[] = [];
    return {
      calls,
      ai: {
        async generate(_tenant: unknown, request: AIRequest) {
          calls.push(request);
          return response(request);
        },
      },
    };
  }
  const completed =
    (verdict: 'pass' | 'fail', credits = 1) =>
    (request: AIRequest): AIResponse =>
      ({
        status: 'completed',
        requestId: request.requestId,
        provider: 'vertex_ai',
        model: 'gemini-2.5-flash-lite',
        output: {
          structured: { verdict, reason: verdict === 'pass' ? 'answers_request' : 'off_topic' },
        },
        cost: { estimatedMicroUsd: null, actualMicroUsd: null },
        credits: { state: 'consumed', estimated: credits, consumed: credits },
        attempts: 1,
        fallbackFrom: null,
      }) as unknown as AIResponse;

  async function setup(aiVerification: boolean, maxCredits?: number) {
    const w = await world();
    const ana = await w.agent('marketing', 'Ana', w.alice, { aiVerification });
    const { execution } = await w.service.assign(w.alice, ana.identity.id, {
      request: 'Escribe un post',
      ...(maxCredits === undefined ? {} : { maxCredits }),
    });
    const running = execution as Execution;
    const done: Execution = {
      ...running,
      nodes: running.nodes.map((n) => ({ ...n, status: 'completed' as const })),
    };
    await answerOf(w, running.id, 1);
    const reviewer = createAgentAnswerReviewer({
      outputs: w.outputs,
      specialists: w.repository,
      tasks: w.tasks,
      spent: (tenant, e) => creditsSpentBy(w.outputs, tenant, e),
    });
    const verifier = createAgentTaskVerifier({ outputs: w.outputs, reviewer });
    return { w, done, verifier };
  }

  it('asks no model when the agent has it off: the usual checks only', async () => {
    const { w, done, verifier } = await setup(false);
    const g = gateway(completed('pass'));
    const result = await verifier.verify(w.runtime, done, { ai: g.ai as never });
    expect(g.calls).toHaveLength(0);
    expect(result?.verification.nodes[0]?.checks.map((c) => c.code)).toEqual([
      'agent_answer_valid',
    ]);
  });

  it('asks once, keeps the review with its model and credits, and never asks again', async () => {
    const { w, done, verifier } = await setup(true);
    const g = gateway(completed('pass', 1));
    const first = await verifier.verify(w.runtime, done, { ai: g.ai as never });
    expect(first?.verification.nodes[0]?.checks).toEqual([
      expect.objectContaining({ code: 'agent_answer_valid', result: 'passed' }),
      expect.objectContaining({ code: 'ai_review', result: 'passed' }),
    ]);
    expect(first?.result).toBeDefined();
    expect(g.calls).toHaveLength(1);
    expect(g.calls[0]).toMatchObject({
      executionId: done.id,
      nodeId: AI_REVIEW_NODE,
      taskType: 'agent_review',
    });
    await verifier.verify(w.runtime, done, { ai: g.ai as never });
    expect(g.calls).toHaveLength(1);
    const kept = await w.outputs.find(w.runtime, done.id, AI_REVIEW_NODE);
    expect(kept?.ai).toMatchObject({ model: 'gemini-2.5-flash-lite', creditsConsumed: 1 });
    // Its credits count toward what the task spent.
    expect(await creditsSpentBy(w.outputs, w.runtime, done)).toBe(2);
  });

  it('a failed review fails the verification', async () => {
    const { w, done, verifier } = await setup(true);
    const g = gateway(completed('fail'));
    const result = await verifier.verify(w.runtime, done, { ai: g.ai as never });
    expect(result?.verification.nodes[0]?.checks[1]).toMatchObject({
      code: 'ai_review',
      result: 'failed',
    });
    expect(result?.result).toBeUndefined();
  });

  it('without budget left or with the call refused, the usual checks stand alone', async () => {
    const spent = await setup(true, 1);
    const g = gateway(completed('pass'));
    const result = await spent.verifier.verify(spent.w.runtime, spent.done, { ai: g.ai as never });
    expect(g.calls).toHaveLength(0);
    expect(result?.verification.nodes[0]?.checks.map((c) => c.code)).toEqual([
      'agent_answer_valid',
    ]);
    expect(result?.result).toBeDefined();
    const refused = await setup(true);
    const denied = gateway(
      (r) => ({ status: 'denied', requestId: r.requestId, code: 'credits_insufficient' }) as const,
    );
    const after = await refused.verifier.verify(refused.w.runtime, refused.done, {
      ai: denied.ai as never,
    });
    expect(after?.result).toBeDefined();
    const kept = await refused.w.outputs.find(refused.w.runtime, refused.done.id, AI_REVIEW_NODE);
    expect(kept?.output.structured).toEqual({
      verdict: 'unavailable',
      reason: 'credits_insufficient',
    });
  });
});

// ---------------------------------------------------------------------------------------------

describe('A task’s trace and credits (ADR-0117)', () => {
  it('answers how much the task cost and which agent spent it, its handed task included', async () => {
    const w = await world();
    const handoffs = new InMemoryAgentHandoffRepository(w.audit);
    const directory = createHandoffDirectory({
      departments: w.departments,
      specialists: w.repository,
    });
    const lucia = await w.agent('commercial', 'Lucía', w.alice, { collaboration: true });
    const mara = await w.agent('marketing', 'Mara');
    const { task, execution } = await w.service.assign(w.alice, lucia.identity.id, {
      request: 'Lanza',
      maxCredits: 10,
    });
    await answerOf(w, task.id, 3);
    await createHandoffRecorder({
      repository: handoffs,
      tasks: w.tasks,
      specialists: w.repository,
      directory,
      authorization: w.authorization,
      now: w.now,
    }).record(
      w.runtime,
      {
        taskId: task.id,
        specialistId: lucia.identity.id,
        specialistVersion: task.specialistVersion,
      },
      { department: 'marketing', reason: 'next_step', request: 'Haz el post', context: 'Combo' },
    );
    const service = createAgentHandoffService({
      repository: handoffs,
      tasks: w.tasks,
      assign: w.service,
      specialists: w.repository,
      directory,
      authorization: w.authorization,
      spent: async (tenant) => creditsSpentBy(w.outputs, tenant, execution as Execution),
      now: w.now,
    });
    const accepted = await service.accept(w.alice, task.id);
    await answerOf(w, accepted.childTaskId as string, 2);
    const trace = await readAgentTaskTrace(w.alice, task.id, {
      tasks: w.service,
      outputs: w.outputs,
      handoffs: service,
      history: { history: async (org, target) => w.audit.history(org, target, 50) },
    });
    expect(trace.credits).toMatchObject({
      task: 3,
      review: 0,
      subtasks: 2,
      total: 5,
      budget: 10,
      remaining: 7,
    });
    expect(trace.credits.byAgent).toEqual([
      { specialistId: lucia.identity.id, credits: 3 },
      { specialistId: mara.identity.id, credits: 2 },
    ]);
    expect(trace.subtasks).toMatchObject([{ taskId: accepted.childTaskId, credits: 2 }]);
    expect(trace.steps[0]).toMatchObject({
      nodeId: 'work',
      model: { model: 'gemini-2.5-flash-lite', credits: 3 },
    });
    expect(trace.history.map((h) => h.action)).toEqual(
      expect.arrayContaining(['agent_handoff.proposed', 'agent_handoff.accepted']),
    );
    // Nothing of the answer text or the request reaches the trace.
    expect(JSON.stringify(trace)).not.toContain('Respuesta del agente');
    // Another organization reads nothing.
    expect(
      await codeOf(readAgentTaskTrace(w.bob, task.id, { tasks: w.service, outputs: w.outputs })),
    ).toBe('task_not_found');
  });
});

// ---------------------------------------------------------------------------------------------

describe('1000+ agents (ADR-0115, ADR-0117)', () => {
  it('lists and searches 1200 agents page by page, losing and repeating none', async () => {
    const w = await world();
    for (let i = 0; i < 1200; i += 1) {
      await w.management.create(w.alice, {
        templateId: i % 2 === 0 ? 'commercial' : 'marketing',
        displayName: i % 100 === 7 ? `Ágata ${i}` : `Agente ${i}`,
      });
    }
    // One of B's, which A never sees.
    await w.management.create(w.bob, { templateId: 'commercial', displayName: 'Ágata B' });
    const walk = async (query: { q?: string; skill?: string }) => {
      const seen: string[] = [];
      let after: string | undefined;
      let requests = 0;
      for (;;) {
        requests += 1;
        const page = await pageOfAgents(w.repository, w.orgA, {
          limit: 25,
          ...(after === undefined ? {} : { after: decode(after) }),
          ...query,
        });
        seen.push(...page.items.map((s) => s.identity.id));
        if (page.nextCursor === null) break;
        after = page.nextCursor;
      }
      return { seen, requests };
    };
    const decode = (cursor: string) =>
      JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'))
        .a as Specialist['identity']['id'];
    const all = await walk({});
    expect(all.seen).toHaveLength(1200);
    expect(new Set(all.seen).size).toBe(1200);
    const search = await walk({ q: 'agata' });
    expect(search.seen).toHaveLength(12);
    expect(new Set(search.seen).size).toBe(12);
    // Each request reads at most 500 records: a sparse search needs a few requests, none more.
    expect(search.requests).toBeLessThanOrEqual(4);
    const skill = await walk({ skill: 'campaign_analysis' });
    expect(skill.seen).toHaveLength(600);
  });
});
