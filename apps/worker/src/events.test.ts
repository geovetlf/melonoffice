import { createServiceIdentityVerifier } from '@melonoffice/auth';
import type { FollowUpTask } from '@melonoffice/conversations';
import type { FollowUp, UserId } from '@melonoffice/domain';
import {
  createEventBus,
  eventIdFor,
  InMemoryEventOutbox,
  type DomainEvent,
  type EventDeliveryRef,
  type EventSubscriber,
} from '@melonoffice/events';
import { createLogger } from '@melonoffice/observability';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import { describe, expect, it } from 'vitest';
import { createApp, RUN_JOB_PATH } from './app.js';
import { createEventHandler, RUN_EVENT_PATH } from './events.js';
import {
  createFollowUpHandler,
  FOLLOW_UP_MAX_ATTEMPTS,
  RETRY_COUNT_HEADER,
  RUN_FOLLOW_UP_PATH,
} from './follow-ups.js';

const WORKER_URL = 'https://worker-123456789012.us-central1.run.app';
const INVOKER = 'job-dispatch@melonoffice-test.iam.gserviceaccount.com';
const ORG = '0f8fad5b-d9cb-469f-a165-70867728950e';
const OTHER_ORG = '9b2e6f1a-1c3d-4e5f-8a9b-0c1d2e3f4a5b';
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const MARIA = '33333333-3333-4333-8333-333333333333' as UserId;
const TASK = {
  organizationId: ORG,
  followUpId: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  schedule: 2,
};

/** The follow-up the service made due: a record, as Firestore holds it. */
const FOLLOW_UP = {
  id: TASK.followUpId,
  organizationId: ORG,
  contactId: 'contact_1',
  opportunityId: 'opp_1',
  assignedTo: MARIA,
  title: 'Llamar a Juan',
  schedule: 2,
  status: 'due',
  dueAt: '2026-09-29T15:00:00.000Z',
  createdBy: ALICE,
} as unknown as FollowUp;

async function google() {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'google', alg: 'RS256', use: 'sig' };
  const nowSeconds = Math.floor(Date.now() / 1000);
  return {
    keys: createLocalJWKSet({ keys: [jwk] }),
    async token(claims: Record<string, unknown> = {}) {
      return new SignJWT({
        iss: 'https://accounts.google.com',
        aud: WORKER_URL,
        sub: '1234567890',
        email: INVOKER,
        email_verified: true,
        iat: nowSeconds - 10,
        exp: nowSeconds + 3600,
        ...claims,
      } as JWTPayload)
        .setProtectedHeader({ alg: 'RS256', typ: 'JWT', kid: 'google' })
        .sign(privateKey);
    },
  };
}

/**
 * The worker as it runs (EV-2): the follow-up handler publishes through the bus; the bus stores
 * the event in the outbox and queues `{ organizationId, eventId }`; the queue calls the events
 * route, which delivers it. Only the Cloud Tasks transport and Firestore are replaced.
 */
async function worker(options: { failing?: () => boolean; runDue?: () => Promise<unknown> } = {}) {
  const signer = await google();
  const outbox = new InMemoryEventOutbox();
  const queued: EventDeliveryRef[] = [];
  let queueDown = false;
  const seen: DomainEvent[] = [];
  const subscriber: EventSubscriber = {
    id: 'test.subscriber',
    types: ['follow_up.due'],
    async handle(event) {
      if (options.failing?.() === true) throw Object.assign(new Error('x'), { code: 'down' });
      seen.push(event);
    },
  };
  const bus = createEventBus({
    outbox,
    queue: {
      async enqueue(ref) {
        if (queueDown) throw new Error('queue down');
        queued.push(ref);
      },
    },
    subscribers: [subscriber],
  });
  const ran: FollowUpTask[] = [];
  const logger = createLogger({ service: 'worker', sink: () => undefined });
  const app = createApp({
    logger,
    version: 'test',
    jobs: {
      handler: { run: async () => ({ status: 200, body: { result: 'done' } }) } as never,
      invoker: createServiceIdentityVerifier({
        audience: WORKER_URL,
        allowedEmails: [INVOKER],
        keys: signer.keys,
      }),
      followUps: createFollowUpHandler({
        followUps: {
          runDue: async (task) => {
            ran.push(task);
            return (await (
              options.runDue ?? (async () => ({ kind: 'due', followUp: FOLLOW_UP }))
            )()) as never;
          },
          failDue: async () => true,
        },
        events: bus,
      }),
      events: createEventHandler({ events: bus }),
    },
  });
  const post = async (
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
    token?: string,
  ) => {
    const response = await app.request(path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${token ?? (await signer.token())}`,
        ...headers,
      },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: (await response.json()) as Record<string, unknown> };
  };
  return {
    signer,
    outbox,
    queued,
    seen,
    ran,
    post,
    setQueueDown: (down: boolean) => {
      queueDown = down;
    },
  };
}

const EVENT_ID = eventIdFor(ORG as never, 'follow_up.due', `${TASK.followUpId}:2`);

describe('follow_up.due, end to end in the worker (EV-2)', () => {
  it('a follow-up that comes due is published, queued, delivered once and recorded', async () => {
    const w = await worker();
    expect(await w.post(RUN_FOLLOW_UP_PATH, TASK)).toEqual({
      status: 200,
      body: { result: 'due' },
    });
    // Stored, then queued with its reference only.
    expect(w.queued).toEqual([{ organizationId: ORG, eventId: EVENT_ID }]);
    const record = await w.outbox.find(ORG as never, EVENT_ID);
    expect(record?.event).toEqual({
      id: EVENT_ID,
      type: 'follow_up.due',
      version: 1,
      organizationId: ORG,
      occurredAt: '2026-09-29T15:00:00.000Z',
      actor: { type: 'system', id: 'runtime', initiatedBy: ALICE, via: 'runtime' },
      subject: { type: 'follow_up', id: TASK.followUpId },
      data: { contactId: 'contact_1', opportunityId: 'opp_1', assignedTo: MARIA },
      correlationId: null,
      source: 'follow_ups',
    });
    // References only: never the title or a person's name.
    expect(JSON.stringify(record)).not.toContain('Juan');
    // The queue calls the events route.
    expect(await w.post(RUN_EVENT_PATH, w.queued[0])).toEqual({
      status: 200,
      body: { result: 'delivered' },
    });
    expect(w.seen.map((e) => e.id)).toEqual([EVENT_ID]);
    expect(await w.outbox.find(ORG as never, EVENT_ID)).toMatchObject({
      status: 'delivered',
      deliveredTo: ['test.subscriber'],
    });
  });

  it('a repeated follow-up task publishes the same event: stored, queued and delivered once', async () => {
    let calls = 0;
    // The queue delivers the follow-up task again: the service finds it already due.
    const w = await worker({
      runDue: async () => ({ kind: calls++ === 0 ? 'due' : 'already_due', followUp: FOLLOW_UP }),
    });
    expect(await w.post(RUN_FOLLOW_UP_PATH, TASK)).toMatchObject({ status: 200 });
    expect(await w.post(RUN_EVENT_PATH, w.queued[0])).toMatchObject({ status: 200 });
    expect(await w.post(RUN_FOLLOW_UP_PATH, TASK)).toEqual({
      status: 200,
      body: { result: 'already_due' },
    });
    expect(w.ran).toHaveLength(2);
    expect(w.queued).toHaveLength(1);
    expect(await w.post(RUN_EVENT_PATH, w.queued[0])).toEqual({
      status: 200,
      body: { result: 'already_delivered' },
    });
    expect(w.seen).toHaveLength(1);
  });

  it('when the queue is down the follow-up task is retried, and its retry queues the stored event', async () => {
    const w = await worker();
    w.setQueueDown(true);
    expect(await w.post(RUN_FOLLOW_UP_PATH, TASK)).toEqual({
      status: 503,
      body: { result: 'unavailable', code: 'event_not_published' },
    });
    expect(await w.outbox.find(ORG as never, EVENT_ID)).toMatchObject({ status: 'pending' });
    w.setQueueDown(false);
    expect(await w.post(RUN_FOLLOW_UP_PATH, TASK, { [RETRY_COUNT_HEADER]: '1' })).toMatchObject({
      status: 200,
    });
    expect(w.queued).toEqual([{ organizationId: ORG, eventId: EVENT_ID }]);
    // On the queue's last attempt the follow-up stays due and the task ends; the log says so.
    const last = await worker();
    last.setQueueDown(true);
    expect(
      await last.post(RUN_FOLLOW_UP_PATH, TASK, {
        [RETRY_COUNT_HEADER]: String(FOLLOW_UP_MAX_ATTEMPTS - 1),
      }),
    ).toEqual({ status: 200, body: { result: 'due', code: 'event_not_published' } });
  });

  it('nothing is published for a stale, early or ended follow-up task', async () => {
    for (const kind of ['stale', 'early', 'cancelled', 'not_found']) {
      const w = await worker({ runDue: async () => ({ kind }) });
      expect(await w.post(RUN_FOLLOW_UP_PATH, TASK)).toEqual({
        status: 200,
        body: { result: kind },
      });
      expect(w.queued).toEqual([]);
    }
  });

  it('a failing subscriber is retried by the queue, then set aside on its last attempt', async () => {
    const w = await worker({ failing: () => true });
    await w.post(RUN_FOLLOW_UP_PATH, TASK);
    const ref = w.queued[0];
    expect(await w.post(RUN_EVENT_PATH, ref)).toEqual({
      status: 503,
      body: { result: 'retry', code: 'down' },
    });
    expect(
      await w.post(RUN_EVENT_PATH, ref, {
        [RETRY_COUNT_HEADER]: String(FOLLOW_UP_MAX_ATTEMPTS - 1),
      }),
    ).toEqual({ status: 200, body: { result: 'dead', code: 'down' } });
    expect(await w.outbox.find(ORG as never, EVENT_ID)).toMatchObject({ status: 'dead' });
    // Set aside: the queue's next delivery ends it.
    expect(await w.post(RUN_EVENT_PATH, ref)).toEqual({
      status: 200,
      body: { result: 'already_dead' },
    });
  });
});

describe('POST /internal/events/run (EV-2)', () => {
  it('delivers only for the invoker, only exactly { organizationId, eventId }', async () => {
    const w = await worker();
    await w.post(RUN_FOLLOW_UP_PATH, TASK);
    const ref = w.queued[0];
    expect(
      (
        await w.post(
          RUN_EVENT_PATH,
          ref,
          {},
          await w.signer.token({ email: 'other@x.iam.gserviceaccount.com' }),
        )
      ).status,
    ).toBe(403);
    expect((await w.post(RUN_EVENT_PATH, ref, { authorization: '' })).status).toBe(401);
    for (const bad of [
      null,
      [],
      { ...ref, extra: 1 },
      { ...ref, eventId: 'evt_x' },
      { ...ref, organizationId: 'not-a-uuid' },
      { eventId: EVENT_ID },
    ]) {
      expect(await w.post(RUN_EVENT_PATH, bad)).toEqual({
        status: 400,
        body: { result: 'invalid_request' },
      });
    }
    expect(w.seen).toEqual([]);
    expect(RUN_EVENT_PATH).not.toBe(RUN_JOB_PATH);
  });

  it("never delivers one organization's event for another", async () => {
    const w = await worker();
    await w.post(RUN_FOLLOW_UP_PATH, TASK);
    expect(await w.post(RUN_EVENT_PATH, { organizationId: OTHER_ORG, eventId: EVENT_ID })).toEqual({
      status: 200,
      body: { result: 'not_found' },
    });
    expect(w.seen).toEqual([]);
  });

  it('asks the queue to retry when the outbox is out of reach, and is refused where events are not configured', async () => {
    const handler = createEventHandler({
      events: {
        deliver: async () => {
          throw new Error('firestore down');
        },
      },
    });
    expect(await handler.run({ organizationId: ORG, eventId: EVENT_ID }, 0)).toEqual({
      status: 503,
      body: { result: 'unavailable' },
    });
    const app = createApp({
      logger: createLogger({ service: 'worker', sink: () => undefined }),
      version: 'test',
      jobs: {
        handler: { run: async () => ({ status: 200, body: {} }) } as never,
        invoker: createServiceIdentityVerifier({ audience: WORKER_URL, allowedEmails: [INVOKER] }),
      },
    });
    const response = await app.request(RUN_EVENT_PATH, { method: 'POST' });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: 'events_not_configured' });
  });
});
