import type { ChannelConnectionId, OrganizationId } from '@melonoffice/domain';
import {
  InMemoryConnectionRateLimiter,
  type ConnectionRateLimiter,
} from '@melonoffice/integrations';
import { describe, expect, it } from 'vitest';
import { CONNECTION_RATE_WINDOWS, FirestoreConnectionRateLimiter } from './rate-limits.js';
import { emulatorFirestore, emulatorHost } from './testing.js';

const NOW = new Date('2026-09-28T12:00:00Z');
const ORG_A = '11111111-1111-4111-8111-111111111111' as OrganizationId;
const ORG_B = '22222222-2222-4222-8222-222222222222' as OrganizationId;
const CONN_1 = '33333333-3333-4333-8333-333333333333' as ChannelConnectionId;
const CONN_2 = '44444444-4444-4444-8444-444444444444' as ChannelConnectionId;
const LIMIT = { windowMs: 60_000, maxSends: 3 };
const at = (ms: number) => new Date(NOW.getTime() + ms);

const limiters: [string, () => ConnectionRateLimiter][] = [
  ['memory', () => new InMemoryConnectionRateLimiter()],
  ...(emulatorHost
    ? [
        ['firestore', () => new FirestoreConnectionRateLimiter(emulatorFirestore())] as [
          string,
          () => ConnectionRateLimiter,
        ],
      ]
    : []),
];

describe.each(limiters)('connection rate limiter (%s)', (_, make) => {
  it('A: allows the limit in a window, then refuses until the window is over', async () => {
    const limiter = make();
    const key = { organizationId: ORG_A, connectionId: CONN_1 };
    for (let i = 0; i < 3; i += 1) {
      expect(await limiter.acquire(key, LIMIT, at(i))).toEqual({ allowed: true });
    }
    expect(await limiter.acquire(key, LIMIT, at(10_000))).toEqual({
      allowed: false,
      retryAfterMs: 50_000,
    });
    expect(await limiter.acquire(key, LIMIT, at(60_000))).toEqual({ allowed: true });
  });

  it('B: never shares a count between organizations or connections', async () => {
    const limiter = make();
    for (let i = 0; i < 3; i += 1) {
      await limiter.acquire({ organizationId: ORG_A, connectionId: CONN_1 }, LIMIT, at(i));
    }
    expect(
      (await limiter.acquire({ organizationId: ORG_A, connectionId: CONN_1 }, LIMIT, at(5)))
        .allowed,
    ).toBe(false);
    // The same connection id under another organization, and another connection: untouched.
    expect(
      (await limiter.acquire({ organizationId: ORG_B, connectionId: CONN_1 }, LIMIT, at(5)))
        .allowed,
    ).toBe(true);
    expect(
      (await limiter.acquire({ organizationId: ORG_A, connectionId: CONN_2 }, LIMIT, at(5)))
        .allowed,
    ).toBe(true);
  });

  it('C: concurrent senders (agents, processes) never pass the limit together', async () => {
    const limiter = make();
    const key = { organizationId: ORG_A, connectionId: CONN_1 };
    const decisions = await Promise.all(
      Array.from({ length: 8 }, (_, i) => limiter.acquire(key, LIMIT, at(i))),
    );
    expect(decisions.filter((d) => d.allowed)).toHaveLength(3);
  });

  it('counts a window a slightly faster clock started, but never locks out on a clock jump', async () => {
    const limiter = make();
    const key = { organizationId: ORG_A, connectionId: CONN_1 };
    for (let i = 0; i < 3; i += 1) await limiter.acquire(key, LIMIT, at(2_000 + i));
    // Another instance, 2 s behind: the same window, full.
    expect(await limiter.acquire(key, LIMIT, at(0))).toEqual({
      allowed: false,
      retryAfterMs: 60_000,
    });
    // A clock more than a window behind: the stored window is not trusted.
    expect((await limiter.acquire(key, LIMIT, at(-70_000))).allowed).toBe(true);
  });
});

describe.runIf(emulatorHost)('FirestoreConnectionRateLimiter (emulator)', () => {
  it('shares one window across instances, and stores no message, recipient or secret', async () => {
    const db = emulatorFirestore();
    const one = new FirestoreConnectionRateLimiter(db);
    const two = new FirestoreConnectionRateLimiter(db);
    const key = { organizationId: ORG_A, connectionId: CONN_1 };
    const decisions = await Promise.all([
      one.acquire(key, LIMIT, at(0)),
      two.acquire(key, LIMIT, at(1)),
      one.acquire(key, LIMIT, at(2)),
      two.acquire(key, LIMIT, at(3)),
    ]);
    expect(decisions.filter((d) => d.allowed)).toHaveLength(3);
    const stored = await db.collection(CONNECTION_RATE_WINDOWS).doc(`${ORG_A}_${CONN_1}`).get();
    expect(Object.keys(stored.data() ?? {}).sort()).toEqual([
      'connectionId',
      'count',
      'organizationId',
      'startedAt',
    ]);
    expect(stored.data()?.count).toBe(3);
  });

  it("ignores a stored window that names another organization's connection", async () => {
    const db = emulatorFirestore();
    await db
      .collection(CONNECTION_RATE_WINDOWS)
      .doc(`${ORG_A}_${CONN_1}`)
      .set({ organizationId: ORG_B, connectionId: CONN_1, startedAt: NOW.getTime(), count: 99 });
    const limiter = new FirestoreConnectionRateLimiter(db);
    expect(
      (await limiter.acquire({ organizationId: ORG_A, connectionId: CONN_1 }, LIMIT, at(1)))
        .allowed,
    ).toBe(true);
  });
});
