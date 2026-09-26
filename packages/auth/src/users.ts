import type { IsoTimestamp, User, UserId } from '@melonoffice/domain';
import { randomUUID } from 'node:crypto';
import type { VerifiedIdentity } from './identity.js';

export interface SignInResult {
  readonly user: User;
  /** True when this sign-in created the user. */
  readonly created: boolean;
}

/** Where users are stored: Firestore in the API (ADR-0017), memory in tests. */
export interface UserDirectory {
  findBySubject(subject: string): Promise<User | undefined>;
  findById(id: UserId): Promise<User | undefined>;
  /**
   * Creates the user for this verified identity, or refreshes the existing one. Idempotent, and
   * safe under concurrent calls: one subject never gets two users. Only the email, its verified
   * flag and the sign-in time are updated; the id, identity and creation time never change.
   */
  recordSignIn(identity: VerifiedIdentity): Promise<SignInResult>;
}

/** Internal user ids: random, opaque and unrelated to the email or the provider's id. */
export const newUserId = (): UserId => randomUUID() as UserId;

/** For tests and local runs only: everything is lost on restart and not shared between instances. */
export class InMemoryUserDirectory implements UserDirectory {
  readonly #bySubject = new Map<string, User>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async findBySubject(subject: string): Promise<User | undefined> {
    return this.#bySubject.get(subject);
  }

  async findById(id: UserId): Promise<User | undefined> {
    return [...this.#bySubject.values()].find((user) => user.id === id);
  }

  // No await between the lookup and the write, so concurrent calls cannot both create.
  async recordSignIn(identity: VerifiedIdentity): Promise<SignInResult> {
    const at = this.now().toISOString() as IsoTimestamp;
    const existing = this.#bySubject.get(identity.subject);
    const user: User = Object.freeze({
      id: existing?.id ?? newUserId(),
      identity:
        existing?.identity ??
        Object.freeze({ provider: 'identity-platform', subject: identity.subject }),
      ...(identity.email === undefined ? {} : { email: identity.email }),
      emailVerified: identity.emailVerified,
      createdAt: existing?.createdAt ?? at,
      updatedAt: at,
      lastLoginAt: at,
    });
    this.#bySubject.set(identity.subject, user);
    return { user, created: existing === undefined };
  }
}
