import type { Firestore, Transaction } from '@google-cloud/firestore';
import type { AuditEvent } from '@melonoffice/audit';
import type { IsoTimestamp, UserId } from '@melonoffice/domain';
import {
  counterMovesOn,
  MAX_PASSKEYS_PER_PERSON,
  PasskeyError,
  type Passkey,
  type PasskeyChallenge,
  type PasskeyConfirmation,
  type PasskeyPurpose,
  type PasskeyStore,
} from '@melonoffice/tenancy';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';

/**
 * Passkeys (ADR-0188), read and written only by the API, never by clients.
 *
 * - `passkeys/{passkeyId}`: a person's passkey: its public key, credential id and counter.
 * - `passkeyChallenges/{id}`: a one-time challenge, deleted when it is answered.
 * - `passkeyConfirmations/{sha256(token)}`: a passkey confirmation for 30 minutes; the token
 *   itself is only in the person's browser.
 */
export const PASSKEYS = 'passkeys';
export const PASSKEY_CHALLENGES = 'passkeyChallenges';
export const PASSKEY_CONFIRMATIONS = 'passkeyConfirmations';

type PasskeyDocument = Omit<Passkey, 'id'>;

const PURPOSES: readonly string[] = ['register', 'confirm'];

function toPasskey(id: string, d: Record<string, unknown> | undefined): Passkey | undefined {
  if (
    d === undefined ||
    typeof d.userId !== 'string' ||
    typeof d.credentialId !== 'string' ||
    typeof d.publicKey !== 'string' ||
    typeof d.counter !== 'number' ||
    !Array.isArray(d.transports) ||
    typeof d.createdAt !== 'string' ||
    (d.lastUsedAt !== null && typeof d.lastUsedAt !== 'string')
  ) {
    return undefined;
  }
  return Object.freeze({
    id,
    userId: d.userId as UserId,
    credentialId: d.credentialId,
    publicKey: d.publicKey,
    counter: d.counter,
    transports: Object.freeze(d.transports.filter((t): t is string => typeof t === 'string')),
    createdAt: d.createdAt as IsoTimestamp,
    lastUsedAt: d.lastUsedAt as IsoTimestamp | null,
  });
}

function toConfirmation(
  id: string,
  d: Record<string, unknown> | undefined,
): PasskeyConfirmation | undefined {
  if (
    d === undefined ||
    typeof d.userId !== 'string' ||
    typeof d.passkeyId !== 'string' ||
    typeof d.confirmedAt !== 'string' ||
    typeof d.expiresAt !== 'string'
  ) {
    return undefined;
  }
  return Object.freeze({
    id,
    userId: d.userId as UserId,
    passkeyId: d.passkeyId,
    confirmedAt: d.confirmedAt as IsoTimestamp,
    expiresAt: d.expiresAt as IsoTimestamp,
  });
}

/** Passkeys in Firestore: every write and its audit in one transaction. */
export class FirestorePasskeyStore implements PasskeyStore {
  constructor(private readonly db: Firestore) {}

  async passkeysOf(userId: UserId) {
    const snapshot = await this.db.collection(PASSKEYS).where('userId', '==', userId).get();
    return snapshot.docs
      .map((doc) => toPasskey(doc.id, doc.data()))
      .filter((p): p is Passkey => p !== undefined && p.userId === userId);
  }

  async findByCredential(credentialId: string) {
    const snapshot = await this.db
      .collection(PASSKEYS)
      .where('credentialId', '==', credentialId)
      .limit(1)
      .get();
    const doc = snapshot.docs[0];
    const passkey = doc === undefined ? undefined : toPasskey(doc.id, doc.data());
    return passkey?.credentialId === credentialId ? passkey : undefined;
  }

  async saveChallenge(challenge: PasskeyChallenge) {
    const { id, ...rest } = challenge;
    await this.db.collection(PASSKEY_CHALLENGES).doc(id).create(rest);
  }

  async takeChallenge(id: string, userId: UserId, purpose: PasskeyPurpose, now: Date) {
    const ref = this.db.collection(PASSKEY_CHALLENGES).doc(id);
    return this.db.runTransaction(async (tx) => {
      const d = (await tx.get(ref)).data();
      if (d === undefined) return undefined;
      tx.delete(ref);
      if (
        d.userId !== userId ||
        d.purpose !== purpose ||
        !PURPOSES.includes(d.purpose as string) ||
        typeof d.challenge !== 'string' ||
        typeof d.expiresAt !== 'string' ||
        Date.parse(d.expiresAt) <= now.getTime()
      ) {
        return undefined;
      }
      return Object.freeze({
        id,
        userId,
        purpose,
        challenge: d.challenge,
        expiresAt: d.expiresAt as IsoTimestamp,
      });
    });
  }

  async addPasskey(passkey: Passkey, events: readonly AuditEvent[]) {
    const passkeys = this.db.collection(PASSKEYS);
    await this.db.runTransaction(async (tx) => {
      const [taken, mine] = await Promise.all([
        tx.get(passkeys.where('credentialId', '==', passkey.credentialId).limit(1)),
        tx.get(passkeys.where('userId', '==', passkey.userId)),
      ]);
      if (!taken.empty) throw new PasskeyError('passkey_exists');
      if (mine.size >= MAX_PASSKEYS_PER_PERSON) throw new PasskeyError('passkey_limit');
      const { id, ...rest } = passkey;
      const document: PasskeyDocument = { ...rest, transports: [...rest.transports] };
      tx.create(passkeys.doc(id), document);
      this.#audit(tx, events);
    });
  }

  async confirm(
    passkey: Passkey,
    counter: number,
    confirmation: PasskeyConfirmation,
    events: readonly AuditEvent[],
  ) {
    const ref = this.db.collection(PASSKEYS).doc(passkey.id);
    await this.db.runTransaction(async (tx) => {
      const stored = toPasskey(passkey.id, (await tx.get(ref)).data());
      if (stored === undefined || stored.userId !== passkey.userId) {
        throw new PasskeyError('passkey_not_found');
      }
      if (!counterMovesOn(stored.counter, counter)) throw new PasskeyError('passkey_counter');
      tx.update(ref, { counter, lastUsedAt: confirmation.confirmedAt });
      const { id, ...rest } = confirmation;
      tx.create(this.db.collection(PASSKEY_CONFIRMATIONS).doc(id), rest);
      this.#audit(tx, events);
    });
  }

  async findConfirmation(id: string, now: Date) {
    const snapshot = await this.db.collection(PASSKEY_CONFIRMATIONS).doc(id).get();
    const confirmation = toConfirmation(id, snapshot.data());
    return confirmation !== undefined && Date.parse(confirmation.expiresAt) > now.getTime()
      ? confirmation
      : undefined;
  }

  async removePasskeys(
    userId: UserId,
    passkeyId: string | undefined,
    events: readonly AuditEvent[],
  ) {
    return this.db.runTransaction(async (tx) => {
      const [mine, confirmations] = await Promise.all([
        tx.get(this.db.collection(PASSKEYS).where('userId', '==', userId)),
        tx.get(this.db.collection(PASSKEY_CONFIRMATIONS).where('userId', '==', userId)),
      ]);
      const gone = mine.docs.filter(
        (doc) => doc.data().userId === userId && (passkeyId === undefined || doc.id === passkeyId),
      );
      if (gone.length === 0) return 0;
      const ids = new Set(gone.map((doc) => doc.id));
      for (const doc of gone) tx.delete(doc.ref);
      for (const doc of confirmations.docs) {
        if (ids.has(doc.data().passkeyId as string)) tx.delete(doc.ref);
      }
      this.#audit(tx, events);
      return gone.length;
    });
  }

  #audit(tx: Transaction, events: readonly AuditEvent[]) {
    for (const event of events) {
      tx.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
    }
  }
}
