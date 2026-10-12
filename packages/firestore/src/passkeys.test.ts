import type { IsoTimestamp, UserId } from '@melonoffice/domain';
import {
  InMemoryPasskeyStore,
  isPasskeyError,
  type Passkey,
  type PasskeyConfirmation,
  type PasskeyStore,
} from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { FirestorePasskeyStore } from './passkeys.js';
import { emulatorFirestore, emulatorHost } from './testing.js';

/**
 * A passkey's signature counter (ADR-0188) only moves forward, checked where it is stored: a
 * replayed or cloned authenticator, or two confirmations racing with one value, never pass.
 */
const USER = '11111111-1111-4111-8111-111111111111' as UserId;
const AT = '2026-10-12T02:00:00.000Z' as IsoTimestamp;

const passkey = (counter: number): Passkey => ({
  id: 'pk-1',
  userId: USER,
  credentialId: 'cred-1',
  publicKey: 'cHVibGlj',
  counter,
  transports: ['internal'],
  createdAt: AT,
  lastUsedAt: null,
});
const confirmation = (id: string): PasskeyConfirmation => ({
  id,
  userId: USER,
  passkeyId: 'pk-1',
  confirmedAt: AT,
  expiresAt: '2026-10-12T02:30:00.000Z' as IsoTimestamp,
});
const codeOf = (error: unknown) => (isPasskeyError(error) ? error.code : error);

const STORES: readonly [string, () => PasskeyStore, boolean][] = [
  ['memory', () => new InMemoryPasskeyStore(), true],
  ['Firestore', () => new FirestorePasskeyStore(emulatorFirestore()), emulatorHost !== undefined],
];

describe.each(STORES)('the passkey counter in %s', (_name, create, runs) => {
  it.runIf(runs)('moves forward, and a repeated or older value is refused', async () => {
    const store = create();
    await store.addPasskey(passkey(5), []);
    await store.confirm(passkey(5), 6, confirmation('c1'), []);
    await expect(
      store.confirm(passkey(5), 6, confirmation('c2'), []).catch((e: unknown) => {
        throw codeOf(e);
      }),
    ).rejects.toBe('passkey_counter');
    await expect(
      store.confirm(passkey(5), 3, confirmation('c3'), []).catch((e: unknown) => {
        throw codeOf(e);
      }),
    ).rejects.toBe('passkey_counter');
    expect(await store.findConfirmation('c2', new Date(AT))).toBeUndefined();
  });

  it.runIf(runs)('lets an authenticator without a counter answer 0 every time', async () => {
    const store = create();
    await store.addPasskey(passkey(0), []);
    await store.confirm(passkey(0), 0, confirmation('c1'), []);
    await store.confirm(passkey(0), 0, confirmation('c2'), []);
    expect(await store.findConfirmation('c2', new Date(AT))).toBeDefined();
  });
});
