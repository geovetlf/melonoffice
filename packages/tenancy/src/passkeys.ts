import type { AuditEvent, InMemoryAuditStore } from '@melonoffice/audit';
import type { IsoTimestamp, UserId } from '@melonoffice/domain';
import { createHash, randomBytes, randomUUID } from 'node:crypto';

/**
 * Passkeys for sensitive administrators (ADR-0188, S-2). A platform, white-label or reseller
 * administrator may add passkeys: the device's own sign-in (fingerprint, face, PIN) proves it is
 * them, with no typed code. Once they have one, their administrative changes need a passkey
 * confirmation from the last 30 minutes instead of a recent password sign-in (ADR-0138). A business
 * owner never meets any of this.
 *
 * Only public material is stored: the credential's public key, its id and its signature counter.
 * The private key never leaves the person's device.
 */

/** One passkey of one person. `credentialId` and `publicKey` are base64url. */
export interface Passkey {
  /** Ours: what the person and the audit trail name it by. */
  readonly id: string;
  readonly userId: UserId;
  /** The authenticator's credential id, unique across every person. */
  readonly credentialId: string;
  readonly publicKey: string;
  /** The authenticator's signature counter: a value that goes back means a cloned key. */
  readonly counter: number;
  readonly transports: readonly string[];
  readonly createdAt: IsoTimestamp;
  readonly lastUsedAt: IsoTimestamp | null;
}

/** What a passkey ceremony is for. */
export type PasskeyPurpose = 'register' | 'confirm';

/** A one-time challenge: it works once, for its person and purpose, until it expires. */
export interface PasskeyChallenge {
  readonly id: string;
  readonly userId: UserId;
  readonly purpose: PasskeyPurpose;
  /** base64url, as the browser signs it. */
  readonly challenge: string;
  readonly expiresAt: IsoTimestamp;
}

/**
 * A passkey confirmation: proof, for 30 minutes, that the person just used one of their passkeys.
 * The browser keeps the token; only its SHA-256 is stored, as `id`.
 */
export interface PasskeyConfirmation {
  readonly id: string;
  readonly userId: UserId;
  readonly passkeyId: string;
  readonly confirmedAt: IsoTimestamp;
  readonly expiresAt: IsoTimestamp;
}

/** How long a passkey confirmation counts, the same window as a recent sign-in (ADR-0138). */
export const PASSKEY_CONFIRMATION_TTL_MS = 30 * 60 * 1000;
/** How long the browser has to answer a challenge. */
export const PASSKEY_CHALLENGE_TTL_MS = 5 * 60 * 1000;
/** Enough for a phone, a laptop and a spare key; more is likely a mistake or an attack. */
export const MAX_PASSKEYS_PER_PERSON = 10;

export interface PasskeyStore {
  passkeysOf(userId: UserId): Promise<readonly Passkey[]>;
  findByCredential(credentialId: string): Promise<Passkey | undefined>;
  saveChallenge(challenge: PasskeyChallenge): Promise<void>;
  /**
   * Takes a challenge exactly once: it is deleted whatever the outcome. Undefined when it does
   * not exist, belongs to someone else, is for another purpose or expired.
   */
  takeChallenge(
    id: string,
    userId: UserId,
    purpose: PasskeyPurpose,
    now: Date,
  ): Promise<PasskeyChallenge | undefined>;
  /**
   * Adds a passkey with its audit, in one write. Refused with `passkey_exists` when its
   * credential is already anyone's, and `passkey_limit` past `MAX_PASSKEYS_PER_PERSON`.
   */
  addPasskey(passkey: Passkey, events: readonly AuditEvent[]): Promise<void>;
  /**
   * Records a passkey's use (new counter, when) and stores a confirmation, with its audit, in one
   * write. Refused with `passkey_not_found` when the passkey is gone.
   */
  confirm(
    passkey: Passkey,
    counter: number,
    confirmation: PasskeyConfirmation,
    events: readonly AuditEvent[],
  ): Promise<void>;
  /** A live confirmation by its token's hash, or undefined. */
  findConfirmation(id: string, now: Date): Promise<PasskeyConfirmation | undefined>;
  /**
   * Removes one of a person's passkeys, or all of them when `passkeyId` is undefined (a platform
   * reset), with their confirmations and the audit, in one write. Answers how many were removed.
   */
  removePasskeys(
    userId: UserId,
    passkeyId: string | undefined,
    events: readonly AuditEvent[],
  ): Promise<number>;
}

export type PasskeyErrorCode =
  | 'passkey_exists'
  | 'passkey_limit'
  | 'passkey_not_found'
  /** The signature counter did not move past the stored one: a replay or a cloned key. */
  | 'passkey_counter';

/**
 * Whether a confirmation's counter may follow the stored one (WebAuthn §6.1.1): an authenticator
 * without a counter answers 0 every time; any other must move forward. Checked where the counter
 * is stored, so two confirmations at once cannot both pass with the same value.
 */
export const counterMovesOn = (stored: number, next: number): boolean =>
  (stored === 0 && next === 0) || next > stored;

export class PasskeyError extends Error {
  override readonly name = 'PasskeyError';
  constructor(readonly code: PasskeyErrorCode) {
    super(code);
  }
}

export const isPasskeyError = (error: unknown): error is PasskeyError =>
  error instanceof PasskeyError;

export const newPasskeyId = (): string => randomUUID();
export const newPasskeyChallengeId = (): string => randomUUID();

/** A new confirmation token for the browser, and the hash that is stored. */
export function newConfirmationToken(): { readonly token: string; readonly id: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, id: confirmationIdOf(token) };
}

/** The stored id of a confirmation token: its SHA-256, base64url. */
export const confirmationIdOf = (token: string): string =>
  createHash('sha256').update(token, 'utf8').digest('base64url');

/** A token as the browser sends it: 43 base64url characters, nothing else. */
export const isConfirmationToken = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value);

/** For tests and local runs only: everything is lost on restart and not shared between instances. */
export class InMemoryPasskeyStore implements PasskeyStore {
  readonly #passkeys = new Map<string, Passkey>();
  readonly #challenges = new Map<string, PasskeyChallenge>();
  readonly #confirmations = new Map<string, PasskeyConfirmation>();

  /** Receives the writes' audit events in the same step as the data. */
  constructor(private readonly audit?: InMemoryAuditStore) {}

  async passkeysOf(userId: UserId) {
    return [...this.#passkeys.values()].filter((p) => p.userId === userId);
  }

  async findByCredential(credentialId: string) {
    return [...this.#passkeys.values()].find((p) => p.credentialId === credentialId);
  }

  async saveChallenge(challenge: PasskeyChallenge) {
    this.#challenges.set(challenge.id, Object.freeze({ ...challenge }));
  }

  async takeChallenge(id: string, userId: UserId, purpose: PasskeyPurpose, now: Date) {
    const challenge = this.#challenges.get(id);
    this.#challenges.delete(id);
    return challenge !== undefined &&
      challenge.userId === userId &&
      challenge.purpose === purpose &&
      Date.parse(challenge.expiresAt) > now.getTime()
      ? challenge
      : undefined;
  }

  async addPasskey(passkey: Passkey, events: readonly AuditEvent[]) {
    if (await this.findByCredential(passkey.credentialId)) {
      throw new PasskeyError('passkey_exists');
    }
    if ((await this.passkeysOf(passkey.userId)).length >= MAX_PASSKEYS_PER_PERSON) {
      throw new PasskeyError('passkey_limit');
    }
    this.#record(events);
    this.#passkeys.set(passkey.id, Object.freeze({ ...passkey }));
  }

  async confirm(
    passkey: Passkey,
    counter: number,
    confirmation: PasskeyConfirmation,
    events: readonly AuditEvent[],
  ) {
    const stored = this.#passkeys.get(passkey.id);
    if (stored === undefined || stored.userId !== passkey.userId) {
      throw new PasskeyError('passkey_not_found');
    }
    if (!counterMovesOn(stored.counter, counter)) throw new PasskeyError('passkey_counter');
    this.#record(events);
    this.#passkeys.set(
      passkey.id,
      Object.freeze({ ...stored, counter, lastUsedAt: confirmation.confirmedAt }),
    );
    this.#confirmations.set(confirmation.id, Object.freeze({ ...confirmation }));
  }

  async findConfirmation(id: string, now: Date) {
    const confirmation = this.#confirmations.get(id);
    return confirmation !== undefined && Date.parse(confirmation.expiresAt) > now.getTime()
      ? confirmation
      : undefined;
  }

  async removePasskeys(
    userId: UserId,
    passkeyId: string | undefined,
    events: readonly AuditEvent[],
  ) {
    const gone = (await this.passkeysOf(userId)).filter(
      (p) => passkeyId === undefined || p.id === passkeyId,
    );
    if (gone.length === 0) return 0;
    this.#record(events);
    const ids = new Set(gone.map((p) => p.id));
    for (const id of ids) this.#passkeys.delete(id);
    for (const [key, c] of this.#confirmations) {
      if (c.userId === userId && ids.has(c.passkeyId)) this.#confirmations.delete(key);
    }
    return gone.length;
  }

  #record(events: readonly AuditEvent[]) {
    if (events.length === 0) return;
    if (this.audit === undefined) throw new Error('no audit store for passkey events');
    this.audit.appendNow(events);
  }
}
