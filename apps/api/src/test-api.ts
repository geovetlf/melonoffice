import {
  AuthError,
  InMemoryUserDirectory,
  type IdTokenVerifier,
  type UserDirectory,
  type VerifiedIdentity,
} from '@melonoffice/auth';
import { Timestamp, type Firestore } from '@google-cloud/firestore';
import type { Membership, Organization } from '@melonoffice/domain';
import { createLogger } from '@melonoffice/observability';
import type { AuthorizationService } from '@melonoffice/rbac';
import { InMemoryTenancyStore, type TenancyStore } from '@melonoffice/tenancy';
import { createApp } from './app.js';
import { FirestoreTenancyStore, MEMBERSHIPS, ORGANIZATIONS } from './tenancy-firestore.js';
import { emulatorFirestore, emulatorHost } from './test-firestore.js';
import { FirestoreUserDirectory } from './users-firestore.js';

/**
 * Stands in for Identity Platform. Real signature, issuer and expiry checks are tested in
 * @melonoffice/auth; here each fixed token maps to an outcome.
 */
const IDENTITIES: Record<string, VerifiedIdentity> = {
  'token-alice': { subject: 'uid-alice', email: 'alice@example.com', emailVerified: true },
  'token-bob': { subject: 'uid-bob', email: 'bob@example.com', emailVerified: false },
};
export const verifier: IdTokenVerifier = {
  async verify(token) {
    if (token === 'token-expired') throw new AuthError('token_expired');
    if (token === 'token-keys-down') throw new AuthError('verifier_unavailable');
    const identity = IDENTITIES[token];
    if (identity === undefined) throw new AuthError('invalid_token');
    return identity;
  },
};

export interface Stores {
  readonly users: UserDirectory;
  readonly tenancy: TenancyStore;
  /** Stores a record as given, e.g. a suspended membership, the way an operator change would. */
  readonly put: (record: Organization | Membership) => Promise<void>;
}

function memoryStores(): Stores {
  const tenancy = new InMemoryTenancyStore();
  return { users: new InMemoryUserDirectory(), tenancy, put: async (r) => tenancy.put(r) };
}

function firestoreStores(): Stores {
  const db: Firestore = emulatorFirestore();
  return {
    users: new FirestoreUserDirectory(db),
    tenancy: new FirestoreTenancyStore(db),
    async put({ id, createdAt, updatedAt, ...rest }) {
      const collection = 'userId' in rest ? MEMBERSHIPS : ORGANIZATIONS;
      await db
        .collection(collection)
        .doc(id)
        .set({
          ...rest,
          createdAt: Timestamp.fromDate(new Date(createdAt)),
          updatedAt: Timestamp.fromDate(new Date(updatedAt)),
        });
    },
  };
}

/** Every API test runs against memory and, where the emulator runs, against Firestore. */
export const STORES: [string, () => Stores][] = [
  ['memory', memoryStores],
  ...(emulatorHost ? [['firestore', firestoreStores] as [string, () => Stores]] : []),
];

export function setupApp(stores: Stores, authorization?: AuthorizationService) {
  const lines: string[] = [];
  const logger = createLogger({ service: 'api', sink: (line) => lines.push(line) });
  const app = createApp({
    logger,
    version: 'test',
    auth: { verifier, users: stores.users },
    tenancy: stores.tenancy,
    ...(authorization ? { authorization } : {}),
  });
  const as = (token: string, init: RequestInit = {}): RequestInit => ({
    ...init,
    headers: { authorization: `Bearer ${token}`, ...(init.headers as Record<string, string>) },
  });
  const register = async (token: string): Promise<string> =>
    (
      (await (await app.request('/v1/me', as(token, { method: 'POST' }))).json()) as {
        userId: string;
      }
    ).userId;
  return { app, lines, as, register, ...stores };
}
