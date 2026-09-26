import type { Firestore, Timestamp as FirestoreTimestamp } from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import {
  newUserId,
  type SignInResult,
  type UserDirectory,
  type VerifiedIdentity,
} from '@melonoffice/auth';
import type { IsoTimestamp, User, UserId } from '@melonoffice/domain';
import { createHash } from 'node:crypto';

/** Collections (ADR-0017). Both are read and written only by the API, never by clients. */
export const USERS = 'users';
export const IDENTITIES = 'identities';

const PROVIDER = 'identity-platform';

/** `users/{userId}` */
interface UserDocument {
  readonly identity: { readonly provider: typeof PROVIDER; readonly subject: string };
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly createdAt: FirestoreTimestamp;
  readonly updatedAt: FirestoreTimestamp;
  readonly lastLoginAt: FirestoreTimestamp;
}

/** `identities/{identityKey}`: the uniqueness record linking one external identity to one user. */
interface IdentityDocument {
  readonly provider: typeof PROVIDER;
  readonly subject: string;
  readonly userId: string;
  readonly createdAt: FirestoreTimestamp;
}

/**
 * The document id for an external identity: a hash, so any subject gives a valid, fixed-length
 * id and the id itself carries no personal data.
 */
export function identityKey(subject: string): string {
  return createHash('sha256').update(`${PROVIDER}\n${subject}`).digest('hex');
}

const iso = (timestamp: FirestoreTimestamp): IsoTimestamp =>
  timestamp.toDate().toISOString() as IsoTimestamp;

function toUser(id: string, data: UserDocument): User {
  return Object.freeze({
    id: id as UserId,
    identity: Object.freeze({ provider: data.identity.provider, subject: data.identity.subject }),
    ...(data.email === null ? {} : { email: data.email }),
    emailVerified: data.emailVerified,
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
    lastLoginAt: iso(data.lastLoginAt),
  });
}

/**
 * Users in Firestore. One subject maps to one user because the identity document is created in
 * the same transaction as the user, with `create`, which fails if it already exists; the losing
 * transaction retries and finds the winner's user.
 */
export class FirestoreUserDirectory implements UserDirectory {
  constructor(
    private readonly db: Firestore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async findBySubject(subject: string): Promise<User | undefined> {
    const identity = await this.db.collection(IDENTITIES).doc(identityKey(subject)).get();
    if (!identity.exists) return undefined;
    return this.findById((identity.data() as IdentityDocument).userId as UserId);
  }

  async findById(id: UserId): Promise<User | undefined> {
    const snapshot = await this.db.collection(USERS).doc(id).get();
    return snapshot.exists ? toUser(snapshot.id, snapshot.data() as UserDocument) : undefined;
  }

  async recordSignIn(verified: VerifiedIdentity): Promise<SignInResult> {
    const identityRef = this.db.collection(IDENTITIES).doc(identityKey(verified.subject));
    return this.db.runTransaction(async (tx) => {
      const at = Timestamp.fromDate(this.now());
      const signIn = {
        email: verified.email ?? null,
        emailVerified: verified.emailVerified,
        updatedAt: at,
        lastLoginAt: at,
      };

      const identity = await tx.get(identityRef);
      if (identity.exists) {
        const { userId, subject } = identity.data() as IdentityDocument;
        // A hash collision or a hand-edited document: never hand over someone else's user.
        if (subject !== verified.subject) throw new Error('identity record does not match subject');
        const userRef = this.db.collection(USERS).doc(userId);
        const current = await tx.get(userRef);
        if (!current.exists) throw new Error('identity record points to a missing user');
        tx.update(userRef, signIn);
        return {
          user: toUser(userId, { ...(current.data() as UserDocument), ...signIn }),
          created: false,
        };
      }

      const userId = newUserId();
      const user: UserDocument = {
        identity: { provider: PROVIDER, subject: verified.subject },
        ...signIn,
        createdAt: at,
      };
      const link: IdentityDocument = {
        provider: PROVIDER,
        subject: verified.subject,
        userId,
        createdAt: at,
      };
      tx.create(identityRef, link);
      tx.create(this.db.collection(USERS).doc(userId), user);
      return { user: toUser(userId, user), created: true };
    });
  }
}
