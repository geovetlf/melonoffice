import type { UserId } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { authenticate, type AuthDependencies } from './authenticate.js';
import { actAsGia } from './context.js';
import { AuthError } from './errors.js';
import { createIdentityPlatformVerifier } from './identity-platform.js';
import { createSigner, NOW, PROJECT_ID } from './test-tokens.js';
import { InMemoryUserDirectory, type UserDirectory } from './users.js';

const registerSubject = async (users: UserDirectory, subject: string) =>
  (await users.recordSignIn({ subject, emailVerified: false })).user;

async function setup() {
  const signer = await createSigner();
  const users = new InMemoryUserDirectory(() => NOW);
  const deps: AuthDependencies = {
    verifier: createIdentityPlatformVerifier({
      projectId: PROJECT_ID,
      keys: signer.keys,
      now: () => NOW,
    }),
    users,
  };
  return { ...signer, users, deps };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof AuthError) return error.code;
    throw error;
  }
  return 'accepted';
}

describe('authenticate', () => {
  it('identifies a registered user from a valid token', async () => {
    const { sign, users, deps } = await setup();
    const alice = await registerSubject(users, 'uid-alice');
    const context = await authenticate({ authorization: `Bearer ${await sign()}` }, deps);
    expect(context).toEqual({
      actor: 'user',
      userId: alice.id,
      email: 'alice@example.com',
      emailVerified: true,
    });
    expect(Object.isFrozen(context)).toBe(true);
  });

  it('never uses the provider subject as the internal user id', async () => {
    const { sign, users, deps } = await setup();
    await registerSubject(users, 'uid-alice');
    const context = await authenticate({ authorization: `Bearer ${await sign()}` }, deps);
    expect(context.userId).not.toBe('uid-alice');
  });

  it('rejects a request without a token', async () => {
    const { deps } = await setup();
    expect(await codeOf(authenticate({ authorization: undefined }, deps))).toBe('missing_token');
  });

  it('rejects a malformed authorization header', async () => {
    const { deps } = await setup();
    expect(await codeOf(authenticate({ authorization: 'Basic abc' }, deps))).toBe('invalid_token');
  });

  it('rejects a valid token for a user that is not registered', async () => {
    const { sign, deps } = await setup();
    expect(await codeOf(authenticate({ authorization: `Bearer ${await sign()}` }, deps))).toBe(
      'user_not_registered',
    );
  });

  it('keeps users apart: each token maps to its own user', async () => {
    const { sign, users, deps } = await setup();
    const alice = await registerSubject(users, 'uid-alice');
    const bob = await registerSubject(users, 'uid-bob');
    const asBob = await authenticate(
      { authorization: `Bearer ${await sign({ sub: 'uid-bob', email: 'bob@example.com' })}` },
      deps,
    );
    expect(asBob.userId).toBe(bob.id);
    expect(asBob.userId).not.toBe(alice.id);
  });
});

describe('actAsGia', () => {
  it('keeps the same user and identity, and only marks the actor', async () => {
    const context = Object.freeze({
      actor: 'user' as const,
      userId: 'u1' as UserId,
      email: 'alice@example.com',
      emailVerified: true,
    });
    const gia = actAsGia(context);
    expect(gia).toEqual({ ...context, actor: 'gia' });
    expect(Object.isFrozen(gia)).toBe(true);
    expect(context.actor).toBe('user');
  });

  it('cannot be widened or redirected: extra arguments are type errors and are ignored', () => {
    const context = { actor: 'user' as const, userId: 'u1' as UserId, emailVerified: false };
    // @ts-expect-error actAsGia takes exactly one context argument.
    const gia = actAsGia(context, { userId: 'u2' });
    expect(gia.userId).toBe('u1');
  });
});

describe('InMemoryUserDirectory', () => {
  const alice = { subject: 'uid-alice', email: 'alice@example.com', emailVerified: false };

  it('creates the user on the first sign-in', async () => {
    const users = new InMemoryUserDirectory(() => NOW);
    const { user, created } = await users.recordSignIn(alice);
    expect(created).toBe(true);
    expect(user).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      identity: { provider: 'identity-platform', subject: 'uid-alice' },
      email: 'alice@example.com',
      emailVerified: false,
      createdAt: '2026-09-26T12:00:00.000Z',
      updatedAt: '2026-09-26T12:00:00.000Z',
      lastLoginAt: '2026-09-26T12:00:00.000Z',
    });
    expect(await users.findById(user.id)).toEqual(user);
    expect(await users.findBySubject('uid-alice')).toEqual(user);
  });

  it('refreshes only the email, its flag and the sign-in time on later sign-ins', async () => {
    let now = NOW;
    const users = new InMemoryUserDirectory(() => now);
    const first = (await users.recordSignIn(alice)).user;
    now = new Date(NOW.getTime() + 60_000);
    const { user, created } = await users.recordSignIn({
      subject: 'uid-alice',
      email: 'alice@new.example.com',
      emailVerified: true,
    });
    expect(created).toBe(false);
    expect(user).toEqual({
      ...first,
      email: 'alice@new.example.com',
      emailVerified: true,
      updatedAt: '2026-09-26T12:01:00.000Z',
      lastLoginAt: '2026-09-26T12:01:00.000Z',
    });
  });

  it('never creates two users for one subject, even concurrently', async () => {
    const users = new InMemoryUserDirectory(() => NOW);
    const results = await Promise.all(Array.from({ length: 10 }, () => users.recordSignIn(alice)));
    expect(new Set(results.map((r) => r.user.id)).size).toBe(1);
    expect(results.filter((r) => r.created)).toHaveLength(1);
  });
});
