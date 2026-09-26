import { Timestamp } from '@google-cloud/firestore';
import type { UserId } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { emulatorFirestore, emulatorHost, emulatorRequired } from './test-firestore.js';
import { FirestoreUserDirectory, IDENTITIES, identityKey, USERS } from './users-firestore.js';

const NOW = new Date('2026-09-26T12:00:00Z');
const LATER = new Date('2026-09-26T12:05:00Z');
const alice = { subject: 'uid-alice', email: 'alice@example.com', emailVerified: false };

describe('the Firestore emulator', () => {
  it.runIf(emulatorRequired)('is available where it is required', () => {
    expect(emulatorHost).toBeDefined();
  });
});

describe.runIf(emulatorHost)('FirestoreUserDirectory (emulator)', () => {
  function setup() {
    const db = emulatorFirestore();
    let now = NOW;
    const users = new FirestoreUserDirectory(db, () => now);
    return { db, users, advance: () => (now = LATER) };
  }

  it('creates the user and its identity link on the first sign-in', async () => {
    const { db, users } = setup();
    const { user, created } = await users.recordSignIn(alice);
    expect(created).toBe(true);
    expect(user).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      identity: { provider: 'identity-platform', subject: 'uid-alice' },
      email: 'alice@example.com',
      emailVerified: false,
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
      lastLoginAt: NOW.toISOString(),
    });
    const link = await db.collection(IDENTITIES).doc(identityKey('uid-alice')).get();
    expect(link.data()).toEqual({
      provider: 'identity-platform',
      subject: 'uid-alice',
      userId: user.id,
      createdAt: Timestamp.fromDate(NOW),
    });
    expect((await db.collection(USERS).doc(user.id).get()).exists).toBe(true);
  });

  it('never keys users by email or by the provider id', async () => {
    const { db, users } = setup();
    const { user } = await users.recordSignIn(alice);
    expect(user.id).not.toBe('uid-alice');
    expect(user.id).not.toContain('alice');
    const ids = (await db.collection(USERS).listDocuments()).map((d) => d.id);
    expect(ids).toEqual([user.id]);
  });

  it('finds the user by subject and by id, and nothing for unknown ones', async () => {
    const { users } = setup();
    const { user } = await users.recordSignIn(alice);
    expect(await users.findBySubject('uid-alice')).toEqual(user);
    expect(await users.findById(user.id)).toEqual(user);
    expect(await users.findBySubject('uid-nobody')).toBeUndefined();
    expect(await users.findById('nobody' as UserId)).toBeUndefined();
  });

  it('is idempotent: a later sign-in returns the same user and refreshes allowed fields only', async () => {
    const { users, advance } = setup();
    const first = (await users.recordSignIn(alice)).user;
    advance();
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
      updatedAt: LATER.toISOString(),
      lastLoginAt: LATER.toISOString(),
    });
    expect(await users.findById(first.id)).toEqual(user);
  });

  it('drops a stored email when the token no longer carries one', async () => {
    const { users } = setup();
    await users.recordSignIn(alice);
    const { user } = await users.recordSignIn({ subject: 'uid-alice', emailVerified: false });
    expect(user.email).toBeUndefined();
  });

  it(
    'never creates two users for one subject under concurrent sign-ins',
    { timeout: 30_000 },
    async () => {
      const { db, users } = setup();
      const results = await Promise.all(
        Array.from({ length: 10 }, () => users.recordSignIn(alice)),
      );
      expect(new Set(results.map((r) => r.user.id)).size).toBe(1);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(await db.collection(USERS).listDocuments()).toHaveLength(1);
      expect(await db.collection(IDENTITIES).listDocuments()).toHaveLength(1);
    },
  );

  it('keeps different subjects apart, even when they share an email', async () => {
    const { users } = setup();
    const a = (await users.recordSignIn(alice)).user;
    const b = (await users.recordSignIn({ ...alice, subject: 'uid-other' })).user;
    expect(a.id).not.toBe(b.id);
    expect((await users.findBySubject('uid-other'))?.id).toBe(b.id);
  });

  it('refuses an identity record whose subject does not match', async () => {
    const { db, users } = setup();
    const { user } = await users.recordSignIn(alice);
    await db
      .collection(IDENTITIES)
      .doc(identityKey('uid-mallory'))
      .set({ provider: 'identity-platform', subject: 'uid-alice', userId: user.id });
    await expect(users.recordSignIn({ ...alice, subject: 'uid-mallory' })).rejects.toThrow(
      'identity record does not match subject',
    );
  });
});
