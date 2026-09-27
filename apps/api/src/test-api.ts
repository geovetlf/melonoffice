import { InMemoryApprovalRepository, type ApprovalRepository } from '@melonoffice/approvals';
import type { ToolRegistry } from '@melonoffice/tools';
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
import { InMemoryDepartmentRepository, type DepartmentRepository } from '@melonoffice/departments';
import { InMemoryExecutionRepository, type ExecutionRepository } from '@melonoffice/execution';
import { InMemoryCreditStore, type CreditStore } from '@melonoffice/credits';
import {
  createConversationIngress,
  InMemoryConversationRepository,
  type ConversationRepository,
} from '@melonoffice/conversations';
import {
  createWebhookIngress,
  createWhatsAppAdapter,
  InMemoryChannelConnectionRepository,
  InMemorySecretStore,
  type ChannelConnectionRepository,
} from '@melonoffice/integrations';
import { InMemoryPlanRepository, type PlanRepository } from '@melonoffice/planning';
import { InMemoryWorkflowRepository, type WorkflowRepository } from '@melonoffice/workflows';
import type {
  BillingAccount,
  ChannelConnection,
  Message,
  Department,
  Membership,
  Organization,
  OrganizationId,
  PlanId,
  Specialist,
  SpecialistVersion,
  Subscription,
} from '@melonoffice/domain';
import { createLogger } from '@melonoffice/observability';
import type { EntitlementService } from '@melonoffice/entitlements';
import type { AuthorizationService } from '@melonoffice/rbac';
import { InMemorySpecialistRepository, type SpecialistRepository } from '@melonoffice/specialists';
import { InMemoryTenancyStore, type TenancyStore } from '@melonoffice/tenancy';
import { createApp } from './app.js';
import {
  AUDIT_LOGS,
  FirestoreAuditStore,
  type AuditDocument,
  fromAuditDocument,
  BILLING_ACCOUNTS,
  FirestoreBillingStore,
  SUBSCRIPTIONS,
  toAccountDocument,
  toSubscriptionDocument,
  DEPARTMENTS,
  FirestoreDepartmentRepository,
  toDepartmentDocument,
  FirestoreExecutionRepository,
  FirestoreApprovalRepository,
  FirestoreSpecialistRepository,
  SPECIALISTS,
  SPECIALIST_VERSIONS,
  toSpecialistDocument,
  toSpecialistVersionDocument,
  CREDIT_WALLETS,
  FirestoreCreditStore,
  FirestorePlanRepository,
  PLAN_VERSIONS,
  FirestoreWorkflowRepository,
  FirestoreTenancyStore,
  MEMBERSHIPS,
  ORGANIZATIONS,
  FirestoreUserDirectory,
  CHANNEL_CONNECTIONS,
  FirestoreChannelConnectionRepository,
  FirestoreConversationRepository,
  putOutboundMessage,
  toConnectionDocument,
} from '@melonoffice/firestore';
import { emulatorFirestore, emulatorHost } from '@melonoffice/firestore/testing';

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
  readonly approvals: ApprovalRepository;
  readonly departments: DepartmentRepository;
  readonly specialists: SpecialistRepository;
  /** Stores a department or specialist record as given, the way an operator change or bad data would. */
  readonly putStructure: (record: Department | Specialist | SpecialistVersion) => Promise<void>;
  readonly credits: CreditStore;
  readonly plans: PlanRepository;
  readonly workflows: WorkflowRepository;
  /** Changes a stored plan version's label behind the digest's back, as corrupted data would. */
  readonly tamperPlanVersion: (
    organizationId: OrganizationId,
    planId: PlanId,
    version: number,
  ) => Promise<void>;
  /** Removes an organization's wallet, as for one created before credits existed. */
  readonly removeWallet: (organizationId: OrganizationId) => Promise<void>;
  readonly conversations: ConversationRepository;
  readonly connections: ChannelConnectionRepository;
  /** Stores a channel connection as given, the way the server-side setup would. */
  readonly putConnection: (connection: ChannelConnection) => Promise<void>;
  /** Stores an outbound message as given (nothing sends in CV-1), to test delivery statuses. */
  readonly putOutbound: (message: Message) => Promise<void>;
  /** Channel secrets: in memory in both, standing in for Secret Manager. */
  readonly secrets: InMemorySecretStore;
  readonly audit: AuditService;
  /** Every stored audit event, oldest first, as plain data. */
  readonly auditEvents: () => Promise<readonly AuditEvent[]>;
  /** Makes the audit store fail (or work again), to test the error policy. */
  readonly breakAudit: (broken: boolean) => void;
  /** Everything stored in the audit trail, raw, as one string: for scanning it for secrets. */
  readonly storedAudit: () => Promise<string>;
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
  const departments = new InMemoryDepartmentRepository();
  const specialists = new InMemorySpecialistRepository();
  const credits = new InMemoryCreditStore(events);
  const tenancy = new InMemoryTenancyStore(undefined, events, billing, departments, credits);
  const plans = new InMemoryPlanRepository(events);
  const conversations = new InMemoryConversationRepository(events);
  const connections = new InMemoryChannelConnectionRepository(events);
  return {
    conversations,
    connections,
    putConnection: async (c) => connections.put(c),
    putOutbound: async (m) => conversations.putOutbound(m),
    secrets: new InMemorySecretStore(),
    users: new InMemoryUserDirectory(),
    tenancy,
    put: async (r) => tenancy.put(r),
    billing,
    putBilling: async (r) => billing.put(r),
    removeBilling: async (id) => billing.removeAccount(id),
    executions: new InMemoryExecutionRepository(events),
    approvals: new InMemoryApprovalRepository(events),
    departments,
    specialists,
    putStructure: async (record) => {
      if ('origin' in record) departments.put(record);
      else specialists.put(record);
    },
    credits,
    plans,
    workflows: new InMemoryWorkflowRepository(events),
    async tamperPlanVersion(organizationId, planId, version) {
      // Memory stores what it is given; the repository checks the digest when it reads.
      const found = await plans.findVersion(organizationId, planId, version);
      const [first, ...rest] = found?.steps ?? [];
      if (found === undefined || first === undefined) throw new Error('no such plan version');
      plans.putVersion({ ...found, steps: [{ ...first, label: 'Tampered' }, ...rest] });
    },
    removeWallet: async (id) => credits.removeWallet(id),
    audit: createAuditService(breakable),
    auditEvents: async () => events.events(),
    breakAudit: (broken) => (breakable.broken = broken),
    storedAudit: async () => JSON.stringify(events.events()),
  };
}

function firestoreStores(): Stores {
  const db: Firestore = emulatorFirestore();
  const breakable = new Breakable(new FirestoreAuditStore(db));
  return {
    conversations: new FirestoreConversationRepository(db),
    connections: new FirestoreChannelConnectionRepository(db),
    async putConnection(c) {
      await db.collection(CHANNEL_CONNECTIONS).doc(c.id).set(toConnectionDocument(c));
    },
    putOutbound: (m) => putOutboundMessage(db, m),
    secrets: new InMemorySecretStore(),
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
    approvals: new FirestoreApprovalRepository(db),
    departments: new FirestoreDepartmentRepository(db),
    specialists: new FirestoreSpecialistRepository(db),
    async putStructure(record) {
      if ('origin' in record) {
        await db.collection(DEPARTMENTS).doc(record.id).set(toDepartmentDocument(record));
      } else if ('identity' in record) {
        await db.collection(SPECIALISTS).doc(record.identity.id).set(toSpecialistDocument(record));
      } else {
        await db
          .collection(SPECIALIST_VERSIONS)
          .doc(`${record.specialistId}_${record.version}`)
          .set(toSpecialistVersionDocument(record));
      }
    },
    async removeBilling(organizationId) {
      await db.collection(BILLING_ACCOUNTS).doc(organizationId).delete();
    },
    credits: new FirestoreCreditStore(db),
    plans: new FirestorePlanRepository(db),
    workflows: new FirestoreWorkflowRepository(db),
    async tamperPlanVersion(organizationId, planId, version) {
      const doc = db.collection(PLAN_VERSIONS).doc(`${planId}_${version}`);
      const stored = await doc.get();
      if (stored.get('organizationId') !== organizationId) throw new Error('no such plan version');
      const content = stored.get('content') as string;
      await doc.update({ content: content.replace(/"label":"[^"]*"/, '"label":"Tampered"') });
    },
    async removeWallet(organizationId) {
      await db.collection(CREDIT_WALLETS).doc(organizationId).delete();
    },
    audit: createAuditService(breakable),
    breakAudit: (broken) => (breakable.broken = broken),
    async storedAudit() {
      const snapshot = await db.collection(AUDIT_LOGS).get();
      return JSON.stringify(snapshot.docs.map((doc) => doc.data()));
    },
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

/**
 * Stands in for Meta's Graph API in a person's sends (CV-2): every call is recorded, and each
 * answers with `answer`, a successful send unless a test changes it. Nothing leaves the process.
 */
export interface FakeGraphApi {
  readonly calls: { readonly url: string; readonly init: RequestInit }[];
  answer: () => Promise<Response>;
}

/** A successful send, with a new provider id each time, as Meta answers. */
export const graphAccepted = (): FakeGraphApi['answer'] => {
  let sent = 0;
  return async () => {
    sent += 1;
    return new Response(JSON.stringify({ messages: [{ id: `wamid.HBgLMTU1NTEyMzQ1Ng${sent}` }] }), {
      status: 200,
    });
  };
};

export function setupApp(
  stores: Stores,
  authorization?: AuthorizationService,
  entitlements?: EntitlementService,
  tools?: ToolRegistry,
  credits: CreditStore = stores.credits,
  {
    sending = true,
    webOrigins,
  }: { readonly sending?: boolean; readonly webOrigins?: readonly string[] } = {},
) {
  const lines: string[] = [];
  const logger = createLogger({ service: 'api', sink: (line) => lines.push(line) });
  const meta: FakeGraphApi = { calls: [], answer: graphAccepted() };
  const graph = createWhatsAppAdapter({
    graphApiVersion: 'v23.0',
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      meta.calls.push({ url: String(url), init: init ?? {} });
      return meta.answer();
    }) as typeof fetch,
  });
  const app = createApp({
    logger,
    version: 'test',
    auth: { verifier, users: stores.users },
    tenancy: stores.tenancy,
    billing: stores.billing,
    executions: stores.executions,
    structure: { departments: stores.departments, specialists: stores.specialists },
    approvals: stores.approvals,
    credits,
    plans: stores.plans,
    workflows: stores.workflows,
    audit: stores.audit,
    conversations: {
      repository: stores.conversations,
      connections: stores.connections,
      secretProjectId: 'melonoffice-test',
      ...(sending
        ? {
            outbound: {
              secrets: stores.secrets,
              adapters: { whatsapp: graph },
              environment: 'dev' as const,
            },
          }
        : {}),
    },
    webhooks: createWebhookIngress({
      connections: stores.connections,
      secrets: stores.secrets,
      adapters: [createWhatsAppAdapter()],
      conversations: createConversationIngress({ repository: stores.conversations }),
      logger,
    }),
    ...(tools ? { tools } : {}),
    ...(webOrigins ? { webOrigins } : {}),
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
  return { app, lines, as, register, meta, ...stores };
}
