import { ROLES, createAuthorizationService, type Permission } from '@melonoffice/rbac';
import { contactRef } from '@melonoffice/agents';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * Agent tasks over HTTP (ADR-0063): a person asks an agent for a task, and reads the agent's
 * tasks and a task with its answer. Asking needs `specialist.task`; reading `specialist.read`.
 * The API creates, starts and queues the task; the worker runs it (its tests are the worker's).
 */
interface Task {
  readonly id: string;
  readonly specialistId: string;
  readonly request: string;
  readonly status: string;
  readonly failure: string | null;
  readonly answer: {
    readonly answer: string;
    readonly missing: readonly string[];
    readonly facts?: number;
    readonly followUp?: Record<string, unknown> | null;
  } | null;
}
interface Body {
  readonly [key: string]: unknown;
  readonly id?: string;
  readonly error?: string;
  readonly field?: string;
  readonly organization?: { readonly id: string };
  readonly tasks?: readonly Task[];
  readonly nextCursor?: string | null;
}

describe.each(STORES)('agent tasks with storage in %s', (_name, createStores) => {
  async function setup(options: { readonly without?: readonly Permission[] } = {}) {
    const stores: Stores = createStores();
    const ctx = setupApp(
      stores,
      options.without === undefined
        ? undefined
        : createAuthorizationService({
            ...ROLES,
            owner: ROLES.owner.filter((p) => !(options.without ?? []).includes(p)),
          }),
    );
    await ctx.register('token-alice');
    await ctx.register('token-bob');
    const call = async (token: string, method: string, path: string, body?: unknown) => {
      const response = await ctx.app.request(
        path,
        ctx.as(token, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        }),
      );
      return { status: response.status, body: (await response.json()) as Body & Partial<Task> };
    };
    const orgOf = async (token: string, name: string) =>
      (await call(token, 'POST', '/v1/organizations', { name })).body.organization?.id as string;
    const orgA = await orgOf('token-alice', 'A');
    const orgB = await orgOf('token-bob', 'B');
    const base = (org: string) => `/v1/organizations/${org}`;
    const agent = async (token = 'token-alice', org = orgA) => {
      const created = await call(token, 'POST', `${base(org)}/specialists`, {
        templateId: 'commercial',
        displayName: 'Lucía',
      });
      const id = created.body.id as string;
      await call(token, 'POST', `${base(org)}/specialists/${id}/status`, {
        from: 'draft',
        to: 'active',
      });
      return id;
    };
    return { ...ctx, stores, call, orgA, orgB, base, agent };
  }

  it('asks an agent for a task: stored, started and queued once, then read back', async () => {
    const { call, orgA, base, agent, kicked } = await setup();
    const id = await agent();
    const asked = await call('token-alice', 'POST', `${base(orgA)}/specialists/${id}/tasks`, {
      request: 'Resume las oportunidades abiertas',
      idempotencyKey: 'k-1',
    });
    expect(asked.status).toBe(202);
    expect(asked.body).toMatchObject({
      specialistId: id,
      request: 'Resume las oportunidades abiertas',
      status: 'running',
      failure: null,
      answer: null,
    });
    const again = await call('token-alice', 'POST', `${base(orgA)}/specialists/${id}/tasks`, {
      request: 'Resume las oportunidades abiertas',
      idempotencyKey: 'k-1',
    });
    expect(again.status).toBe(202);
    expect(again.body.id).toBe(asked.body.id);
    expect(kicked).toEqual([asked.body.id, asked.body.id]);

    const read = await call('token-alice', 'GET', `${base(orgA)}/agent-tasks/${asked.body.id}`);
    expect(read.status).toBe(200);
    expect(read.body).toMatchObject({ id: asked.body.id, status: 'running', answer: null });

    const conflict = await call('token-alice', 'POST', `${base(orgA)}/specialists/${id}/tasks`, {
      request: 'Otra cosa',
      idempotencyKey: 'k-1',
    });
    expect(conflict).toEqual({ status: 409, body: { error: 'idempotency_conflict' } });
  });

  it('shows the answer only once the task completed and passed its verification', async () => {
    const { call, orgA, base, agent, stores, agentOutputs } = await setup();
    const id = await agent();
    const asked = await call('token-alice', 'POST', `${base(orgA)}/specialists/${id}/tasks`, {
      request: 'Hola',
    });
    const taskId = asked.body.id as string;
    // What the worker would have done: kept the answer, verified it and completed the task.
    await agentOutputs.save({
      organizationId: orgA as never,
      executionId: taskId as never,
      nodeId: 'work' as never,
      requestId: 'req-1',
      output: { structured: { answer: 'Tienes 3 oportunidades abiertas.', missing: [] } },
      createdAt: new Date().toISOString() as never,
    });
    const running = await call('token-alice', 'GET', `${base(orgA)}/agent-tasks/${taskId}`);
    expect(running.body.answer).toBeNull();
    await stores.executions.update(orgA as never, taskId as never, (current) => ({
      execution: {
        ...current,
        status: 'completed',
        nodes: current.nodes.map((n) => ({ ...n, status: 'completed' as const })),
        completedAt: new Date().toISOString() as never,
        revision: current.revision + 1,
      },
      events: [],
    }));
    const done = await call('token-alice', 'GET', `${base(orgA)}/agent-tasks/${taskId}`);
    expect(done.body).toMatchObject({
      status: 'completed',
      answer: { answer: 'Tienes 3 oportunidades abiertas.', missing: [] },
    });
  });

  it('shows the follow-up the agent proposed, where it stands, and the answer meanwhile (ADR-0084)', async () => {
    const { call, orgA, base, agent, stores, agentOutputs } = await setup();
    const id = await agent();
    const juan = (
      await call('token-alice', 'POST', `${base(orgA)}/customers`, {
        displayName: 'Juan Pérez',
        phone: '+51999888777',
      })
    ).body.id as string;
    const asked = await call('token-alice', 'POST', `${base(orgA)}/specialists/${id}/tasks`, {
      request: 'Llama a Juan mañana a las 10',
    });
    const taskId = asked.body.id as string;
    await agentOutputs.save({
      organizationId: orgA as never,
      executionId: taskId as never,
      nodeId: 'work' as never,
      requestId: 'req-1',
      output: {
        structured: {
          answer: 'Te propongo llamar a Juan.',
          missing: [],
          followUp: {
            contact: contactRef(juan),
            type: 'call',
            title: 'Llamar a Juan',
            date: '2026-09-30',
            time: '10:00',
          },
          facts: [],
        },
      },
      createdAt: new Date().toISOString() as never,
    });
    const set = (status: string, schedule: Record<string, unknown>, failure?: string) =>
      stores.executions.update(orgA as never, taskId as never, (current) => ({
        execution: {
          ...current,
          status: status as never,
          nodes: current.nodes.map((n) =>
            n.id === 'work' ? { ...n, status: 'completed' as const } : { ...n, ...schedule },
          ),
          ...(failure === undefined ? {} : { failure: { code: failure } as never }),
          revision: current.revision + 1,
        },
        events: [],
      }));
    const read = async () =>
      (await call('token-alice', 'GET', `${base(orgA)}/agent-tasks/${taskId}`)).body;

    // A real approval id: the Firestore store checks it is a UUID before trusting the record.
    const approvalId = '0a0a0a0a-0000-4000-8000-00000000000a';
    await set('waiting_approval', { approvalId });
    const waiting = await read();
    expect(waiting.answer).toEqual({
      answer: 'Te propongo llamar a Juan.',
      missing: [],
      facts: 0,
      followUp: {
        contactId: juan,
        contactName: 'Juan Pérez',
        type: 'call',
        title: 'Llamar a Juan',
        date: '2026-09-30',
        time: '10:00',
        state: 'waiting_approval',
        approvalId,
      },
    });
    await set('failed', { status: 'pending' }, 'approval_rejected');
    const rejected = await read();
    expect(rejected.answer?.answer).toBe('Te propongo llamar a Juan.');
    expect(rejected.answer?.followUp).toMatchObject({ state: 'rejected', approvalId: null });
    await set('completed', { status: 'completed' });
    expect((await read()).answer?.followUp).toMatchObject({ state: 'scheduled' });
  });

  it('refuses malformed requests with the field, and inactive or unknown agents', async () => {
    const { call, orgA, base, agent } = await setup();
    const id = await agent();
    const post = (body: unknown, to = id) =>
      call('token-alice', 'POST', `${base(orgA)}/specialists/${to}/tasks`, body);
    expect(await post({ request: '' })).toEqual({
      status: 400,
      body: { error: 'invalid_task', field: 'request' },
    });
    expect(await post({ request: 'Hola', tools: ['x'] })).toEqual({
      status: 400,
      body: { error: 'invalid_task', field: 'tools' },
    });
    expect((await post({ request: 'Hola' }, 'nope')).status).toBe(404);
    await call('token-alice', 'POST', `${base(orgA)}/specialists/${id}/status`, {
      from: 'active',
      to: 'paused',
    });
    expect(await post({ request: 'Hola' })).toEqual({
      status: 409,
      body: { error: 'specialist_not_available' },
    });
  });

  it('lists an agent’s tasks a page at a time', async () => {
    const { call, orgA, base, agent } = await setup();
    const id = await agent();
    for (const request of ['uno', 'dos', 'tres']) {
      await call('token-alice', 'POST', `${base(orgA)}/specialists/${id}/tasks`, { request });
      // Newest first is by creation time: two tasks created in the same millisecond tie, and
      // their order is then the ids', not the order they were asked in.
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    const first = await call('token-alice', 'GET', `${base(orgA)}/specialists/${id}/tasks?limit=2`);
    expect(first.status).toBe(200);
    expect(first.body.tasks?.map((t) => t.request)).toEqual(['tres', 'dos']);
    const cursor = first.body.nextCursor as string;
    const second = await call(
      'token-alice',
      'GET',
      `${base(orgA)}/specialists/${id}/tasks?limit=2&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(second.body.tasks?.map((t) => t.request)).toEqual(['uno']);
    expect(second.body.nextCursor).toBeNull();
    for (const bad of ['limit=0', 'limit=51', 'limit=abc', 'cursor=zzz']) {
      const got = await call('token-alice', 'GET', `${base(orgA)}/specialists/${id}/tasks?${bad}`);
      expect(got.status).toBe(400);
    }
  });

  it('keeps every organization’s agents and tasks apart', async () => {
    const { call, orgA, orgB, base, agent } = await setup();
    const id = await agent();
    const asked = await call('token-alice', 'POST', `${base(orgA)}/specialists/${id}/tasks`, {
      request: 'Hola',
    });
    // Bob, in his own organization, cannot reach Alice's agent or task.
    expect(
      (await call('token-bob', 'POST', `${base(orgB)}/specialists/${id}/tasks`, { request: 'x' }))
        .status,
    ).toBe(404);
    expect(
      (await call('token-bob', 'GET', `${base(orgB)}/agent-tasks/${asked.body.id}`)).status,
    ).toBe(404);
    expect((await call('token-bob', 'GET', `${base(orgB)}/specialists/${id}/tasks`)).status).toBe(
      404,
    );
    // Nor by naming her organization.
    expect(
      (await call('token-bob', 'GET', `${base(orgA)}/agent-tasks/${asked.body.id}`)).status,
    ).toBe(403);
  });

  it('asking needs specialist.task and reading specialist.read', async () => {
    const noTask = await setup({ without: ['specialist.task'] });
    const id = await noTask.agent();
    const refused = await noTask.call(
      'token-alice',
      'POST',
      `${noTask.base(noTask.orgA)}/specialists/${id}/tasks`,
      { request: 'Hola' },
    );
    expect(refused.status).toBe(403);
    expect(noTask.kicked).toHaveLength(0);

    const noRead = await setup({ without: ['specialist.read'] });
    const other = await noRead.agent();
    const listed = await noRead.call(
      'token-alice',
      'GET',
      `${noRead.base(noRead.orgA)}/specialists/${other}/tasks`,
    );
    expect(listed.status).toBe(403);
  });
});
