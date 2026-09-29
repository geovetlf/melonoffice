import type { OrganizationId, UserId } from '@melonoffice/domain';
import {
  createEventBus,
  type DomainEvent,
  type EventDeliveryRef,
  type EventSubscriber,
} from '@melonoffice/events';
import { describe, expect, it } from 'vitest';
import { DOMAIN_EVENTS, FirestoreEventOutbox } from './events.js';
import { emulatorFirestore, emulatorHost } from './testing.js';

const ORG_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as OrganizationId;
const ORG_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' as OrganizationId;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;

const DUE = (followUpId: string, schedule = 1) => ({
  type: 'follow_up.due',
  subject: { type: 'follow_up', id: followUpId },
  data: { contactId: 'contact_1', assignedTo: ALICE },
  idempotencyKey: `${followUpId}:${schedule}`,
});

function recorder(failing: () => boolean = () => false) {
  const seen: DomainEvent[] = [];
  const subscriber: EventSubscriber = {
    id: 'test.subscriber',
    types: ['follow_up.due'],
    async handle(event) {
      if (failing()) throw Object.assign(new Error('down'), { code: 'downstream_down' });
      seen.push(event);
    },
  };
  return { seen, subscriber };
}

describe.runIf(emulatorHost)('FirestoreEventOutbox (emulator)', () => {
  function world(failing?: () => boolean) {
    const db = emulatorFirestore();
    const outbox = new FirestoreEventOutbox(db);
    const refs: EventDeliveryRef[] = [];
    const sub = recorder(failing);
    const bus = createEventBus({
      outbox,
      queue: { enqueue: async (ref) => void refs.push(ref) },
      subscribers: [sub.subscriber],
      maxAttempts: 3,
    });
    return { db, outbox, bus, refs, seen: sub.seen };
  }

  it('stores the event with its delivery record, once per key, and queues it once', async () => {
    const w = world();
    const [event] = await w.bus.publishRuntime(ORG_A, ALICE, [DUE('fu_1')]);
    await w.bus.publishRuntime(ORG_A, ALICE, [DUE('fu_1')]);
    expect(w.refs).toEqual([{ organizationId: ORG_A, eventId: event?.id }]);
    const snapshot = await w.db.collection(DOMAIN_EVENTS).get();
    expect(snapshot.size).toBe(1);
    expect(snapshot.docs[0]?.data()).toMatchObject({
      organizationId: ORG_A,
      type: 'follow_up.due',
      status: 'queued',
      attempts: 0,
      event: {
        id: event?.id,
        source: 'follow_ups',
        actor: { type: 'system', id: 'runtime', initiatedBy: ALICE, via: 'runtime' },
        data: { contactId: 'contact_1', assignedTo: ALICE },
      },
    });
    expect(await w.outbox.find(ORG_A, event?.id ?? '')).toMatchObject({
      event: event as object,
      status: 'queued',
    });
  });

  it('delivers once, even when the queue delivers the same task twice at the same time', async () => {
    const w = world();
    const [event] = await w.bus.publishRuntime(ORG_A, ALICE, [DUE('fu_1')]);
    const ref = { organizationId: ORG_A, eventId: event?.id ?? '' };
    const results = await Promise.all([
      w.bus.deliver(ref, { retryCount: 0 }),
      w.bus.deliver(ref, { retryCount: 0 }),
    ]);
    // The other one found it held or already delivered.
    expect(['busy', 'already_delivered']).toContain(
      results.find((r) => r.kind !== 'delivered')?.kind,
    );
    expect(results.filter((r) => r.kind === 'delivered')).toHaveLength(1);
    expect(w.seen).toHaveLength(1);
    expect(await w.bus.deliver(ref, { retryCount: 1 })).toEqual({ kind: 'already_delivered' });
    expect(await w.outbox.find(ORG_A, ref.eventId)).toMatchObject({
      status: 'delivered',
      attempts: 1,
      deliveredTo: ['test.subscriber'],
      leaseId: null,
    });
  });

  it('retries, then sets the event aside as dead on the last attempt', async () => {
    const w = world(() => true);
    const [event] = await w.bus.publishRuntime(ORG_A, ALICE, [DUE('fu_1')]);
    const ref = { organizationId: ORG_A, eventId: event?.id ?? '' };
    const kinds = [];
    for (let retryCount = 0; retryCount < 3; retryCount += 1) {
      kinds.push((await w.bus.deliver(ref, { retryCount })).kind);
    }
    expect(kinds).toEqual(['retry', 'retry', 'dead']);
    expect(await w.outbox.find(ORG_A, ref.eventId)).toMatchObject({
      status: 'dead',
      attempts: 3,
      lastError: { subscriber: 'test.subscriber', code: 'downstream_down' },
      settledAt: expect.any(String),
    });
  });

  it("never gives one organization's event to a delivery for another", async () => {
    const w = world();
    const [event] = await w.bus.publishRuntime(ORG_A, ALICE, [DUE('fu_1')]);
    expect(
      await w.bus.deliver({ organizationId: ORG_B, eventId: event?.id ?? '' }, { retryCount: 0 }),
    ).toEqual({ kind: 'not_found' });
    expect(await w.outbox.find(ORG_B, event?.id ?? '')).toBeUndefined();
    expect(w.seen).toEqual([]);
    await expect(
      w.outbox.append([{ ...(event as DomainEvent), organizationId: ORG_B }], 'now'),
    ).rejects.toThrow('event id taken');
  });
});
