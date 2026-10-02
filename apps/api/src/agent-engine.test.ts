import type { AgentNotification, OrganizationId, SpecialistId, UserId } from '@melonoffice/domain';
import { notificationIdOf } from '@melonoffice/agents';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * The Agent Engine block over HTTP (ADR-0117): an agent's work settings and own memory, a task's
 * trace, the person's in-app notices and GIA's summary of a plan. Every case runs on memory and,
 * in CI, on the Firestore emulator; every one checks another organization's person.
 */

interface Body {
  readonly [key: string]: unknown;
  readonly id?: string;
  readonly error?: string;
  readonly field?: string | null;
  readonly version?: number;
  readonly organization?: { readonly id: string };
}

describe.each(STORES)('agent engine with storage in %s', (_name, createStores) => {
  async function setup() {
    const stores: Stores = createStores();
    const ctx = setupApp(stores);
    const alice = await ctx.register('token-alice');
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
      const text = await response.text();
      return {
        status: response.status,
        body: (text === '' ? {} : JSON.parse(text)) as Body,
      };
    };
    const orgOf = async (token: string, name: string) =>
      (await call(token, 'POST', '/v1/organizations', { name })).body.organization?.id as string;
    const orgA = await orgOf('token-alice', 'A');
    const orgB = await orgOf('token-bob', 'B');
    const base = (org: string) => `/v1/organizations/${org}`;
    const agent = async () => {
      const created = (
        await call('token-alice', 'POST', `${base(orgA)}/specialists`, {
          templateId: 'marketing',
          displayName: 'Mara',
        })
      ).body;
      await call('token-alice', 'POST', `${base(orgA)}/specialists/${created.id}/status`, {
        from: 'draft',
        to: 'active',
      });
      return (await call('token-alice', 'GET', `${base(orgA)}/specialists/${created.id}`)).body;
    };
    return { ...ctx, stores, call, orgA, orgB, base, agent, alice };
  }

  it('switches an agent’s memory on as a new version, and keeps and forgets its notes', async () => {
    const t = await setup();
    const mara = await t.agent();
    const path = `${t.base(t.orgA)}/specialists/${mara.id}`;
    expect(mara.work).toEqual({ memory: false, aiVerification: false, collaboration: false });
    const on = await t.call('token-alice', 'POST', `${path}/settings`, {
      fromVersion: mara.version,
      memory: true,
    });
    expect(on.status).toBe(200);
    expect(on.body).toMatchObject({
      version: (mara.version ?? 0) + 1,
      work: { memory: true, aiVerification: false, collaboration: false },
    });
    expect(
      (await t.call('token-alice', 'POST', `${path}/settings`, { fromVersion: 9, nope: true }))
        .body,
    ).toMatchObject({ error: 'invalid_specialist' });
    const added = await t.call('token-alice', 'POST', `${path}/memories`, {
      text: 'Prefieren mensajes cortos',
    });
    expect(added.status).toBe(201);
    expect(
      (await t.call('token-alice', 'POST', `${path}/memories`, { text: 'password: 1234' })).body,
    ).toEqual({ error: 'invalid_memory', field: 'secret' });
    expect((await t.call('token-alice', 'GET', `${path}/memories`)).body).toMatchObject({
      enabled: true,
      items: [{ id: added.body.id, text: 'Prefieren mensajes cortos', source: 'person' }],
    });
    // Another organization's person finds no such agent.
    const theirs = `${t.base(t.orgB)}/specialists/${mara.id}`;
    expect((await t.call('token-bob', 'GET', `${theirs}/memories`)).status).toBe(404);
    expect((await t.call('token-bob', 'GET', `${path}/memories`)).status).toBe(403);
    expect(
      (await t.call('token-alice', 'DELETE', `${path}/memories/${String(added.body.id)}`)).status,
    ).toBe(204);
    expect((await t.call('token-alice', 'DELETE', `${path}/memories`)).body).toEqual({
      deleted: 0,
    });
  });

  it('reads a task’s trace, as codes and numbers, only in its organization', async () => {
    const t = await setup();
    const mara = await t.agent();
    const task = await t.call(
      'token-alice',
      'POST',
      `${t.base(t.orgA)}/specialists/${mara.id}/tasks`,
      { request: 'Escribe un post', maxCredits: 5 },
    );
    expect(task.status).toBe(202);
    const trace = await t.call(
      'token-alice',
      'GET',
      `${t.base(t.orgA)}/agent-tasks/${task.body.id}/trace`,
    );
    expect(trace.status).toBe(200);
    expect(trace.body).toMatchObject({
      taskId: task.body.id,
      specialistId: mara.id,
      credits: { task: 0, review: 0, subtasks: 0, total: 0, budget: 5, remaining: 5 },
      handoff: null,
      subtasks: [],
    });
    expect(JSON.stringify(trace.body)).not.toContain('Escribe un post');
    expect(
      (await t.call('token-bob', 'GET', `${t.base(t.orgB)}/agent-tasks/${task.body.id}/trace`))
        .status,
    ).toBe(404);
  });

  it('lists only the person’s own notices and lets only them mark them read', async () => {
    const t = await setup();
    const empty = await t.call('token-alice', 'GET', `${t.base(t.orgA)}/notifications`);
    expect(empty.body).toEqual({ notifications: [], nextCursor: null, unread: 0 });
    const at = new Date();
    const notice: AgentNotification = {
      id: notificationIdOf(at, 'k-1'),
      organizationId: t.orgA as OrganizationId,
      recipientId: t.alice as UserId,
      kind: 'task_finished',
      specialistId: 'spec_x' as SpecialistId,
      taskId: 'task-1',
      code: null,
      otherSpecialistId: null,
      createdAt: at.toISOString() as AgentNotification['createdAt'],
      readAt: null,
      expiresAt: new Date(
        at.getTime() + 86_400_000,
      ).toISOString() as AgentNotification['expiresAt'],
    };
    await t.stores.agentNotifications.put(notice);
    const listed = await t.call('token-alice', 'GET', `${t.base(t.orgA)}/notifications`);
    expect(listed.body).toMatchObject({
      unread: 1,
      notifications: [{ id: notice.id, kind: 'task_finished', taskId: 'task-1', read: false }],
    });
    // Bob, in his organization, neither sees nor marks it.
    expect(
      (await t.call('token-bob', 'GET', `${t.base(t.orgB)}/notifications`)).body,
    ).toMatchObject({ notifications: [], unread: 0 });
    expect(
      (await t.call('token-bob', 'POST', `${t.base(t.orgB)}/notifications/${notice.id}/read`))
        .status,
    ).toBe(404);
    expect(
      (await t.call('token-alice', 'POST', `${t.base(t.orgA)}/notifications/${notice.id}/read`))
        .status,
    ).toBe(204);
    expect(
      (await t.call('token-alice', 'GET', `${t.base(t.orgA)}/notifications`)).body.unread,
    ).toBe(0);
    expect(
      (await t.call('token-alice', 'POST', `${t.base(t.orgA)}/notifications/read`)).body,
    ).toEqual({ marked: 0 });
  });

  it('GIA summarizes only a plan the person may read', async () => {
    const t = await setup();
    const summary = await t.call(
      'token-alice',
      'POST',
      `${t.base(t.orgA)}/gia/plans/00000000-0000-4000-8000-000000000000/summary`,
      { requestKey: 'summary-key-1' },
    );
    // A plan that is not there (or another organization's) is not found; nothing is asked.
    expect(summary).toEqual({ status: 404, body: { error: 'plan_not_found' } });
    expect(
      (
        await t.call(
          'token-bob',
          'POST',
          `${t.base(t.orgA)}/gia/plans/00000000-0000-4000-8000-000000000000/summary`,
          { requestKey: 'summary-key-1' },
        )
      ).status,
    ).toBe(403);
  });
});
