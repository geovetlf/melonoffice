import type { Firestore } from '@google-cloud/firestore';
import {
  contactRef,
  createAgentTaskService,
  InMemoryAgentTaskRepository,
  parseAgentAnswer,
  type AgentTaskRepository,
} from '@melonoffice/agents';
import {
  createModelPolicyCatalogue,
  createProviderRegistry,
  CREDIT_RATE,
  type AICreditsPort,
  type ProviderCall,
  type ProviderOutcome,
} from '@melonoffice/ai-gateway';
import {
  AGENT_TASK_POLICY,
  CONVERSATION_AGENT_POLICY,
  VERTEX_AI_MODELS,
  VERTEX_AI_PROVIDER,
  VERTEX_AI_PROVIDER_ID,
} from '@melonoffice/ai-vertex';
import { createApprovalService, InMemoryApprovalRepository } from '@melonoffice/approvals';
import { createAuditService, InMemoryAuditStore, type AuditEvent } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import {
  createCompanyBrain,
  InMemoryKnowledgeRepository,
  type KnowledgeRepository,
} from '@melonoffice/brain';
import {
  createCustomerService,
  createFollowUpService,
  InMemoryConversationRepository,
  type ConversationRepository,
} from '@melonoffice/conversations';
import type { EventDraft } from '@melonoffice/events';
import { createLogger } from '@melonoffice/observability';
import { openWallet } from '@melonoffice/credits';
import {
  DEFAULT_DEPARTMENT_CATALOGUE,
  InMemoryDepartmentRepository,
  provisionDepartments,
} from '@melonoffice/departments';
import type {
  InitialBilling,
  JobId,
  Organization,
  Specialist,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import {
  createAgentOutputStore,
  createExecutionService,
  InMemoryAgentOutputRepository,
  InMemoryExecutionRepository,
  type AgentOutputRepository,
} from '@melonoffice/execution';
import {
  AUDIT_LOGS,
  FirestoreAgentOutputRepository,
  FirestoreAgentTaskRepository,
  FirestoreApprovalRepository,
  FirestoreAuditStore,
  FirestoreConversationRepository,
  FirestoreDepartmentRepository,
  FirestoreExecutionRepository,
  FirestoreJobRepository,
  FirestoreKnowledgeRepository,
  FirestoreSpecialistRepository,
  FirestoreTenancyStore,
  fromAuditDocument,
  type AuditDocument,
} from '@melonoffice/firestore';
import { emulatorFirestore, emulatorHost } from '@melonoffice/firestore/testing';
import { InMemoryJobRepository, isJobError } from '@melonoffice/jobs';
import { createAuthorizationService } from '@melonoffice/rbac';
import {
  createSkillCatalogue,
  createSpecialistManagement,
  createSpecialistService,
  InMemorySpecialistRepository,
} from '@melonoffice/specialists';
import { createOrganization, InMemoryTenancyStore, resolveTenant } from '@melonoffice/tenancy';
import { createToolRegistry, TOOL_CATALOGUE } from '@melonoffice/tools';
import { harnessTaskPolicy } from '@melonoffice/harness';
import { describe, expect, it } from 'vitest';
import { createAgentTaskParts, createConversationAgentParts, routeAgentWork } from './agents.js';
import { createWorkerRuntime, type WorkerStores } from './runtime.js';

/**
 * Agent Engine phase 2 (ADR-0063): a person asks an organization's agent for a task, and the
 * worker's runtime runs it end to end on the real engines. The agent is created from a template
 * (AE-1), its context comes from Company Brain for its department, the model is reached only
 * through the AI Gateway (a fake Vertex AI adapter behind the real policy and credits), and the
 * answer is kept and verified before the task completes. In memory and on the emulator.
 */

const T0 = new Date('2026-09-29T12:00:00Z');
const LEASE_MS = 60_000;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;

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

const answer = (structured: unknown): ProviderOutcome => ({
  status: 'success',
  output: { structured },
  usage: { inputTokens: 700, outputTokens: 80 },
  finishReason: 'stop',
  providerRequestId: 'vertex-req-1',
});
const GOOD = answer({
  answer: 'El Combo Familiar cuesta S/ 25. Sugiero ofrecerlo a clientes que piden para cuatro.',
  missing: ['Margen del Combo Familiar'],
});

const price = (soles: number) => ({
  domain: 'products',
  key: 'price',
  subject: { type: 'product', id: 'combo_familiar' },
  label: 'Combo Familiar',
  value: { type: 'money', amountMinor: soles * 100, currency: 'PEN' },
});

type Stores = WorkerStores & {
  readonly conversations: ConversationRepository;
  readonly outputs: AgentOutputRepository;
  readonly tasks: AgentTaskRepository;
  readonly knowledge: KnowledgeRepository;
  readonly events: () => Promise<readonly AuditEvent[]>;
};

function memoryStores(now: () => Date): Stores {
  const audit = new InMemoryAuditStore();
  const departments = new InMemoryDepartmentRepository();
  return {
    tenancy: new InMemoryTenancyStore(now, audit, undefined, departments),
    departments,
    specialists: new InMemorySpecialistRepository(audit),
    executions: new InMemoryExecutionRepository(audit),
    approvals: new InMemoryApprovalRepository(audit),
    jobs: new InMemoryJobRepository(audit),
    conversations: new InMemoryConversationRepository(audit),
    outputs: new InMemoryAgentOutputRepository(),
    tasks: new InMemoryAgentTaskRepository(),
    knowledge: new InMemoryKnowledgeRepository(audit),
    audit,
    events: async () => audit.events(),
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
    conversations: new FirestoreConversationRepository(db),
    outputs: new FirestoreAgentOutputRepository(db),
    tasks: new FirestoreAgentTaskRepository(db),
    knowledge: new FirestoreKnowledgeRepository(db),
    audit: new FirestoreAuditStore(db),
    async events() {
      const snapshot = await db.collection(AUDIT_LOGS).orderBy('occurredAt').get();
      return snapshot.docs.map((doc) => fromAuditDocument(doc.id, doc.data() as AuditDocument));
    },
  };
}

const STORES: [string, (now: () => Date) => Stores][] = [
  ['memory', memoryStores],
  ...(emulatorHost ? [['firestore', firestoreStores] as [string, typeof memoryStores]] : []),
];

describe.each(STORES)('AE-2 agent tasks with storage in %s', (_storage, createStores) => {
  async function world(options: { readonly balance?: number } = {}) {
    let clock = new Date(T0);
    const now = () => {
      clock = new Date(clock.getTime() + 1);
      return clock;
    };
    const stores = createStores(now);
    const provision = (organization: Organization) =>
      provisionDepartments(organization, DEFAULT_DEPARTMENT_CATALOGUE);
    const a = await createOrganization(as(ALICE), { name: 'Pollería A' }, stores.tenancy, {
      billing: BILLING,
      credits: openWallet,
      departments: provision,
    });
    const b = await createOrganization(as(BOB), { name: 'Empresa B' }, stores.tenancy, {
      billing: BILLING,
      credits: openWallet,
      departments: provision,
    });
    const orgA = a.organization.id;
    const orgB = b.organization.id;
    const authorization = createAuthorizationService();
    const audit = createAuditService(stores.audit, now);
    const specialists = createSpecialistService({
      repository: stores.specialists,
      departments: stores.departments,
      organizations: stores.tenancy,
      authorization,
    });
    const management = createSpecialistManagement({
      repository: stores.specialists,
      departments: stores.departments,
      organizations: stores.tenancy,
      authorization,
      skills: createSkillCatalogue(),
      // The commercial agent's follow-up (ADR-0084), granted by its skill.
      tools: (id, version) =>
        id === 'follow_up_schedule' && version === 2
          ? { riskLevel: 'low', approval: 'approval_required', permissions: ['follow_up.manage'] }
          : undefined,
      now,
    });
    const brain = createCompanyBrain({
      repository: stores.knowledge,
      organizations: stores.tenancy,
      authorization,
      now,
    });

    const providerCalls: ProviderCall[] = [];
    let modelAnswers: (() => Promise<ProviderOutcome>)[] = [];
    const vertex = {
      providerId: VERTEX_AI_PROVIDER_ID,
      adapterVersion: 'vertex-test-1',
      capabilities: () => VERTEX_AI_PROVIDER.capabilities,
      health: async () => 'available' as const,
      async generate(call: ProviderCall): Promise<ProviderOutcome> {
        providerCalls.push(call);
        const next = modelAnswers.shift();
        return next === undefined ? GOOD : next();
      },
    };
    let balance = options.balance ?? 1_000;
    const charges = new Map<string, number>();
    const credits: AICreditsPort = {
      async balanceOf() {
        return { status: 'present', balance };
      },
      async consume(tenant, { amount, referenceId }) {
        const key = `${tenant.organizationId}\n${referenceId}`;
        if (charges.has(key)) return { balance, replayed: true };
        if (balance < amount)
          throw Object.assign(new Error('insufficient'), { code: 'insufficient_credits' });
        charges.set(key, amount);
        balance -= amount;
        return { balance, replayed: false };
      },
      async refund() {
        throw new Error('not used');
      },
    };

    // The worker's composition, exactly as in production: conversation turns and agent tasks
    // share one runtime, routed by what the execution is.
    const conversation = createConversationAgentParts({ stores, now });
    // Follow-ups (C5) with a queue that only records: the same service the worker schedules with.
    const queued: string[] = [];
    const followUps = createFollowUpService({
      repository: stores.conversations,
      organizations: stores.tenancy,
      authorization,
      timeZone: async () => 'America/Lima',
      scheduler: { schedule: async (ref) => void queued.push(ref.followUpId) },
      now,
    });
    const published: {
      organizationId: string;
      initiatedBy: string;
      drafts: readonly EventDraft[];
    }[] = [];
    // What the monitoring module's log-based metrics count (G-6, ADR-0136).
    const logged: Record<string, unknown>[] = [];
    const taskParts = createAgentTaskParts({
      logger: createLogger({
        service: 'worker',
        sink: (line) => void logged.push(JSON.parse(line) as Record<string, unknown>),
      }),
      stores: {
        tenancy: stores.tenancy,
        specialists: stores.specialists,
        tasks: stores.tasks,
        knowledge: stores.knowledge,
        outputs: stores.outputs,
      },
      proposals: {
        conversations: stores.conversations,
        followUps,
        timeZone: async () => 'America/Lima',
      },
      events: {
        async publishRuntime(organizationId, initiatedBy, drafts) {
          published.push({ organizationId, initiatedBy, drafts });
          return [];
        },
      },
      now,
    });
    const routed = routeAgentWork(conversation, taskParts);
    const dispatched: JobId[] = [];
    const { jobs, runtime } = createWorkerRuntime({
      stores,
      environment: 'dev',
      leaseMs: LEASE_MS,
      tools: {
        registry: createToolRegistry(TOOL_CATALOGUE),
        executors: { ...conversation.executors, ...taskParts.executors },
      },
      ai: createProviderRegistry({
        providers: [VERTEX_AI_PROVIDER],
        models: VERTEX_AI_MODELS,
        adapters: [vertex],
      }),
      credits: { port: credits, rate: CREDIT_RATE },
      policies: createModelPolicyCatalogue([
        { ...CONVERSATION_AGENT_POLICY, backoffMs: 0 },
        { ...AGENT_TASK_POLICY, backoffMs: 0 },
        {
          ...harnessTaskPolicy({
            preferredProviders: ['nvidia'],
            environments: ['dev'],
            maxCostMicroUsd: CREDIT_RATE.microUsdPerCredit,
          }),
          backoffMs: 0,
        },
      ]),
      work: routed.work,
      verifier: routed.verifier,
      outputs: conversation.outputs,
      onStopped: routed.onStopped,
      ...(taskParts.onEnded === undefined ? {} : { onEnded: taskParts.onEnded }),
      dispatcher: { dispatch: async (id) => void dispatched.push(id) },
      now,
    });

    // The API's side: the task service over the same execution service, kicking off the runtime.
    const executions = createExecutionService({
      repository: stores.executions,
      organizations: stores.tenancy,
      assignments: specialists.assignments,
      authorization,
      audit,
      now,
    });
    const tasks = createAgentTaskService({
      tasks: stores.tasks,
      specialists: stores.specialists,
      executions,
      authorization,
      runtime,
      now,
    });

    const tenantA = await resolveTenant(as(ALICE), orgA, stores.tenancy);
    const tenantB = await resolveTenant(as(BOB), orgB, stores.tenancy);

    /** Alice's agent from a template (AE-1), active. */
    async function agent(
      templateId = 'commercial',
      tenant = tenantA,
      status: 'active' | 'paused' = 'active',
    ): Promise<Specialist> {
      const created = await management.create(tenant, { templateId, displayName: 'Lucía' });
      let current = await management.setStatus(tenant, created.identity.id, {
        from: 'draft',
        to: 'active',
      });
      if (status === 'paused') {
        current = await management.setStatus(tenant, created.identity.id, {
          from: 'active',
          to: 'paused',
        });
      }
      return current;
    }

    async function drive(limit = 10): Promise<void> {
      for (let i = 0; i < limit && dispatched.length > 0; i += 1) {
        const jobId = dispatched.shift() as JobId;
        let claim;
        try {
          claim = await jobs.acquire(jobId, 'worker-1');
        } catch (error) {
          if (isJobError(error)) continue;
          throw error;
        }
        await runtime.advance(claim.lease);
      }
    }

    const promptOf = (call: ProviderCall | undefined) => JSON.stringify(call?.messages ?? []);

    const approvals = createApprovalService({
      repository: stores.approvals,
      organizations: stores.tenancy,
      authorization,
      audit,
      now,
    });
    const customers = createCustomerService({
      repository: stores.conversations,
      organizations: stores.tenancy,
      authorization,
      now,
    });

    return {
      stores,
      orgA,
      orgB,
      tenantA,
      tenantB,
      brain,
      approvals,
      customers,
      followUps,
      queued,
      runtime,
      tasks,
      executions,
      providerCalls,
      charges,
      dispatched,
      agent,
      drive,
      promptOf,
      taskParts,
      published,
      logged,
      outputs: createAgentOutputStore(stores.outputs),
      management,
      setModel: (...next: (() => Promise<ProviderOutcome>)[]) => {
        modelAnswers = next;
      },
    };
  }

  it('1. an agent answers a task from its department’s Company Brain facts, verified', async () => {
    const w = await world();
    await w.brain.propose(w.tenantA, price(25));
    await w.brain.propose(w.tenantB, price(99));
    const lucia = await w.agent();

    const asked = await w.tasks.assign(w.tenantA, lucia.identity.id, {
      request: '¿Cuánto cuesta el Combo Familiar y a quién se lo ofrezco?',
    });
    expect(asked.execution?.status).toBe('running');
    expect(w.dispatched).toHaveLength(1);
    await w.drive();

    const { task, execution } = await w.tasks.get(w.tenantA, asked.task.id);
    expect(execution).toMatchObject({
      status: 'completed',
      specialistId: lucia.identity.id,
      verification: { result: 'passed' },
      result: { type: 'agent_output', id: `${task.id}:work` },
    });
    // One model call through the gateway, with its own organization's fact only, charged once.
    expect(w.providerCalls).toHaveLength(1);
    const prompt = w.promptOf(w.providerCalls[0]);
    expect(prompt).toContain('Combo Familiar');
    expect(prompt).toContain('25');
    expect(prompt).not.toContain('99');
    expect(prompt).toContain('¿Cuánto cuesta el Combo Familiar');
    expect([...w.charges.values()]).toEqual([1]);
    const record = await w.outputs.find(w.tenantA, task.id, 'work');
    // How the call was served (ADR-0100): the router's choice, its cost and credits, no budget.
    expect(must(record).ai).toMatchObject({
      provider: 'google-vertex-ai',
      model: 'gemini-2.5-flash-lite',
      fallbackFrom: null,
      creditsConsumed: 1,
      maxCredits: null,
      escalation: null,
      attempts: 1,
      // The prompt version it was written with (G-3).
      prompt: 'agent_task@3',
    });
    expect(must(record).ai?.actualMicroUsd).toEqual(expect.any(Number));
    expect(parseAgentAnswer(must(record).output)).toEqual({
      answer: 'El Combo Familiar cuesta S/ 25. Sugiero ofrecerlo a clientes que piden para cuatro.',
      missing: ['Margen del Combo Familiar'],
      followUp: null,
      facts: [],
      remember: [],
      handoff: null,
    });
    // Its end in the logs, for the monitoring metrics: codes only, never the answer (G-6).
    expect(w.logged.filter((l) => l.message === 'agent_task.finished')).toEqual([
      expect.objectContaining({ severity: 'INFO', outcome: 'completed', code: null }),
    ]);
    // Its end on the event bus, as the runtime for Alice (ADR-0102): it finished, and what it
    // could not answer goes to a person.
    const subject = { type: 'execution', id: must(execution).id };
    expect(w.published).toEqual([
      {
        organizationId: w.orgA,
        initiatedBy: ALICE,
        drafts: [
          {
            type: 'agent_task.finished',
            subject,
            data: {
              specialistId: lucia.identity.id,
              outcome: 'completed',
              handoff: 'missing_information',
            },
            idempotencyKey: `${subject.id}:finished`,
          },
          {
            type: 'agent_execution.handoff',
            subject,
            data: { specialistId: lucia.identity.id, reason: 'missing_information', code: null },
            idempotencyKey: `${subject.id}:handoff`,
          },
        ],
      },
    ]);
  });

  it('1b. the Harness gives the model call its routing order and reads only the context it needs (ADR-0099)', async () => {
    const w = await world();
    await w.brain.propose(w.tenantA, price(25));
    const lucia = await w.agent();
    const workOf = async (request: string) => {
      const asked = await w.tasks.assign(w.tenantA, lucia.identity.id, { request });
      const execution = must(asked.execution);
      const node = must(execution.nodes.find((n) => n.id === 'work'));
      const work = await w.taskParts.work.agentWork(w.tenantA, execution, node);
      if (work !== undefined && 'stop' in work) throw new Error(`stopped: ${work.stop}`);
      return work;
    };
    // Work on the text it is given: the cheapest model that fits, and no company memory.
    const classify = await workOf('Clasifica este mensaje: hola');
    expect(classify).toMatchObject({
      strategy: 'cost_optimized',
      metadata: { harnessIntent: 'classification', harnessPolicy: 'harness_default@2' },
    });
    expect(JSON.stringify(classify?.messages)).not.toContain('Combo Familiar');
    // Analysis about a price: the best model allowed, and the company memory.
    const analyse = await workOf('Analiza el precio del Combo Familiar');
    expect(analyse).toMatchObject({
      strategy: 'quality_first',
      metadata: { skills: expect.any(Number) },
    });
    expect(JSON.stringify(analyse?.messages)).toContain('Combo Familiar');
    // About customers: the CRM's counts too, never its records (ADR-0102).
    const customers = JSON.stringify(
      (await workOf('¿Cuántos clientes y oportunidades abiertas tenemos?'))?.messages,
    );
    expect(customers).toContain('crm_context');
    expect(customers).toContain('Contacts: 0 leads, 0 customers');
    expect(customers).toContain('Opportunities: 0 open');
    expect(JSON.stringify(classify?.messages)).not.toContain('crm_context');
    // Never a model or a provider: the agent's model policy and the router still choose.
    expect(analyse).not.toHaveProperty('quality');
    expect(analyse).not.toHaveProperty('maxCredits');
    // A task with a budget: its one call may spend at most that (ADR-0100).
    const budgeted = await w.tasks.assign(w.tenantA, lucia.identity.id, {
      request: 'Redacta un saludo',
      maxCredits: 3,
    });
    const execution = must(budgeted.execution);
    const node = must(execution.nodes.find((n) => n.id === 'work'));
    expect(await w.taskParts.work.agentWork(w.tenantA, execution, node)).toMatchObject({
      maxCredits: 3,
      // Private company data, whatever the request says: the data policy routes on it.
      sensitivity: 'confidential',
      metadata: { harnessData: 'company_private' },
    });
    // Analysis asks for the strongest model allowed, and says why on the call (ADR-0100).
    expect(analyse?.metadata).toMatchObject({ harnessEscalation: 'complex_task' });
    expect(classify?.metadata).not.toHaveProperty('harnessEscalation');
  });

  it('2. asking again with the same key is the same task: nothing new runs or is charged', async () => {
    const w = await world();
    const lucia = await w.agent();
    const input = { request: 'Resume nuestros productos', idempotencyKey: 'k-1' };
    const first = await w.tasks.assign(w.tenantA, lucia.identity.id, input);
    const again = await w.tasks.assign(w.tenantA, lucia.identity.id, input);
    expect(again.task.id).toBe(first.task.id);
    await w.drive();
    const third = await w.tasks.assign(w.tenantA, lucia.identity.id, input);
    expect(third.execution?.status).toBe('completed');
    await w.drive();
    expect(w.providerCalls).toHaveLength(1);
    expect(w.charges.size).toBe(1);
    expect(
      await codeOf(
        w.tasks.assign(w.tenantA, lucia.identity.id, { ...input, request: 'Otra cosa distinta' }),
      ),
    ).toBe('idempotency_conflict');
  });

  it('3. an answer without the task’s shape fails verification and shows no answer', async () => {
    const w = await world();
    const lucia = await w.agent();
    w.setModel(async () => answer({ text: 'sin la forma pedida' }));
    const { task } = await w.tasks.assign(w.tenantA, lucia.identity.id, { request: 'Hola' });
    await w.drive();
    const { execution } = await w.tasks.get(w.tenantA, task.id);
    expect(execution?.status).toBe('failed');
    expect(execution?.result).toBeUndefined();
  });

  it('3b. an answer that claims it sent something is completed with a Guardian warning, published and logged (G-2, G-6)', async () => {
    const w = await world();
    const lucia = await w.agent();
    w.setModel(async () =>
      answer({ answer: 'Listo, ya envié el WhatsApp a Rosa con su pedido.', missing: [] }),
    );
    const { task } = await w.tasks.assign(w.tenantA, lucia.identity.id, {
      request: 'Confirma el pedido de Rosa',
    });
    await w.drive();
    const { execution } = await w.tasks.get(w.tenantA, task.id);
    // A warning never fails the task: only a critical finding does (ADR-0132).
    expect(execution?.status).toBe('completed');
    expect(
      w.published.flatMap((p) =>
        p.drafts.filter((d) => d.type === 'agent_guardian.warning').map((d) => d.data),
      ),
    ).toEqual([
      { specialistId: lucia.identity.id, code: 'unsupported_completion', severity: 'warning' },
    ]);
    const guardian = w.logged.filter((l) => l.message === 'agent_guardian.warning');
    expect(guardian).toEqual([
      expect.objectContaining({ code: 'unsupported_completion', guardianSeverity: 'warning' }),
    ]);
  });

  it('4. without credits the model is never reached and the task fails', async () => {
    const w = await world({ balance: 0 });
    const lucia = await w.agent();
    const { task } = await w.tasks.assign(w.tenantA, lucia.identity.id, { request: 'Hola' });
    await w.drive();
    expect(w.providerCalls).toHaveLength(0);
    const { execution } = await w.tasks.get(w.tenantA, task.id);
    expect(execution?.status).toBe('failed');
    expect(w.logged.filter((l) => l.message === 'agent_task.finished')).toEqual([
      expect.objectContaining({ outcome: 'failed', code: execution?.failure?.code }),
    ]);
    // A person must add credits: the hand-off says so (ADR-0102).
    expect(w.published.flatMap((p) => p.drafts.map((d) => [d.type, d.data]))).toEqual([
      [
        'agent_task.finished',
        {
          specialistId: lucia.identity.id,
          outcome: 'failed',
          handoff: 'authorization_required',
          code: execution?.failure?.code,
        },
      ],
      [
        'agent_execution.handoff',
        {
          specialistId: lucia.identity.id,
          reason: 'authorization_required',
          code: execution?.failure?.code,
        },
      ],
    ]);
  });

  it('5. a paused agent takes no new task; another organization’s agent does not exist', async () => {
    const w = await world();
    const paused = await w.agent('commercial', w.tenantA, 'paused');
    expect(await codeOf(w.tasks.assign(w.tenantA, paused.identity.id, { request: 'Hola' }))).toBe(
      'specialist_not_available',
    );
    const bobs = await w.agent('commercial', w.tenantB);
    expect(await codeOf(w.tasks.assign(w.tenantA, bobs.identity.id, { request: 'Hola' }))).toBe(
      'specialist_not_found',
    );
    const { task } = await w.tasks.assign(w.tenantB, bobs.identity.id, { request: 'Hola' });
    expect(await codeOf(w.tasks.get(w.tenantA, task.id))).toBe('task_not_found');
    expect(w.dispatched).toHaveLength(1);
  });

  it('5b. an agent paused after a task was asked never reaches the model or spends credits (AE-4, ADR-0115)', async () => {
    const w = await world();
    const lucia = await w.agent();
    const { task } = await w.tasks.assign(w.tenantA, lucia.identity.id, { request: 'Hola' });
    // Paused before the worker picks the task up: the Harness checks the agent first.
    await w.management.setStatus(w.tenantA, lucia.identity.id, {
      from: 'active',
      to: 'paused',
      reason: 'Revisión',
    });
    await w.drive();
    expect(w.providerCalls).toHaveLength(0);
    expect(w.charges.size).toBe(0);
    const { execution } = await w.tasks.get(w.tenantA, task.id);
    expect(execution?.status).toBe('failed');
    expect(execution?.failure?.code).toBe('agent_paused');
  });

  it('6. with nothing recorded the agent is told so, and nothing is invented for it', async () => {
    const w = await world();
    const researcher = await w.agent('research');
    await w.tasks.assign(w.tenantA, researcher.identity.id, { request: 'Precio del combo' });
    await w.drive();
    expect(w.providerCalls).toHaveLength(1);
    const prompt = w.promptOf(w.providerCalls[0]);
    expect(prompt).toContain('the company memory has nothing on this yet');
    expect(prompt).not.toContain('Combo Familiar');
  });

  /** Alice's contact Juan, and the answer that proposes calling him tomorrow at 10. */
  async function proposing(w: Awaited<ReturnType<typeof world>>, extra: object = {}) {
    const juan = await w.customers.create(w.tenantA, {
      displayName: 'Juan Pérez',
      phone: '+51999888777',
    });
    w.setModel(async () =>
      answer({
        answer: 'Te propongo llamar a Juan mañana a las 10.',
        missing: [],
        followUp: {
          contact: contactRef(juan.id),
          type: 'call',
          title: 'Llamar a Juan por el pedido',
          date: '2026-09-30',
          time: '10:00',
        },
        ...extra,
      }),
    );
    const lucia = await w.agent();
    const asked = await w.tasks.assign(w.tenantA, lucia.identity.id, {
      request: 'Llama a Juan mañana a las 10 por su pedido',
    });
    await w.drive();
    return { juan, taskId: asked.task.id };
  }

  it("7. the commercial agent's follow-up waits for a person's approval, then is scheduled (ADR-0084)", async () => {
    const w = await world();
    const { juan, taskId } = await proposing(w);
    // The model saw Juan by reference only, and was offered the follow-up.
    const prompt = w.promptOf(w.providerCalls[0]);
    expect(prompt).toContain(contactRef(juan.id));
    expect(prompt).not.toContain(juan.id);
    let { execution } = await w.tasks.get(w.tenantA, taskId);
    expect(execution?.status).toBe('waiting_approval');
    const node = execution?.nodes.find((n) => n.id === 'schedule');
    expect(node?.approvalId).toBeDefined();
    expect(w.queued).toEqual([]);
    const approval = await w.approvals.get(w.tenantA, must(node?.approvalId));
    expect(approval).toMatchObject({
      status: 'pending',
      riskLevel: 'low',
      operation: { toolId: 'follow_up_schedule', toolVersion: 2, nodeId: 'schedule' },
    });

    // A person approves; the task is handed back to the worker and the follow-up is scheduled.
    await w.approvals.approve(w.tenantA, approval.id);
    await w.runtime.resume(w.tenantA, taskId);
    await w.drive();
    ({ execution } = await w.tasks.get(w.tenantA, taskId));
    expect(execution?.status).toBe('completed');
    expect(execution?.verification?.result).toBe('passed');
    const list = await w.followUps.list(w.tenantA);
    expect(list.items).toHaveLength(1);
    expect(list.items[0]).toMatchObject({
      contactId: juan.id,
      type: 'call',
      title: 'Llamar a Juan por el pedido',
      source: 'agent',
      status: 'scheduled',
      createdBy: ALICE,
    });
    expect(w.queued).toHaveLength(1);
    const events = await w.stores.events();
    expect(events.map((e) => e.action)).toContain('follow_up.created');
    // Created by the runtime, for Alice who asked the task.
    expect(events.find((e) => e.action === 'follow_up.created')?.actor).toMatchObject({
      type: 'system',
      id: 'runtime',
      initiatedBy: ALICE,
    });
  });

  it('8. a rejected follow-up is never scheduled; the answer stands (ADR-0084)', async () => {
    const w = await world();
    const { taskId } = await proposing(w);
    let { execution } = await w.tasks.get(w.tenantA, taskId);
    const node = execution?.nodes.find((n) => n.id === 'schedule');
    await w.approvals.reject(w.tenantA, must(node?.approvalId));
    await w.runtime.resume(w.tenantA, taskId);
    await w.drive();
    ({ execution } = await w.tasks.get(w.tenantA, taskId));
    expect(execution).toMatchObject({ status: 'failed', failure: { code: 'approval_rejected' } });
    expect((await w.followUps.list(w.tenantA)).items).toEqual([]);
    expect(w.queued).toEqual([]);
    const record = await w.outputs.find(w.tenantA, taskId, 'work');
    expect(parseAgentAnswer(must(record).output)?.answer).toContain('llamar a Juan');
  });

  it('9. facts the agent proposed wait in the company memory for the owner (ADR-0084)', async () => {
    const w = await world();
    const { taskId } = await proposing(w, {
      followUp: null,
      facts: [
        {
          domain: 'operations',
          key: 'opening_days',
          valueType: 'list',
          items: ['domingo'],
          confidence: 0.9,
        },
      ],
    });
    const { execution } = await w.tasks.get(w.tenantA, taskId);
    // No follow-up proposed: the schedule node is skipped and the task completes.
    expect(execution?.status).toBe('completed');
    expect(execution?.nodes.find((n) => n.id === 'schedule')?.status).toBe('skipped');
    const facts = await w.brain.list(w.tenantA, { domain: 'operations' });
    const opening = facts.find((f) => f.key === 'opening_days');
    expect(opening).toMatchObject({ verification: 'proposed', needsConfirmation: true });
    expect(opening?.provenance).toMatchObject({ sourceType: 'agent', sourceId: taskId });
  });
});

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing value');
  return value;
}
