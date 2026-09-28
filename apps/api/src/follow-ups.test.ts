import { createAuthorizationService } from '@melonoffice/rbac';
import {
  createFollowUpService,
  localDateTime,
  plusDays,
  type FollowUpScheduler,
  type FollowUpTask,
} from '@melonoffice/conversations';
import type { OrganizationId, UserId } from '@melonoffice/domain';
import { resolveTenant } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

const LIMA = 'America/Lima';

describe.each(STORES)('follow-ups (C5) with storage in %s', (_name, createStores) => {
  async function setup(
    options: {
      readOnly?: boolean;
      scheduler?: FollowUpScheduler | null;
    } = {},
  ) {
    const stores: Stores = createStores();
    const ctx = setupApp(
      stores,
      options.readOnly
        ? createAuthorizationService({
            owner: ['follow_up.read', 'contact.read', 'contact.manage'],
          })
        : undefined,
      undefined,
      undefined,
      undefined,
      options.scheduler === undefined ? {} : { followUpScheduler: options.scheduler },
    );
    const alice = (await ctx.register('token-alice')) as UserId;
    await ctx.register('token-bob');
    const call = async (token: string, path: string, init: RequestInit = {}) => {
      const response = await ctx.app.request(path, ctx.as(token, init));
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const send = (token: string, method: string, path: string, body: unknown) =>
      call(token, path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
    const create = async (token: string, name: string) =>
      (
        (await send(token, 'POST', '/v1/organizations', { name })).body as {
          organization: { id: string };
        }
      ).organization.id as OrganizationId;
    const orgA = await create('token-alice', 'Pollería A');
    const orgB = await create('token-bob', 'Tienda B');
    const base = (org: string) => `/v1/organizations/${org}`;
    const contact = async (org: string, phone: string, token = 'token-alice') =>
      (await send(token, 'POST', `${base(org)}/customers`, { displayName: 'Juan Pérez', phone }))
        .body.id as string;
    const tomorrow = plusDays(localDateTime(new Date(), LIMA).date, 1);
    let keys = 0;
    const followUp = (contactId: string, extra: Record<string, unknown> = {}) => ({
      requestKey: `key-api-${String(++keys).padStart(4, '0')}`,
      contactId,
      type: 'call',
      title: 'Llamar a Juan',
      date: tomorrow,
      time: '10:00',
      ...extra,
    });
    return { ...ctx, stores, alice, orgA, orgB, call, send, base, contact, followUp, tomorrow };
  }

  it('schedules from a contact, lists it, mirrors its next action and refreshes Company Brain', async () => {
    const t = await setup();
    const contactId = await t.contact(t.orgA, '+51911111111');
    const request = t.followUp(contactId);
    const created = await t.send('token-alice', 'POST', `${t.base(t.orgA)}/follow-ups`, request);
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      created: true,
      contactId,
      opportunityId: null,
      assignee: 'you',
      type: 'call',
      title: 'Llamar a Juan',
      date: t.tomorrow,
      time: '10:00',
      timeZone: LIMA,
      when: 'upcoming',
      status: 'scheduled',
      source: 'manual',
      createdBy: 'you',
    });
    const id = created.body.id as string;
    // One task for its time, with codes only.
    expect(t.scheduled).toHaveLength(1);
    expect(t.scheduled[0]?.task).toEqual({ organizationId: t.orgA, followUpId: id, schedule: 1 });
    expect(t.scheduled[0]?.at.toISOString()).toBe(created.body.scheduledAt);
    // The same request again is the same follow-up, not a second one.
    const again = await t.send('token-alice', 'POST', `${t.base(t.orgA)}/follow-ups`, request);
    expect(again).toMatchObject({ status: 200, body: { id, created: false } });
    // Its task is queued again, the same one (a repeat does nothing when it arrives).
    expect(t.scheduled).toHaveLength(2);
    expect(t.scheduled[1]?.task).toEqual(t.scheduled[0]?.task);
    // A time zone in the request is refused: it is always the business's.
    expect(
      await t.send('token-alice', 'POST', `${t.base(t.orgA)}/follow-ups`, {
        ...t.followUp(contactId),
        timeZone: 'Asia/Tokyo',
      }),
    ).toMatchObject({ status: 400, body: { error: 'invalid_request', field: 'timeZone' } });

    const list = await t.call('token-alice', `${t.base(t.orgA)}/follow-ups?open=true`);
    expect(list.body).toMatchObject({ timeZone: LIMA, counts: { open: 1, overdue: 0 } });
    expect(list.body.items).toEqual([expect.objectContaining({ id, contactName: 'Juan Pérez' })]);
    expect((await t.call('token-alice', `${t.base(t.orgA)}/follow-ups/${id}`)).body).toMatchObject({
      id,
      status: 'scheduled',
    });

    // The contact's next action is the follow-up, and only the follow-up changes it.
    const card = await t.call('token-alice', `${t.base(t.orgA)}/customers/${contactId}`);
    expect(card.body).toMatchObject({
      commercial: { nextAction: { text: 'Llamar a Juan', dueOn: t.tomorrow, followUpId: id } },
    });
    expect(
      await t.send('token-alice', 'PATCH', `${t.base(t.orgA)}/customers/${contactId}`, {
        revision: card.body.revision,
        nextAction: { text: 'Otra cosa', dueOn: t.tomorrow },
      }),
    ).toEqual({ status: 409, body: { error: 'next_action_from_follow_up' } });

    // Company Brain keeps totals only: never a name or a title.
    const knowledge = await t.call('token-alice', `${t.base(t.orgA)}/brain/knowledge`);
    const facts = knowledge.body.items as { key: string; value: unknown }[];
    expect(facts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          key: 'open_follow_ups_count',
          value: { type: 'number', number: 1 },
        }),
        expect.objectContaining({
          key: 'overdue_follow_ups_count',
          value: { type: 'number', number: 0 },
        }),
      ]),
    );
    expect(JSON.stringify(facts)).not.toMatch(/Llamar/);

    // Rescheduled, completed: the next action clears.
    const later = plusDays(t.tomorrow, 2);
    const moved = await t.send(
      'token-alice',
      'POST',
      `${t.base(t.orgA)}/follow-ups/${id}/reschedule`,
      { revision: 1, date: later, time: '16:30' },
    );
    expect(moved.body).toMatchObject({ date: later, time: '16:30', revision: 2 });
    expect(t.scheduled.at(-1)?.task.schedule).toBe(2);
    const done = await t.send(
      'token-alice',
      'POST',
      `${t.base(t.orgA)}/follow-ups/${id}/complete`,
      {
        revision: 2,
      },
    );
    expect(done.body).toMatchObject({ status: 'completed', completedBy: 'you' });
    const after = await t.call('token-alice', `${t.base(t.orgA)}/customers/${contactId}`);
    expect((after.body.commercial as { nextAction?: unknown }).nextAction).toBeNull();
    // A stale revision is refused.
    expect(
      await t.send('token-alice', 'POST', `${t.base(t.orgA)}/follow-ups/${id}/cancel`, {
        revision: 1,
      }),
    ).toMatchObject({ status: 409 });
  });

  it('never invents a time and keeps organizations apart', async () => {
    const t = await setup();
    const contactId = await t.contact(t.orgA, '+51922222222');
    const noTime: Record<string, unknown> = { ...t.followUp(contactId), time: undefined };
    expect(
      await t.send('token-alice', 'POST', `${t.base(t.orgA)}/follow-ups`, noTime),
    ).toMatchObject({ status: 400, body: { error: 'invalid_request', field: 'time' } });
    const created = await t.send(
      'token-alice',
      'POST',
      `${t.base(t.orgA)}/follow-ups`,
      t.followUp(contactId),
    );
    const id = created.body.id as string;
    // Bob is not a member of A; and A's follow-up is not in B.
    expect((await t.call('token-bob', `${t.base(t.orgA)}/follow-ups`)).status).toBe(403);
    expect((await t.call('token-bob', `${t.base(t.orgB)}/follow-ups/${id}`)).status).toBe(404);
    expect(
      (await t.send('token-bob', 'POST', `${t.base(t.orgB)}/follow-ups`, t.followUp(contactId)))
        .status,
    ).toBe(404);
    expect((await t.call('token-bob', `${t.base(t.orgB)}/follow-ups`)).body.items).toEqual([]);
  });

  it('refuses changes to a role that may only read them', async () => {
    const t = await setup({ readOnly: true });
    const contactId = await t.contact(t.orgA, '+51933333333');
    expect(
      await t.send('token-alice', 'POST', `${t.base(t.orgA)}/follow-ups`, t.followUp(contactId)),
    ).toMatchObject({ status: 403 });
    expect((await t.call('token-alice', `${t.base(t.orgA)}/follow-ups`)).status).toBe(200);
  });

  it('creates nothing without a scheduler, and keeps one it could not queue as failed', async () => {
    const none = await setup({ scheduler: null });
    const c1 = await none.contact(none.orgA, '+51944444444');
    expect(
      await none.send(
        'token-alice',
        'POST',
        `${none.base(none.orgA)}/follow-ups`,
        none.followUp(c1),
      ),
    ).toEqual({ status: 503, body: { error: 'follow_up_scheduler_unavailable' } });
    expect(
      (await none.call('token-alice', `${none.base(none.orgA)}/follow-ups`)).body.items,
    ).toEqual([]);

    const down = await setup({
      scheduler: {
        schedule: async () => {
          throw new Error('queue down');
        },
      },
    });
    const c2 = await down.contact(down.orgA, '+51955555555');
    expect(
      await down.send(
        'token-alice',
        'POST',
        `${down.base(down.orgA)}/follow-ups`,
        down.followUp(c2),
      ),
    ).toEqual({ status: 503, body: { error: 'follow_up_not_scheduled' } });
    const list = await down.call('token-alice', `${down.base(down.orgA)}/follow-ups`);
    expect(list.body.items).toEqual([
      expect.objectContaining({ status: 'failed', failure: 'not_scheduled' }),
    ]);
  });

  it('when its time comes, the runtime marks it due and the office activity shows it', async () => {
    const t = await setup();
    const contactId = await t.contact(t.orgA, '+51966666666');
    // Scheduled half an hour ago, from an hour ago: as the worker would find it now.
    const real = Date.now();
    const at = localDateTime(new Date(real - 30 * 60_000), LIMA);
    const scheduled: { task: FollowUpTask; at: Date }[] = [];
    const service = (now: number) =>
      createFollowUpService({
        repository: t.stores.conversations,
        organizations: t.stores.tenancy,
        authorization: createAuthorizationService(),
        timeZone: async () => LIMA,
        scheduler: { schedule: async (task, when) => void scheduled.push({ task, at: when }) },
        now: () => new Date(now),
      });
    const tenant = await resolveTenant(
      Object.freeze({ actor: 'user' as const, userId: t.alice, emailVerified: true }),
      t.orgA,
      t.stores.tenancy,
    );
    const { followUp } = await service(real - 60 * 60_000).create(tenant, {
      requestKey: 'key-api-due-0001',
      contactId,
      type: 'call',
      title: 'Llamar a Juan',
      date: at.date,
      time: at.time,
    });
    const task = scheduled[0]?.task as FollowUpTask;
    expect(await service(real).runDue(task)).toMatchObject({ kind: 'due' });
    // The same task again changes nothing.
    expect(await service(real).runDue(task)).toMatchObject({ kind: 'stale' });

    const one = await t.call('token-alice', `${t.base(t.orgA)}/follow-ups/${followUp.id}`);
    expect(one.body).toMatchObject({ status: 'due', when: 'today' });
    const activity = await t.call('token-alice', `${t.base(t.orgA)}/activity?period=today`);
    const items = activity.body.items as { action: string; actor: string; link?: unknown }[];
    expect(items).toContainEqual(
      expect.objectContaining({
        action: 'follow_up.due',
        actor: 'system',
        link: { kind: 'follow_up', id: followUp.id },
      }),
    );
    // Nothing was sent to the contact.
    expect(t.meta.calls).toEqual([]);
  });
});
