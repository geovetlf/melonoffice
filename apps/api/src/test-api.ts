import {
  AuthError,
  InMemoryUserDirectory,
  type IdTokenVerifier,
  type UserDirectory,
  type VerifiedIdentity,
} from '@melonoffice/auth';
import { Timestamp, type Firestore } from '@google-cloud/firestore';
import {
  createAuditService,
  InMemoryAuditStore,
  type AuditEvent,
  type AuditService,
  type AuditStore,
} from '@melonoffice/audit';
import { InMemoryBillingStore, type BillingStore } from '@melonoffice/billing';
import { InMemoryExecutionRepository, type ExecutionRepository } from '@melonoffice/execution';
import type {
  BillingAccount,
  Membership,
  Organization,
  OrganizationId,
  Subscription,
} from '@melonoffice/domain';
import { createLogger } from '@melonoffice/observability';
import type { EntitlementService } from '@melonoffice/entitlements';
import type { AuthorizationService } from '@melonoffice/rbac';
import { InMemoryTenancyStore, type TenancyStore } from '@melonoffice/tenancy';
import { createApp } from './app.js';
import { AUDIT_LOGS, FirestoreAuditStore, type AuditDocument } from './audit-firestore.js';
import {
  BILLING_ACCOUNTS,
  FirestoreBillingStore,
  SUBSCRIPTIONS,
  toAccountDocument,
  toSubscriptionDocument,
} from './billing-firestore.js';
import { FirestoreExecutionRepository } from './executions-firestore.js';
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
  readonly billing: BillingStore;
  /** Stores a billing record as given, the way a provider sync or an operator change would. */
  readonly putBilling: (record: BillingAccount | Subscription) => Promise<void>;
  /** Removes an organization's billing account, as for one created before billing existed. */
  readonly removeBilling: (organizationId: OrganizationId) => Promise<void>;
  readonly executions: ExecutionRepository;
  readonly audit: AuditService;
  /** Every stored audit event, oldest first, as plain data. */
  readonly auditEvents: () => Promise<readonly AuditEvent[]>;
  /** Makes the audit store fail (or work again), to test the error policy. */
  readonly breakAudit: (broken: boolean) => void;
}

/** An audit store that can be made to fail on demand. */
class Breakable implements AuditStore {
  broken = false;
  constructor(private readonly inner: AuditStore) {}
  async append(events: readonly AuditEvent[]): Promise<void> {
    if (this.broken) throw new Error('audit store unavailable');
    await this.inner.append(events);
  }
}

function memoryStores(): Stores {
  const events = new InMemoryAuditStore();
  const breakable = new Breakable(events);
  const billing = new InMemoryBillingStore();
  const tenancy = new InMemoryTenancyStore(undefined, events, billing);
  return {
    users: new InMemoryUserDirectory(),
    tenancy,
    put: async (r) => tenancy.put(r),
    billing,
    putBilling: async (r) => billing.put(r),
    removeBilling: async (id) => billing.removeAccount(id),
    executions: new InMemoryExecutionRepository(events),
    audit: createAuditService(breakable),
    auditEvents: async () => events.events(),
    breakAudit: (broken) => (breakable.broken = broken),
  };
}

/** Reads a stored document back into an event, the inverse of toAuditDocument. */
function fromAuditDocument(id: string, d: AuditDocument): AuditEvent {
  return {
    id,
    occurredAt: d.occurredAt.toDate().toISOString(),
    action: d.action,
    result: d.result,
    actor:
      d.actorType === 'user'
        ? { type: 'user', userId: d.actorUserId, via: d.actorVia }
        : { type: d.actorType },
    ...(d.organizationId === null ? {} : { organizationId: d.organizationId }),
    ...(d.targetType === null ? {} : { target: { type: d.targetType, id: d.targetId } }),
    ...(d.requestedOrganizationId === null
      ? {}
      : { requestedOrganizationId: d.requestedOrganizationId }),
    ...(d.permission === null ? {} : { permission: d.permission }),
    ...(d.planId === null ? {} : { plan: { id: d.planId, version: d.planVersion } }),
    ...(d.transitionFrom === null
      ? {}
      : { transition: { from: d.transitionFrom, to: d.transitionTo } }),
    ...(d.reason === null ? {} : { reason: d.reason }),
    ...(d.requestId === null ? {} : { requestId: d.requestId }),
    source: d.source,
  } as unknown as AuditEvent;
}

function firestoreStores(): Stores {
  const db: Firestore = emulatorFirestore();
  const breakable = new Breakable(new FirestoreAuditStore(db));
  return {
    users: new FirestoreUserDirectory(db),
    tenancy: new FirestoreTenancyStore(db),
    billing: new FirestoreBillingStore(db),
    async putBilling(record) {
      if ('status' in record) {
        await db.collection(SUBSCRIPTIONS).doc(record.id).set(toSubscriptionDocument(record));
      } else {
        await db
          .collection(BILLING_ACCOUNTS)
          .doc(record.organizationId)
          .set(toAccountDocument(record));
      }
    },
    executions: new FirestoreExecutionRepository(db),
    async removeBilling(organizationId) {
      await db.collection(BILLING_ACCOUNTS).doc(organizationId).delete();
    },
    audit: createAuditService(breakable),
    breakAudit: (broken) => (breakable.broken = broken),
    async auditEvents() {
      const snapshot = await db.collection(AUDIT_LOGS).orderBy('occurredAt').get();
      return snapshot.docs.map((doc) => fromAuditDocument(doc.id, doc.data() as AuditDocument));
    },
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

export function setupApp(
  stores: Stores,
  authorization?: AuthorizationService,
  entitlements?: EntitlementService,
) {
  const lines: string[] = [];
  const logger = createLogger({ service: 'api', sink: (line) => lines.push(line) });
  const app = createApp({
    logger,
    version: 'test',
    auth: { verifier, users: stores.users },
    tenancy: stores.tenancy,
    billing: stores.billing,
    executions: stores.executions,
    audit: stores.audit,
    ...(authorization ? { authorization } : {}),
    ...(entitlements ? { entitlements } : {}),
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
