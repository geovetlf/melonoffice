import type { IsoTimestamp, User, UserId } from '@melonoffice/domain';
import { randomUUID } from 'node:crypto';

/** Where users are stored. The Firestore implementation comes with persistence. */
export interface UserDirectory {
  findBySubject(subject: string): Promise<User | undefined>;
  /** Returns the user for this subject, creating it the first time. Safe to call again. */
  register(subject: string): Promise<User>;
}

/** For tests and local runs only: everything is lost on restart and not shared between instances. */
export class InMemoryUserDirectory implements UserDirectory {
  readonly #bySubject = new Map<string, User>();

  constructor(private readonly now: () => Date = () => new Date()) {}

  async findBySubject(subject: string): Promise<User | undefined> {
    return this.#bySubject.get(subject);
  }

  async register(subject: string): Promise<User> {
    const existing = this.#bySubject.get(subject);
    if (existing) return existing;
    const user: User = Object.freeze({
      id: randomUUID() as UserId,
      identity: Object.freeze({ provider: 'identity-platform', subject }),
      createdAt: this.now().toISOString() as IsoTimestamp,
    });
    this.#bySubject.set(subject, user);
    return user;
  }
}
