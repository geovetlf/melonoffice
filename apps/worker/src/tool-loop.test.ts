import type { Firestore } from '@google-cloud/firestore';
import {
  createAIGateway,
  createModelPolicyCatalogue,
  createProviderRegistry,
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
import type { AuthenticatedContext } from '@melonoffice/auth';
import { openWallet } from '@melonoffice/credits';
import {
  DEFAULT_DEPARTMENT_CATALOGUE,
  departmentIdOf,
  InMemoryDepartmentRepository,
  provisionDepartments,
  type DepartmentRepository,
} from '@melonoffice/departments';
import type {
  AgentAutonomy,
  AIModelDefinition,
  DepartmentTypeId,
  Execution,
  InitialBilling,
  IsoTimestamp,
  JobId,
  Organization,
  Specialist,
  SubscriptionId,
  ToolDefinition,
  ToolVersion,
  UserId,
} from '@melonoffice/domain';
import {
  createAgentOutputStore,
  createExecutionService,
  InMemoryAgentOutputRepository,
  InMemoryExecutionRepository,
  type AgentOutputRepository,
  type ExecutionRepository,
} from '@melonoffice/execution';
import {
  AUDIT_LOGS,
  FirestoreAgentOutputRepository,
  FirestoreApprovalRepository,
  FirestoreAuditStore,
  FirestoreDepartmentRepository,
  FirestoreExecutionRepository,
  FirestoreJobRepository,
  FirestoreSpecialistRepository,
  FirestoreTenancyStore,
  fromAuditDocument,
  type AuditDocument,
} from '@melonoffice/firestore';
import { emulatorFirestore, emulatorHost } from '@melonoffice/firestore/testing';
import { createToolGate } from '@melonoffice/guardrails';
import {
  createHarnessAgentWork,
  createHarnessToolDirectory,
  createHarnessToolLoop,
  createHarnessToolOffer,
  DEFAULT_HARNESS_LIMITS,
  harnessTaskPolicy,
  type HarnessLimits,
  type ToolUseRules,
} from '@melonoffice/harness';
import { createJobService, InMemoryJobRepository, type JobRepository } from '@melonoffice/jobs';
import { createAuthorizationService } from '@melonoffice/rbac';
import {
  createRuntime,
  type AdvanceResult,
  type AgentWork,
  type NodeWorkSource,
  type VerificationSource,
} from '@melonoffice/runtime';
import {
  applySpecialistStatus,
  createSkillCatalogue,
  createSpecialistService,
  defaultOrganizationAgentPolicy,
  InMemorySpecialistRepository,
  newSpecialist,
  type SpecialistRepository,
} from '@melonoffice/specialists';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveTenant,
  type TenancyStore,
} from '@melonoffice/tenancy';
import {
  createToolRegistry,
  MODEL_TOOL_CALL_INPUT,
  type ToolExecutor,
  type ToolExecutorOutcome,
} from '@melonoffice/tools';
import { describe, expect, it } from 'vitest';

/**
 * Block 5 of the Melon Agent Harness (ADR-0103): tools in the middle of a task, end to end, on the
 * real engines. An agent's model (a fake official adapter behind the real AI Gateway) asks for
 * tools; the Harness decides each call with `authorizeToolUse`; the runtime runs what it allowed as
 * nodes of the task's execution through the real Tool Gate and approvals; and the agent's next
 * turn reads what the tools gave. In memory and on the Firestore emulator.
 */

const T0 = new Date('2026-09-30T12:00:00Z');
const AT = T0.toISOString() as IsoTimestamp;
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

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing value');
  return value;
};

// ---------------------------------------------------------------------------------------------
// Fixtures. Test only: no tool of MelonOffice's real catalogue says a model may ask for it yet.

const SUBJECT_IN = {
  type: 'object',
  properties: { subject: { type: 'string', maxLength: 200, minLength: 1 } },
  required: ['subject'],
} as const;
const COUNT_OUT = {
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
      inputSchema: SUBJECT_IN,
      outputSchema: COUNT_OUT,
      permissions: ['organization.read'],
      credentials: [],
      riskLevel: 'low',
      approvalPolicy: 'auto',
      approvalTtlSeconds: 3 * 3_600,
      timeoutMs: 1000,
      retryPolicy: { maxAttempts: 1, backoffMs: 0 },
      provider: { kind: 'internal', id: 'fixture' },
      environments: ['dev'],
      invocationModes: ['runtime', 'model'],
      ...overrides,
    },
  ],
});

const TOOLS: readonly ToolDefinition[] = [
  // A: a read.
  tool('lookup'),
  // B: a reversible change inside MelonOffice.
  tool('update_record', { mutating: true }),
  // B too, of medium risk: the default level of autonomy asks a person (AE-4.4).
  tool('update_price', { mutating: true, riskLevel: 'medium' }),
  // C: it leaves MelonOffice. Its own policy is `auto`: only the Harness asks for a person.
  tool('send_email', {
    mutating: true,
    action: 'send',
    provider: { kind: 'external', id: 'fixture' },
  }),
  // A read that fails, and one that never answers in time.
  tool('broken'),
  tool('slow', { timeoutMs: 20 }),
  // A tool that never says a model may ask for it.
  tool('plain_lookup', { invocationModes: ['runtime'] }),
];

const MODEL: AIModelDefinition = {
  providerId: 'alpha',
  modelId: 'alpha-tools',
  version: '2026-09-01',
  status: 'active',
  capabilities: ['text_generation'],
  inputModalities: ['text'],
  outputModalities: ['text'],
  contextWindowTokens: 100_000,
  maxOutputTokens: 8_000,
  structuredOutput: false,
  toolUse: true,
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
  maxSensitivity: 'confidential',
};

type Call = { name: string; subject: string };

/** The model asks for these tools. */
const asks = (...calls: Call[]): ProviderOutcome => ({
  status: 'success',
  output: {
    toolCalls: calls.map((c, i) => ({
      id: `call_${i}`,
      name: c.name,
      arguments: { subject: c.subject },
    })),
  },
  usage: { inputTokens: 400, outputTokens: 40 },
  finishReason: 'tool_use',
  providerRequestId: 'prov-tools',
});

/** The model answers. */
const ANSWER: ProviderOutcome = {
  status: 'success',
  output: { text: 'There are 3 open records.' },
  usage: { inputTokens: 500, outputTokens: 60 },
  finishReason: 'stop',
  providerRequestId: 'prov-answer',
};

const AGENT_WORK: AgentWork = {
  taskType: 'agent_task',
  capability: 'text_generation',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'How many records are open?' }] }],
  outputModality: 'text',
  maxOutputTokens: 200,
  sensitivity: 'confidential',
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
  readonly outputs: AgentOutputRepository;
  readonly audit: AuditStore;
  readonly events: () => Promise<readonly AuditEvent[]>;
}

function memoryStores(now: () => Date): Stores {
  const audit = new InMemoryAuditStore();
  const departments = new InMemoryDepartmentRepository();
  return {
    tenancy: new InMemoryTenancyStore(now, audit, undefined, departments),
    departments,
    specialists: new InMemorySpecialistRepository(),
    executions: new InMemoryExecutionRepository(audit),
    approvals: new InMemoryApprovalRepository(audit),
    jobs: new InMemoryJobRepository(audit),
    outputs: new InMemoryAgentOutputRepository(),
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
    outputs: new FirestoreAgentOutputRepository(db),
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

interface WorldOptions {
  readonly limits?: Partial<HarnessLimits>;
  readonly tools?: Record<string, () => Promise<ToolExecutorOutcome>>;
  /** `none`: the runtime has no tool loop at all. */
  readonly loop?: 'none';
  /** The agent's level of autonomy (AE-4.4). Absent: the default. */
  readonly autonomy?: AgentAutonomy;
  /** The organization's rules for its agents (AE-4.4). Absent: MelonOffice's defaults. */
  readonly policy?: Partial<ToolUseRules>;
}

describe.each(STORES)('Harness tool loop (ADR-0103) with storage in %s', (_storage, create) => {
  async function world(options: WorldOptions = {}) {
    let clock = new Date(T0);
    const now = () => {
      clock = new Date(clock.getTime() + 1);
      return clock;
    };
    const stores = create(now);
    const provision = (organization: Organization) =>
      provisionDepartments(organization, DEFAULT_DEPARTMENT_CATALOGUE);
    const a = await createOrganization(as(ALICE), { name: 'A' }, stores.tenancy, {
      billing: BILLING,
      credits: openWallet,
      departments: provision,
    });
    await createOrganization(as(BOB), { name: 'B' }, stores.tenancy, {
      billing: BILLING,
      credits: openWallet,
      departments: provision,
    });
    const orgA = a.organization.id;
    const authorization = createAuthorizationService();
    const audit = createAuditService(stores.audit, now);
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
      audit,
      now,
    });
    // The fixture skill that grants every fixture tool (SK-2, ADR-0083).
    const skills = createSkillCatalogue([
      {
        id: 'fixture_work',
        version: 1,
        nameKey: 'fixture',
        descriptionKey: 'fixture',
        tools: TOOLS.map((t) => ({ id: t.id, versions: [1] })),
        actions: [],
        reads: [],
      } as never,
    ]);
    const registry = createToolRegistry(TOOLS);

    // Tools: the fixture executor records every call.
    const toolCalls: { toolId: string; input: unknown; approvalId?: string }[] = [];
    const executor: ToolExecutor = {
      async execute(context, input) {
        toolCalls.push({
          toolId: context.toolId,
          input,
          ...(context.approvalId === undefined ? {} : { approvalId: context.approvalId }),
        });
        const answer = options.tools?.[context.toolId];
        if (answer !== undefined) return answer();
        if (context.toolId === 'broken') return { status: 'failure', code: 'record_store_down' };
        if (context.toolId === 'slow') return new Promise(() => undefined);
        return { status: 'success', output: { count: 3 } };
      },
    };

    // The model: a fake official adapter behind the real gateway, answering from a script.
    const providerCalls: ProviderCall[] = [];
    let script: ProviderOutcome[] = [];
    const adapter: ProviderAdapter = {
      providerId: 'alpha',
      adapterVersion: 'alpha-adapter-1',
      capabilities: () => ['text_generation'],
      health: async () => 'available',
      async generate(call) {
        providerCalls.push(call);
        return script.shift() ?? ANSWER;
      },
    };
    const spent = new Map<string, number>();
    const credits: AICreditsPort = {
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
          maxSensitivity: 'confidential',
        },
      ],
      models: [MODEL],
      adapters: [adapter],
    });

    const executionsFor = (requestId: string) =>
      createExecutionService({
        repository: stores.executions,
        organizations: stores.tenancy,
        assignments: specialists.assignments,
        authorization,
        audit,
        now,
        requestId,
      });
    const jobsFor = (requestId?: string) =>
      createJobService({
        jobs: stores.jobs,
        executions: stores.executions,
        tenancy: stores.tenancy,
        authorization,
        audit,
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
        skills,
        approvals,
        executors: { fixture: executor },
        authorization,
        audit,
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
        // The Harness's own task policy (ADR-0100): the agents' real routing, with no waits.
        policies: createModelPolicyCatalogue([], {
          ...harnessTaskPolicy({
            preferredProviders: ['nvidia'],
            environments: ['dev'],
            maxCostMicroUsd: 10_000,
            maxModelCalls: DEFAULT_HARNESS_LIMITS.maxModelCalls,
          }),
          backoffMs: 0,
        }),
        environment: 'dev',
        credits: { port: credits, rate: { microUsdPerCredit: 10_000 } },
        audit,
        timeoutMs: 1_000,
        now,
        sleep: async () => undefined,
      }),
      jobs: jobsFor(correlationId),
      approvals,
    });

    // The Harness: the tools this agent may be offered, and its loop over the task's work.
    const outputs = createAgentOutputStore(stores.outputs, now);
    const limits = { ...DEFAULT_HARNESS_LIMITS, ...options.limits };
    const loop = createHarnessToolLoop({
      offer: createHarnessToolOffer({
        directory: createHarnessToolDirectory({
          specialists: stores.specialists,
          skills,
          registry,
          authorization,
        }),
        executors: ['fixture'],
        specialists: stores.specialists,
        ...(options.policy === undefined
          ? {}
          : {
              policies: {
                forOrganization: async (organizationId) => ({
                  ...defaultOrganizationAgentPolicy(organizationId),
                  ...options.policy,
                }),
              },
            }),
      }),
      outputs,
      limits,
      now,
    });
    const inner = {
      toolInput: async () => undefined,
      agentWork: async (_tenant: unknown, _execution: Execution, node: { id: string }) =>
        node.id === 'work' ? AGENT_WORK : undefined,
    };
    const work = createHarnessAgentWork(loop.work(inner), {
      limits,
      now,
      spent: loop.spent,
    }) as NodeWorkSource;
    // The task's own check: its last turn answered. The loop's covers the turns and tools before.
    const answerCheck: VerificationSource = {
      async verify(tenant, execution) {
        const last = execution.nodes.filter((n) => n.type === 'agent').at(-1);
        if (last?.status !== 'completed') return undefined;
        const record = await outputs.find(tenant, execution.id, last.id);
        const answered = typeof record?.output.text === 'string';
        return {
          verification: {
            correlationId: `verify-${execution.id}`,
            nodes: [
              {
                nodeId: last.id,
                policy: 'output_schema',
                checks: [
                  {
                    code: 'agent_answer_valid',
                    result: answered ? 'passed' : 'failed',
                    evidence: { type: 'agent_output', id: `${execution.id}:${last.id}` },
                  },
                ],
              },
            ],
          },
          result: { type: 'agent_output', id: `${execution.id}:${last.id}` },
        };
      },
    };
    const dispatched: JobId[] = [];
    const baseJobs = jobsFor();
    const runtime = createRuntime({
      jobs: baseJobs,
      services,
      work,
      verifier: loop.verifier(answerCheck),
      outputs,
      ...(options.loop === 'none' ? {} : { toolLoop: { plan: loop.plan } }),
      dispatcher: { dispatch: async (id) => void dispatched.push(id) },
    });

    const tenantA = await resolveTenant(as(ALICE), orgA, stores.tenancy);
    const executions = executionsFor('req-owner');

    async function agent(): Promise<Specialist> {
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
            skills: [{ id: 'fixture_work', version: 1 }],
            tools: TOOLS.map((t) => ({ id: t.id, version: 1 })),
            permissions: ['organization.read'],
            policies: {},
            ...(options.autonomy === undefined ? {} : { autonomy: options.autonomy }),
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

    /** Alice's task for her agent: one agent node, as an agent task has. */
    async function task(): Promise<Execution> {
      const specialist = await agent();
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
        nodes: [{ id: 'work', type: 'agent', label: 'agent_task' }],
      });
      return executions.start(tenantA, created.id);
    }

    /** Delivers jobs as a worker would, until the execution stops or waits. */
    async function drive(first: JobId): Promise<AdvanceResult[]> {
      const results: AdvanceResult[] = [];
      let next: JobId | undefined = first;
      while (next !== undefined && results.length < 40) {
        const claim = await baseJobs.acquire(next, 'worker-1');
        const result = await runtime.advance(claim.lease);
        results.push(result);
        next = result.nextJobId;
      }
      return results;
    }

    /** Starts a task with the model's script, and runs it to wherever it stops. */
    async function run(...outcomes: ProviderOutcome[]) {
      script = [...outcomes];
      const execution = await task();
      const results = await drive((await runtime.kickoff(tenantA, execution.id)).id);
      return { execution: await executions.get(tenantA, execution.id), results };
    }

    /** Starts a task with the model's script, and hands back its first job, undelivered. */
    async function begin(...outcomes: ProviderOutcome[]) {
      script = [...outcomes];
      const execution = await task();
      return { execution, jobId: (await runtime.kickoff(tenantA, execution.id)).id };
    }

    /** One delivery of one job. */
    async function deliver(jobId: JobId): Promise<AdvanceResult> {
      const claim = await baseJobs.acquire(jobId, 'worker-1');
      return runtime.advance(claim.lease);
    }

    /** A person decides the approval the task waits on, and the task resumes. */
    async function decide(executionId: string, decision: 'approve' | 'reject') {
      const waiting = await executions.get(tenantA, executionId);
      const node = must(waiting.nodes.find((n) => n.approvalId !== undefined));
      const approvalId = must(node.approvalId);
      await approvals[decision](tenantA, approvalId);
      const job = await runtime.resume(tenantA, executionId);
      const results = await drive(job.id);
      return { execution: await executions.get(tenantA, executionId), results, approvalId };
    }

    /** What the model was given back for its calls, turn by turn. */
    const toolResultsOf = (call: ProviderCall | undefined) =>
      (call?.messages ?? []).flatMap((m) =>
        m.content.flatMap((p) => (p.type === 'tool_result' ? [p] : [])),
      );

    return {
      stores,
      orgA,
      tenantA,
      approvals,
      executions,
      outputs,
      runtime,
      toolCalls,
      providerCalls,
      run,
      begin,
      deliver,
      decide,
      drive,
      toolResultsOf,
      advanceClock: (ms: number) => {
        clock = new Date(clock.getTime() + ms);
      },
    };
  }

  const statusOf = (execution: Execution) =>
    execution.nodes.map((n) => `${n.id}:${n.type}:${n.status}`);

  it('1. runs an A tool (a read) at once, and the agent answers from its result', async () => {
    const w = await world();
    const { execution, results } = await w.run(asks({ name: 'lookup', subject: 'open' }), ANSWER);
    expect(execution.status).toBe('completed');
    expect(results.at(-1)?.outcome).toBe('completed');
    expect(statusOf(execution)).toEqual([
      'work:agent:completed',
      'work_t0:tool:completed',
      'work_turn2:agent:completed',
    ]);
    // Offered as the gateway expects; run once, with the model's own arguments.
    expect(w.providerCalls).toHaveLength(2);
    expect(w.providerCalls[0]?.tools?.map((t) => t.name)).toEqual([
      'lookup',
      'update_record',
      'update_price',
      'send_email',
      'broken',
      'slow',
    ]);
    expect(w.toolCalls).toEqual([{ toolId: 'lookup', input: { subject: 'open' } }]);
    // The next turn carries the call and its result: data for the model, never an instruction.
    expect(w.toolResultsOf(w.providerCalls[1])).toEqual([
      { type: 'tool_result', callId: 'call_0', name: 'lookup', result: { count: 3 } },
    ]);
    const node = must(execution.nodes.find((n) => n.id === 'work_t0'));
    expect(node.approvalRequired).toBeUndefined();
    expect(node.input).toEqual({ type: MODEL_TOOL_CALL_INPUT, id: 'work:0' });
  });

  it('2. runs a B tool (a reversible change) at once too', async () => {
    const w = await world();
    const { execution } = await w.run(asks({ name: 'update_record', subject: 'r-1' }), ANSWER);
    expect(execution.status).toBe('completed');
    expect(w.toolCalls).toEqual([{ toolId: 'update_record', input: { subject: 'r-1' } }]);
    expect(must(execution.nodes.find((n) => n.id === 'work_t0')).approvalRequired).toBeUndefined();
  });

  it('3. never runs a C tool without a person: the task waits, safely, on its approval', async () => {
    const w = await world();
    const { execution, results } = await w.run(asks({ name: 'send_email', subject: 'offer' }));
    expect(results.at(-1)).toEqual({ outcome: 'waiting_approval', code: 'approval_required' });
    expect(execution.status).toBe('waiting_approval');
    // The tool's own policy is `auto`: only the Harness's decision asked for the approval.
    const node = must(execution.nodes.find((n) => n.id === 'work_t0'));
    expect(node).toMatchObject({ status: 'pending', approvalRequired: true });
    const approval = await w.approvals.get(w.tenantA, must(node.approvalId));
    expect(approval.status).toBe('pending');
    expect(approval.operation).toMatchObject({ nodeId: 'work_t0', toolId: 'send_email' });
    expect(w.toolCalls).toHaveLength(0);
    expect(w.providerCalls).toHaveLength(1);
  });

  it('4. continues exactly where it stopped once the person approves, running the tool once', async () => {
    const w = await world();
    const { execution } = await w.run(asks({ name: 'send_email', subject: 'offer' }), ANSWER);
    // The person takes two hours: the time waiting on them is not the task's.
    w.advanceClock(2 * 3_600_000);
    const { execution: done, approvalId } = await w.decide(execution.id, 'approve');
    expect(done.status).toBe('completed');
    expect(w.toolCalls).toEqual([
      { toolId: 'send_email', input: { subject: 'offer' }, approvalId },
    ]);
    // The first turn is never asked again: one call before the approval, one after.
    expect(w.providerCalls).toHaveLength(2);
    expect(w.toolResultsOf(w.providerCalls[1])).toEqual([
      { type: 'tool_result', callId: 'call_0', name: 'send_email', result: { count: 3 } },
    ]);
    // Resuming again finds nothing to resume.
    await expect(w.runtime.resume(w.tenantA, execution.id)).rejects.toMatchObject({
      code: 'execution_not_waiting',
    });
  });

  it('5. ends the task cleanly when the person rejects: no tool, no further model call', async () => {
    const w = await world();
    const { execution } = await w.run(asks({ name: 'send_email', subject: 'offer' }), ANSWER);
    const { execution: ended } = await w.decide(execution.id, 'reject');
    expect(ended.status).toBe('failed');
    expect(ended.failure?.code).toBe('approval_rejected');
    expect(ended.nodes.find((n) => n.id === 'work_turn2')?.status).toBe('cancelled');
    expect(w.toolCalls).toHaveLength(0);
    expect(w.providerCalls).toHaveLength(1);
  });

  it('6. stops at the task’s tool limit before running anything past it', async () => {
    const w = await world();
    const six = ['a', 'b', 'c', 'd', 'e', 'f'].map((subject) => ({ name: 'lookup', subject }));
    const { execution } = await w.run(asks(...six));
    expect(execution.status).toBe('failed');
    expect(execution.failure?.code).toBe('tool_call_limit_reached');
    expect(w.toolCalls).toHaveLength(0);
    expect(execution.nodes.map((n) => n.id)).toEqual(['work']);

    // Over several turns too: the limit counts every tool the task used. The turn after it is
    // told to answer; one that asks anyway stops there.
    const v = await world({ limits: { maxToolCalls: 2 } });
    const { execution: second } = await v.run(
      asks({ name: 'lookup', subject: 'a' }, { name: 'lookup', subject: 'b' }),
      asks({ name: 'lookup', subject: 'c' }),
    );
    expect(second.failure?.code).toBe('tool_call_limit_reached');
    expect(v.toolCalls).toHaveLength(2);
    expect(JSON.stringify(v.providerCalls[1]?.messages)).toContain('Answer now');

    // A model that heeds it answers, and the task completes with what the tools gave.
    const u = await world({ limits: { maxToolCalls: 1 } });
    const { execution: third } = await u.run(asks({ name: 'lookup', subject: 'a' }), ANSWER);
    expect(third.status).toBe('completed');
  });

  it('7. stops at the task’s step limit: one more turn would pass it', async () => {
    const w = await world({ limits: { maxSteps: 3 } });
    const { execution } = await w.run(
      asks({ name: 'lookup', subject: 'a' }),
      asks({ name: 'lookup', subject: 'b' }),
      asks({ name: 'lookup', subject: 'c' }),
    );
    expect(execution.status).toBe('failed');
    expect(execution.failure?.code).toBe('step_limit_reached');
    expect(w.providerCalls).toHaveLength(3);
    expect(w.toolCalls.map((c) => c.input)).toEqual([{ subject: 'a' }, { subject: 'b' }]);
  });

  it('8. never runs the same call twice: a repeat reads the first result', async () => {
    const w = await world();
    const { execution } = await w.run(
      asks({ name: 'lookup', subject: 'a' }),
      asks({ name: 'lookup', subject: 'a' }, { name: 'lookup', subject: 'b' }),
      ANSWER,
    );
    expect(execution.status).toBe('completed');
    expect(w.toolCalls.map((c) => c.input)).toEqual([{ subject: 'a' }, { subject: 'b' }]);
    // The repeat has no node of its own; the model still reads a result for it.
    expect(execution.nodes.map((n) => n.id)).toEqual([
      'work',
      'work_t0',
      'work_turn2',
      'work_turn2_t1',
      'work_turn3',
    ]);
    expect(w.toolResultsOf(w.providerCalls[2]).map((p) => p.result)).toEqual([
      { count: 3 },
      { count: 3 },
      { count: 3 },
    ]);
  });

  it('9. cannot go around the Harness: no tool loop, no tool offered, no model mode', async () => {
    // A tool the Harness did not offer, named by the model: the gateway refuses the answer.
    const w = await world();
    const { execution } = await w.run(asks({ name: 'plain_lookup', subject: 'a' }));
    expect(execution.status).toBe('failed');
    expect(w.toolCalls).toHaveLength(0);
    expect(w.providerCalls[0]?.tools?.map((t) => t.name)).not.toContain('plain_lookup');

    // A runtime with no tool loop: an answer with tool calls runs nothing.
    const v = await world({ loop: 'none' });
    const { execution: unlooped } = await v.run(asks({ name: 'lookup', subject: 'a' }));
    expect(unlooped.failure?.code).toBe('tool_use_unsupported');
    expect(v.toolCalls).toHaveLength(0);
  });

  it('10. stops an agent that goes round in circles, asking only what it already asked', async () => {
    const w = await world();
    const { execution } = await w.run(
      asks({ name: 'lookup', subject: 'a' }),
      asks({ name: 'lookup', subject: 'a' }),
    );
    expect(execution.status).toBe('failed');
    expect(execution.failure?.code).toBe('loop_detected');
    expect(w.toolCalls).toHaveLength(1);
  });

  it('11. stops at the task’s time before a tool runs, and never retries a tool that timed out', async () => {
    const w = await world();
    const { execution, jobId } = await w.begin(asks({ name: 'lookup', subject: 'a' }), ANSWER);
    const asked = await w.deliver(jobId);
    expect(asked.outcome).toBe('progressed');
    // The task works past its limit before its tool's turn comes.
    w.advanceClock(DEFAULT_HARNESS_LIMITS.maxDurationMs + 1);
    const result = await w.deliver(must(asked.nextJobId));
    expect(result.outcome).toBe('failed');
    const stopped = await w.executions.get(w.tenantA, execution.id);
    expect(stopped.failure?.code).toBe('task_time_limit_reached');
    expect(w.toolCalls).toHaveLength(0);
    expect(w.providerCalls).toHaveLength(1);

    // A tool that does not answer in time: nobody knows whether it acted, so it is never run
    // again and the model is not asked again; a person resolves it (ADR-0029).
    const v = await world();
    const { execution: timed, results } = await v.run(asks({ name: 'slow', subject: 'a' }), ANSWER);
    expect(results.at(-1)).toMatchObject({ outcome: 'awaiting_resolution' });
    expect(timed.nodes.find((n) => n.id === 'work_t0')).toMatchObject({
      status: 'failed',
      error: { code: 'timeout' },
    });
    expect(v.toolCalls).toHaveLength(1);
    expect(v.providerCalls).toHaveLength(1);
  });

  it('12. ends the task with the tool’s own code when the tool fails, asking the model nothing more', async () => {
    const w = await world();
    const { execution } = await w.run(asks({ name: 'broken', subject: 'a' }), ANSWER);
    expect(execution.status).toBe('failed');
    expect(execution.failure?.code).toBe('record_store_down');
    expect(w.toolCalls.every((c) => c.toolId === 'broken')).toBe(true);
    expect(w.providerCalls).toHaveLength(1);
    expect(execution.nodes.find((n) => n.id === 'work_turn2')?.status).toBe('cancelled');
  });

  it('13. completes after using a tool, verified node by node, and keeps every turn traced', async () => {
    const w = await world();
    const { execution } = await w.run(asks({ name: 'lookup', subject: 'open' }), ANSWER);
    expect(execution.status).toBe('completed');
    expect(execution.result).toEqual({
      type: 'agent_output',
      id: `${execution.id}:work_turn2`,
    });
    // Every completed node has its evidence: the answer, the call the Harness decided, the tool.
    expect(
      execution.verification?.nodes.map((n) => [n.nodeId, n.checks[0]?.code, n.result]),
    ).toEqual([
      ['work_turn2', 'agent_answer_valid', 'passed'],
      ['work', 'tool_calls_decided', 'passed'],
      ['work_t0', 'tool_output_valid', 'passed'],
    ]);
    // Both turns went through the Harness: company data, the cheapest fitting model, traced.
    for (const call of w.providerCalls) expect(call.messages.length).toBeGreaterThan(0);
    const first = await w.outputs.find(w.tenantA, execution.id, 'work');
    expect(first?.output.toolCalls).toEqual([
      { id: 'call_0', name: 'lookup', arguments: { subject: 'open' } },
    ]);
    expect(first?.ai).toMatchObject({ sensitivity: 'confidential', dataClass: 'company_private' });
    const kept = await w.outputs.find(w.tenantA, execution.id, 'work_t0');
    expect(kept?.output.structured).toEqual({ count: 3 });
    const answer = await w.outputs.find(w.tenantA, execution.id, 'work_turn2');
    expect(answer?.output.text).toBe('There are 3 open records.');
    expect(answer?.ai).toMatchObject({ sensitivity: 'confidential' });
  });

  describe('autonomy and the sensitive-action policy (AE-4.4, ADR-0116)', () => {
    const waitsOn = async (w: Awaited<ReturnType<typeof world>>, execution: Execution) => {
      const node = must(execution.nodes.find((n) => n.id === 'work_t0'));
      expect(execution.status).toBe('waiting_approval');
      expect(node).toMatchObject({ status: 'pending', approvalRequired: true });
      expect((await w.approvals.get(w.tenantA, must(node.approvalId))).status).toBe('pending');
      expect(w.toolCalls).toHaveLength(0);
    };

    it('14. an agent that only proposes runs a read, but every change waits on a person', async () => {
      const w = await world({ autonomy: 'propose' });
      const read = await w.run(asks({ name: 'lookup', subject: 'open' }), ANSWER);
      expect(read.execution.status).toBe('completed');
      const change = await world({ autonomy: 'propose' });
      const { execution } = await change.run(asks({ name: 'update_record', subject: 'r-1' }));
      await waitsOn(change, execution);
    });

    it('15. the default level makes low-risk changes only; within policy makes the rest', async () => {
      const medium = { name: 'update_price', subject: 'p-1' };
      const controlled = await world();
      await waitsOn(controlled, (await controlled.run(asks(medium))).execution);
      const low = await world();
      const { execution } = await low.run(asks({ name: 'update_record', subject: 'r-1' }), ANSWER);
      expect(execution.status).toBe('completed');
      const within = await world({ autonomy: 'within_policy' });
      expect((await within.run(asks(medium), ANSWER)).execution.status).toBe('completed');
      expect(within.toolCalls).toEqual([{ toolId: 'update_price', input: { subject: 'p-1' } }]);
    });

    it("16. the organization's maximum caps every agent: within policy acts as propose", async () => {
      const w = await world({ autonomy: 'within_policy', policy: { maxAutonomy: 'propose' } });
      const { execution } = await w.run(asks({ name: 'update_record', subject: 'r-1' }));
      await waitsOn(w, execution);
    });

    it('17. an action the organization counts as sensitive waits on a person at every level', async () => {
      const w = await world({
        autonomy: 'within_policy',
        policy: { sensitiveTools: ['update_record'] },
      });
      const { execution } = await w.run(asks({ name: 'update_record', subject: 'r-1' }));
      await waitsOn(w, execution);
      // MelonOffice's own list: sending outside waits too, whatever the level.
      const send = await world({ autonomy: 'within_policy' });
      await waitsOn(send, (await send.run(asks({ name: 'send_email', subject: 'x' }))).execution);
    });

    it('18. an agent disabled while its action waits never runs it, nor asks the model again', async () => {
      const w = await world();
      const { execution } = await w.run(asks({ name: 'send_email', subject: 'offer' }), ANSWER);
      const specialistId = must(execution.specialistId);
      await w.stores.specialists.update(w.orgA, specialistId, (s) =>
        applySpecialistStatus(s, { from: 'active', to: 'disabled', reason: 'test' }, AT),
      );
      const calls = w.providerCalls.length;
      const { execution: after } = await w.decide(execution.id, 'approve');
      // The Tool Gate refuses an agent that is no longer active; nothing ran, no model was asked.
      expect(w.toolCalls).toHaveLength(0);
      expect(w.providerCalls).toHaveLength(calls);
      expect(after.status).toBe('failed');
    });
  });
});
