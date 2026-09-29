import { InMemoryAIUsageStore, type AIUsageStore } from '@melonoffice/ai-usage';
import { InMemoryKnowledgeRepository, type KnowledgeRepository } from '@melonoffice/brain';
import { InMemoryApprovalRepository, type ApprovalRepository } from '@melonoffice/approvals';
import {
  InMemoryDepartmentMigrationStore,
  type DepartmentMigrationStore,
} from './department-migration.js';
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
  type AuditHistoryReader,
  type AuditReader,
  type AuditService,
  type AuditStore,
} from '@melonoffice/audit';
import { InMemoryBillingStore, type BillingStore } from '@melonoffice/billing';
import {
  InMemoryBusinessProfileRepository,
  type BusinessProfileRepository,
} from '@melonoffice/business';
import { InMemoryDepartmentRepository, type DepartmentRepository } from '@melonoffice/departments';
import {
  InMemoryDocumentRepository,
  InMemoryFileStore,
  type DocumentRepository,
  type FileStore,
} from '@melonoffice/documents';
import {
  InMemoryAgentOutputRepository,
  InMemoryExecutionRepository,
  type ExecutionRepository,
} from '@melonoffice/execution';
import { InMemoryCreditStore, type CreditStore } from '@melonoffice/credits';
import {
  createConversationIngress,
  InMemoryConversationRepository,
  type ConversationRepository,
  type FollowUpScheduler,
  type FollowUpTask,
} from '@melonoffice/conversations';
import {
  createIntegrationEngine,
  createIntegrationRegistry,
  createWhatsAppAdapter,
  InMemoryChannelConnectionRepository,
  InMemoryChannelTemplateRepository,
  InMemorySecretStore,
  type ChannelConnectionRepository,
  type ChannelTemplateRepository,
} from '@melonoffice/integrations';
import { InMemoryPlanRepository, type PlanRepository } from '@melonoffice/planning';
import { InMemoryAgentTaskRepository, type AgentTaskRepository } from '@melonoffice/agents';
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
import { createApp, type AppOptions } from './app.js';
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
  FirestoreDocumentRepository,
  toDepartmentDocument,
  FirestoreExecutionRepository,
  FirestoreApprovalRepository,
  FirestoreSpecialistRepository,
  FirestoreDepartmentMigrationStore,
  FirestoreBusinessProfileRepository,
  FirestoreKnowledgeRepository,
  SPECIALISTS,
  SPECIALIST_VERSIONS,
  toSpecialistDocument,
  toSpecialistVersionDocument,
  CREDIT_WALLETS,
  FirestoreAIUsageStore,
  FirestoreCreditStore,
  FirestorePlanRepository,
  FirestoreAgentTaskRepository,
  PLAN_VERSIONS,
  FirestoreWorkflowRepository,
  FirestoreTenancyStore,
  MEMBERSHIPS,
  ORGANIZATIONS,
  FirestoreUserDirectory,
  CHANNEL_CONNECTIONS,
  FirestoreChannelConnectionRepository,
  FirestoreChannelTemplateRepository,
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
  /** Business profiles (ADR-0048). */
  readonly businessProfiles: BusinessProfileRepository;
  /** The audit trail's read side (ADR-0049). */
  readonly auditReader: AuditReader & AuditHistoryReader;
  readonly knowledge: KnowledgeRepository;
  /** What people asked agents (ADR-0063). */
  readonly agentTasks: AgentTaskRepository;
  /** Uploaded documents' records (ADR-0078); their bytes are in `setupApp`'s file store. */
  readonly documents: DocumentRepository;
  /** The department catalogue migration's storage (ADR-0047). */
  readonly departmentMigration: DepartmentMigrationStore;
  readonly credits: CreditStore;
  /** The AI Usage Ledger (ADR-0074). */
  readonly aiUsage: AIUsageStore;
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
  /** The organizations' templates (ADR-0046). */
  readonly templates: ChannelTemplateRepository;
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
  const specialists = new InMemorySpecialistRepository(events);
  const credits = new InMemoryCreditStore(events);
  const tenancy = new InMemoryTenancyStore(undefined, events, billing, departments, credits);
  const plans = new InMemoryPlanRepository(events);
  const conversations = new InMemoryConversationRepository(events);
  const connections = new InMemoryChannelConnectionRepository(events);
  return {
    conversations,
    connections,
    templates: new InMemoryChannelTemplateRepository(events),
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
    businessProfiles: new InMemoryBusinessProfileRepository(breakable),
    auditReader: events,
    knowledge: new InMemoryKnowledgeRepository(breakable),
    agentTasks: new InMemoryAgentTaskRepository(),
    documents: new InMemoryDocumentRepository(breakable),
    departmentMigration: new InMemoryDepartmentMigrationStore(
      departments,
      specialists,
      breakable,
      async () => departments.organizationIds(),
    ),
    putStructure: async (record) => {
      if ('origin' in record) departments.put(record);
      else specialists.put(record);
    },
    credits,
    aiUsage: new InMemoryAIUsageStore(),
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
    templates: new FirestoreChannelTemplateRepository(db),
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
    businessProfiles: new FirestoreBusinessProfileRepository(db),
    auditReader: new FirestoreAuditStore(db),
    knowledge: new FirestoreKnowledgeRepository(db),
    agentTasks: new FirestoreAgentTaskRepository(db),
    documents: new FirestoreDocumentRepository(db),
    departmentMigration: new FirestoreDepartmentMigrationStore(db),
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
    aiUsage: new FirestoreAIUsageStore(db),
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
  answer: (url: string, init: RequestInit) => Promise<Response>;
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
    ai,
    followUpScheduler,
    forecasting,
    toolEnvironment = 'dev',
    runPlans = false,
    files = new InMemoryFileStore(),
  }: {
    readonly sending?: boolean;
    readonly webOrigins?: readonly string[];
    readonly ai?: AppOptions['ai'];
    /** Follow-ups' scheduler (C5): a recording one unless a test passes its own, or `null`. */
    readonly followUpScheduler?: FollowUpScheduler | null;
    /** The Forecasting Engine's parts (ADR-0059). Absent: its routes answer 503. */
    readonly forecasting?: AppOptions['forecasting'];
    /** Where a person's business tools run (TL-1); `null` leaves it unset (fails closed). */
    readonly toolEnvironment?: 'dev' | 'staging' | 'prod' | null;
    /** Approving a plan starts it (WF-1): its steps are queued with the recording kickoff. */
    readonly runPlans?: boolean;
    /** Where documents' bytes live (ADR-0078): memory unless a test passes its own, or `null`. */
    readonly files?: FileStore | null;
  } = {},
) {
  const lines: string[] = [];
  const logger = createLogger({ service: 'api', sink: (line) => lines.push(line) });
  // Agents' kept answers (CV-6B): the API only reads a hand-off's note from them.
  const agentOutputs = new InMemoryAgentOutputRepository();
  const meta: FakeGraphApi = { calls: [], answer: graphAccepted() };
  const graph = createWhatsAppAdapter({
    graphApiVersion: 'v23.0',
    fetch: (async (url: string | URL | Request, init?: RequestInit) => {
      meta.calls.push({ url: String(url), init: init ?? {} });
      return meta.answer(String(url), init ?? {});
    }) as typeof fetch,
  });
  // One Integration Engine for webhooks, sends and connection checks (ADR-0044), over the fake
  // Graph API.
  const engine = createIntegrationEngine({
    registry: createIntegrationRegistry([graph]),
    connections: stores.connections,
    secrets: stores.secrets,
    inbound: createConversationIngress({ repository: stores.conversations }),
    audit: stores.audit,
    logger,
    templates: stores.templates,
    // Retries (ADR-0045) wait no time here: the jitter is always zero.
    random: () => 0,
  });
  // Stands in for the runtime's kickoff (ADR-0063): every queued agent task is recorded.
  const kicked: string[] = [];
  const kickoff = {
    kickoff: async (_tenant: unknown, executionId: string) => void kicked.push(executionId),
  };
  // Stands in for Cloud Tasks: every scheduled follow-up task is recorded, nothing is queued.
  const scheduled: { readonly task: FollowUpTask; readonly at: Date }[] = [];
  const scheduler =
    followUpScheduler === undefined
      ? { schedule: async (task: FollowUpTask, at: Date) => void scheduled.push({ task, at }) }
      : followUpScheduler;
  const app = createApp({
    logger,
    version: 'test',
    auth: { verifier, users: stores.users },
    tenancy: stores.tenancy,
    billing: stores.billing,
    executions: stores.executions,
    structure: { departments: stores.departments, specialists: stores.specialists },
    businessProfiles: stores.businessProfiles,
    activity: stores.auditReader,
    knowledge: stores.knowledge,
    approvals: stores.approvals,
    credits,
    aiUsage: stores.aiUsage,
    plans: stores.plans,
    ...(runPlans ? { planRuntime: kickoff } : {}),
    workflows: stores.workflows,
    audit: stores.audit,
    conversations: {
      repository: stores.conversations,
      connections: stores.connections,
      templates: stores.templates,
      secretProjectId: 'melonoffice-test',
      agentOutputs,
      engine,
      ...(sending ? { outbound: { environment: 'dev' as const } } : {}),
      ...(toolEnvironment === null ? {} : { toolEnvironment }),
      ...(scheduler === null ? {} : { followUpScheduler: scheduler }),
    },
    webhooks: engine,
    agentTasks: { repository: stores.agentTasks, outputs: agentOutputs, runtime: kickoff },
    documents: { repository: stores.documents, ...(files === null ? {} : { files }) },
    ...(forecasting ? { forecasting } : {}),
    ...(tools ? { tools } : {}),
    ...(webOrigins ? { webOrigins } : {}),
    ...(ai ? { ai } : {}),
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
  return { app, lines, as, register, meta, agentOutputs, scheduled, kicked, files, ...stores };
}
