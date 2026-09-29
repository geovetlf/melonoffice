import { InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { openWallet } from '@melonoffice/credits';
import {
  DEFAULT_DEPARTMENT_CATALOGUE,
  InMemoryDepartmentRepository,
  provisionDepartments,
} from '@melonoffice/departments';
import type {
  FollowUp,
  InitialBilling,
  Organization,
  OrganizationId,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import { createAuthorizationService, ROLES, type RoleCatalogue } from '@melonoffice/rbac';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveRuntimeTenant,
  resolveTenant,
} from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { consentAllows, createCustomerService } from './customers.js';
import { ConversationError } from './errors.js';
import { localDateTime, relativeDate, relativeTime, zonedInstant } from './follow-up-time.js';
import {
  createFollowUpService,
  followUpIdFor,
  nextActionFrom,
  type FollowUpScheduler,
  type FollowUpTask,
} from './follow-ups.js';
import { createCommercialInsights } from './insights.js';
import { createOpportunityService } from './opportunities.js';
import { InMemoryConversationRepository } from './repository.js';

/** Monday 28 September 2026, 17:00 UTC = 12:00 in Lima. */
const T0 = new Date('2026-09-28T17:00:00Z');
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const LIMA = 'America/Lima';

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

async function codeOf(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    if (error instanceof ConversationError)
      return `${error.code}${error.detail ? `:${error.detail}` : ''}`;
    throw error;
  }
  return 'accepted';
}

/** A scheduler that records what it was given, and fails when told to. */
function recordingScheduler() {
  const tasks: { task: FollowUpTask; at: string }[] = [];
  let failing = false;
  const scheduler: FollowUpScheduler = {
    async schedule(task, at) {
      if (failing) throw new Error('enqueue_failed');
      tasks.push({ task: { ...task }, at: at.toISOString() });
    },
  };
  return { scheduler, tasks, fail: (value: boolean) => (failing = value) };
}

async function world(options: { roles?: RoleCatalogue; scheduler?: boolean } = {}) {
  let clock = T0.getTime();
  const now = () => new Date(clock);
  const advance = (ms: number) => (clock += ms);
  const audit = new InMemoryAuditStore();
  const tenancy = new InMemoryTenancyStore(
    now,
    audit,
    undefined,
    new InMemoryDepartmentRepository(),
  );
  const setup = {
    billing: BILLING,
    credits: openWallet,
    departments: (o: Organization) => provisionDepartments(o, DEFAULT_DEPARTMENT_CATALOGUE),
  };
  const a = await createOrganization(as(ALICE), { name: 'A' }, tenancy, setup);
  const b = await createOrganization(as(BOB), { name: 'B' }, tenancy, setup);
  const repository = new InMemoryConversationRepository(audit);
  const owner = createAuthorizationService(ROLES);
  const customers = createCustomerService({
    repository,
    organizations: tenancy,
    authorization: owner,
    now,
  });
  const opportunities = createOpportunityService({
    repository,
    organizations: tenancy,
    authorization: owner,
    businessType: async () => 'restaurant',
    currency: async () => 'PEN',
    now,
  });
  const recorder = recordingScheduler();
  const followUps = createFollowUpService({
    repository,
    organizations: tenancy,
    authorization: createAuthorizationService(options.roles ?? ROLES),
    timeZone: async () => LIMA,
    ...(options.scheduler === false ? {} : { scheduler: recorder.scheduler }),
    now,
  });
  const alice = await resolveTenant(as(ALICE), a.organization.id, tenancy);
  const bob = await resolveTenant(as(BOB), b.organization.id, tenancy);
  const juan = await customers.create(alice, { displayName: 'Juan Pérez', phone: '+51911111111' });
  const rosa = await customers.create(alice, { displayName: 'Rosa', phone: '+51922222222' });
  const deal = await opportunities.create(alice, { contactId: rosa.id, title: 'Cena de empresa' });
  return {
    audit,
    repository,
    tenancy,
    customers,
    opportunities,
    followUps,
    recorder,
    now,
    advance,
    alice,
    aliceAsGia: await resolveTenant(as(ALICE, 'gia'), a.organization.id, tenancy),
    runtime: await resolveRuntimeTenant(ALICE, a.organization.id, tenancy),
    bob,
    orgA: a.organization.id,
    orgB: b.organization.id,
    juan,
    rosa,
    deal,
  };
}

let keys = 0;
const key = () => `request-key-${String(++keys).padStart(6, '0')}`;

/** The value a read must have found. */
async function found<T>(read: Promise<T | undefined>): Promise<T> {
  const value = await read;
  if (value === undefined) throw new Error('not found');
  return value;
}

const tomorrowAt10 = (contactId: string, extra: Record<string, unknown> = {}) => ({
  requestKey: key(),
  contactId,
  type: 'call',
  title: 'Llamar a Juan',
  date: '2026-09-29',
  time: '10:00',
  ...extra,
});

const actions = (audit: InMemoryAuditStore, prefix = 'follow_up.') =>
  audit
    .events()
    .filter((e) => e.action.startsWith(prefix))
    .map((e) => e.action);

describe('follow-up times (C5)', () => {
  it('7. reads a local time in the business time zone: 10:00 in Lima is 15:00 UTC', () => {
    expect(zonedInstant('2026-09-29', '10:00', LIMA).toISOString()).toBe(
      '2026-09-29T15:00:00.000Z',
    );
    expect(zonedInstant('2026-09-29', '10:00', 'Asia/Tokyo').toISOString()).toBe(
      '2026-09-29T01:00:00.000Z',
    );
    // A daylight-saving jump: 02:30 does not exist in New York on 8 March 2026.
    expect(
      localDateTime(zonedInstant('2026-03-08', '02:30', 'America/New_York'), 'America/New_York'),
    ).toEqual({
      date: '2026-03-08',
      time: '03:30',
    });
    expect(localDateTime('2026-09-29T15:00:00Z', LIMA)).toEqual({
      date: '2026-09-29',
      time: '10:00',
    });
  });

  it('7b. near midnight, "today" and "tomorrow" are the business’s days, not UTC’s', async () => {
    const w = await world();
    w.advance(11 * 3_600_000 + 40 * 60_000); // 2026-09-29 04:40Z = 2026-09-28 23:40 in Lima
    const today = localDateTime(w.now(), LIMA).date;
    expect(today).toBe('2026-09-28');
    expect(relativeDate('mañana', today)).toBe('2026-09-29');
    const { followUp } = await w.followUps.create(
      w.alice,
      tomorrowAt10(w.juan.id, { date: today, time: '23:50' }),
    );
    expect(followUp.scheduledAt).toBe('2026-09-29T04:50:00.000Z');
    const list = await w.followUps.list(w.alice);
    expect(list.today).toBe('2026-09-28');
    expect(list.counts).toMatchObject({ today: 1, upcoming: 0 });
    // 23:30 Lima is already past: refused, although in UTC it is "tomorrow".
    expect(
      await codeOf(
        w.followUps.create(w.alice, tomorrowAt10(w.juan.id, { date: today, time: '23:30' })),
      ),
    ).toBe('invalid_request:date_in_past');
  });

  it('8. resolves relative dates by fixed rules, never the time', () => {
    const today = '2026-09-28'; // a Monday
    expect(relativeDate('Recuérdame llamar a Juan mañana', today)).toBe('2026-09-29');
    expect(relativeDate('hoy en la tarde', today)).toBe('2026-09-28');
    expect(relativeDate('pasado mañana', today)).toBe('2026-09-30');
    expect(relativeDate('el viernes', today)).toBe('2026-10-02');
    expect(relativeDate('en 3 días', today)).toBe('2026-10-01');
    expect(relativeDate('en tres dias', today)).toBe('2026-10-01');
    expect(relativeDate('la próxima semana', today)).toBe('2026-10-05');
    expect(relativeDate('next friday', today)).toBe('2026-10-02');
    expect(relativeDate('el lunes', today)).toBe('2026-10-05'); // said on a Monday: next week
    expect(relativeDate('a las 10 de la mañana', today)).toBeUndefined();
    expect(relativeDate('llamar a Juan', today)).toBeUndefined();
    expect(relativeTime('mañana a las 10')).toBe('10:00');
    expect(relativeTime('a las 3 de la tarde')).toBe('15:00');
    expect(relativeTime('at 9am')).toBe('09:00');
    expect(relativeTime('10:30')).toBe('10:30');
    expect(relativeTime('al mediodía')).toBe('12:00');
    expect(relativeTime('llama a Juan mañana')).toBeUndefined();
    expect(relativeTime('en 3 días')).toBeUndefined();
  });
});

describe('follow-ups (C5, ADR-0058)', () => {
  it('1–2. a person schedules one for a contact, reads it back, and its task is queued for its time', async () => {
    const w = await world();
    const { followUp, created } = await w.followUps.create(w.alice, tomorrowAt10(w.juan.id));
    expect(created).toBe(true);
    expect(followUp).toMatchObject({
      organizationId: w.orgA,
      contactId: w.juan.id,
      assignedTo: ALICE,
      type: 'call',
      title: 'Llamar a Juan',
      scheduledAt: '2026-09-29T15:00:00.000Z',
      timeZone: LIMA,
      status: 'scheduled',
      source: 'manual',
      schedule: 1,
      revision: 1,
      createdBy: ALICE,
      metadata: { automation: 'manual' },
    });
    expect(await w.followUps.get(w.alice, followUp.id)).toEqual(followUp);
    const list = await w.followUps.list(w.alice);
    expect(list.items.map((f) => f.id)).toEqual([followUp.id]);
    expect(list.counts).toEqual({ overdue: 0, today: 0, upcoming: 1, open: 1 });
    // 15. The existing transport holds the task until its time: nothing polls.
    expect(w.recorder.tasks).toEqual([
      {
        task: { organizationId: w.orgA, followUpId: followUp.id, schedule: 1 },
        at: '2026-09-29T15:00:00.000Z',
      },
    ]);
  });

  it('asks for the time: never assumes one, and refuses the past', async () => {
    const w = await world();
    expect(
      await codeOf(w.followUps.create(w.alice, tomorrowAt10(w.juan.id, { time: undefined }))),
    ).toBe('invalid_request:time');
    expect(
      await codeOf(w.followUps.create(w.alice, tomorrowAt10(w.juan.id, { date: '2026-09-27' }))),
    ).toBe('invalid_request:date_in_past');
    expect(
      await codeOf(w.followUps.create(w.alice, tomorrowAt10(w.juan.id, { date: '2028-01-01' }))),
    ).toBe('invalid_request:date_too_far');
    expect(
      await codeOf(w.followUps.create(w.alice, tomorrowAt10(w.juan.id, { type: 'email_blast' }))),
    ).toBe('invalid_request:type');
    expect(
      await codeOf(w.followUps.create(w.alice, tomorrowAt10(w.juan.id, { timeZone: 'Mars/Base' }))),
    ).toBe('invalid_request:timeZone');
    // The business's zone only: a zone sent in the request is refused, even a real one.
    expect(
      await codeOf(
        w.followUps.create(w.alice, tomorrowAt10(w.juan.id, { timeZone: 'Asia/Tokyo' })),
      ),
    ).toBe('invalid_request:timeZone');
    expect(w.recorder.tasks).toEqual([]);
  });

  it('3. changes its details against its revision, audited without the values', async () => {
    const w = await world();
    const { followUp } = await w.followUps.create(w.alice, tomorrowAt10(w.juan.id));
    const changed = await w.followUps.update(w.alice, followUp.id, {
      revision: 1,
      title: 'Llamar a Juan por la cotización',
      type: 'follow_up',
    });
    expect(changed).toMatchObject({ revision: 2, type: 'follow_up', schedule: 1 });
    expect(
      await codeOf(w.followUps.update(w.alice, followUp.id, { revision: 1, title: 'x' })),
    ).toBe('follow_up_concurrency_conflict');
    const updated = w.audit.events().filter((e) => e.action === 'follow_up.updated');
    expect(updated.map((e) => e.reason)).toEqual(['details', 'type']);
    expect(JSON.stringify(w.audit.events())).not.toContain('cotización');
  });

  it('4–5. cancels (kept) and completes, recording who and when', async () => {
    const w = await world();
    const one = (await w.followUps.create(w.alice, tomorrowAt10(w.juan.id))).followUp;
    const two = (await w.followUps.create(w.alice, tomorrowAt10(w.juan.id, { time: '11:00' })))
      .followUp;
    const cancelled = await w.followUps.cancel(w.alice, one.id, { revision: 1 });
    expect(cancelled).toMatchObject({
      status: 'cancelled',
      cancelledBy: ALICE,
      cancelReason: 'person',
      cancelledAt: T0.toISOString(),
    });
    expect(await w.followUps.get(w.alice, one.id)).toMatchObject({ status: 'cancelled' });
    const done = await w.followUps.complete(w.alice, two.id, { revision: 1 });
    expect(done).toMatchObject({ status: 'completed', completedBy: ALICE });
    expect(await codeOf(w.followUps.complete(w.alice, two.id, { revision: 2 }))).toBe(
      'follow_up_closed',
    );
    expect(await codeOf(w.followUps.cancel(w.alice, one.id, { revision: 2 }))).toBe(
      'follow_up_closed',
    );
  });

  it('6, 30. reschedules keeping the history, and reopens a closed one with a new task', async () => {
    const w = await world();
    const { followUp } = await w.followUps.create(w.alice, tomorrowAt10(w.juan.id));
    const moved = await w.followUps.reschedule(w.alice, followUp.id, {
      revision: 1,
      date: '2026-10-02',
      time: '09:30',
    });
    expect(moved).toMatchObject({
      scheduledAt: '2026-10-02T14:30:00.000Z',
      schedule: 2,
      status: 'scheduled',
      history: [
        {
          from: '2026-09-29T15:00:00.000Z',
          to: '2026-10-02T14:30:00.000Z',
          status: 'scheduled',
          by: ALICE,
        },
      ],
    });
    const done = await w.followUps.complete(w.alice, followUp.id, { revision: 2 });
    const reopened = await w.followUps.reschedule(w.alice, followUp.id, {
      revision: done.revision,
      date: '2026-10-05',
      time: '10:00',
    });
    expect(reopened).toMatchObject({ status: 'scheduled', schedule: 3 });
    expect(reopened.completedAt).toBeUndefined();
    expect(reopened.history).toHaveLength(2);
    expect(reopened.history[1]).toMatchObject({ status: 'completed' });
    expect(w.recorder.tasks.map((t) => t.task.schedule)).toEqual([1, 2, 3]);
    expect(actions(w.audit)).toEqual([
      'follow_up.created',
      'follow_up.rescheduled',
      'follow_up.completed',
      'follow_up.rescheduled',
    ]);
  });

  it('9. keeps organizations apart', async () => {
    const w = await world();
    const { followUp } = await w.followUps.create(w.alice, tomorrowAt10(w.juan.id));
    expect(await codeOf(w.followUps.get(w.bob, followUp.id))).toBe('follow_up_not_found');
    expect((await w.followUps.list(w.bob)).items).toEqual([]);
    expect(await codeOf(w.followUps.complete(w.bob, followUp.id, { revision: 1 }))).toBe(
      'follow_up_not_found',
    );
    // Bob may not schedule one for Alice's contact.
    expect(await codeOf(w.followUps.create(w.bob, tomorrowAt10(w.juan.id)))).toBe(
      'contact_not_found',
    );
    // A task naming the wrong organization finds nothing.
    expect(
      await w.followUps.runDue({ organizationId: w.orgB, followUpId: followUp.id, schedule: 1 }),
    ).toEqual({ kind: 'not_found' });
  });

  it('10, 25. needs its permissions, and only a person directly changes one', async () => {
    const reader = await world({ roles: { ...ROLES, owner: ['follow_up.read', 'contact.read'] } });
    expect(await codeOf(reader.followUps.create(reader.alice, tomorrowAt10(reader.juan.id)))).toBe(
      'permission_denied',
    );
    expect((await reader.followUps.list(reader.alice)).items).toEqual([]);
    const none = await world({ roles: { ...ROLES, owner: [] } });
    expect(await codeOf(none.followUps.list(none.alice))).toBe('permission_denied');
    const w = await world();
    // GIA and the runtime never create or change one: only a person confirming.
    expect(await codeOf(w.followUps.create(w.aliceAsGia, tomorrowAt10(w.juan.id)))).toBe(
      'requires_user',
    );
    expect(await codeOf(w.followUps.create(w.runtime, tomorrowAt10(w.juan.id)))).toBe(
      'requires_user',
    );
    expect(
      reader.recorder.tasks.length + none.recorder.tasks.length + w.recorder.tasks.length,
    ).toBe(0);
  });

  it('11. is assigned to the record’s responsible member, or to one chosen', async () => {
    const w = await world();
    await w.customers.update(w.alice, w.juan.id, { revision: 1, ownerId: ALICE });
    const own = (await w.followUps.create(w.alice, tomorrowAt10(w.juan.id))).followUp;
    expect(own.assignedTo).toBe(ALICE);
    expect(
      await codeOf(w.followUps.create(w.alice, tomorrowAt10(w.juan.id, { assignedTo: BOB }))),
    ).toBe('owner_not_member');
    expect((await w.followUps.list(w.alice, { assignee: 'me' })).items).toHaveLength(1);
  });

  it('12. for an opportunity: its next action is its earliest open follow-up, in the same write', async () => {
    const w = await world();
    const later = (
      await w.followUps.create(
        w.alice,
        tomorrowAt10(w.rosa.id, {
          opportunityId: w.deal.id,
          title: 'Enviar menú',
          date: '2026-10-01',
        }),
      )
    ).followUp;
    const sooner = (
      await w.followUps.create(
        w.alice,
        tomorrowAt10(w.rosa.id, { opportunityId: w.deal.id, title: 'Confirmar fecha' }),
      )
    ).followUp;
    let deal = await w.repository.findOpportunity(w.orgA, w.deal.id);
    expect(deal?.nextAction).toEqual({
      text: 'Confirmar fecha',
      dueOn: '2026-09-29',
      followUpId: sooner.id,
    });
    // Done: the next one takes its place; none left: cleared.
    await w.followUps.complete(w.alice, sooner.id, { revision: 1 });
    deal = await w.repository.findOpportunity(w.orgA, w.deal.id);
    expect(deal?.nextAction).toMatchObject({ text: 'Enviar menú', followUpId: later.id });
    await w.followUps.cancel(w.alice, later.id, { revision: 1 });
    deal = await w.repository.findOpportunity(w.orgA, w.deal.id);
    expect(deal?.nextAction).toBeUndefined();
    const reasons = w.audit
      .events()
      .filter((e) => e.action === 'opportunity.updated')
      .map((e) => e.reason);
    expect(reasons).toEqual(['follow_up', 'follow_up', 'follow_up', 'next_action_cleared']);
    // A closed opportunity takes no new follow-up.
    const current = await found(w.repository.findOpportunity(w.orgA, w.deal.id));
    await w.opportunities.update(w.alice, w.deal.id, {
      revision: current.revision,
      stageId: 'won',
    });
    expect(
      await codeOf(
        w.followUps.create(w.alice, tomorrowAt10(w.rosa.id, { opportunityId: w.deal.id })),
      ),
    ).toBe('opportunity_closed');
    // Another contact's opportunity is not this contact's.
    expect(
      await codeOf(
        w.followUps.create(w.alice, tomorrowAt10(w.juan.id, { opportunityId: w.deal.id })),
      ),
    ).toBe('opportunity_not_found');
  });

  it('13. for a contact: one source of truth for its next action', async () => {
    const w = await world();
    await w.customers.update(w.alice, w.juan.id, {
      revision: 1,
      nextAction: { text: 'Nota antigua', dueOn: '2026-10-10' },
    });
    const { followUp } = await w.followUps.create(w.alice, tomorrowAt10(w.juan.id));
    const juan = await w.repository.findContact(w.orgA, w.juan.id);
    expect(juan?.commercial?.nextAction).toEqual({
      text: 'Llamar a Juan',
      dueOn: '2026-09-29',
      followUpId: followUp.id,
    });
    // It changes only through its follow-up.
    expect(
      await codeOf(
        w.customers.update(w.alice, w.juan.id, {
          revision: juan?.revision,
          nextAction: { text: 'Otra cosa', dueOn: '2026-10-01' },
        }),
      ),
    ).toBe('next_action_from_follow_up');
    expect(
      await codeOf(
        w.customers.update(w.alice, w.juan.id, { revision: juan?.revision, nextAction: null }),
      ),
    ).toBe('next_action_from_follow_up');
    // Other changes to the contact still work.
    await w.customers.update(w.alice, w.juan.id, { revision: juan?.revision, stage: 'customer' });
    // 27. Consent is not touched by scheduling: an internal reminder is not an outbound message.
    expect((await w.repository.findContact(w.orgA, w.juan.id))?.commercial?.consent.messaging).toBe(
      'unknown',
    );
  });

  it('16. when its time comes, the task marks it due: audited as the runtime for its author', async () => {
    const w = await world();
    const { followUp } = await w.followUps.create(w.alice, tomorrowAt10(w.juan.id));
    const task = { organizationId: w.orgA, followUpId: followUp.id, schedule: 1 };
    w.advance(22 * 3_600_000); // 2026-09-29 15:00Z
    const result = await w.followUps.runDue(task);
    expect(result).toMatchObject({ kind: 'due', followUp: { status: 'due', revision: 2 } });
    const due = w.audit.events().find((e) => e.action === 'follow_up.due');
    expect(due).toMatchObject({
      actor: { type: 'system', id: 'runtime', initiatedBy: ALICE, via: 'runtime' },
      target: { type: 'follow_up', id: followUp.id },
      transition: { from: 'scheduled', to: 'due' },
    });
    const list = await w.followUps.list(w.alice);
    expect(list.counts).toMatchObject({ today: 1, open: 1 });
    // A due one is still done or cancelled by a person.
    expect(await w.followUps.complete(w.alice, followUp.id, { revision: 2 })).toMatchObject({
      status: 'completed',
    });
  });

  it('17, 29. is idempotent: the same request, a repeated task or an earlier scheduling change nothing', async () => {
    const w = await world();
    const input = tomorrowAt10(w.juan.id);
    const first = await w.followUps.create(w.alice, input);
    const again = await w.followUps.create(w.alice, input);
    expect(again).toEqual({ followUp: first.followUp, created: false });
    expect(first.followUp.id).toBe(followUpIdFor(w.orgA, input.requestKey));
    expect((await w.followUps.list(w.alice)).items).toHaveLength(1);
    // The same request re-queues the same task (it heals a first attempt that stopped before
    // queuing); the two deliveries are one: the second finds it done.
    expect(w.recorder.tasks).toHaveLength(2);
    expect(w.recorder.tasks[1]).toEqual(w.recorder.tasks[0]);
    expect(actions(w.audit)).toEqual(['follow_up.created']);

    w.advance(22 * 3_600_000);
    const task = { organizationId: w.orgA, followUpId: first.followUp.id, schedule: 1 };
    expect((await w.followUps.runDue(task)).kind).toBe('due');
    // The same task again changes nothing; it says the follow-up is already due (ADR-0067).
    expect(await w.followUps.runDue(task)).toMatchObject({ kind: 'already_due' });
    expect(actions(w.audit, 'follow_up.due')).toHaveLength(1);

    // Rescheduled: the old task's scheduling is no longer current.
    const current = await w.followUps.get(w.alice, first.followUp.id);
    await w.followUps.reschedule(w.alice, current.id, {
      revision: current.revision,
      date: '2026-10-02',
      time: '10:00',
    });
    expect(await w.followUps.runDue(task)).toEqual({ kind: 'stale' });
    expect(await w.followUps.runDue({ ...task, schedule: 0 })).toEqual({ kind: 'stale' });
    // A request replayed once the follow-up is done queues nothing more.
    const done = await w.followUps.create(w.alice, tomorrowAt10(w.rosa.id));
    await w.followUps.complete(w.alice, done.followUp.id, { revision: 1 });
    const queued = w.recorder.tasks.length;
    const replay = tomorrowAt10(w.rosa.id);
    await w.followUps.create(w.alice, replay);
    await w.followUps.complete(w.alice, followUpIdFor(w.orgA, replay.requestKey), { revision: 1 });
    await w.followUps.create(w.alice, replay);
    expect(w.recorder.tasks.length).toBe(queued + 1);
  });

  it('a task for a stopped organization is not acknowledged: the queue retries, then it fails', async () => {
    const w = await world();
    const { followUp } = await w.followUps.create(w.alice, tomorrowAt10(w.juan.id));
    const task = { organizationId: w.orgA, followUpId: followUp.id, schedule: 1 };
    w.advance(22 * 3_600_000);
    const organization = await found(w.tenancy.findOrganization(w.orgA));
    w.tenancy.put({ ...organization, status: 'suspended' });
    expect(await codeOf(w.followUps.runDue(task))).toBe('organization_inactive');
    expect((await w.repository.findFollowUp(w.orgA, followUp.id))?.status).toBe('scheduled');
    // The queue's last attempt keeps it as failed, for a person to see and reschedule.
    expect(await w.followUps.failDue(task)).toBe(true);
    expect((await w.repository.findFollowUp(w.orgA, followUp.id))?.status).toBe('failed');
  });

  it('15. beyond the queue’s horizon, the task hops: it arrives early and queues the next one', async () => {
    const w = await world();
    const { followUp } = await w.followUps.create(
      w.alice,
      tomorrowAt10(w.juan.id, { date: '2026-12-15' }),
    );
    // The first task is held for at most 29 days.
    expect(w.recorder.tasks[0]?.at).toBe('2026-10-27T17:00:00.000Z');
    w.advance(29 * 86_400_000);
    const task = { organizationId: w.orgA, followUpId: followUp.id, schedule: 1 };
    const early = await w.followUps.runDue(task);
    expect(early).toMatchObject({ kind: 'early' });
    expect(w.recorder.tasks[1]).toEqual({ task, at: '2026-11-25T17:00:00.000Z' });
    expect((await w.followUps.get(w.alice, followUp.id)).status).toBe('scheduled');
    expect(actions(w.audit, 'follow_up.due')).toEqual([]);
  });

  it('when its record ended before its time, the task cancels it and says why', async () => {
    const w = await world();
    const { followUp } = await w.followUps.create(
      w.alice,
      tomorrowAt10(w.rosa.id, { opportunityId: w.deal.id }),
    );
    const deal = await found(w.repository.findOpportunity(w.orgA, w.deal.id));
    await w.opportunities.update(w.alice, w.deal.id, {
      revision: deal.revision,
      stageId: 'lost',
      lostReason: 'price',
    });
    w.advance(22 * 3_600_000);
    expect(
      await w.followUps.runDue({ organizationId: w.orgA, followUpId: followUp.id, schedule: 1 }),
    ).toEqual({ kind: 'cancelled', reason: 'opportunity_closed' });
    expect(await w.followUps.get(w.alice, followUp.id)).toMatchObject({
      status: 'cancelled',
      cancelReason: 'opportunity_closed',
    });
  });

  it('19. a task that cannot be queued is never pretended: the follow-up is kept as failed', async () => {
    const w = await world();
    w.recorder.fail(true);
    const input = tomorrowAt10(w.juan.id);
    expect(await codeOf(w.followUps.create(w.alice, input))).toBe('follow_up_not_scheduled');
    const [failed] = (await w.followUps.list(w.alice)).items;
    expect(failed).toMatchObject({ status: 'failed', failure: 'not_scheduled', revision: 2 });
    expect(w.audit.events().find((e) => e.action === 'follow_up.failed')).toMatchObject({
      result: 'failure',
      reason: 'not_scheduled',
    });
    // A person gives it a new time once the queue is back.
    w.recorder.fail(false);
    const retried = await w.followUps.reschedule(w.alice, (failed as FollowUp).id, {
      revision: 2,
      date: '2026-09-30',
      time: '10:00',
    });
    expect(retried).toMatchObject({ status: 'scheduled', schedule: 2 });
    expect(retried.failure).toBeUndefined();
    // Without the transport, nothing is scheduled at all (fails closed).
    const off = await world({ scheduler: false });
    expect(await codeOf(off.followUps.create(off.alice, tomorrowAt10(off.juan.id)))).toBe(
      'follow_up_scheduler_unavailable',
    );
    expect((await off.followUps.list(off.alice)).items).toEqual([]);
  });

  it('18. when the queue gives up on a task, the follow-up is kept as failed', async () => {
    const w = await world();
    const { followUp } = await w.followUps.create(w.alice, tomorrowAt10(w.juan.id));
    const task = { organizationId: w.orgA, followUpId: followUp.id, schedule: 1 };
    expect(await w.followUps.failDue(task)).toBe(true);
    expect(await w.followUps.get(w.alice, followUp.id)).toMatchObject({
      status: 'failed',
      failure: 'retries_exhausted',
    });
    expect(await w.followUps.failDue(task)).toBe(false);
    expect(await w.followUps.runDue(task)).toEqual({ kind: 'stale' });
  });

  it('20, 26, 28. audits every change without personal data, and never sends or charges', async () => {
    const w = await world();
    const { followUp } = await w.followUps.create(
      w.alice,
      tomorrowAt10(w.juan.id, {
        type: 'message',
        description: 'Mandarle la cotización de S/ 5,000',
      }),
    );
    await w.followUps.complete(w.alice, followUp.id, { revision: 1 });
    const events = w.audit.events().filter((e) => e.action.startsWith('follow_up.'));
    expect(events.map((e) => [e.action, e.reason ?? null, e.reference ?? null])).toEqual([
      ['follow_up.created', 'message', 'manual'],
      ['follow_up.completed', null, null],
    ]);
    const text = JSON.stringify(w.audit.events());
    for (const personal of ['Juan', 'Llamar', 'cotización', '+51911111111']) {
      expect(text).not.toContain(personal);
    }
    // The only thing handed to the transport is the task: ids and a number, no content.
    expect(Object.keys((w.recorder.tasks[0] as { task: object }).task).sort()).toEqual([
      'followUpId',
      'organizationId',
      'schedule',
    ]);
    // A MESSAGE follow-up is a reminder: no conversation or message was created.
    expect(await w.repository.listConversations(w.orgA)).toEqual([]);
  });

  it('27. is an internal reminder: consent does not gate it, and it grants no send', async () => {
    const w = await world();
    const juan = await found(w.repository.findContact(w.orgA, w.juan.id));
    await w.customers.update(w.alice, w.juan.id, {
      revision: juan.revision,
      consent: { messaging: 'denied', recordedBy: 'contact' },
    });
    const { followUp } = await w.followUps.create(
      w.alice,
      tomorrowAt10(w.juan.id, { type: 'message' }),
    );
    const after = await found(w.repository.findContact(w.orgA, w.juan.id));
    // Consent is exactly what the contact said; the reminder never makes an automated send allowed.
    expect(after.commercial?.consent.messaging).toBe('denied');
    expect(consentAllows(after, 'automated')).toBe(false);
    expect(followUp.type).toBe('message');
    expect(await w.repository.listConversations(w.orgA)).toEqual([]);
  });

  it('14. C4 reads them: today, overdue and upcoming, with the records they are about', async () => {
    const w = await world();
    await w.followUps.create(
      w.alice,
      tomorrowAt10(w.juan.id, { date: '2026-09-28', time: '12:30' }),
    );
    await w.followUps.create(
      w.alice,
      tomorrowAt10(w.rosa.id, { opportunityId: w.deal.id, title: 'Enviar menú' }),
    );
    const insights = createCommercialInsights({
      customers: w.customers,
      opportunities: w.opportunities,
      conversations: w.repository,
      followUps: w.followUps,
      authorization: createAuthorizationService(ROLES),
      timeZone: async () => LIMA,
      currency: async () => 'PEN',
      now: w.now,
    });
    const read = await insights.read(w.alice, { mentions: 'Recuérdame llamar a Juan mañana' });
    expect(read.followUps).toMatchObject({ today: 1, upcoming: 1, open: 2, mine: { today: 1 } });
    expect(read.records.followUps.map((f) => [f.title, f.when, f.time])).toEqual([
      ['Llamar a Juan', 'today', '12:30'],
      ['Enviar menú', 'upcoming', '10:00'],
    ]);
    const [first, second] = read.records.followUps;
    expect(read.records.contacts.find((c) => c.ref === first?.contact)?.name).toBe('Juan Pérez');
    expect(read.records.opportunities.find((o) => o.ref === second?.opportunity)?.title).toBe(
      'Cena de empresa',
    );
    // The mirrored next action is what C4's rules already read: today's follow-up is "due today".
    const juan = read.records.contacts.find((c) => c.name === 'Juan Pérez');
    expect(read.attention.find((a) => a.ref === juan?.ref)?.reasons[0]?.kind).toBe(
      'next_action_today',
    );
    // The contact named in the message is listed for a proposal.
    expect(read.lists.mentioned).toContain(juan?.ref);
    // Without follow_up.read, that part is null and nothing of it is named.
    const blind = createCommercialInsights({
      customers: w.customers,
      opportunities: w.opportunities,
      conversations: w.repository,
      followUps: w.followUps,
      authorization: createAuthorizationService({
        ...ROLES,
        owner: ROLES.owner.filter((p) => !p.startsWith('follow_up.')),
      }),
      timeZone: async () => LIMA,
      currency: async () => 'PEN',
      now: w.now,
    });
    const hidden = await blind.read(w.alice);
    expect(hidden.followUps).toBeNull();
    expect(hidden.records.followUps).toEqual([]);
  });

  it('C4 through a follow-up’s life: overdue, done, cancelled or none, never invented', async () => {
    const w = await world();
    const insights = createCommercialInsights({
      customers: w.customers,
      opportunities: w.opportunities,
      conversations: w.repository,
      followUps: w.followUps,
      authorization: createAuthorizationService(ROLES),
      timeZone: async () => LIMA,
      currency: async () => 'PEN',
      now: w.now,
    });
    const reasonsOf = async (name: string) => {
      const read = await insights.read(w.alice);
      const ref =
        read.records.opportunities.find((o) => o.title === name)?.ref ??
        read.records.contacts.find((c) => c.name === name)?.ref;
      return (read.attention.find((a) => a.ref === ref)?.reasons ?? []).map((r) => r.kind);
    };
    // No follow-up: the lead is "without follow-up", the opportunity has no next-action reason.
    expect(await reasonsOf('Juan Pérez')).toContain('lead_without_follow_up');
    expect(await reasonsOf('Cena de empresa')).not.toContain('overdue_next_action');
    const call = (await w.followUps.create(w.alice, tomorrowAt10(w.juan.id))).followUp;
    const deal = (
      await w.followUps.create(w.alice, tomorrowAt10(w.rosa.id, { opportunityId: w.deal.id }))
    ).followUp;
    expect(await reasonsOf('Juan Pérez')).not.toContain('lead_without_follow_up');
    // Two days later both are overdue: C4 says so from the mirrored next action.
    w.advance(2 * 86_400_000);
    expect(await reasonsOf('Juan Pérez')).toContain('overdue_next_action');
    expect(await reasonsOf('Cena de empresa')).toContain('overdue_next_action');
    // Done and cancelled: nothing stale is left behind.
    await w.followUps.complete(w.alice, deal.id, { revision: 1 });
    await w.followUps.cancel(w.alice, call.id, { revision: 1 });
    expect(await reasonsOf('Cena de empresa')).not.toContain('overdue_next_action');
    expect(await reasonsOf('Juan Pérez')).not.toContain('overdue_next_action');
    expect(await reasonsOf('Juan Pérez')).toContain('lead_without_follow_up');
    expect((await w.repository.findOpportunity(w.orgA, w.deal.id))?.nextAction).toBeUndefined();
  });

  it('keeps a record to a limited number of open follow-ups', async () => {
    const w = await world();
    for (let i = 0; i < 20; i += 1) {
      await w.followUps.create(
        w.alice,
        tomorrowAt10(w.juan.id, { time: `1${i % 10}:0${i >= 10 ? 5 : 0}` }),
      );
    }
    expect(await codeOf(w.followUps.create(w.alice, tomorrowAt10(w.juan.id)))).toBe(
      'follow_up_limit_reached',
    );
  });

  it('computes a record’s next action from its open follow-ups only', () => {
    const base = {
      organizationId: 'o' as OrganizationId,
      timeZone: LIMA,
      title: 'x',
    } as unknown as FollowUp;
    const f = (id: string, at: string, status: FollowUp['status']) =>
      ({ ...base, id, scheduledAt: at, status, title: id }) as FollowUp;
    const note = { text: 'nota', dueOn: '2026-10-01' };
    expect(nextActionFrom(note, [])).toBe(note);
    expect(nextActionFrom({ ...note, followUpId: 'z' as never }, [])).toBeUndefined();
    expect(
      nextActionFrom(note, [
        f('b', '2026-09-30T15:00:00Z', 'scheduled'),
        f('a', '2026-09-29T15:00:00Z', 'completed'),
        f('c', '2026-09-29T20:00:00Z', 'due'),
      ]),
    ).toEqual({ text: 'c', dueOn: '2026-09-29', followUpId: 'c' });
  });
});
