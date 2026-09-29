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
import type { AuditEventInput } from '@melonoffice/audit';
import {
  createEventBus,
  EVENT_LIMITS,
  eventIdFor,
  type EventDeliveryRef,
  type EventQueue,
  type EventSubscriber,
} from './bus.js';
import { checkEventCatalogue, EVENT_CATALOGUE } from './catalogue.js';
import { EventError, type DomainEvent } from './model.js';
import { InMemoryEventOutbox } from './outbox.js';
import { createTriggerRouter, type EventTrigger, type TriggerStarter } from './triggers.js';

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
  data: { contactId: 'contact_1', opportunityId: 'opp_1', assignedTo: ALICE },
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
      data: { contactId: 'contact_1', opportunityId: 'opp_1', assignedTo: ALICE },
      correlationId: 'req_1',
      source: 'follow_ups',
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
    expect(await code([{ ...DUE(), data: { ...DUE().data, note: 'Llamar a Juan' } }])).toBe(
      'invalid_event:note',
    );
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
    expect(
      await code([DUE('fu_1'), { ...DUE('fu_2'), data: { ...DUE().data, opportunityId: 'a b' } }]),
    ).toBe('invalid_event:opportunityId');
    expect(await code(Array.from({ length: EVENT_LIMITS.draftsPerPublish + 1 }, () => DUE()))).toBe(
      'invalid_event:drafts',
    );
    expect(await code([{ ...DUE(), idempotencyKey: 'a b' }])).toBe('invalid_event:idempotencyKey');
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

/** A queue that keeps what it was given, and can be made to fail. */
function memoryQueue() {
  const refs: EventDeliveryRef[] = [];
  let down = false;
  const queue: EventQueue = {
    async enqueue(ref) {
      if (down) throw new Error('queue down');
      refs.push(ref);
    },
  };
  return {
    queue,
    refs,
    setDown: (value: boolean) => {
      down = value;
    },
  };
}

function memoryAudit() {
  const events: AuditEventInput[] = [];
  return { events, audit: { record: async (e: AuditEventInput) => (events.push(e), e) as never } };
}

describe('events: persistence and queue (EV-2, ADR-0067)', () => {
  it('stores each event, then queues exactly its organization and id', async () => {
    const w = await world();
    const t = clock();
    const outbox = new InMemoryEventOutbox();
    const q = memoryQueue();
    const bus = createEventBus({ outbox, queue: q.queue, now: t.now });
    const [event] = await bus.publish(w.alice, [DUE()]);
    expect(q.refs).toEqual([{ organizationId: w.alice.organizationId, eventId: event?.id }]);
    expect(await outbox.find(w.alice.organizationId, event?.id ?? '')).toMatchObject({
      status: 'queued',
      attempts: 0,
      createdAt: '2026-09-29T10:00:00.000Z',
      queuedAt: '2026-09-29T10:00:00.000Z',
      settledAt: null,
      event: { source: 'follow_ups', actor: { type: 'user', userId: ALICE } },
    });
  });

  it('a producer retry with the same key stores and queues the event once', async () => {
    const w = await world();
    const outbox = new InMemoryEventOutbox();
    const q = memoryQueue();
    const bus = createEventBus({ outbox, queue: q.queue });
    const draft = { ...DUE(), idempotencyKey: 'fu_1:1' };
    const [first] = await bus.publishRuntime(w.alice.organizationId, ALICE, [draft]);
    const [again] = await bus.publishRuntime(w.alice.organizationId, ALICE, [draft]);
    expect(again?.id).toBe(first?.id);
    expect(first?.id).toBe(eventIdFor(w.alice.organizationId, 'follow_up.due', 'fu_1:1'));
    expect(outbox.records()).toHaveLength(1);
    expect(q.refs).toHaveLength(1);
    // The same key in another organization is another event.
    const [other] = await bus.publishRuntime(w.bob.organizationId, BOB, [draft]);
    expect(other?.id).not.toBe(first?.id);
  });

  it('when the queue is down the event stays stored, the producer is told, and its retry queues it', async () => {
    const w = await world();
    const outbox = new InMemoryEventOutbox();
    const q = memoryQueue();
    const bus = createEventBus({ outbox, queue: q.queue });
    const draft = { ...DUE(), idempotencyKey: 'fu_1:1' };
    q.setDown(true);
    await expect(bus.publish(w.alice, [draft])).rejects.toMatchObject({
      code: 'queue_unavailable',
    });
    expect(outbox.records()).toMatchObject([{ status: 'pending' }]);
    q.setDown(false);
    await bus.publish(w.alice, [draft]);
    expect(outbox.records()).toMatchObject([{ status: 'queued' }]);
    expect(q.refs).toHaveLength(1);
  });

  it('without a queue, events are stored as pending and not delivered', async () => {
    const w = await world();
    const outbox = new InMemoryEventOutbox();
    const bus = createEventBus({ outbox });
    await bus.publish(w.alice, [DUE()]);
    expect(outbox.records()).toMatchObject([{ status: 'pending' }]);
  });

  it('the runtime publishes as itself for the member, never as that person', async () => {
    const w = await world();
    const bus = createEventBus({ outbox: new InMemoryEventOutbox() });
    const [event] = await bus.publishRuntime(w.alice.organizationId, ALICE, [DUE()]);
    expect(event?.actor).toEqual({
      type: 'system',
      id: 'runtime',
      initiatedBy: ALICE,
      via: 'runtime',
    });
  });

  it('an event id stored for another organization is refused', async () => {
    const w = await world();
    const outbox = new InMemoryEventOutbox();
    const bus = createEventBus({ outbox });
    const [event] = await bus.publish(w.alice, [DUE()]);
    const forged = { ...(event as DomainEvent), organizationId: w.bob.organizationId };
    await expect(outbox.append([forged], new Date().toISOString())).rejects.toThrow(
      'event id taken',
    );
  });
});

describe('events: delivery', () => {
  it('delivers an event once to every subscriber of its type; a repeated task changes nothing', async () => {
    const w = await world();
    const outbox = new InMemoryEventOutbox();
    const q = memoryQueue();
    const followUps = recorder('follow_ups.notify', ['follow_up.due']);
    const pipeline = recorder('pipeline.watch', ['opportunity.stage_changed', 'follow_up.due']);
    const other = recorder('knowledge.watch', ['knowledge.document_ingested']);
    const bus = createEventBus({
      outbox,
      queue: q.queue,
      subscribers: [followUps.subscriber, pipeline.subscriber, other.subscriber],
    });
    await bus.publish(w.alice, [DUE('fu_1')]);
    const [ref] = q.refs;
    if (ref === undefined) throw new Error('not queued');
    expect(await bus.deliver(ref, { retryCount: 0 })).toEqual({
      kind: 'delivered',
      subscribers: 2,
    });
    expect(followUps.seen.map((s) => [s.event.subject.id, s.attempt])).toEqual([['fu_1', 1]]);
    expect(pipeline.seen).toHaveLength(1);
    expect(other.seen).toEqual([]);
    // The queue delivers the same task again (at least once): nobody sees it twice.
    expect(await bus.deliver(ref, { retryCount: 1 })).toEqual({ kind: 'already_delivered' });
    expect(followUps.seen).toHaveLength(1);
    expect(outbox.records()).toMatchObject([
      {
        status: 'delivered',
        attempts: 1,
        deliveredTo: ['follow_ups.notify', 'pipeline.watch'],
        leaseId: null,
        settledAt: expect.any(String),
      },
    ]);
    expect(bus.subscribersOf('follow_up.due')).toEqual(['follow_ups.notify', 'pipeline.watch']);
  });

  it('retries only the subscriber that failed, keeping only a code', async () => {
    const w = await world();
    const outbox = new InMemoryEventOutbox();
    const q = memoryQueue();
    let down = true;
    const ok = recorder('ok.subscriber', ['follow_up.due']);
    const flaky = recorder('flaky.subscriber', ['follow_up.due'], () => down);
    const bus = createEventBus({
      outbox,
      queue: q.queue,
      subscribers: [flaky.subscriber, ok.subscriber],
    });
    const [event] = await bus.publish(w.alice, [DUE()]);
    const ref = { organizationId: w.alice.organizationId, eventId: event?.id ?? '' };
    expect(await bus.deliver(ref, { retryCount: 0 })).toEqual({
      kind: 'retry',
      subscriber: 'flaky.subscriber',
      code: 'downstream_down',
    });
    const failed = await outbox.find(w.alice.organizationId, ref.eventId);
    expect(failed).toMatchObject({
      status: 'queued',
      attempts: 1,
      deliveredTo: ['ok.subscriber'],
      leaseId: null,
      lastError: { subscriber: 'flaky.subscriber', code: 'downstream_down' },
    });
    expect(JSON.stringify(failed)).not.toContain('Juan');
    down = false;
    expect(await bus.deliver(ref, { retryCount: 1 })).toMatchObject({ kind: 'delivered' });
    expect(ok.seen).toHaveLength(1);
    expect(flaky.seen).toEqual([expect.objectContaining({ attempt: 2 })]);
  });

  it("sets an event aside as dead on the queue's last attempt, audits it, and never retries it", async () => {
    const w = await world();
    const outbox = new InMemoryEventOutbox();
    const q = memoryQueue();
    const a = memoryAudit();
    const broken = recorder('broken.subscriber', ['follow_up.due'], () => true);
    const bus = createEventBus({
      outbox,
      queue: q.queue,
      subscribers: [broken.subscriber],
      audit: a.audit,
      maxAttempts: 3,
    });
    const [event] = await bus.publishRuntime(w.alice.organizationId, ALICE, [DUE()]);
    const ref = { organizationId: w.alice.organizationId, eventId: event?.id ?? '' };
    const kinds = [];
    for (let retryCount = 0; retryCount < 4; retryCount += 1) {
      kinds.push((await bus.deliver(ref, { retryCount })).kind);
    }
    expect(kinds).toEqual(['retry', 'retry', 'dead', 'already_dead']);
    expect(outbox.records()).toMatchObject([{ status: 'dead', attempts: 3 }]);
    expect(a.events).toEqual([
      {
        action: 'event.dead_lettered',
        result: 'failure',
        actor: { type: 'system', id: 'runtime', initiatedBy: ALICE, via: 'runtime' },
        organizationId: w.alice.organizationId,
        target: { type: 'event', id: ref.eventId },
        reason: 'downstream_down',
        source: 'api',
      },
    ]);
  });

  it('two deliveries of one event never run at once; a crashed one is taken over after its lease', async () => {
    const w = await world();
    const t = clock();
    const outbox = new InMemoryEventOutbox();
    const seen = recorder('one.subscriber', ['follow_up.due']);
    const bus = createEventBus({
      outbox,
      subscribers: [seen.subscriber],
      now: t.now,
      leaseMs: 5000,
    });
    const [event] = await bus.publish(w.alice, [DUE()]);
    const ref = { organizationId: w.alice.organizationId, eventId: event?.id ?? '' };
    // A delivery took it and stopped before settling (a crashed worker).
    await outbox.begin(ref.organizationId, ref.eventId, {
      leaseId: 'crashed',
      now: t.now().getTime(),
      leaseMs: 5000,
    });
    expect(await bus.deliver(ref, { retryCount: 1 })).toEqual({ kind: 'busy' });
    expect(seen.seen).toEqual([]);
    t.advance(5000);
    expect(await bus.deliver(ref, { retryCount: 2 })).toMatchObject({ kind: 'delivered' });
    // The crashed delivery cannot settle over the one that took over.
    expect(
      await outbox.settle(ref.organizationId, ref.eventId, 'crashed', {
        deliveredTo: [],
        status: 'queued',
        lastError: null,
        at: t.now().toISOString(),
      }),
    ).toBe(false);
    expect(seen.seen).toHaveLength(1);
  });

  it("a delivery for another organization's event finds nothing and runs no subscriber", async () => {
    const w = await world();
    const outbox = new InMemoryEventOutbox();
    const all = recorder('all.subscriber', ['follow_up.due']);
    const bus = createEventBus({ outbox, subscribers: [all.subscriber] });
    const [event] = await bus.publish(w.alice, [DUE('fu_a')]);
    expect(
      await bus.deliver(
        { organizationId: w.bob.organizationId, eventId: event?.id ?? '' },
        { retryCount: 0 },
      ),
    ).toEqual({ kind: 'not_found' });
    expect(
      await bus.deliver(
        { organizationId: w.alice.organizationId, eventId: 'evt_not-an-id' },
        { retryCount: 0 },
      ),
    ).toEqual({ kind: 'not_found' });
    expect(all.seen).toEqual([]);
    expect(await outbox.find(w.bob.organizationId, event?.id ?? '')).toBeUndefined();
  });
});

describe('events: triggers (EVENT → WORKFLOW or AGENT, no autonomy)', () => {
  const trigger = (
    organizationId: OrganizationId,
    over: Partial<EventTrigger> = {},
  ): EventTrigger => ({
    id: 'trg_1',
    organizationId,
    eventType: 'follow_up.due',
    target: { kind: 'workflow', id: 'wf_1' },
    ...over,
  });

  it("starts only its organization's triggers, once per event and trigger, through the owning engine", async () => {
    const w = await world();
    const started: [string, string, string][] = [];
    const starter: TriggerStarter = {
      async start(event, t, key) {
        started.push([event.id, t.target.id, key]);
      },
    };
    const router = createTriggerRouter({
      triggers: async (organizationId) => [
        trigger(organizationId),
        trigger(w.bob.organizationId, { id: 'trg_foreign' }),
        trigger(organizationId, { id: 'trg_other', eventType: 'opportunity.stage_changed' }),
        trigger(organizationId, { id: 'trg_agent', target: { kind: 'agent', id: 'sp_1' } }),
      ],
      starters: { workflow: starter },
    });
    const outbox = new InMemoryEventOutbox();
    const bus = createEventBus({ outbox, subscribers: [router] });
    const [event] = await bus.publish(w.alice, [DUE()]);
    const ref = { organizationId: w.alice.organizationId, eventId: event?.id ?? '' };
    expect(await bus.deliver(ref, { retryCount: 0 })).toMatchObject({ kind: 'delivered' });
    // The foreign, the other type and the agent (no starter set up) start nothing.
    expect(started).toEqual([[ref.eventId, 'wf_1', `${ref.eventId}:trg_1`]]);
    expect(await bus.deliver(ref, { retryCount: 1 })).toEqual({ kind: 'already_delivered' });
    expect(started).toHaveLength(1);
  });

  it('with no triggers, an event starts nothing', async () => {
    const w = await world();
    const router = createTriggerRouter({ triggers: async () => [], starters: {} });
    const bus = createEventBus({ outbox: new InMemoryEventOutbox(), subscribers: [router] });
    const [event] = await bus.publish(w.alice, [DUE()]);
    expect(
      await bus.deliver(
        { organizationId: w.alice.organizationId, eventId: event?.id ?? '' },
        { retryCount: 0 },
      ),
    ).toEqual({ kind: 'delivered', subscribers: 1 });
    expect(router.types).toEqual(EVENT_CATALOGUE.map((d) => d.type));
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
