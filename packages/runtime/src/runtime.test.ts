import type { Firestore } from '@google-cloud/firestore';
import {
  ProviderCredential,
  createAIGateway,
  createModelPolicyCatalogue,
  createProviderRegistry,
  DEFAULT_MODEL_POLICY,
  type AICreditsPort,
  type ProviderAdapter,
  type ProviderCall,
  type ProviderOutcome,
} from '@melonoffice/ai-gateway';
import {
  createApprovalService,
  InMemoryApprovalRepository,
  type ApprovalRepository,
} from '@melonoffice/approvals';
import {
  createAuditService,
  InMemoryAuditStore,
  type AuditEvent,
  type AuditStore,
} from '@melonoffice/audit';
import { actAsGia, type AuthenticatedContext } from '@melonoffice/auth';
import { openWallet } from '@melonoffice/credits';
import {
  DEFAULT_DEPARTMENT_CATALOGUE,
  departmentIdOf,
  InMemoryDepartmentRepository,
  provisionDepartments,
  type DepartmentRepository,
} from '@melonoffice/departments';
import type {
  AIModelDefinition,
  ApprovalId,
  DepartmentTypeId,
  Execution,
  ExecutionJob,
  ExecutionNodeType,
  InitialBilling,
  IsoTimestamp,
  JobId,
  Membership,
  Organization,
  Specialist,
  SubscriptionId,
  ToolDefinition,
  ToolVersion,
  UserId,
} from '@melonoffice/domain';
import {
  attachApproval,
  createExecutionService,
  InMemoryExecutionRepository,
  type ExecutionRepository,
} from '@melonoffice/execution';
import {
  AUDIT_LOGS,
  FirestoreApprovalRepository,
  FirestoreAuditStore,
  FirestoreDepartmentRepository,
  FirestoreExecutionRepository,
  FirestoreJobRepository,
  FirestoreSpecialistRepository,
  FirestoreTenancyStore,
  fromAuditDocument,
  MEMBERSHIPS,
  type AuditDocument,
} from '@melonoffice/firestore';
import { emulatorFirestore, emulatorHost } from '@melonoffice/firestore/testing';
import { createToolGate } from '@melonoffice/guardrails';
import {
  createJobService,
  InMemoryJobRepository,
  isJobError,
  jobIdFor,
  type JobClaim,
  type JobRepository,
} from '@melonoffice/jobs';
import { createAuthorizationService } from '@melonoffice/rbac';
import {
  applySpecialistStatus,
  createSpecialistService,
  InMemorySpecialistRepository,
  newSpecialist,
  type SpecialistRepository,
} from '@melonoffice/specialists';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveRuntimeTenant,
  resolveTenant,
  type TenancyStore,
  type TenantContext,
} from '@melonoffice/tenancy';
import {
  createToolRegistry,
  type ToolExecutionContext,
  type ToolExecutor,
  type ToolExecutorOutcome,
} from '@melonoffice/tools';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isRuntimeError } from './errors.js';
import type { AgentWork, NodeWorkSource, VerificationSource } from './ports.js';
import { createRuntime, type AdvanceResult } from './runtime.js';

const T0 = new Date('2026-09-27T12:00:00Z');
const AT = T0.toISOString() as IsoTimestamp;
const LEASE_MS = 60_000;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const INPUT = { subject: 'Weekly summary' };
/** A credential-shaped value, built at run time so secret scanners do not flag the source. */
const SECRET_VALUE = ['super', '-secret-', 'provider-value'].join('');

const BILLING = (organization: Organization): InitialBilling => {
  const subscriptionId = `sub-${organization.id}` as SubscriptionId;
  const at = organization.createdAt;
  return {
    account: { organizationId: organization.id, subscriptionId, createdAt: at, updatedAt: at },
    subscription: {
      id: subscriptionId,
      organizationId: organization.id,
      plan: { id: 'test-plan', version: 1 },
      status: 'active',
      createdAt: at,
      updatedAt: at,
    },
  };
};

const as = (userId: UserId): AuthenticatedContext =>
  Object.freeze({ actor: 'user', userId, emailVerified: true });

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing value');
  return value;
};

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    throw error;
  }
  return 'accepted';
}

// ---------------------------------------------------------------------------------------------
// Fixtures. Test only: MelonOffice's real tool and model catalogues are empty (ADR-0026, D-7).

const OBJECT_IN = {
  type: 'object',
  properties: { subject: { type: 'string', maxLength: 200, minLength: 1 } },
  required: ['subject'],
} as const;
const OBJECT_OUT = {
  type: 'object',
  properties: { count: { type: 'integer', minimum: 0 } },
  required: ['count'],
} as const;

const tool = (id: string, overrides: Partial<ToolVersion> = {}): ToolDefinition => ({
  id: id as ToolDefinition['id'],
  status: 'active',
  versions: [
    {
      toolId: id as ToolVersion['toolId'],
      version: 1,
      nameKey: `tools.${id}.name` as ToolVersion['nameKey'],
      descriptionKey: `tools.${id}.description` as ToolVersion['descriptionKey'],
      category: 'test',
      action: 'run',
      mutating: false,
      inputSchema: OBJECT_IN,
      outputSchema: OBJECT_OUT,
      permissions: ['organization.read'],
      credentials: [],
      riskLevel: 'low',
      approvalPolicy: 'auto',
      approvalTtlSeconds: 600,
      timeoutMs: 1000,
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      provider: { kind: 'internal', id: 'fixture' },
      environments: ['dev'],
      ...overrides,
    },
  ],
});

const TOOLS: readonly ToolDefinition[] = [
  tool('lookup'),
  tool('update_record', { mutating: true }),
  tool('send_email', { riskLevel: 'high', mutating: true, action: 'send' }),
  tool('slow', { timeoutMs: 20 }),
];

type Answers = Record<string, () => Promise<ToolExecutorOutcome>>;

const MODEL: AIModelDefinition = {
  providerId: 'alpha',
  modelId: 'alpha-small',
  version: '2026-09-01',
  status: 'active',
  capabilities: ['text_generation'],
  inputModalities: ['text'],
  outputModalities: ['text'],
  contextWindowTokens: 100_000,
  maxOutputTokens: 8_000,
  structuredOutput: false,
  toolUse: false,
  streaming: false,
  quality: 'standard',
  latency: 'standard',
  pricing: {
    status: 'known',
    currency: 'USD',
    inputMicroUsdPerMillionTokens: 1_000_000,
    outputMicroUsdPerMillionTokens: 4_000_000,
    source: 'test fixture',
    asOf: '2026-09-01',
  },
  environments: ['dev'],
  maxSensitivity: 'internal',
};

const OK: ProviderOutcome = {
  status: 'success',
  output: { text: 'Summary ready.' },
  usage: { inputTokens: 1_000, outputTokens: 500 },
  finishReason: 'stop',
  providerRequestId: 'prov-req-1',
};

/** A fake official adapter: records every call. Only the gateway ever holds it. */
function fakeAdapter(calls: ProviderCall[], answer: () => Promise<ProviderOutcome>) {
  const credential = new ProviderCredential(SECRET_VALUE);
  const adapter: ProviderAdapter = {
    providerId: 'alpha',
    adapterVersion: 'alpha-adapter-1',
    capabilities: () => ['text_generation'],
    health: async () => 'available',
    async generate(call) {
      calls.push(call);
      if (credential.reveal() !== SECRET_VALUE) throw new Error('credential lost');
      return answer();
    },
  };
  return adapter;
}

/** A test double of the Credits engine's port: counts each reference once. */
function fakeCredits() {
  const spent = new Map<string, number>();
  const port: AICreditsPort = {
    async balanceOf() {
      return { status: 'present', balance: 1_000_000 };
    },
    async consume(tenant, { amount, referenceId }) {
      const key = `${tenant.organizationId}\n${referenceId}`;
      if (spent.has(key)) return { balance: 1_000_000, replayed: true };
      spent.set(key, amount);
      return { balance: 1_000_000 - amount, replayed: false };
    },
    async refund() {
      throw new Error('not used');
    },
  };
  return { port, spent };
}

const AGENT_WORK: AgentWork = {
  taskType: 'summarise_document',
  capability: 'text_generation',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarise the week.' }] }],
  outputModality: 'text',
  maxOutputTokens: 200,
  sensitivity: 'internal',
};

// ---------------------------------------------------------------------------------------------
// Storage: memory, and the Firestore emulator when it runs.

interface Stores {
  readonly tenancy: TenancyStore;
  readonly departments: DepartmentRepository;
  readonly specialists: SpecialistRepository;
  readonly executions: ExecutionRepository;
  readonly approvals: ApprovalRepository;
  readonly jobs: JobRepository;
  readonly audit: AuditStore;
  readonly events: () => Promise<readonly AuditEvent[]>;
  /** Memory only: the audit store, to make its writes fail. */
  readonly memoryAudit?: InMemoryAuditStore;
  readonly suspend: (membership: Membership) => Promise<void>;
}

function memoryStores(now: () => Date): Stores {
  const audit = new InMemoryAuditStore();
  const departments = new InMemoryDepartmentRepository();
  const tenancy = new InMemoryTenancyStore(now, audit, undefined, departments);
  return {
    tenancy,
    departments,
    specialists: new InMemorySpecialistRepository(),
    executions: new InMemoryExecutionRepository(audit),
    approvals: new InMemoryApprovalRepository(audit),
    jobs: new InMemoryJobRepository(audit),
    audit,
    events: async () => audit.events(),
    memoryAudit: audit,
    suspend: async (membership) => tenancy.put({ ...membership, status: 'suspended' }),
  };
}

function firestoreStores(now: () => Date): Stores {
  const db: Firestore = emulatorFirestore();
  return {
    tenancy: new FirestoreTenancyStore(db, now),
    departments: new FirestoreDepartmentRepository(db),
    specialists: new FirestoreSpecialistRepository(db),
    executions: new FirestoreExecutionRepository(db),
    approvals: new FirestoreApprovalRepository(db),
    jobs: new FirestoreJobRepository(db),
    audit: new FirestoreAuditStore(db),
    async events() {
      const snapshot = await db.collection(AUDIT_LOGS).orderBy('occurredAt').get();
      return snapshot.docs.map((doc) => fromAuditDocument(doc.id, doc.data() as AuditDocument));
    },
    async suspend(membership) {
      await db.collection(MEMBERSHIPS).doc(membership.id).update({ status: 'suspended' });
    },
  };
}

const STORES: [string, (now: () => Date) => Stores][] = [
  ['memory', memoryStores],
  ...(emulatorHost ? [['firestore', firestoreStores] as [string, typeof memoryStores]] : []),
];

interface WorldOptions {
  readonly answers?: Answers;
  readonly ai?: () => Promise<ProviderOutcome>;
  /** `none`: no credits engine or rate (D-12), so every AI call is denied. */
  readonly credits?: 'none';
  readonly work?: NodeWorkSource | 'none';
  readonly verifier?: VerificationSource | 'none';
}

describe.each(STORES)('runtime advance() with storage in %s', (storage, createStores) => {
  async function world(options: WorldOptions = {}) {
    let clock = new Date(T0);
    // A server clock that moves a millisecond per read, so stored events have a strict order.
    const now = () => {
      clock = new Date(clock.getTime() + 1);
      return clock;
    };
    const stores = createStores(now);
    const provision = (organization: Organization) =>
      provisionDepartments(organization, DEFAULT_DEPARTMENT_CATALOGUE);
    const a = await createOrganization(as(ALICE), { name: 'A' }, stores.tenancy, {
      billing: BILLING,
      credits: openWallet,
      departments: provision,
    });
    const b = await createOrganization(as(BOB), { name: 'B' }, stores.tenancy, {
      billing: BILLING,
      credits: openWallet,
      departments: provision,
    });
    const orgA = a.organization.id;
    const authorization = createAuthorizationService();
    const auditService = createAuditService(stores.audit, now);
    const specialists = createSpecialistService({
      repository: stores.specialists,
      departments: stores.departments,
      organizations: stores.tenancy,
      authorization,
    });
    const approvals = createApprovalService({
      repository: stores.approvals,
      organizations: stores.tenancy,
      authorization,
      audit: auditService,
      now,
    });

    // Tools: the fixture executor records every call, with the context the gate gave it.
    const toolCalls: { context: ToolExecutionContext; input: unknown }[] = [];
    let executorHook: ((context: ToolExecutionContext) => Promise<void>) | undefined;
    const executor: ToolExecutor = {
      async execute(context, input) {
        toolCalls.push({ context, input });
        await executorHook?.(context);
        const answer = options.answers?.[context.toolId];
        return answer === undefined ? { status: 'success', output: { count: 3 } } : answer();
      },
    };
    const registry = createToolRegistry(TOOLS);

    // AI: a fake official provider behind the gateway, and a credits double.
    const providerCalls: ProviderCall[] = [];
    const credits = fakeCredits();
    const aiRegistry = createProviderRegistry({
      providers: [
        {
          id: 'alpha',
          name: 'Test alpha',
          status: 'active',
          access: 'official',
          capabilities: ['text_generation'],
          modalities: ['text'],
          environments: ['dev'],
          credential: { provider: 'alpha_api', scopes: ['generate'] },
          maxSensitivity: 'internal',
        },
      ],
      models: [MODEL],
      adapters: [fakeAdapter(providerCalls, options.ai ?? (async () => OK))],
    });

    const dispatched: JobId[] = [];
    const executionsFor = (requestId: string) =>
      createExecutionService({
        repository: stores.executions,
        organizations: stores.tenancy,
        assignments: specialists.assignments,
        authorization,
        audit: auditService,
        now,
        requestId,
      });
    const jobsFor = (requestId?: string) =>
      createJobService({
        jobs: stores.jobs,
        executions: stores.executions,
        tenancy: stores.tenancy,
        authorization,
        audit: auditService,
        leaseMs: LEASE_MS,
        now,
        ...(requestId === undefined ? {} : { requestId }),
      });
    const services = (correlationId: string) => ({
      executions: executionsFor(correlationId),
      gate: createToolGate({
        executions: stores.executions,
        organizations: stores.tenancy,
        specialists,
        departments: stores.departments,
        registry,
        approvals,
        executors: { fixture: executor },
        authorization,
        audit: auditService,
        environment: 'dev',
        now,
        requestId: correlationId,
        sleep: async () => undefined,
      }),
      ai: createAIGateway({
        executions: stores.executions,
        organizations: stores.tenancy,
        specialists,
        authorization,
        registry: aiRegistry,
        policies: createModelPolicyCatalogue([], { ...DEFAULT_MODEL_POLICY, backoffMs: 0 }),
        environment: 'dev',
        ...(options.credits === 'none'
          ? {}
          : { credits: { port: credits.port, rate: { microUsdPerCredit: 1_000 } } }),
        audit: auditService,
        timeoutMs: 1_000,
        now,
        sleep: async () => undefined,
      }),
      jobs: jobsFor(correlationId),
      approvals,
    });

    const work: NodeWorkSource = {
      toolInput: async () => INPUT,
      agentWork: async () => AGENT_WORK,
    };
    // Passing evidence for every completed node, as an output_schema check would give.
    const verifier: VerificationSource = {
      async verify(_tenant, execution) {
        return {
          verification: {
            correlationId: 'verify-1',
            nodes: execution.nodes
              .filter((n) => n.status === 'completed')
              .map((n) => ({
                nodeId: n.id,
                policy: 'output_schema',
                checks: [
                  {
                    code: 'schema_valid',
                    result: 'passed',
                    evidence: { type: 'check', id: `${n.id}-1` },
                  },
                ],
              })),
          },
          result: { type: 'report', id: 'rep-1' },
        };
      },
    };
    const baseJobs = jobsFor();
    const runtime = createRuntime({
      jobs: baseJobs,
      services,
      ...(options.work === 'none' ? {} : { work: options.work ?? work }),
      ...(options.verifier === 'none' ? {} : { verifier: options.verifier ?? verifier }),
      dispatcher: { dispatch: async (id) => void dispatched.push(id) },
    });

    const tenantA = await resolveTenant(as(ALICE), orgA, stores.tenancy);
    const tenantB = await resolveTenant(as(BOB), b.organization.id, stores.tenancy);
    const giaA = await resolveTenant(actAsGia(as(ALICE)), orgA, stores.tenancy);
    const runtimeA = await resolveRuntimeTenant(ALICE, orgA, stores.tenancy);
    const executions = executionsFor('req-owner');

    async function seed(): Promise<Specialist> {
      const departmentId = departmentIdOf(orgA, 'research' as DepartmentTypeId);
      const write = newSpecialist(
        {
          organizationId: orgA,
          displayName: 'María',
          configuration: {
            departmentId,
            mainRoleId: 'operations_assistant',
            roleVersion: 1,
            capabilities: [],
            skills: [],
            tools: TOOLS.map((t) => ({ id: t.id, version: 1 })),
            permissions: ['organization.read'],
            policies: {},
          } as never,
        },
        must(await stores.departments.find(orgA, departmentId)),
        ALICE,
        AT,
      );
      await stores.specialists.create(write);
      return stores.specialists.update(orgA, write.specialist.identity.id, (s) =>
        applySpecialistStatus(s, { from: s.status, to: 'active' }, AT),
      );
    }

    type NodeSpec = {
      id: string;
      type?: ExecutionNodeType;
      tool?: string;
      dependsOn?: string[];
    };

    /** Alice's started execution of an active specialist, with the given nodes. */
    async function started(nodes: readonly NodeSpec[]): Promise<Execution> {
      const specialist = await seed();
      const created = await executions.create(tenantA, {
        mode: 'execute',
        input: { type: 'task', id: 'task-1' },
        specialistId: specialist.identity.id,
        specialistVersion: specialist.version,
        departmentId: specialist.configuration.departmentId,
        versionSnapshot: {
          schemaVersion: 1,
          components: [{ kind: 'specialist', id: specialist.identity.id, version: '1' }],
        },
        nodes: nodes.map((n) => ({
          id: n.id,
          type: n.type ?? (n.tool === undefined ? 'agent' : 'tool'),
          label: n.id,
          ...(n.tool === undefined ? {} : { tool: { id: n.tool, version: 1 } }),
          ...(n.dependsOn === undefined ? {} : { dependsOn: n.dependsOn }),
        })),
      });
      return executions.start(tenantA, created.id);
    }

    const get = (id: string) => executions.get(tenantA, id);
    const nodeOf = async (id: string, nodeId: string) =>
      must((await get(id)).nodes.find((n) => n.id === nodeId));

    /** A worker's delivery: lease the job, then advance it. */
    async function deliver(jobId: JobId, workerId = 'worker-1'): Promise<AdvanceResult> {
      const claim = await baseJobs.acquire(jobId, workerId);
      return runtime.advance(claim.lease);
    }

    /** Runs an execution to wherever it stops, one job at a time, as a worker would. */
    async function drive(execution: Execution): Promise<AdvanceResult[]> {
      const results: AdvanceResult[] = [];
      let next: JobId | undefined = (await runtime.kickoff(tenantA, execution.id)).id;
      while (next !== undefined && results.length < 20) {
        const result = await deliver(next);
        results.push(result);
        next = result.nextJobId;
      }
      return results;
    }

    const eventsOf = async (executionId: string, prefix = '') =>
      (await stores.events()).filter(
        (e) => e.target?.id === executionId && e.action.startsWith(prefix),
      );

    return {
      stores,
      a,
      orgA,
      tenantA,
      tenantB,
      giaA,
      runtimeA,
      approvals,
      executions,
      jobs: baseJobs,
      runtime,
      toolCalls,
      providerCalls,
      credits,
      dispatched,
      started,
      get,
      nodeOf,
      deliver,
      drive,
      eventsOf,
      setExecutorHook: (hook: (context: ToolExecutionContext) => Promise<void>) => {
        executorHook = hook;
      },
      advanceClock: (ms: number) => {
        clock = new Date(clock.getTime() + ms);
      },
    };
  }

  type World = Awaited<ReturnType<typeof world>>;

  /** Kicks an execution off and leases its first job. */
  async function firstClaim(w: World, execution: Execution): Promise<JobClaim> {
    const job = await w.runtime.kickoff(w.tenantA, execution.id);
    return w.jobs.acquire(job.id, 'worker-1');
  }

  // -------------------------------------------------------------------------------------------

  it('1. advances a running execution: runs its first node and queues the next', async () => {
    const w = await world();
    const execution = await w.started([
      { id: 'n0', tool: 'lookup' },
      { id: 'n1', tool: 'lookup', dependsOn: ['n0'] },
    ]);
    const claim = await firstClaim(w, execution);
    const result = await w.runtime.advance(claim.lease);
    expect(result).toMatchObject({ outcome: 'progressed', code: 'node_completed' });
    expect(result.nextJobId).toBe(jobIdFor(w.orgA, execution.id, 'n1', 1));
    expect(w.dispatched).toContain(result.nextJobId);
    const stored = await w.get(execution.id);
    expect(stored.status).toBe('running');
    expect(stored.nodes.map((n) => n.status)).toEqual(['completed', 'pending']);
    expect(await w.jobs.get(w.tenantA, claim.job.id)).toMatchObject({
      state: 'succeeded',
      outcome: { code: 'node_completed' },
    });
    // The rest runs to completion, verified.
    const rest = await w.deliver(must(result.nextJobId));
    expect(rest).toMatchObject({ outcome: 'completed', code: 'execution_completed' });
    expect(await w.get(execution.id)).toMatchObject({
      status: 'completed',
      result: { type: 'report', id: 'rep-1' },
      verification: { result: 'passed' },
    });
  });

  it('2. leaves an ended execution unchanged and cancels its job', async () => {
    const w = await world();
    const execution = await w.started([{ id: 'n0', tool: 'lookup' }]);
    const claim = await firstClaim(w, execution);
    const cancelled = await w.executions.cancel(w.tenantA, execution.id, 'director_request');
    const before = (await w.eventsOf(execution.id, 'execution.node')).length;
    expect(await w.runtime.advance(claim.lease)).toEqual({
      outcome: 'execution_ended',
      code: 'job_cancelled',
    });
    expect(await w.get(execution.id)).toMatchObject({
      status: 'cancelled',
      revision: cancelled.revision,
    });
    expect((await w.eventsOf(execution.id, 'execution.node')).length).toBe(before);
    expect((await w.jobs.get(w.tenantA, claim.job.id)).state).toBe('cancelled');
    expect(w.toolCalls).toHaveLength(0);
  });

  it('3. runs exactly one node per advance, even when several are ready', async () => {
    const w = await world();
    const execution = await w.started([
      { id: 'n0', tool: 'lookup' },
      { id: 'n1', tool: 'lookup' },
      { id: 'n2', tool: 'lookup' },
    ]);
    const result = await w.runtime.advance((await firstClaim(w, execution)).lease);
    expect(w.toolCalls).toHaveLength(1);
    expect((await w.get(execution.id)).nodes.map((n) => n.status)).toEqual([
      'completed',
      'pending',
      'pending',
    ]);
    // One next job, for the next node in graph order: never two at once.
    expect(result.nextJobId).toBe(jobIdFor(w.orgA, execution.id, 'n1', 1));
    expect(await codeOf(w.jobs.get(w.tenantA, jobIdFor(w.orgA, execution.id, 'n2', 1)))).toBe(
      'job_not_found',
    );
  });

  it('4. treats a second delivery of the same proof as a duplicate, changing nothing', async () => {
    const w = await world();
    const execution = await w.started([
      { id: 'n0', tool: 'lookup' },
      { id: 'n1', tool: 'lookup', dependsOn: ['n0'] },
    ]);
    const claim = await firstClaim(w, execution);
    await w.runtime.advance(claim.lease);
    const events = (await w.stores.events()).length;
    const stored = await w.get(execution.id);
    expect(await w.runtime.advance(claim.lease)).toEqual({
      outcome: 'duplicate',
      code: 'job_terminal',
    });
    expect(await w.get(execution.id)).toEqual(stored);
    expect((await w.stores.events()).length).toBe(events);
    expect(w.toolCalls).toHaveLength(1);
  });

  it('5. lets only one of five concurrent advances work; the others exit with no effect', async () => {
    const w = await world();
    const execution = await w.started([
      { id: 'n0', tool: 'update_record' },
      { id: 'n1', tool: 'lookup', dependsOn: ['n0'] },
    ]);
    const claim = await firstClaim(w, execution);
    const results = await Promise.all(
      Array.from({ length: 5 }, () => w.runtime.advance(claim.lease)),
    );
    expect(results.filter((r) => r.outcome === 'progressed')).toHaveLength(1);
    expect(results.filter((r) => r.outcome === 'duplicate')).toHaveLength(4);
    expect(w.toolCalls).toHaveLength(1);
    const nodeChanges = await w.eventsOf(execution.id, 'execution.node_changed');
    expect(nodeChanges.map((e) => [e.nodeId, e.transition?.to])).toEqual([
      ['n0', 'running'],
      ['n0', 'completed'],
    ]);
    expect(await w.eventsOf(execution.id, 'execution.job_enqueued')).toHaveLength(2);
    expect(await w.eventsOf(execution.id, 'execution.job_finished')).toHaveLength(1);
  });

  it('6. runs a tool only through the tool gate, with its checks and its audit', async () => {
    const w = await world();
    const execution = await w.started([{ id: 'n0', tool: 'update_record' }]);
    await w.runtime.advance((await firstClaim(w, execution)).lease);
    expect(w.toolCalls).toHaveLength(1);
    const call = must(w.toolCalls[0]);
    // The context only the gate builds: organization and user from the stored execution, the
    // node's idempotency key, and the runtime acting for the user who started the work.
    expect(call.context).toMatchObject({
      organizationId: w.orgA,
      executionId: execution.id,
      nodeId: 'n0',
      toolId: 'update_record',
      actor: { userId: ALICE, via: 'runtime' },
    });
    expect(call.context.idempotencyKey).toMatch(/^[0-9a-f]{64}$/);
    expect(call.input).toEqual(INPUT);
    const toolEvents = await w.eventsOf(execution.id, 'tool.');
    expect(toolEvents.map((e) => e.action)).toContain('tool.execution_completed');
  });

  it('7. calls a model only through the AI gateway, audited and charged once', async () => {
    const w = await world();
    const execution = await w.started([{ id: 'n0' }]);
    const claim = await firstClaim(w, execution);
    const result = await w.runtime.advance(claim.lease);
    expect(result.outcome).toBe('completed');
    expect(w.providerCalls).toHaveLength(1);
    const requestId = `job-${claim.job.id}`;
    // A completed call is recorded by the credits it consumed, under the request id; refusals
    // and failures are audited by the gateway (ADR-0027). None here.
    expect((await w.stores.events()).filter((e) => e.action.startsWith('ai.'))).toEqual([]);
    expect([...w.credits.spent.keys()]).toEqual([`${w.orgA}\nai:${requestId}`]);
    expect(await w.nodeOf(execution.id, 'n0')).toMatchObject({
      status: 'completed',
      output: { type: 'ai_request', id: requestId },
    });
    expect(JSON.stringify(await w.stores.events())).not.toContain(SECRET_VALUE);
  });

  it('7b. denies every AI call while no credit rate is configured (D-12), and fails the node', async () => {
    const w = await world({ credits: 'none' });
    const execution = await w.started([{ id: 'n0' }]);
    const result = await w.runtime.advance((await firstClaim(w, execution)).lease);
    expect(result).toEqual({ outcome: 'failed', code: 'credits_not_configured' });
    expect(w.providerCalls).toHaveLength(0);
    expect(await w.get(execution.id)).toMatchObject({
      status: 'failed',
      failure: { code: 'credits_not_configured' },
    });
  });

  it('8. cannot reach a provider directly: no adapter, credential or SDK in the runtime', () => {
    const root = join(import.meta.dirname, '..');
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      dependencies: Record<string, string>;
    };
    // Workspace packages only: no provider SDK, HTTP client or Firestore.
    expect(Object.keys(manifest.dependencies).every((d) => d.startsWith('@melonoffice/'))).toBe(
      true,
    );
    expect(Object.keys(manifest.dependencies)).not.toContain('@melonoffice/firestore');
    const sources = readdirSync(join(root, 'src')).filter(
      (f) => f.endsWith('.ts') && !f.endsWith('.test.ts'),
    );
    expect(sources.length).toBeGreaterThan(0);
    for (const file of sources) {
      const text = readFileSync(join(root, 'src', file), 'utf8');
      // The AI gateway is used only as types; nothing that reaches a provider is imported.
      expect(text).not.toMatch(/import\s+\{[^}]*\}\s+from\s+'@melonoffice\/ai-gateway'/);
      expect(text).not.toMatch(/ProviderAdapter|ProviderCredential|CredentialResolver|registry/);
      expect(text).not.toMatch(/from '@melonoffice\/tools'|executors?\b/);
      expect(text).not.toMatch(/fetch\(|node:http|node:https/);
    }
  });

  it('9. stops on a tool that needs approval: execution waits, job back in the queue', async () => {
    const w = await world();
    const execution = await w.started([{ id: 'n0', tool: 'send_email' }]);
    const claim = await firstClaim(w, execution);
    expect(await w.runtime.advance(claim.lease)).toEqual({
      outcome: 'waiting_approval',
      code: 'approval_required',
    });
    expect(w.toolCalls).toHaveLength(0);
    const stored = await w.get(execution.id);
    expect(stored.status).toBe('waiting_approval');
    const approvalId = must(stored.nodes[0]?.approvalId);
    expect((await w.approvals.get(w.tenantA, approvalId)).status).toBe('pending');
    expect(await w.jobs.get(w.tenantA, claim.job.id)).toMatchObject({ state: 'queued' });
    expect(await w.eventsOf(execution.id, 'execution.job_released')).toHaveLength(1);
    // Nothing moves until a person decides.
    expect(await codeOf(w.runtime.resume(w.tenantA, execution.id))).toBe('approval_pending');
  });

  it('10. resumes on the exact approval and runs the tool once', async () => {
    const w = await world();
    const execution = await w.started([{ id: 'n0', tool: 'send_email' }]);
    const claim = await firstClaim(w, execution);
    await w.runtime.advance(claim.lease);
    const approvalId = must((await w.get(execution.id)).nodes[0]?.approvalId);
    await w.approvals.approve(w.tenantA, approvalId);
    const job = await w.runtime.resume(w.tenantA, execution.id);
    expect(job.id).toBe(claim.job.id);
    expect(w.dispatched).toContain(job.id);
    const result = await w.deliver(job.id, 'worker-2');
    expect(result.outcome).toBe('completed');
    expect(w.toolCalls).toHaveLength(1);
    expect(await w.nodeOf(execution.id, 'n0')).toMatchObject({ status: 'completed', approvalId });
    // Resuming again finds nothing to resume.
    expect(await codeOf(w.runtime.resume(w.tenantA, execution.id))).toBe('execution_not_waiting');
  });

  it('11. refuses an approval that is not for exactly this node', async () => {
    const w = await world();
    const execution = await w.started([{ id: 'n0', tool: 'send_email' }]);
    const other = await w.started([{ id: 'n0', tool: 'send_email' }]);
    await w.runtime.advance((await firstClaim(w, other)).lease);
    const foreign = must((await w.get(other.id)).nodes[0]?.approvalId);
    await w.approvals.approve(w.tenantA, foreign);
    // Forged: another execution's approval attached to this node, as tampering would do.
    await w.stores.executions.update(w.orgA, execution.id, (current) => ({
      execution: {
        ...attachApproval(current, 'n0', foreign as ApprovalId, AT),
        status: 'waiting_approval',
      },
      events: [],
    }));
    expect(await codeOf(w.runtime.resume(w.tenantA, execution.id))).toBe('approval_mismatch');
    expect(w.toolCalls).toHaveLength(0);
  });

  it('12. never lets the runtime decide an approval', async () => {
    const w = await world();
    const execution = await w.started([{ id: 'n0', tool: 'send_email' }]);
    await w.runtime.advance((await firstClaim(w, execution)).lease);
    const approvalId = must((await w.get(execution.id)).nodes[0]?.approvalId);
    expect(await codeOf(w.approvals.approve(w.runtimeA, approvalId))).toBe('approval_forbidden');
    expect(await codeOf(w.approvals.reject(w.runtimeA, approvalId))).toBe('approval_forbidden');
    expect((await w.approvals.get(w.tenantA, approvalId)).status).toBe('pending');
    expect(await codeOf(w.runtime.resume(w.runtimeA, execution.id))).toBe('approval_pending');
  });

  it('13. never lets GIA decide an approval or drive the runtime', async () => {
    const w = await world();
    const execution = await w.started([{ id: 'n0', tool: 'send_email' }]);
    expect(await codeOf(w.runtime.kickoff(w.giaA, execution.id))).toBe('actor_not_allowed');
    await w.runtime.advance((await firstClaim(w, execution)).lease);
    const approvalId = must((await w.get(execution.id)).nodes[0]?.approvalId);
    expect(await codeOf(w.approvals.approve(w.giaA, approvalId))).toBe('approval_forbidden');
    expect(await codeOf(w.runtime.resume(w.giaA, execution.id))).toBe('actor_not_allowed');
    expect(w.toolCalls).toHaveLength(0);
  });

  it('14. never runs a completed node again, even after its worker lost the lease', async () => {
    const w = await world();
    const execution = await w.started([
      { id: 'n0', tool: 'lookup' },
      { id: 'n1', tool: 'lookup', dependsOn: ['n0'] },
    ]);
    const claim = await firstClaim(w, execution);
    // The tool outlives the lease: the worker cannot finish its job.
    w.setExecutorHook(async () => w.advanceClock(LEASE_MS + 1));
    const result = await w.runtime.advance(claim.lease);
    expect(result.outcome).toBe('progressed');
    expect((await w.jobs.get(w.tenantA, claim.job.id)).state).toBe('leased');
    // Another worker takes the job over: the node is done, so there is nothing to run.
    expect(await codeOf(w.jobs.acquire(claim.job.id, 'worker-2'))).toBe('node_not_runnable');
    expect(w.toolCalls).toHaveLength(1);
    expect(await w.nodeOf(execution.id, 'n0')).toMatchObject({ status: 'completed' });
    // The next node was queued before the lost finish, so no progress is lost.
    expect(result.nextJobId).toBe(jobIdFor(w.orgA, execution.id, 'n1', 1));
  });

  it('15. never runs a skipped node', async () => {
    const w = await world();
    const execution = await w.started([
      { id: 'n0', tool: 'lookup' },
      { id: 'n1', tool: 'update_record' },
    ]);
    const claim = await firstClaim(w, execution);
    await w.executions.runtimeChangeNode(w.runtimeA, execution.id, {
      nodeId: 'n1',
      from: 'pending',
      to: 'skipped',
    });
    expect(
      await codeOf(w.jobs.enqueue(w.runtimeA, { executionId: execution.id, nodeId: 'n1' })),
    ).toBe('node_not_runnable');
    const result = await w.runtime.advance(claim.lease);
    expect(result.outcome).toBe('completed');
    expect(w.toolCalls.map((c) => c.context.toolId)).toEqual(['lookup']);
    expect(await w.nodeOf(execution.id, 'n1')).toMatchObject({ status: 'skipped' });
  });

  it('16. never re-runs a node whose outcome is unknown: it waits for a person', async () => {
    const w = await world();
    const execution = await w.started([{ id: 'n0', tool: 'update_record' }]);
    const claim = await firstClaim(w, execution);
    // A previous worker started the node and was lost.
    await w.executions.runtimeChangeNode(w.runtimeA, execution.id, {
      nodeId: 'n0',
      from: 'pending',
      to: 'running',
    });
    expect(await w.runtime.advance(claim.lease)).toEqual({
      outcome: 'awaiting_resolution',
      code: 'outcome_unknown',
    });
    expect(w.toolCalls).toHaveLength(0);
    const stored = await w.get(execution.id);
    expect(stored.status).toBe('running');
    expect(stored.nodes[0]).toMatchObject({ status: 'failed', error: { code: 'outcome_unknown' } });
    expect(await codeOf(w.executions.retryNode(w.runtimeA, execution.id, 'n0'))).toBe(
      'retry_not_allowed',
    );
    expect(await codeOf(w.jobs.get(w.tenantA, jobIdFor(w.orgA, execution.id, 'n0', 2)))).toBe(
      'job_not_found',
    );
  });

  it('17. never retries a timed-out node', async () => {
    const w = await world({
      answers: { slow: () => new Promise(() => undefined) },
    });
    const execution = await w.started([{ id: 'n0', tool: 'slow' }]);
    const result = await w.runtime.advance((await firstClaim(w, execution)).lease);
    expect(result).toEqual({ outcome: 'awaiting_resolution', code: 'outcome_unknown' });
    expect(await w.nodeOf(execution.id, 'n0')).toMatchObject({
      status: 'failed',
      error: { code: 'timeout' },
    });
    expect((await w.nodeOf(execution.id, 'n0')).attempt ?? 1).toBe(1);
    expect(w.toolCalls).toHaveLength(1);
    expect(await codeOf(w.jobs.get(w.tenantA, jobIdFor(w.orgA, execution.id, 'n0', 2)))).toBe(
      'job_not_found',
    );
  });

  it('18–19. retries a failed idempotent node once, with the same idempotency key, never twice', async () => {
    const w = await world({
      answers: { update_record: async () => ({ status: 'failure', code: 'tool_failure' }) },
    });
    const execution = await w.started([{ id: 'n0', tool: 'update_record' }]);
    const first = await w.runtime.advance((await firstClaim(w, execution)).lease);
    expect(first).toMatchObject({ outcome: 'retrying', code: 'tool_failure' });
    expect(first.nextJobId).toBe(jobIdFor(w.orgA, execution.id, 'n0', 2));
    const second = await w.deliver(must(first.nextJobId));
    expect(second).toEqual({ outcome: 'failed', code: 'tool_failure' });
    expect(w.toolCalls).toHaveLength(2);
    const [one, two] = w.toolCalls.map((c) => c.context.idempotencyKey);
    expect(one).toMatch(/^[0-9a-f]{64}$/);
    expect(two).toBe(one);
    expect(await w.get(execution.id)).toMatchObject({
      status: 'failed',
      failure: { code: 'tool_failure' },
    });
    expect(await codeOf(w.jobs.get(w.tenantA, jobIdFor(w.orgA, execution.id, 'n0', 3)))).toBe(
      'job_not_found',
    );
  });

  it('18b. never retries an agent node: its call may have cost credits', async () => {
    const w = await world({
      ai: async () => ({ status: 'error', kind: 'invalid_request' }),
    });
    const execution = await w.started([{ id: 'n0' }]);
    const result = await w.runtime.advance((await firstClaim(w, execution)).lease);
    expect(result.outcome).toBe('failed');
    expect(w.providerCalls).toHaveLength(1);
  });

  it('20. never verifies while a node is unfinished', async () => {
    const w = await world({ verifier: 'none' });
    const execution = await w.started([
      { id: 'n0', tool: 'lookup' },
      { id: 'n1', tool: 'lookup', dependsOn: ['n0'] },
    ]);
    expect(
      await codeOf(
        w.executions.runtimeChangeStatus(w.runtimeA, execution.id, {
          from: 'running',
          to: 'verifying',
        }),
      ),
    ).toBe('invalid_execution_transition');
    const results = await w.drive(execution);
    // All work done, no verifier: it stays verifying, never completed.
    expect(results.at(-1)).toEqual({
      outcome: 'verification_pending',
      code: 'verification_pending',
    });
    expect((await w.get(execution.id)).status).toBe('verifying');
  });

  it('21. never skips verifying on the way to completed', async () => {
    const w = await world();
    const execution = await w.started([{ id: 'n0', tool: 'lookup' }]);
    expect(
      await codeOf(
        w.executions.runtimeChangeStatus(w.runtimeA, execution.id, {
          from: 'running',
          to: 'completed',
        }),
      ),
    ).toBe('invalid_execution_transition');
    await w.drive(execution);
    const path = (await w.eventsOf(execution.id, 'execution.state_changed')).map(
      (e) => e.transition?.to,
    );
    expect(path).toEqual(['running', 'verifying', 'completed']);
  });

  it('22. completes only with evidence that passed; failing evidence fails the execution', async () => {
    const failing = await world({
      verifier: {
        async verify(_tenant, execution) {
          return {
            verification: {
              correlationId: 'verify-1',
              nodes: execution.nodes.map((n) => ({
                nodeId: n.id,
                policy: 'checks',
                checks: [
                  { code: 'totals_match', result: 'failed', evidence: { type: 'check', id: 'c1' } },
                ],
              })),
            },
          };
        },
      },
    });
    const execution = await failing.started([{ id: 'n0', tool: 'lookup' }]);
    expect((await failing.drive(execution)).at(-1)).toEqual({
      outcome: 'failed',
      code: 'verification_failed',
    });
    expect(await failing.get(execution.id)).toMatchObject({
      status: 'failed',
      verification: { result: 'failed' },
    });
    const passing = await world();
    const ok = await passing.started([{ id: 'n0', tool: 'lookup' }]);
    await passing.drive(ok);
    expect(await passing.get(ok.id)).toMatchObject({
      status: 'completed',
      verification: { result: 'passed' },
    });
  });

  it('23–24. audits every node change with who, where, which node, from and to, in its write', async () => {
    const w = await world();
    const execution = await w.started([
      { id: 'n0', tool: 'lookup' },
      { id: 'n1', dependsOn: ['n0'] },
    ]);
    await w.drive(execution);
    const changes = await w.eventsOf(execution.id, 'execution.node_changed');
    expect(changes.map((e) => [e.nodeId, e.transition?.from, e.transition?.to])).toEqual([
      ['n0', 'pending', 'running'],
      ['n0', 'running', 'completed'],
      ['n1', 'pending', 'running'],
      ['n1', 'running', 'completed'],
    ]);
    const jobOf = (nodeId: string) => jobIdFor(w.orgA, execution.id, nodeId, 1);
    for (const change of changes) {
      expect(change).toMatchObject({
        result: 'success',
        actor: { type: 'system', id: 'runtime', initiatedBy: ALICE, via: 'runtime' },
        organizationId: w.orgA,
        target: { type: 'execution', id: execution.id },
        source: 'api',
      });
      expect(typeof change.occurredAt).toBe('string');
      // Correlated with the job that ran it, never with a payload.
      expect(change.requestId).toBeDefined();
      expect(JSON.stringify(change)).not.toMatch(/Weekly summary|Summarise|Summary ready/);
    }
    // One event per change stored: the node history is the audit history.
    const stored = await w.get(execution.id);
    expect(stored.nodes.every((n) => n.status === 'completed')).toBe(true);
    expect(await w.jobs.get(w.tenantA, jobOf('n1'))).toMatchObject({ state: 'succeeded' });
  });

  it.runIf(storage === 'memory')(
    '25. makes no transition when its audit cannot be written: nothing runs',
    async () => {
      const w = await world();
      const execution = await w.started([{ id: 'n0', tool: 'update_record' }, { id: 'n1' }]);
      const claim = await firstClaim(w, execution);
      const audit = must(w.stores.memoryAudit);
      const original = audit.appendNow.bind(audit);
      audit.appendNow = () => {
        throw new Error('audit unavailable');
      };
      await expect(w.runtime.advance(claim.lease)).rejects.toThrow();
      audit.appendNow = original;
      const stored = await w.get(execution.id);
      expect(stored.nodes.map((n) => n.status)).toEqual(['pending', 'pending']);
      expect(stored.revision).toBe(execution.revision);
      expect(w.toolCalls).toHaveLength(0);
      // The same for an agent node: no running node without its audit, so no model call.
      const agent = await w.started([{ id: 'n0' }]);
      const agentClaim = await firstClaim(w, agent);
      audit.appendNow = () => {
        throw new Error('audit unavailable');
      };
      await expect(w.runtime.advance(agentClaim.lease)).rejects.toThrow('audit unavailable');
      audit.appendNow = original;
      expect(await w.nodeOf(agent.id, 'n0')).toMatchObject({ status: 'pending' });
      expect(w.providerCalls).toHaveLength(0);
    },
  );

  it('26. stops processing a cancelled execution: late results are discarded, nothing is queued', async () => {
    const w = await world();
    const execution = await w.started([
      { id: 'n0', tool: 'lookup' },
      { id: 'n1', tool: 'lookup', dependsOn: ['n0'] },
    ]);
    const claim = await firstClaim(w, execution);
    // The owner cancels while the tool runs.
    w.setExecutorHook(async () => {
      await w.executions.cancel(w.tenantA, execution.id, 'director_request');
    });
    const result = await w.runtime.advance(claim.lease);
    expect(result.outcome).toBe('execution_ended');
    const stored = await w.get(execution.id);
    expect(stored.status).toBe('cancelled');
    expect(stored.nodes.map((n) => n.status)).toEqual(['cancelled', 'cancelled']);
    expect(await codeOf(w.jobs.get(w.tenantA, jobIdFor(w.orgA, execution.id, 'n1', 1)))).toBe(
      'job_not_found',
    );
    expect((await w.jobs.get(w.tenantA, claim.job.id)).state).toBe('cancelled');
  });

  it('27. refuses another organization, and a context that was not resolved', async () => {
    const w = await world();
    const execution = await w.started([{ id: 'n0', tool: 'lookup' }]);
    expect(await codeOf(w.runtime.kickoff(w.tenantB, execution.id))).toBe('execution_not_found');
    expect(await codeOf(w.runtime.resume(w.tenantB, execution.id))).toBe('execution_not_found');
    const forged = { ...w.tenantA } as TenantContext;
    expect(await codeOf(w.runtime.kickoff(forged, execution.id))).toBe('unresolved_tenant');
    expect(w.dispatched).toHaveLength(0);
  });

  it('28. refuses to work for a user whose membership was suspended', async () => {
    const w = await world();
    const execution = await w.started([{ id: 'n0', tool: 'lookup' }]);
    const claim = await firstClaim(w, execution);
    await w.stores.suspend(w.a.membership);
    expect(await codeOf(w.runtime.advance(claim.lease))).toBe('job_forbidden');
    expect(w.toolCalls).toHaveLength(0);
    expect((await w.stores.executions.find(w.orgA, execution.id))?.nodes[0]?.status).toBe(
      'pending',
    );
  });

  it('29–31. refuses a wrong lease, an old revision and an expired lease, with no effect', async () => {
    const w = await world();
    const execution = await w.started([{ id: 'n0', tool: 'lookup' }]);
    const claim = await firstClaim(w, execution);
    expect(await codeOf(w.runtime.advance({ ...claim.lease, leaseId: randomUUID() }))).toBe(
      'job_lease_mismatch',
    );
    for (const revision of [claim.lease.revision - 1, claim.lease.revision + 1]) {
      expect(await w.runtime.advance({ ...claim.lease, revision })).toEqual({
        outcome: 'duplicate',
        code: 'job_revision_mismatch',
      });
    }
    w.advanceClock(LEASE_MS);
    expect(await codeOf(w.runtime.advance(claim.lease))).toBe('job_lease_expired');
    expect(w.toolCalls).toHaveLength(0);
    expect(await w.nodeOf(execution.id, 'n0')).toMatchObject({ status: 'pending' });
  });

  it('32. takes nothing but a lease proof, and refuses fields the runtime sets itself', async () => {
    const w = await world({
      work: {
        toolInput: async () => INPUT,
        agentWork: async () => ({ ...AGENT_WORK, specialistId: 'someone-else' }) as never,
      },
    });
    const execution = await w.started([{ id: 'n0' }]);
    const claim = await firstClaim(w, execution);
    for (const extra of [
      { organizationId: w.orgA },
      { userId: ALICE },
      { role: 'owner' },
      { tenant: w.tenantA },
      { approved: true },
      { approvalId: randomUUID() },
      { provider: 'alpha' },
      { model: 'alpha-small' },
      { nodeStatus: 'completed' },
      { attempt: 2 },
      { executionId: execution.id },
    ]) {
      expect(await codeOf(w.runtime.advance({ ...claim.lease, ...extra }))).toBe('invalid_request');
    }
    for (const bad of [null, 'job', [claim.lease], { jobId: claim.job.id }]) {
      expect(await codeOf(w.runtime.advance(bad))).toBe('invalid_request');
    }
    expect(await w.runtime.advance(claim.lease)).toEqual({
      outcome: 'failed',
      code: 'invalid_work',
    });
    expect(w.providerCalls).toHaveLength(0);
  });

  it('32b. fails safely when a node has nothing to work on, or a type with no behaviour yet', async () => {
    const empty = await world({ work: 'none' });
    const tooled = await empty.started([{ id: 'n0', tool: 'lookup' }]);
    expect(await empty.runtime.advance((await firstClaim(empty, tooled)).lease)).toEqual({
      outcome: 'failed',
      code: 'input_unavailable',
    });
    expect(empty.toolCalls).toHaveLength(0);
    for (const type of ['condition', 'workflow', 'delay', 'event', 'approval'] as const) {
      const w = await world();
      const execution = await w.started([{ id: 'n0', type }]);
      expect(await w.runtime.advance((await firstClaim(w, execution)).lease)).toEqual({
        outcome: 'failed',
        code: 'node_type_unsupported',
      });
    }
  });

  it('32c. runs a parallel node as graph logic only, one branch at a time', async () => {
    const w = await world();
    const execution = await w.started([
      { id: 'split', type: 'parallel' },
      { id: 'a', tool: 'lookup', dependsOn: ['split'] },
      { id: 'b', tool: 'lookup', dependsOn: ['split'] },
    ]);
    const results = await w.drive(execution);
    expect(results.map((r) => r.outcome)).toEqual(['progressed', 'progressed', 'completed']);
    expect(w.toolCalls).toHaveLength(2);
  });

  it('33. never creates a job twice', async () => {
    const w = await world();
    const execution = await w.started([{ id: 'n0', tool: 'lookup' }]);
    const jobs = await Promise.all([
      w.runtime.kickoff(w.tenantA, execution.id),
      w.runtime.kickoff(w.tenantA, execution.id),
      w.runtime.kickoff(w.tenantA, execution.id),
    ]);
    expect(new Set(jobs.map((j: ExecutionJob) => j.id)).size).toBe(1);
    expect(await w.eventsOf(execution.id, 'execution.job_enqueued')).toHaveLength(1);
    await w.runtime.advance((await w.jobs.acquire(must(jobs[0]).id, 'worker-1')).lease);
    expect(await codeOf(w.runtime.kickoff(w.tenantA, execution.id))).toBe('execution_in_progress');
  });

  it('34. never repeats an external effect: one tool call, one model call, one charge', async () => {
    const w = await world();
    const execution = await w.started([
      { id: 'n0', tool: 'update_record' },
      { id: 'n1', dependsOn: ['n0'] },
    ]);
    const claim = await firstClaim(w, execution);
    const first = await Promise.all(
      Array.from({ length: 5 }, () => w.runtime.advance(claim.lease)),
    );
    const next = must(first.find((r) => r.outcome === 'progressed')?.nextJobId);
    const agentClaim = await w.jobs.acquire(next, 'worker-2');
    await Promise.all(Array.from({ length: 5 }, () => w.runtime.advance(agentClaim.lease)));
    // Redelivered after the fact: still nothing new.
    await w.runtime.advance(claim.lease);
    await w.runtime.advance(agentClaim.lease);
    expect(w.toolCalls).toHaveLength(1);
    expect(w.providerCalls).toHaveLength(1);
    expect(w.credits.spent.size).toBe(1);
    expect((await w.get(execution.id)).status).toBe('completed');
  });

  it('refuses a job error that is not a known refusal, and keeps runtime errors typed', async () => {
    const w = await world();
    const execution = await w.started([{ id: 'n0', tool: 'lookup' }]);
    const error = await w.runtime.kickoff(w.giaA, execution.id).catch((e: unknown) => e);
    expect(isRuntimeError(error)).toBe(true);
    const missing = await w.runtime
      .advance({ jobId: randomUUID(), leaseId: randomUUID(), revision: 2 })
      .catch((e: unknown) => e);
    expect(isJobError(missing) && missing.code).toBe('job_not_found');
  });
});
