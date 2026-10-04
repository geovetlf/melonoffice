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
    const agent = async (token = 'token-alice', org = orgA, displayName = 'Lucía') => {
      const created = await call(token, 'POST', `${base(org)}/specialists`, {
        templateId: 'commercial',
        displayName,
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

  it('shows the follow-up the agent asked for with its own tool before it answered (ADR-0104)', async () => {
    const { call, orgA, base, agent, stores, agentOutputs } = await setup();
    const id = await agent();
    // A person moves the commercial agent to customer_follow_up@3.
    const upgraded = await call(
      'token-alice',
      'POST',
      `${base(orgA)}/specialists/${id}/skills/upgrade`,
      {
        fromVersion: 1,
        skillId: 'customer_follow_up',
        version: 3,
      },
    );
    expect(upgraded.status).toBe(200);
    const juan = (
      await call('token-alice', 'POST', `${base(orgA)}/customers`, {
        displayName: 'Juan Pérez',
        phone: '+51999888777',
      })
    ).body.id as string;
    const asked = await call('token-alice', 'POST', `${base(orgA)}/specialists/${id}/tasks`, {
      request: 'Agenda una llamada con Juan mañana a las 10',
    });
    const taskId = asked.body.id as string;
    // What the worker would have done: kept the model's tool call with the turn, and added the
    // tool's node, waiting on a person.
    const args = {
      contact: contactRef(juan),
      type: 'call',
      title: 'Llamar a Juan',
      date: '2026-09-30',
      time: '10:00',
    };
    await agentOutputs.save({
      organizationId: orgA as never,
      executionId: taskId as never,
      nodeId: 'work' as never,
      requestId: 'req-1',
      output: { toolCalls: [{ id: 'call_0', name: 'follow_up_schedule', arguments: args }] },
      createdAt: new Date().toISOString() as never,
    });
    const approvalId = '0a0a0a0a-0000-4000-8000-00000000000b';
    const set = (status: string, tool: Record<string, unknown>, failure?: string) =>
      stores.executions.update(orgA as never, taskId as never, (current) => {
        const work = current.nodes.find((n) => n.id === 'work');
        const others = current.nodes.filter((n) => n.id !== 'work' && n.id !== 'work_t0');
        return {
          execution: {
            ...current,
            status: status as never,
            nodes: [
              { ...(work as object), status: 'completed' as const } as never,
              {
                ...(work as object),
                id: 'work_t0',
                type: 'tool',
                label: 'follow_up_schedule',
                tool: { id: 'follow_up_schedule', version: 3 },
                input: { type: 'model_tool_call', id: 'work:0' },
                dependsOn: ['work'],
                approvalRequired: true,
                status: 'pending',
                ...tool,
              } as never,
              ...others,
            ],
            ...(failure === undefined ? {} : { failure: { code: failure } as never }),
            revision: current.revision + 1,
          },
          events: [],
        };
      });
    const read = async () =>
      (await call('token-alice', 'GET', `${base(orgA)}/agent-tasks/${taskId}`)).body;

    await set('waiting_approval', { approvalId });
    const waiting = await read();
    expect(waiting.answer).toBeNull();
    expect(waiting.toolFollowUp).toEqual({
      contactId: juan,
      contactName: 'Juan Pérez',
      type: 'call',
      title: 'Llamar a Juan',
      date: '2026-09-30',
      time: '10:00',
      state: 'waiting_approval',
      approvalId,
    });
    await set('failed', { status: 'cancelled' }, 'approval_rejected');
    expect((await read()).toolFollowUp).toMatchObject({ state: 'rejected', approvalId: null });
    await set('running', { status: 'completed' });
    expect((await read()).toolFollowUp).toMatchObject({ state: 'scheduled' });
    // Bob reads nothing of it.
    expect((await call('token-bob', 'GET', `${base(orgA)}/agent-tasks/${taskId}`)).status).toBe(
      403,
    );
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

  describe('every agent’s tasks, read only (ADR-0148)', () => {
    interface Listed {
      readonly id: string;
      readonly agent: {
        readonly id: string;
        readonly name: string | null;
        readonly status: string | null;
      };
      readonly request: string;
      readonly status: string;
      readonly failure: string | null;
      readonly createdAt: string;
      readonly updatedAt: string | null;
      readonly progress: { readonly done: number; readonly total: number };
      readonly steps: readonly { readonly type: string; readonly status: string }[];
      readonly plan: { readonly id: string } | null;
      readonly result: {
        readonly summary: string;
        readonly truncated: boolean;
        readonly missing: number;
      } | null;
    }
    interface ListBody {
      readonly tasks: readonly Listed[];
      readonly agents: readonly { readonly id: string; readonly name: string }[];
      readonly statuses: readonly string[];
      readonly period: { readonly from: string; readonly to: string } | null;
      readonly nextCursor: string | null;
      readonly error?: string;
      readonly field?: string;
    }
    async function world() {
      const t = await setup();
      const lucia = await t.agent();
      const mario = await t.agent('token-alice', t.orgA, 'Mario');
      const bobs = await t.agent('token-bob', t.orgB, 'Beto');
      const ask = async (id: string, request: string, token = 'token-alice', org = t.orgA) => {
        const asked = await t.call(token, 'POST', `${t.base(org)}/specialists/${id}/tasks`, {
          request,
        });
        // Newest first is by creation time: tasks of the same millisecond would tie.
        await new Promise((resolve) => setTimeout(resolve, 5));
        return asked.body.id as string;
      };
      const list = async (query = '', token = 'token-alice', org = t.orgA) => {
        const got = await t.call(token, 'GET', `${t.base(org)}/agent-tasks${query}`);
        return { status: got.status, body: got.body as unknown as ListBody };
      };
      return { ...t, lucia, mario, bobs, ask, list };
    }

    it('lists nothing for an organization where no agent was asked anything', async () => {
      const t = await world();
      const { status, body } = await t.list();
      expect(status).toBe(200);
      expect(body.tasks).toEqual([]);
      expect(body.nextCursor).toBeNull();
      expect(body.agents.map((a) => a.name)).toEqual(['Lucía', 'Mario']);
      expect(body.statuses).toEqual(expect.arrayContaining(['running', 'completed', 'failed']));
    });

    it('shows one task with its agent, state, dates, progress and steps', async () => {
      const t = await world();
      const id = await t.ask(t.lucia, 'Resume las ventas');
      const { body } = await t.list();
      expect(body.tasks).toHaveLength(1);
      expect(body.tasks[0]).toMatchObject({
        id,
        agent: { id: t.lucia, name: 'Lucía', status: 'active' },
        request: 'Resume las ventas',
        status: 'running',
        failure: null,
        plan: null,
        result: null,
      });
      expect(body.tasks[0]?.updatedAt).not.toBeNull();
      expect(body.tasks[0]?.progress.total).toBeGreaterThan(0);
      expect(body.tasks[0]?.steps.length).toBe(body.tasks[0]?.progress.total);
    });

    it('lists every agent’s tasks newest first, a page at a time, never another organization’s', async () => {
      const t = await world();
      for (const [id, request] of [
        [t.lucia, 'uno'],
        [t.mario, 'dos'],
        [t.lucia, 'tres'],
        [t.mario, 'cuatro'],
      ] as const) {
        await t.ask(id, request);
      }
      await t.ask(t.bobs, 'ajena', 'token-bob', t.orgB);
      const first = await t.list('?limit=3');
      expect(first.body.tasks.map((x) => [x.request, x.agent.name])).toEqual([
        ['cuatro', 'Mario'],
        ['tres', 'Lucía'],
        ['dos', 'Mario'],
      ]);
      const second = await t.list(
        `?limit=3&cursor=${encodeURIComponent(first.body.nextCursor as string)}`,
      );
      expect(second.body.tasks.map((x) => x.request)).toEqual(['uno']);
      expect(second.body.nextCursor).toBeNull();
      expect(JSON.stringify((await t.list()).body)).not.toContain('ajena');
      expect((await t.list('', 'token-bob', t.orgB)).body.tasks.map((x) => x.request)).toEqual([
        'ajena',
      ]);
      // Naming another organization is refused.
      expect((await t.list('', 'token-bob', t.orgA)).status).toBe(403);
    });

    it('narrows by agent, state and days on the server, and refuses what is not one', async () => {
      const t = await world();
      const one = await t.ask(t.lucia, 'uno');
      await t.ask(t.mario, 'dos');
      await t.stores.executions.update(t.orgA as never, one as never, (current) => ({
        execution: { ...current, status: 'cancelled', revision: current.revision + 1 },
        events: [],
      }));
      expect((await t.list(`?agent=${t.mario}`)).body.tasks.map((x) => x.request)).toEqual(['dos']);
      // Another organization's agent narrows to nothing.
      expect((await t.list(`?agent=${t.bobs}`)).body.tasks).toEqual([]);
      const cancelled = (await t.list('?status=cancelled')).body.tasks;
      expect(cancelled.map((x) => [x.request, x.status])).toEqual([['uno', 'cancelled']]);
      const past = await t.list('?from=2020-01-01&to=2020-01-31');
      expect(past.body.tasks).toEqual([]);
      expect(past.body.period).toEqual({ from: '2020-01-01', to: '2020-01-31' });
      for (const [query, field] of [
        ['?status=stuck', 'status'],
        ['?from=2026-02-30', 'period'],
        ['?from=2024-01-01&to=2026-01-01', 'period'],
        ['?limit=0', 'limit'],
        ['?limit=51', 'limit'],
        ['?cursor=zzz', 'cursor'],
      ] as const) {
        const got = await t.list(query);
        expect([query, got.status, got.body.field]).toEqual([query, 400, field]);
      }
      // A cursor of one agent's own list is not one of this list.
      await t.ask(t.lucia, 'tres');
      const own = await t.call(
        'token-alice',
        'GET',
        `${t.base(t.orgA)}/specialists/${t.lucia}/tasks?limit=1`,
      );
      const ownCursor = own.body.nextCursor as string;
      expect((await t.list(`?cursor=${encodeURIComponent(ownCursor)}`)).status).toBe(400);
    });

    it('shows a summary of the verified answer only, and nothing internal', async () => {
      const t = await world();
      const id = await t.ask(t.lucia, 'Hola');
      const long = `Tienes 3 oportunidades abiertas. ${'Detalle. '.repeat(60)}`;
      await t.agentOutputs.save({
        organizationId: t.orgA as never,
        executionId: id as never,
        nodeId: 'work' as never,
        requestId: 'req-hidden-41',
        output: { structured: { answer: long, missing: ['Margen'] } },
        createdAt: new Date().toISOString() as never,
      });
      expect((await t.list()).body.tasks[0]?.result).toBeNull();
      await t.stores.executions.update(t.orgA as never, id as never, (current) => ({
        execution: {
          ...current,
          status: 'completed',
          nodes: current.nodes.map((n) => ({ ...n, status: 'completed' as const })),
          completedAt: new Date().toISOString() as never,
          revision: current.revision + 1,
        },
        events: [],
      }));
      const { body } = await t.list();
      const listed = body.tasks[0];
      expect(listed?.status).toBe('completed');
      expect(listed?.progress.done).toBe(listed?.progress.total);
      expect(listed?.result).toMatchObject({ truncated: true, missing: 1 });
      expect(listed?.result?.summary).toHaveLength(280);
      const text = JSON.stringify(body);
      for (const hidden of ['req-hidden-41', 'requestedBy', 'Margen', 'specialistVersion']) {
        expect(text).not.toContain(hidden);
      }
      expect(Object.keys(listed ?? {}).sort()).toEqual([
        'agent',
        'completedAt',
        'createdAt',
        'failure',
        'handedFrom',
        'id',
        'plan',
        'progress',
        'request',
        'result',
        'startedAt',
        'status',
        'steps',
        'updatedAt',
      ]);
    });

    it('offers no way to change a task from the list', async () => {
      const t = await world();
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        const response = await t.app.request(
          `${t.base(t.orgA)}/agent-tasks`,
          t.as('token-alice', { method }),
        );
        expect([method, response.status]).toEqual([method, 404]);
      }
    });
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
    expect(
      (await noRead.call('token-alice', 'GET', `${noRead.base(noRead.orgA)}/agent-tasks`)).status,
    ).toBe(403);
  });
});
