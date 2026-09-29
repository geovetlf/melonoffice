import type { AuthenticatedContext } from '@melonoffice/auth';
import { openWallet } from '@melonoffice/credits';
import type {
  InitialBilling,
  Organization,
  OrganizationId,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveRuntimeTenant,
  resolveTenant,
  type TenantContext,
} from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { createEventBus, EVENT_LIMITS, type EventSubscriber } from './bus.js';
import { checkEventCatalogue, EVENT_CATALOGUE } from './catalogue.js';
import { EventError, type DomainEvent } from './model.js';
import { InMemoryEventOutbox } from './outbox.js';

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
const as = (userId: UserId): AuthenticatedContext =>
  Object.freeze({ actor: 'user', userId, emailVerified: true });

async function world() {
  const tenancy = new InMemoryTenancyStore();
  const create = (user: UserId, name: string) =>
    createOrganization(as(user), { name }, tenancy, { billing: BILLING, credits: openWallet });
  const a = await create(ALICE, 'A');
  const b = await create(BOB, 'B');
  return {
    alice: await resolveTenant(as(ALICE), a.organization.id, tenancy),
    runtime: await resolveRuntimeTenant(ALICE, a.organization.id, tenancy),
    bob: await resolveTenant(as(BOB), b.organization.id, tenancy),
  };
}

/** A clock the test moves. */
function clock(start = '2026-09-29T10:00:00Z') {
  let at = Date.parse(start);
  return {
    now: () => new Date(at),
    advance: (ms: number) => {
      at += ms;
    },
  };
}

/** A subscriber that records what it handled and fails while `failing` says so. */
function recorder(id: string, types: readonly string[], failing: () => boolean = () => false) {
  const seen: { event: DomainEvent; attempt: number }[] = [];
  const subscriber: EventSubscriber = {
    id,
    types,
    async handle(event, context) {
      if (failing()) throw Object.assign(new Error('Juan said no'), { code: 'downstream_down' });
      seen.push({ event, attempt: context.attempt });
    },
  };
  return { seen, subscriber };
}

const DUE = (id = 'fu_1') => ({
  type: 'follow_up.due',
  subject: { type: 'follow_up', id },
  data: { opportunityId: 'opp_1' },
});

describe('events: publishing (ADR-0066)', () => {
  it('publishes a catalogue event with its id, organization, actor and time; references only', async () => {
    const w = await world();
    const t = clock();
    const outbox = new InMemoryEventOutbox();
    const bus = createEventBus({ outbox, now: t.now });
    const [event] = await bus.publish(w.alice, [{ ...DUE(), correlationId: 'req_1' }]);
    expect(event).toEqual({
      id: expect.stringMatching(/^evt_[0-9a-f]{32}$/),
      type: 'follow_up.due',
      version: 1,
      organizationId: w.alice.organizationId,
      occurredAt: '2026-09-29T10:00:00.000Z',
      actor: { type: 'user', userId: ALICE, via: 'direct' },
      subject: { type: 'follow_up', id: 'fu_1' },
      data: { opportunityId: 'opp_1' },
      correlationId: 'req_1',
    });
    expect(Object.isFrozen(event)).toBe(true);
    expect(outbox.records()).toMatchObject([{ status: 'pending', attempts: 0 }]);
    // The runtime publishes as itself, for the person it works for.
    const [byRuntime] = await bus.publish(w.runtime, [DUE('fu_2')]);
    expect(byRuntime?.actor).toEqual({
      type: 'system',
      id: 'runtime',
      initiatedBy: ALICE,
      via: 'runtime',
    });
  });

  it('refuses unknown types, wrong subjects, extra or free-text fields, and publishes nothing', async () => {
    const w = await world();
    const outbox = new InMemoryEventOutbox();
    const bus = createEventBus({ outbox });
    const code = async (drafts: Parameters<typeof bus.publish>[1]) => {
      try {
        await bus.publish(w.alice, drafts);
      } catch (error) {
        if (error instanceof EventError) return `${error.code}:${error.field ?? ''}`;
        throw error;
      }
      return 'published';
    };
    expect(await code([{ type: 'payments.sent', subject: { type: 'x', id: 'y' } }])).toBe(
      'event_type_unknown:payments.sent',
    );
    expect(await code([{ ...DUE(), subject: { type: 'contact', id: 'c_1' } }])).toBe(
      'invalid_event:subject',
    );
    expect(await code([{ ...DUE(), data: { note: 'Llamar a Juan' } }])).toBe('invalid_event:note');
    expect(
      await code([
        {
          type: 'opportunity.stage_changed',
          subject: { type: 'opportunity', id: 'opp_1' },
          data: { from: 'quote', to: 'Won by Juan!', status: 'open' },
        },
      ]),
    ).toBe('invalid_event:to');
    expect(
      await code([
        {
          type: 'opportunity.stage_changed',
          subject: { type: 'opportunity', id: 'opp_1' },
          data: { from: 'quote' },
        },
      ]),
    ).toBe('invalid_event:to');
    // One bad draft among good ones: none is published.
    expect(await code([DUE('fu_1'), { ...DUE('fu_2'), data: { opportunityId: 'a b' } }])).toBe(
      'invalid_event:opportunityId',
    );
    expect(await code(Array.from({ length: EVENT_LIMITS.draftsPerPublish + 1 }, () => DUE()))).toBe(
      'invalid_event:drafts',
    );
    expect(outbox.records()).toEqual([]);
  });

  it('never publishes for an unresolved or forged context', async () => {
    const w = await world();
    const bus = createEventBus({ outbox: new InMemoryEventOutbox() });
    const forged = { ...w.alice } as TenantContext;
    await expect(bus.publish(forged, [DUE()])).rejects.toMatchObject({ code: 'unresolved_tenant' });
  });

  it('a verified system source publishes for its organization, as no person', async () => {
    const bus = createEventBus({ outbox: new InMemoryEventOutbox() });
    const [event] = await bus.publishSystem('org_verified' as OrganizationId, [
      {
        type: 'conversation.message_received',
        subject: { type: 'conversation', id: 'conv_1' },
        data: { channel: 'whatsapp' },
      },
    ]);
    expect(event).toMatchObject({ organizationId: 'org_verified', actor: { type: 'anonymous' } });
  });
});

describe('events: delivery', () => {
  it('delivers each event once to every subscriber of its type, in order', async () => {
    const w = await world();
    const t = clock();
    const outbox = new InMemoryEventOutbox();
    const followUps = recorder('follow_ups.notify', ['follow_up.due']);
    const pipeline = recorder('pipeline.watch', ['opportunity.stage_changed', 'follow_up.due']);
    const other = recorder('knowledge.watch', ['knowledge.document_ingested']);
    const bus = createEventBus({
      outbox,
      subscribers: [followUps.subscriber, pipeline.subscriber, other.subscriber],
      now: t.now,
    });
    await bus.publish(w.alice, [DUE('fu_1')]);
    t.advance(1000);
    await bus.publish(w.alice, [DUE('fu_2')]);
    expect(await bus.dispatch()).toEqual({ claimed: 2, delivered: 2, retried: 0, dead: 0 });
    expect(followUps.seen.map((s) => s.event.subject.id)).toEqual(['fu_1', 'fu_2']);
    expect(pipeline.seen).toHaveLength(2);
    expect(other.seen).toEqual([]);
    // Nothing is delivered twice.
    expect(await bus.dispatch()).toEqual({ claimed: 0, delivered: 0, retried: 0, dead: 0 });
    expect(bus.subscribersOf('follow_up.due')).toEqual(['follow_ups.notify', 'pipeline.watch']);
  });

  it('retries only the subscriber that failed, after its back-off, keeping only a code', async () => {
    const w = await world();
    const t = clock();
    const outbox = new InMemoryEventOutbox();
    let down = true;
    const ok = recorder('ok.subscriber', ['follow_up.due']);
    const flaky = recorder('flaky.subscriber', ['follow_up.due'], () => down);
    const bus = createEventBus({
      outbox,
      subscribers: [ok.subscriber, flaky.subscriber],
      now: t.now,
      backoffMs: () => 30_000,
    });
    const [event] = await bus.publish(w.alice, [DUE()]);
    expect(await bus.dispatch()).toMatchObject({ retried: 1 });
    const failed = await outbox.find(event?.id ?? '');
    expect(failed).toMatchObject({
      status: 'pending',
      attempts: 1,
      deliveredTo: ['ok.subscriber'],
      lastError: { subscriber: 'flaky.subscriber', code: 'downstream_down' },
    });
    expect(JSON.stringify(failed)).not.toContain('Juan');
    // Not before its back-off.
    expect(await bus.dispatch()).toMatchObject({ claimed: 0 });
    t.advance(30_000);
    down = false;
    expect(await bus.dispatch()).toMatchObject({ delivered: 1 });
    expect(ok.seen).toHaveLength(1);
    expect(flaky.seen).toEqual([expect.objectContaining({ attempt: 2 })]);
    expect(await outbox.find(event?.id ?? '')).toMatchObject({
      status: 'delivered',
      deliveredTo: ['ok.subscriber', 'flaky.subscriber'],
    });
  });

  it('sets an event aside as dead after its last attempt, never dropping it silently', async () => {
    const w = await world();
    const t = clock();
    const outbox = new InMemoryEventOutbox();
    const broken = recorder('broken.subscriber', ['follow_up.due'], () => true);
    const bus = createEventBus({
      outbox,
      subscribers: [broken.subscriber],
      now: t.now,
      maxAttempts: 3,
      backoffMs: () => 1000,
    });
    await bus.publish(w.alice, [DUE()]);
    const results = [];
    for (let i = 0; i < 4; i += 1) {
      results.push(await bus.dispatch());
      t.advance(1000);
    }
    expect(results.map((r) => [r.retried, r.dead])).toEqual([
      [1, 0],
      [1, 0],
      [0, 1],
      [0, 0],
    ]);
    expect(outbox.records()).toMatchObject([{ status: 'dead', attempts: 3 }]);
  });

  it('a claimed event is not delivered by a second dispatcher until its lease ends', async () => {
    const w = await world();
    const t = clock();
    const outbox = new InMemoryEventOutbox();
    const bus = createEventBus({ outbox, now: t.now, leaseMs: 5000 });
    await bus.publish(w.alice, [DUE()]);
    // A dispatcher claimed it and stopped before settling (a crashed worker).
    await outbox.claim({ now: t.now().getTime(), limit: 10, leaseMs: 5000 });
    expect(await bus.dispatch()).toMatchObject({ claimed: 0 });
    t.advance(5000);
    expect(await bus.dispatch()).toMatchObject({ claimed: 1, delivered: 1 });
  });

  it('a producer retry with the same event id stores it once', async () => {
    const w = await world();
    const outbox = new InMemoryEventOutbox();
    const bus = createEventBus({ outbox });
    const [event] = await bus.publish(w.alice, [DUE()]);
    await outbox.append([event as DomainEvent]);
    expect(outbox.records()).toHaveLength(1);
  });

  it('each event carries its own organization; a subscriber never gets another as one of its own', async () => {
    const w = await world();
    const outbox = new InMemoryEventOutbox();
    const all = recorder('all.subscriber', ['follow_up.due']);
    const bus = createEventBus({ outbox, subscribers: [all.subscriber] });
    await bus.publish(w.alice, [DUE('fu_a')]);
    await bus.publish(w.bob, [DUE('fu_b')]);
    await bus.dispatch();
    expect(all.seen.map((s) => [s.event.organizationId, s.event.subject.id])).toEqual([
      [w.alice.organizationId, 'fu_a'],
      [w.bob.organizationId, 'fu_b'],
    ]);
  });
});

describe('events: catalogue and subscribers', () => {
  it('the catalogue is closed, checked and holds no free-text field', () => {
    expect(checkEventCatalogue(EVENT_CATALOGUE)).toHaveLength(EVENT_CATALOGUE.length);
    for (const definition of EVENT_CATALOGUE) {
      expect(Object.isFrozen(definition)).toBe(true);
      for (const field of Object.values(definition.fields)) {
        expect(['id', 'code', 'number', 'boolean', 'date']).toContain(field.kind);
      }
    }
    const [first] = EVENT_CATALOGUE;
    if (first === undefined) throw new Error('empty catalogue');
    expect(() => checkEventCatalogue([first, first])).toThrow('duplicate event type');
    expect(() => checkEventCatalogue([{ ...first, type: 'Bad' }])).toThrow('invalid event type');
  });

  it('refuses a subscriber to an unknown type, a duplicate id or no type at all', () => {
    const outbox = new InMemoryEventOutbox();
    const make = (subscribers: EventSubscriber[]) => () => createEventBus({ outbox, subscribers });
    const handle = async () => undefined;
    expect(make([{ id: 'a.sub', types: ['payments.sent'], handle }])).toThrow('event_type_unknown');
    expect(
      make([
        { id: 'a.sub', types: ['follow_up.due'], handle },
        { id: 'a.sub', types: ['follow_up.due'], handle },
      ]),
    ).toThrow('subscriber_invalid');
    expect(make([{ id: 'a.sub', types: [], handle }])).toThrow('subscriber_invalid');
    expect(make([{ id: 'Bad Id', types: ['follow_up.due'], handle }])).toThrow(
      'subscriber_invalid',
    );
  });
});
