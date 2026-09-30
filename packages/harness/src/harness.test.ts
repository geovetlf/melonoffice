import type { AgentContextSource } from '@melonoffice/agents';
import { createAgentTaskService, InMemoryAgentTaskRepository } from '@melonoffice/agents';
import {
  createProviderRegistry,
  dataPolicyFromEnv,
  DEFAULT_MODEL_POLICY,
  routeModel,
} from '@melonoffice/ai-gateway';
import { NVIDIA_MODELS, NVIDIA_PROVIDER } from '@melonoffice/ai-nvidia';
import { VERTEX_AI_MODELS, VERTEX_AI_PROVIDER } from '@melonoffice/ai-vertex';
import { createAuditService, InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { openWallet } from '@melonoffice/credits';
import { createDecisionEngine, DECIDERS, type DecisionAgent } from '@melonoffice/decisions';
import {
  DEFAULT_DEPARTMENT_CATALOGUE,
  InMemoryDepartmentRepository,
  provisionDepartments,
} from '@melonoffice/departments';
import type {
  AIModelDefinition,
  AIRoutingStrategy,
  Execution,
  ExecutionNode,
  InitialBilling,
  Organization,
  SubscriptionId,
  ToolVersion,
  UserId,
} from '@melonoffice/domain';
import { createExecutionService, InMemoryExecutionRepository } from '@melonoffice/execution';
import {
  createPlanner,
  createPlanService,
  createPlanValidator,
  InMemoryPlanRepository,
} from '@melonoffice/planning';
import { createAuthorizationService, ROLES, type Permission } from '@melonoffice/rbac';
import {
  createSkillCatalogue,
  createSpecialistManagement,
  createSpecialistService,
  InMemorySpecialistRepository,
} from '@melonoffice/specialists';
import {
  createOrganization,
  InMemoryTenancyStore,
  resolveRuntimeTenant,
  resolveTenant,
  type TenantContext,
} from '@melonoffice/tenancy';
import { createToolRegistry, TOOL_CATALOGUE } from '@melonoffice/tools';
import { describe, expect, it } from 'vitest';
import {
  aiNeedOf,
  authorizationClassOf,
  authorizeToolUse,
  checkHarnessTask,
  checkProfilePolicy,
  classifyTask,
  contextPlanOf,
  createAgentHarness,
  createCrmContextSource,
  createDecisionAgentRouter,
  crmContextText,
  createHarnessAgentWork,
  createHarnessContextSource,
  createHarnessToolDirectory,
  createPlanningHarnessPlanner,
  DEFAULT_HARNESS_LIMITS,
  DEFAULT_HARNESS_PROFILE_POLICY,
  HARNESS_AI_KINDS,
  HARNESS_CONVERSATION_POLICY_REF,
  HARNESS_RISK_POLICY,
  HARNESS_TASK_POLICY_REF,
  handoffForTask,
  harnessConversationPolicy,
  harnessDataPolicy,
  harnessTaskPolicy,
  sensitivityOfData,
  toolLevelOf,
  isHarnessError,
  planLimitProblem,
  modelProfileOf,
  withHarnessProfile,
  type HarnessCredits,
} from './index.js';

/**
 * The Melon Agent Harness, block 1 (ADR-0099), over the real engines it coordinates: tenancy,
 * RBAC, the Decision Engine's agent routing, the Agent Engine's tasks and the AI Gateway's router.
 * Only the credits balance and the routing model are stand-ins.
 */

const T0 = new Date('2026-09-30T08:00:00Z');
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

const as = (userId: UserId, actor: 'user' | 'gia' = 'user'): AuthenticatedContext =>
  Object.freeze({ actor, userId, emailVerified: true });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (isHarnessError(error)) return error.detail ? `${error.code}:${error.detail}` : error.code;
    const code = (error as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    throw error;
  }
  return 'accepted';
}

async function world(
  options: {
    readonly without?: readonly Permission[];
    readonly balance?: number | null;
    readonly routingAnswer?: string;
    /** The planning model's answer, from the plan owner's id. Absent: no planner (block 1). */
    readonly planAnswer?: (agentId: string) => unknown;
  } = {},
) {
  let clock = new Date(T0);
  const now = () => {
    clock = new Date(clock.getTime() + 1000);
    return clock;
  };
  const audit = new InMemoryAuditStore();
  const departments = new InMemoryDepartmentRepository();
  const tenancy = new InMemoryTenancyStore(now, audit, undefined, departments);
  const create = (user: UserId, name: string) =>
    createOrganization(as(user), { name }, tenancy, {
      billing: BILLING,
      credits: openWallet,
      departments: (o: Organization) => provisionDepartments(o, DEFAULT_DEPARTMENT_CATALOGUE),
    });
  const a = await create(ALICE, 'A');
  const b = await create(BOB, 'B');
  const full = createAuthorizationService();
  const authorization = createAuthorizationService({
    ...ROLES,
    owner: ROLES.owner.filter((p) => !(options.without ?? []).includes(p)),
  });
  const repository = new InMemorySpecialistRepository(audit);
  const management = createSpecialistManagement({
    repository,
    departments,
    organizations: tenancy,
    authorization: full,
    skills: createSkillCatalogue(),
    tools: (id, version) =>
      id === 'follow_up_schedule' && version === 2
        ? { riskLevel: 'low', approval: 'approval_required', permissions: ['follow_up.manage'] }
        : undefined,
    now,
  });
  const specialists = createSpecialistService({
    repository,
    departments,
    organizations: tenancy,
    authorization: full,
  });
  const executions = createExecutionService({
    repository: new InMemoryExecutionRepository(audit),
    organizations: tenancy,
    assignments: specialists.assignments,
    authorization,
    audit: createAuditService(audit, now),
    now,
  });
  const tasks = new InMemoryAgentTaskRepository();
  const kicked: string[] = [];
  const taskService = createAgentTaskService({
    tasks,
    specialists: repository,
    executions,
    authorization,
    runtime: { kickoff: async (_t, id) => void kicked.push(id) },
    now,
  });
  // The organization's active agents, as the API reads them for GIA and routing (ADR-0064).
  const directory = {
    async active(tenant: TenantContext): Promise<DecisionAgent[]> {
      const [deps, agents] = await Promise.all([
        departments.list(tenant.organizationId),
        repository.list(tenant.organizationId),
      ]);
      const types = new Map(
        deps.map((d) => [d.id as string, d.origin.kind === 'catalog' ? d.origin.typeId : 'custom']),
      );
      return agents
        .filter((s) => s.status === 'active')
        .map((s) => ({
          id: s.identity.id,
          name: s.identity.displayName,
          department: types.get(s.configuration.departmentId) ?? 'unknown',
          purpose: null,
        }));
    },
  };
  // The routing model: picks the first candidate, and counts how often it was asked.
  let modelCalls = 0;
  const gateway = {
    async assist() {
      modelCalls += 1;
      return {
        status: 'completed',
        provider: 'test',
        model: 'router',
        output: { structured: { agent: options.routingAnswer ?? 'r_a' } },
      } as never;
    },
  };
  const decisions = createDecisionEngine({
    authorization,
    deciders: DECIDERS,
    ports: { agents: directory, gateway },
    audit: createAuditService(audit, now),
  });
  const balance = options.balance === undefined ? 100 : options.balance;
  const creditsAsked: string[] = [];
  const credits: HarnessCredits = {
    async balanceOf(tenant) {
      creditsAsked.push(tenant.organizationId);
      return balance === null
        ? { status: 'unavailable', reason: 'test' }
        : { status: 'present', balance };
    },
  };
  // The planning engine as the API builds it for the Harness (ADR-0101): the real planner,
  // validator and plan service; only the planning model is a stand-in.
  const planRepository = new InMemoryPlanRepository(audit);
  const plans = createPlanService({
    repository: planRepository,
    executions,
    validator: createPlanValidator({
      specialists,
      departments,
      tools: createToolRegistry(TOOL_CATALOGUE),
      authorization,
      environment: undefined,
      riskPolicy: HARNESS_RISK_POLICY,
    }),
    organizations: tenancy,
    authorization,
    audit: createAuditService(audit, now),
    now,
  });
  let planCalls = 0;
  const planAnswer = options.planAnswer;
  const planner =
    planAnswer === undefined
      ? undefined
      : createPlanningHarnessPlanner({
          executions,
          specialists,
          plans,
          planner: createPlanner({
            plans,
            executions,
            specialists,
            departments,
            authorization,
            gateway: {
              async generate(_tenant: TenantContext, request: { specialistId?: string }) {
                planCalls += 1;
                return {
                  status: 'completed',
                  provider: 'test',
                  model: 'planner',
                  versions: { model: '1', policy: { id: 'test', version: 1 } },
                  output: { structured: planAnswer(request.specialistId ?? '') },
                };
              },
            } as never,
          }),
        });
  const harness = createAgentHarness({
    authorization,
    router: createDecisionAgentRouter(decisions),
    ...(planner === undefined ? {} : { planner }),
    directory,
    tasks: taskService,
    credits,
    tools: createHarnessToolDirectory({
      specialists: repository,
      skills: createSkillCatalogue(),
      registry: createToolRegistry(TOOL_CATALOGUE),
      authorization,
    }),
  });
  const alice = await resolveTenant(as(ALICE), a.organization.id, tenancy);
  const bob = await resolveTenant(as(BOB), b.organization.id, tenancy);
  async function agent(tenant = alice, templateId = 'commercial', displayName = 'Lucía') {
    const created = await management.create(tenant, { templateId, displayName });
    return management.setStatus(tenant, created.identity.id, { from: 'draft', to: 'active' });
  }
  return {
    alice,
    bob,
    orgA: a.organization.id,
    harness,
    agent,
    tasks,
    kicked,
    creditsAsked,
    modelCalls: () => modelCalls,
    planCalls: () => planCalls,
    plans,
    executions,
    tenancy,
    audit,
  };
}

describe('Reading a task (ADR-0099 §4)', () => {
  it('reads intent, domains and complexity from fixed rules, in Spanish and English', () => {
    expect(classifyTask('¿Cuál es nuestro horario?')).toMatchObject({
      intent: 'question',
      domains: ['knowledge'],
      complexity: 'simple',
    });
    expect(classifyTask('Clasifica este mensaje')).toMatchObject({
      intent: 'classification',
      complexity: 'simple',
    });
    expect(classifyTask('Summarise this email for me')).toMatchObject({ intent: 'summary' });
    expect(classifyTask('Redacta un saludo para la tienda')).toMatchObject({
      intent: 'generation',
      complexity: 'standard',
    });
    expect(
      classifyTask('Analiza estas ventas y dime qué clientes debería contactar.'),
    ).toMatchObject({ intent: 'analysis', domains: ['crm'], complexity: 'complex' });
    expect(classifyTask('Quiero recuperar clientes que no compraron este mes.')).toMatchObject({
      intent: 'planning',
      domains: ['crm'],
      complexity: 'complex',
    });
    expect(classifyTask('Envía la factura al cliente')).toMatchObject({
      intent: 'action',
      domains: ['crm', 'finance'],
    });
  });

  it('is deterministic: the same words give the same reading', () => {
    const request = 'Prepara una campaña para recuperar clientes inactivos.';
    expect(classifyTask(request)).toEqual(classifyTask(request));
  });

  it('notices a person asking for a person', () => {
    expect(classifyTask('Quiero hablar con una persona, por favor').asksForPerson).toBe(true);
    expect(classifyTask('I want to talk to a human').asksForPerson).toBe(true);
    expect(classifyTask('Resume la reunión').asksForPerson).toBe(false);
  });
});

describe('Model profile (ADR-0099 §5)', () => {
  it('is economic first: the cheapest fitting model unless the task is complex', () => {
    expect(modelProfileOf(classifyTask('Clasifica este mensaje'))).toEqual({
      strategy: 'cost_optimized',
    });
    expect(modelProfileOf(classifyTask('Redacta un saludo'))).toEqual({
      strategy: 'cost_optimized',
    });
    expect(modelProfileOf(classifyTask('Envía el resumen al equipo'))).toMatchObject({
      strategy: 'cost_optimized',
    });
    expect(modelProfileOf(classifyTask('Analiza las ventas del mes'))).toEqual({
      strategy: 'quality_first',
    });
    // A long request is complex whatever its intent.
    expect(modelProfileOf(classifyTask(`Redacta ${'un texto largo '.repeat(80)}`))).toEqual({
      strategy: 'quality_first',
    });
  });

  it('never names a model or provider, and sets no quality floor by default', () => {
    for (const profile of Object.values(DEFAULT_HARNESS_PROFILE_POLICY.intents)) {
      expect(Object.keys(profile)).toEqual(['strategy']);
    }
  });

  it('refuses a policy with an unknown strategy or floor when it is loaded', () => {
    expect(() =>
      checkProfilePolicy({
        ...DEFAULT_HARNESS_PROFILE_POLICY,
        intents: {
          ...DEFAULT_HARNESS_PROFILE_POLICY.intents,
          question: { strategy: 'always_nvidia' as never },
        },
      }),
    ).toThrow(/profile_policy.question.strategy/);
    expect(() =>
      checkProfilePolicy({
        ...DEFAULT_HARNESS_PROFILE_POLICY,
        intents: {
          ...DEFAULT_HARNESS_PROFILE_POLICY.intents,
          analysis: { strategy: 'quality_first', minimumQuality: 'best' as never },
        },
      }),
    ).toThrow(/profile_policy.analysis.minimumQuality/);
  });

  it("lets the AI Gateway's router pick a cheap model for simple work and a strong one for complex work", () => {
    const base = {
      version: 'v1',
      status: 'active',
      capabilities: ['text_generation'],
      inputModalities: ['text'],
      outputModalities: ['text'],
      contextWindowTokens: 100_000,
      maxOutputTokens: 8_000,
      structuredOutput: true,
      toolUse: false,
      streaming: false,
      environments: ['dev'],
      maxSensitivity: 'confidential',
    } as const;
    const price = (input: number, output: number) =>
      ({
        status: 'known',
        currency: 'USD',
        inputMicroUsdPerMillionTokens: input,
        outputMicroUsdPerMillionTokens: output,
        source: 'test fixture',
        asOf: '2026-09-30',
      }) as const;
    const models: AIModelDefinition[] = [
      {
        ...base,
        providerId: 'p',
        modelId: 'cheap',
        quality: 'basic',
        latency: 'fast',
        pricing: price(100_000, 400_000),
      },
      {
        ...base,
        providerId: 'p',
        modelId: 'strong',
        quality: 'high',
        latency: 'slow',
        pricing: price(2_000_000, 8_000_000),
      },
    ];
    const registry = createProviderRegistry({
      providers: [
        {
          id: 'p',
          name: 'Test',
          status: 'active',
          access: 'official',
          capabilities: ['text_generation'],
          modalities: ['text'],
          environments: ['dev'],
          credential: { provider: 'p_api', scopes: [] },
          maxSensitivity: 'confidential',
        },
      ],
      models,
      adapters: [
        {
          providerId: 'p',
          adapterVersion: '1',
          capabilities: () => ['text_generation'],
          health: async () => 'available',
          generate: async () => ({ status: 'error', kind: 'unavailable' }),
        },
      ],
    });
    const route = (request: string) => {
      const decision = routeModel(registry, DEFAULT_MODEL_POLICY, 'dev', {
        capability: 'text_generation',
        inputModalities: ['text'],
        outputModality: 'text',
        sensitivity: 'internal',
        estimatedInputTokens: 500,
        maxOutputTokens: 500,
        strategy: modelProfileOf(classifyTask(request)).strategy,
      });
      return decision.status === 'selected' ? decision.candidates[0]?.model.modelId : undefined;
    };
    expect(route('Clasifica este mensaje')).toBe('cheap');
    expect(route('Analiza nuestras ventas del trimestre')).toBe('strong');
  });
});

describe('Context plan (ADR-0099 §13)', () => {
  it('reads only what the task needs', () => {
    expect(contextPlanOf(classifyTask('Resume este texto'))).toEqual([]);
    expect(contextPlanOf(classifyTask('Redacta un saludo'))).toEqual(['company_brain']);
    expect(
      contextPlanOf(classifyTask('¿Cómo respondo a este cliente según nuestra política?')),
    ).toEqual(['company_brain', 'crm']);
    // Self-contained work about a business area still reads the company's memory.
    expect(contextPlanOf(classifyTask('Resume nuestra política de devoluciones'))).toEqual([
      'company_brain',
    ]);
    expect(contextPlanOf(classifyTask('Resume nuestras ventas'))).toEqual(['company_brain', 'crm']);
  });

  it('reads Company Brain and the CRM only when planned, and nothing for a missing source', async () => {
    const read: string[] = [];
    const source = (name: string): AgentContextSource => ({
      async read() {
        read.push(name);
        return [{ name, text: `${name} facts` }];
      },
    });
    const context = createHarnessContextSource({
      sources: { company_brain: source('company_context'), crm: source('crm_context') },
    });
    const w = await world();
    const configuration = {} as never;
    expect(await context.read(w.alice, { configuration, request: 'Resume este texto' })).toEqual(
      [],
    );
    expect(read).toEqual([]);
    const blocks = await context.read(w.alice, {
      configuration,
      request: '¿Qué le ofrecemos a este cliente según nuestra política?',
    });
    expect(blocks.map((b) => b.name)).toEqual(['company_context', 'crm_context']);
    // A planned source that is not set up here is left out: nothing stands in for it.
    const brainOnly = createHarnessContextSource({
      sources: { company_brain: source('company_context') },
    });
    const only = await brainOnly.read(w.alice, {
      configuration,
      request: 'Redacta un mensaje para el cliente',
    });
    expect(only.map((b) => b.name)).toEqual(['company_context']);
  });
});

describe('Tools (ADR-0099 §16, §18)', () => {
  const version = (extra: Partial<ToolVersion>): ToolVersion =>
    ({
      mutating: true,
      approvalPolicy: 'auto',
      riskLevel: 'low',
      provider: { kind: 'internal', id: 'x' },
      ...extra,
    }) as ToolVersion;

  it("classes a tool's use from its own declaration", () => {
    expect(authorizationClassOf(version({ mutating: false }))).toBe('informative');
    expect(authorizationClassOf(version({}))).toBe('reversible');
    expect(authorizationClassOf(version({ approvalPolicy: 'approval_required' }))).toBe(
      'sensitive',
    );
    expect(authorizationClassOf(version({ provider: { kind: 'external', id: 'wa' } }))).toBe(
      'external',
    );
    expect(authorizationClassOf(version({ riskLevel: 'critical' }))).toBe('irreversible');
  });

  it("lists the agent's granted tools, and never one the person may not use", async () => {
    const w = await world();
    const lucia = await w.agent();
    const strategy = await w.harness.prepare(w.alice, {
      request: 'Agenda un seguimiento con el cliente',
      specialistId: lucia.identity.id,
    });
    expect(strategy.tools).toEqual([
      {
        id: 'follow_up_schedule',
        version: 2,
        level: 'C',
        authorization: 'sensitive',
        approvalRequired: true,
      },
    ]);
    const narrowed = await world({ without: ['follow_up.manage'] });
    const other = await narrowed.agent();
    const denied = await narrowed.harness.prepare(narrowed.alice, {
      request: 'Agenda un seguimiento con el cliente',
      specialistId: other.identity.id,
    });
    expect(denied.tools).toEqual([]);
  });
});

describe('Preparing and starting a task (ADR-0099 block 1)', () => {
  it('routes to the only agent, starts its task through the Agent Engine and queues it once', async () => {
    const w = await world();
    const lucia = await w.agent();
    const { strategy, task } = await w.harness.start(w.alice, {
      request: 'Analiza estas ventas y dime qué clientes debería contactar.',
      idempotencyKey: 'harness-1',
    });
    expect(strategy).toMatchObject({
      version: 1,
      context: { organizationId: w.orgA, userId: ALICE, actor: 'user', role: 'owner' },
      classification: { intent: 'analysis', domains: ['crm'], complexity: 'complex' },
      plan: { mode: 'single_step' },
      contextPlan: ['company_brain', 'crm'],
      agent: { id: lucia.identity.id, name: 'Lucía', department: 'sales' },
      model: { strategy: 'quality_first' },
      budget: { status: 'available', maxCredits: null },
      // The owner's own words and the company's records: private, whatever the request says.
      data: { class: 'company_private', sensitivity: 'confidential' },
      limits: DEFAULT_HARNESS_LIMITS,
      verdict: 'ready',
      reasons: ['only_candidate'],
    });
    expect(task?.task).toMatchObject({
      specialistId: lucia.identity.id,
      request: 'Analiza estas ventas y dime qué clientes debería contactar.',
    });
    expect(task?.execution?.status).toBe('running');
    expect(w.kicked).toEqual([task?.task.id]);
    // Starting the same task again is the same task.
    const again = await w.harness.start(w.alice, {
      request: 'Analiza estas ventas y dime qué clientes debería contactar.',
      idempotencyKey: 'harness-1',
    });
    expect(again.task?.task.id).toBe(task?.task.id);
    expect(new Set(w.kicked)).toEqual(new Set([task?.task.id]));
    // Only rules were needed: no model was asked.
    expect(w.modelCalls()).toBe(0);
  });

  it('prefers the department the task points at, and falls back to any agent', async () => {
    const w = await world();
    await w.agent(w.alice, 'commercial', 'Lucía');
    const finance = await w.agent(w.alice, 'finance', 'Fernando');
    const toFinance = await w.harness.prepare(w.alice, {
      request: 'Redacta un recordatorio de pago de la factura',
    });
    expect(toFinance.agent).toMatchObject({ id: finance.identity.id, department: 'finance' });
    const onlyCommercial = await world();
    const lucia = await onlyCommercial.agent();
    const fallback = await onlyCommercial.harness.prepare(onlyCommercial.alice, {
      request: 'Redacta un recordatorio de pago de la factura',
    });
    expect(fallback).toMatchObject({
      verdict: 'ready',
      agent: { id: lucia.identity.id },
      reasons: ['inferred_department_empty', 'only_candidate'],
    });
  });

  it('asks the routing model only among several agents, and lets the person choose when it cannot', async () => {
    const w = await world();
    await w.agent(w.alice, 'commercial', 'Lucía');
    await w.agent(w.alice, 'marketing', 'Mara');
    const routed = await w.harness.prepare(w.alice, { request: 'Redacta un saludo' });
    expect(routed.verdict).toBe('ready');
    expect(routed.reasons).toEqual(['model_selected']);
    expect(w.modelCalls()).toBe(1);
    const unsure = await world({ routingAnswer: 'none' });
    await unsure.agent(unsure.alice, 'commercial', 'Lucía');
    await unsure.agent(unsure.alice, 'marketing', 'Mara');
    const { strategy, task } = await unsure.harness.start(unsure.alice, {
      request: 'Redacta un saludo',
    });
    expect(strategy).toMatchObject({ verdict: 'choose_agent', agent: null });
    expect(strategy.candidates.map((c) => c.name).sort()).toEqual(['Lucía', 'Mara']);
    expect(task).toBeUndefined();
  });

  it('uses the agent the person named, only if it is active in their organization', async () => {
    const w = await world();
    const lucia = await w.agent();
    const named = await w.harness.prepare(w.alice, {
      request: 'Redacta un saludo',
      specialistId: lucia.identity.id,
    });
    expect(named).toMatchObject({ verdict: 'ready', reasons: ['agent_named_by_person'] });
    // Tenant B cannot name tenant A's agent: it is not among B's active agents.
    const fromB = await w.harness.start(w.bob, {
      request: 'Redacta un saludo',
      specialistId: lucia.identity.id,
    });
    expect(fromB.strategy).toMatchObject({
      verdict: 'no_agent',
      reasons: ['named_agent_not_active'],
      context: { userId: BOB },
    });
    expect(fromB.task).toBeUndefined();
  });

  it("never routes to another organization's agents", async () => {
    const w = await world();
    await w.agent(w.alice);
    const fromB = await w.harness.start(w.bob, { request: 'Redacta un saludo' });
    expect(fromB.strategy).toMatchObject({ verdict: 'no_agent', agent: null });
    expect(w.kicked).toEqual([]);
  });

  it('hands a person asking for a person to a person, without routing or a model', async () => {
    const w = await world();
    await w.agent();
    const { strategy, task } = await w.harness.start(w.alice, {
      request: 'Quiero hablar con una persona',
    });
    expect(strategy).toMatchObject({
      verdict: 'handoff_to_human',
      agent: null,
      reasons: ['person_requested'],
    });
    expect(task).toBeUndefined();
    expect(w.creditsAsked).toEqual([]);
  });

  it('starts nothing without credits, or when the balance cannot be read', async () => {
    for (const [balance, reason, status] of [
      [0, 'insufficient_credits', 'insufficient'],
      [null, 'credits_unavailable', 'unavailable'],
    ] as const) {
      const w = await world({ balance });
      await w.agent();
      const { strategy, task } = await w.harness.start(w.alice, { request: 'Redacta un saludo' });
      expect(strategy).toMatchObject({
        verdict: 'refused',
        reasons: [reason],
        budget: { status, maxCredits: null },
      });
      expect(task).toBeUndefined();
      expect(w.kicked).toEqual([]);
    }
  });

  it('marks a complex plan as multi-step, and still runs it as one task in block 1', async () => {
    const w = await world();
    await w.agent();
    const { strategy, task } = await w.harness.start(w.alice, {
      request: 'Prepara una campaña para recuperar clientes inactivos.',
    });
    expect(strategy.plan).toEqual({ mode: 'multi_step' });
    expect(strategy.reasons).toContain('multi_step_runs_as_single_task');
    expect(task?.execution?.status).toBe('running');
  });

  it('refuses a person without permission, an unresolved tenant and a malformed task', async () => {
    const w = await world({ without: ['specialist.read'] });
    expect(await codeOf(w.harness.prepare(w.alice, { request: 'Hola' }))).toBe('permission_denied');
    const ok = await world();
    const forged = { ...ok.alice } as TenantContext;
    expect(await codeOf(ok.harness.prepare(forged, { request: 'Hola' }))).toBe('unresolved_tenant');
    expect(await codeOf(ok.harness.prepare(ok.alice, { request: ' ' }))).toBe(
      'invalid_task:request',
    );
    expect(() => checkHarnessTask({ request: 'Hola', organizationId: 'x' })).toThrow(
      /organizationId/,
    );
    expect(() => checkHarnessTask({ request: 'Hola', department: 'Ventas!' })).toThrow(
      /department/,
    );
  });

  it('refuses routing for a person who may not evaluate decisions', async () => {
    const w = await world({ without: ['decision.evaluate'] });
    await w.agent();
    expect(await codeOf(w.harness.prepare(w.alice, { request: 'Redacta un saludo' }))).toBe(
      'permission_denied',
    );
  });

  it('prepares only when no task service is given', async () => {
    const w = await world();
    await w.agent();
    const prepareOnly = createAgentHarness({
      authorization: createAuthorizationService(),
      router: { route: async () => ({ status: 'none' }) },
      directory: { active: async () => [] },
      credits: { balanceOf: async () => ({ status: 'present', balance: 5 }) },
    });
    const { task } = await prepareOnly.start(w.alice, { request: 'Redacta un saludo' });
    expect(task).toBeUndefined();
  });
});

/** A shaped call, when the Harness did not stop it. */
const workOf = <T extends object>(value: T | undefined) =>
  value === undefined || 'stop' in value
    ? undefined
    : (value as Exclude<T, { readonly stop: string }>);

describe("The model profile on the runtime's call (ADR-0099 §5)", () => {
  const work: {
    readonly taskType: string;
    readonly capability: 'text_generation';
    readonly messages: readonly never[];
    readonly outputModality: 'text';
    readonly maxOutputTokens: number;
    readonly sensitivity: 'confidential';
    readonly metadata: Readonly<Record<string, string | number | boolean>>;
    readonly strategy?: AIRoutingStrategy;
    readonly quality?: 'basic' | 'standard' | 'high';
  } = {
    taskType: 'agent_task',
    capability: 'text_generation',
    messages: [],
    outputModality: 'text',
    maxOutputTokens: 1200,
    sensitivity: 'confidential',
    metadata: { skills: 2 },
  };

  it('adds the order to try models in and labels, never a model or provider', () => {
    const shaped = withHarnessProfile(work, 'Analiza las ventas del mes');
    expect(shaped).toEqual({
      ...work,
      strategy: 'quality_first',
      metadata: {
        harnessIntent: 'analysis',
        harnessComplexity: 'complex',
        harnessPolicy: 'harness_default@2',
        harnessData: 'company_private',
        harnessEscalation: 'complex_task',
        skills: 2,
      },
    });
    expect(shaped.maxOutputTokens).toBe(1200);
  });

  it("keeps the caller's own choice, and applies a policy's quality floor only when set", () => {
    expect(withHarnessProfile({ ...work, strategy: 'latency_first' }, 'Clasifica').strategy).toBe(
      'latency_first',
    );
    const floored = withHarnessProfile(work, 'Analiza las ventas', {
      ...DEFAULT_HARNESS_PROFILE_POLICY,
      intents: {
        ...DEFAULT_HARNESS_PROFILE_POLICY.intents,
        analysis: { strategy: 'quality_first', minimumQuality: 'high' },
      },
    });
    expect(floored.quality).toBe('high');
  });

  it("shapes the agent task's call from the stored request, and routine work with no bypass", async () => {
    const execution = { id: 'e1' } as Execution;
    const node = { id: 'work' } as ExecutionNode;
    const inner = {
      agentWork: async (tenant: TenantContext, execution: Execution, node: ExecutionNode) =>
        tenant && execution && node ? work : undefined,
      toolInput: async () => 'kept',
    };
    const shaped = createHarnessAgentWork(inner, {
      taskOf: async (_t, e) => (e.id === 'e1' ? { request: 'Clasifica este mensaje' } : undefined),
    });
    const w = await world();
    expect(workOf(await shaped.agentWork(w.alice, execution, node))?.strategy).toBe(
      'cost_optimized',
    );
    // Work with no request (a conversation turn, a plan step) still goes through the Harness.
    expect(await shaped.agentWork(w.alice, { id: 'e2' } as Execution, node)).toEqual({
      ...work,
      strategy: 'cost_optimized',
      metadata: {
        harnessIntent: 'question',
        harnessComplexity: 'simple',
        harnessPolicy: 'harness_default@2',
        harnessData: 'company_private',
        skills: 2,
      },
    });
    expect(await shaped.toolInput()).toBe('kept');
  });
});

describe('Task budget (ADR-0100)', () => {
  it("keeps the person's budget on the task and in the strategy", async () => {
    const w = await world({ balance: 5 });
    await w.agent();
    const { strategy, task } = await w.harness.start(w.alice, {
      request: 'Redacta un saludo',
      maxCredits: 10,
    });
    expect(strategy.budget).toEqual({ status: 'available', maxCredits: 10 });
    // The balance is the real limit; the budget above it is said, not refused.
    expect(strategy.reasons).toContain('budget_above_balance');
    expect(task?.task.maxCredits).toBe(10);
    expect(await codeOf(w.harness.prepare(w.alice, { request: 'Hola', maxCredits: 0 }))).toBe(
      'invalid_task:maxCredits',
    );
    expect(
      await codeOf(w.harness.prepare(w.alice, { request: 'Hola', maxCredits: 1.5 } as never)),
    ).toBe('invalid_task:maxCredits');
  });

  it('caps each model call at what is left, down to nothing when the budget is spent', async () => {
    const work = { maxOutputTokens: 100, metadata: {} };
    const node = { id: 'work' } as ExecutionNode;
    const w = await world();
    const left = (spent: number, own?: number) =>
      createHarnessAgentWork(
        {
          agentWork: async (tenant: TenantContext, execution: Execution, n: ExecutionNode) =>
            tenant && execution && n
              ? { ...work, ...(own === undefined ? {} : { maxCredits: own }) }
              : undefined,
        },
        {
          taskOf: async () => ({ request: 'Redacta un saludo', maxCredits: 10 }),
          spent: async () => spent,
        },
      ).agentWork(w.alice, { id: 'e1' } as Execution, node);
    // Enough: the call may spend what is left.
    expect(workOf(await left(4))?.maxCredits).toBe(6);
    // The call's own lower limit stays.
    expect(workOf(await left(4, 2))?.maxCredits).toBe(2);
    // Spent: the gateway refuses every priced model (`credit_limit_exceeded`) and nothing runs.
    expect(workOf(await left(12))?.maxCredits).toBe(0);
    // No budget: no cap from the Harness.
    const free = await createHarnessAgentWork(
      {
        agentWork: async (tenant: TenantContext, execution: Execution, n: ExecutionNode) =>
          tenant && execution && n ? work : undefined,
      },
      { taskOf: async () => ({ request: 'Redacta un saludo' }) },
    ).agentWork(w.alice, { id: 'e1' } as Execution, node);
    expect(free).not.toHaveProperty('maxCredits');
  });
});

describe('Multi-step plans, limits and hand-off (ADR-0101)', () => {
  const COMPLEX = 'Prepara una campaña para recuperar clientes inactivos.';
  const step = (id: string, agentId: string, label: string, dependsOn: string[] = []) => ({
    id,
    kind: 'specialist',
    label,
    dependsOn,
    specialistId: agentId,
    verification: { policy: 'checks', expectedOutput: 'report', requiredChecks: ['reviewed'] },
  });
  const plan = (steps: unknown[]) => ({ summary: 'Campaign', objective: 'Win back', steps });
  const twoSteps = (agentId: string) =>
    plan([
      step('segment', agentId, 'Segment inactive customers'),
      step('draft', agentId, 'Draft the win-back message', ['segment']),
    ]);

  it('asks the existing planner for a plan that waits for a person, and starts nothing', async () => {
    const w = await world({ planAnswer: twoSteps });
    await w.agent();
    const { strategy, task } = await w.harness.start(w.alice, {
      request: COMPLEX,
      idempotencyKey: 'campaign-1',
    });
    expect(strategy).toMatchObject({
      verdict: 'needs_authorization',
      handoff: null,
      plan: { mode: 'multi_step', status: 'approval_required', steps: 2 },
    });
    expect(strategy.reasons).toEqual(
      expect.arrayContaining(['multi_step_needs_plan', 'plan_awaits_approval']),
    );
    expect(task).toBeUndefined();
    expect(w.kicked).toEqual([]);
    const stored = await w.plans.get(w.alice, strategy.plan.id ?? '');
    expect(stored.status).toBe('approval_required');

    // The same request again is the same plan: the planner is not asked twice.
    const again = await w.harness.start(w.alice, {
      request: COMPLEX,
      idempotencyKey: 'campaign-1',
    });
    expect(again.strategy.plan.id).toBe(strategy.plan.id);
    expect(w.planCalls()).toBe(1);
    const other = await w.harness.start(w.alice, {
      request: `${COMPLEX} Otra cosa.`,
      idempotencyKey: 'campaign-1',
    });
    expect(other.strategy.handoff).toEqual({
      type: 'HANDOFF_TO_HUMAN',
      reason: 'plan_failed',
      code: 'idempotency_conflict',
    });
  });

  it('withdraws a plan that repeats itself or goes past the limits, and hands it to a person', async () => {
    for (const [answer, code] of [
      [
        (id: string) =>
          plan([
            step('one', id, 'Draft the message'),
            step('two', id, 'Draft  the MESSAGE', ['one']),
          ]),
        'loop_detected',
      ],
      [
        (id: string) => plan(Array.from({ length: 9 }, (_, i) => step(`s${i}`, id, `Part ${i}`))),
        'too_many_steps',
      ],
    ] as const) {
      const w = await world({ planAnswer: answer });
      await w.agent();
      const { strategy, task } = await w.harness.start(w.alice, { request: COMPLEX });
      expect(strategy).toMatchObject({
        verdict: 'handoff_to_human',
        handoff: { type: 'HANDOFF_TO_HUMAN', reason: 'policy', code },
        plan: { mode: 'multi_step', status: 'cancelled' },
      });
      expect(task).toBeUndefined();
      expect((await w.plans.get(w.alice, strategy.plan.id ?? '')).status).toBe('cancelled');
      expect(w.kicked).toEqual([]);
    }
  });

  it('hands a plan the pipeline refused to a person, and never runs it', async () => {
    const w = await world({ planAnswer: () => ({ summary: 'x' }) });
    await w.agent();
    const { strategy, task } = await w.harness.start(w.alice, { request: COMPLEX });
    expect(strategy.verdict).toBe('handoff_to_human');
    expect(strategy.handoff?.reason).toBe('plan_failed');
    expect(strategy.plan).toEqual({ mode: 'multi_step' });
    expect(task).toBeUndefined();
  });

  it('runs a multi-step task as one task for a person who may not create plans', async () => {
    const w = await world({ planAnswer: twoSteps, without: ['plan.create'] });
    await w.agent();
    const { strategy, task } = await w.harness.start(w.alice, { request: COMPLEX });
    expect(strategy.reasons).toContain('multi_step_runs_as_single_task');
    expect(task?.execution?.status).toBe('running');
    expect(w.planCalls()).toBe(0);
  });

  it("refuses a task from an agent's own work: no chain of agents asking agents", async () => {
    const w = await world({ planAnswer: twoSteps });
    await w.agent();
    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    const { strategy, task } = await w.harness.start(runtime, { request: 'Redacta un saludo' });
    expect(strategy).toMatchObject({ verdict: 'refused', reasons: ['depth_exceeded'] });
    expect(task).toBeUndefined();
    expect(w.creditsAsked).toEqual([]);
  });

  it('says why a plan may not run, from its steps alone', () => {
    const s = (id: string, specialistId: string, label = id) => ({
      id,
      label,
      dependsOn: [],
      specialistId,
    });
    expect(planLimitProblem([s('a', 'x'), s('b', 'x')])).toBeUndefined();
    expect(planLimitProblem([s('a', 'x', 'Café'), s('b', 'x', 'cafe')])).toBe('loop_detected');
    expect(planLimitProblem([s('a', 'x', 'Café'), s('b', 'y', 'cafe')])).toBeUndefined();
    expect(planLimitProblem(['a', 'b', 'c', 'd', 'e'].map((id) => s(id, id)))).toBe(
      'too_many_agents',
    );
    expect(
      planLimitProblem([s('a', 'x'), s('b', 'x')], {
        ...DEFAULT_HARNESS_LIMITS,
        maxSteps: 1,
        maxAgents: 1,
      }),
    ).toBe('too_many_steps');
  });

  it('says when a finished or stopped task goes to a person, and why', () => {
    const at = (status: string, failure: string | null = null, missing: string[] = []) =>
      handoffForTask({ status, failure, missing });
    expect(at('running')).toBeNull();
    expect(at('completed')).toBeNull();
    expect(at('cancelled')).toBeNull();
    expect(at('failed', 'approval_rejected')).toBeNull();
    expect(at('completed', null, ['price list'])).toMatchObject({ reason: 'missing_information' });
    expect(at('waiting_approval')).toMatchObject({ reason: 'authorization_required' });
    expect(at('failed', 'credit_limit_exceeded')).toEqual({
      type: 'HANDOFF_TO_HUMAN',
      reason: 'authorization_required',
      code: 'credit_limit_exceeded',
    });
    expect(at('failed', 'provider_unavailable')).toMatchObject({ reason: 'repeated_error' });
  });
});

describe('The CRM as context (ADR-0102)', () => {
  const insights = {
    timeZone: 'America/Lima',
    today: '2026-09-30',
    contacts: {
      counts: { lead: 3, customer: 5, inactive: 1 },
      leadsWithoutNextAction: 2,
      overdueNextAction: 1,
      inactiveCustomers: 1,
      newToday: 0,
      newThisWeek: 2,
    },
    opportunities: {
      counts: { open: 4, won: 2, lost: 1 },
      openValue: [
        { currency: 'PEN', amountMinor: 1_250_000, count: 3 },
        { currency: 'JPY', amountMinor: 5000, count: 1 },
      ],
      wonThisMonth: [],
      closingSoon: 1,
      closeDatePassed: 0,
      quiet: 2,
    },
    followUps: { open: 3, overdue: 1, today: 1 },
  } as never;
  const configuration = (permissions: string[]) => ({ permissions }) as never;
  const tenant = {} as TenantContext;

  it('gives an agent the counts and totals its configuration may read, never records', async () => {
    const source = createCrmContextSource({ insights: { read: async () => insights } });
    const [all] = await source.read(tenant, {
      configuration: configuration(['contact.read', 'opportunity.read', 'follow_up.read']),
      request: 'x',
    });
    expect(all?.name).toBe('crm_context');
    expect(all?.text).toContain('Contacts: 3 leads, 5 customers, 1 inactive.');
    expect(all?.text).toContain('Open value: 12,500.00 PEN, 5,000 JPY.');
    expect(all?.text).toContain('Follow-ups open: 3; overdue 1; today 1.');
    const [some] = await source.read(tenant, {
      configuration: configuration(['opportunity.read']),
      request: 'x',
    });
    expect(some?.text).toContain('Opportunities: 4 open');
    expect(some?.text).not.toContain('Contacts');
    expect(some?.text).not.toContain('Follow-ups');
  });

  it("says so when the agent may not read them, and when they cannot be read, and never reads another's", async () => {
    let reads = 0;
    const source = createCrmContextSource({
      insights: {
        read: async () => {
          reads += 1;
          throw new Error('down');
        },
      },
    });
    expect(
      await source.read(tenant, { configuration: configuration(['knowledge.read']), request: 'x' }),
    ).toEqual([{ name: 'crm_context', text: '(this agent may not read the customer records)' }]);
    expect(reads).toBe(0);
    expect(
      await source.read(tenant, { configuration: configuration(['contact.read']), request: 'x' }),
    ).toEqual([{ name: 'crm_context', text: '(the customer records could not be read now)' }]);
    // A part the person may not read comes back null from the insights: nothing of it is shown.
    const text = crmContextText({ ...(insights as object), contacts: null } as never, {
      contacts: true,
      opportunities: false,
      followUps: false,
    });
    expect(text).toBe('(the customer records are not available to this agent)');
  });
});

describe('Routing with NVIDIA evaluated first (ADR-0100, Geovet 2026-09-30)', () => {
  const noop = (provider: typeof NVIDIA_PROVIDER) => ({
    providerId: provider.id,
    adapterVersion: '1',
    capabilities: () => provider.capabilities,
    health: async () => 'available' as const,
    generate: async () => ({ status: 'error' as const, kind: 'unavailable' as const }),
  });
  const registry = createProviderRegistry({
    providers: [NVIDIA_PROVIDER, VERTEX_AI_PROVIDER],
    models: [...NVIDIA_MODELS, ...VERTEX_AI_MODELS],
    adapters: [noop(NVIDIA_PROVIDER), noop(VERTEX_AI_PROVIDER)],
  });
  const policy = harnessTaskPolicy({
    preferredProviders: [NVIDIA_PROVIDER.id],
    environments: ['dev'],
    maxCostMicroUsd: 10_000,
  });
  const route = (
    overrides: {
      sensitivity?: 'public' | 'internal' | 'confidential';
      structuredOutput?: boolean;
    } = {},
    environment: 'dev' | 'prod' = 'dev',
    unavailable: ReadonlySet<string> = new Set(),
  ) =>
    routeModel(
      registry,
      policy,
      environment,
      {
        capability: 'text_generation',
        inputModalities: ['text'],
        outputModality: 'text',
        sensitivity: overrides.sensitivity ?? 'public',
        estimatedInputTokens: 500,
        maxOutputTokens: 500,
        ...(overrides.structuredOutput === undefined
          ? {}
          : { structuredOutput: overrides.structuredOutput }),
        strategy: 'cost_optimized',
      },
      unavailable,
    );
  const providers = (decision: ReturnType<typeof route>) =>
    decision.status === 'selected' ? decision.candidates.map((c) => c.provider.id) : [];

  it('pins no provider or model, and names NVIDIA only as an order', () => {
    expect(policy).not.toHaveProperty('allowedProviders');
    expect(policy).not.toHaveProperty('allowedModels');
    expect(policy).toMatchObject({
      id: 'agent_task',
      version: 2,
      fallback: 'compatible',
      preferredProviders: ['nvidia'],
      maxSensitivity: 'confidential',
    });
    expect(HARNESS_TASK_POLICY_REF).toEqual({ id: 'agent_task', version: 2 });
  });

  it('tries NVIDIA first where its terms allow the call, with the next compatible model as fallback', () => {
    const decision = route();
    // The router records why: a preferred provider won.
    expect(decision).toMatchObject({ status: 'selected', reason: 'preferred' });
    expect(providers(decision)).toEqual([NVIDIA_PROVIDER.id, VERTEX_AI_PROVIDER.id]);
    // NVIDIA down: the next compatible model, with nobody choosing it by hand.
    expect(providers(route({}, 'dev', new Set([NVIDIA_PROVIDER.id])))).toEqual([
      VERTEX_AI_PROVIDER.id,
    ]);
  });

  it('never sends NVIDIA what its trial terms forbid: company data, a shape it cannot give, production', () => {
    // The company's own records (agent tasks are `confidential`): NVIDIA's terms cap it at public.
    expect(providers(route({ sensitivity: 'confidential' }))).toEqual([VERTEX_AI_PROVIDER.id]);
    expect(providers(route({ sensitivity: 'internal' }))).toEqual([VERTEX_AI_PROVIDER.id]);
    // A structured answer, as agent tasks ask for: not documented on NVIDIA's hosted endpoint.
    expect(providers(route({ structuredOutput: true }))).toEqual([VERTEX_AI_PROVIDER.id]);
    // Production: neither the policy nor NVIDIA's registration allows it.
    expect(route({}, 'prod')).toMatchObject({ status: 'none' });
  });
});

describe('Escalation, budget across a retry and AI needs (ADR-0100)', () => {
  const work = {
    taskType: 'agent_task',
    capability: 'text_generation',
    messages: [],
    outputModality: 'text',
    maxOutputTokens: 100,
    sensitivity: 'confidential',
  } as {
    taskType: string;
    capability: string;
    messages: never[];
    outputModality: string;
    maxOutputTokens: number;
    sensitivity: 'confidential';
    strategy?: AIRoutingStrategy;
    quality?: 'basic' | 'standard' | 'high';
    maxCredits?: number;
    metadata?: Record<string, string | number | boolean>;
  };

  it('says why it asks for the strongest model, and caps each call at what is left of the budget', async () => {
    const node = { id: 'work' } as unknown as ExecutionNode;
    const execution = { id: 'e' } as unknown as Execution;
    const shaped = (request: string, strategy?: AIRoutingStrategy) =>
      createHarnessAgentWork(
        {
          agentWork: async (t: TenantContext, e: Execution, n: ExecutionNode) =>
            t && e && n ? { ...work, ...(strategy === undefined ? {} : { strategy }) } : undefined,
        },
        {
          taskOf: async () => ({ request, maxCredits: 3 }),
          spent: async (_t, e) => (e.id === 'e' ? 2 : 0),
        },
      ).agentWork({} as TenantContext, execution, node);
    const simple = await shaped('Clasifica este mensaje');
    expect(simple).toMatchObject({ strategy: 'cost_optimized', maxCredits: 1 });
    expect(workOf(simple)?.metadata).not.toHaveProperty('harnessEscalation');
    expect(await shaped('Analiza las ventas de esta semana')).toMatchObject({
      strategy: 'quality_first',
      metadata: { harnessEscalation: 'complex_task' },
    });
    expect(
      await shaped(`Redacta una propuesta. ${'Detalle del cliente. '.repeat(40)}`),
    ).toMatchObject({
      strategy: 'quality_first',
      metadata: { harnessEscalation: 'complex_task' },
    });
    // A strategy the caller chose stays the caller's: no escalation is claimed for it.
    const chosen = await shaped('Analiza las ventas de esta semana', 'balanced');
    expect(chosen).toMatchObject({ strategy: 'balanced' });
    expect(workOf(chosen)?.metadata).not.toHaveProperty('harnessEscalation');
  });

  it('knows what each kind of AI work needs from the router, and refuses what nothing carries yet', () => {
    expect(HARNESS_AI_KINDS).toEqual([
      'text',
      'vision',
      'audio',
      'video',
      'embedding',
      'image',
      'document',
      'voice',
    ]);
    expect(aiNeedOf('text')).toMatchObject({ supported: true, capability: 'text_generation' });
    expect(aiNeedOf('vision')).toMatchObject({
      capability: 'image_understanding',
      inputModalities: ['text', 'image'],
    });
    expect(aiNeedOf('voice')).toMatchObject({ capability: 'speech', outputModality: 'audio' });
    expect(aiNeedOf('embedding')).toMatchObject({ capability: 'embeddings' });
    expect(aiNeedOf('video')).toEqual({ kind: 'video', supported: false });
  });
});

describe('Data policy before routing (ADR-0100, Geovet 2026-09-30 09:09Z)', () => {
  const noop = (provider: typeof NVIDIA_PROVIDER) => ({
    providerId: provider.id,
    adapterVersion: '1',
    capabilities: () => provider.capabilities,
    health: async () => 'available' as const,
    generate: async () => ({ status: 'error' as const, kind: 'unavailable' as const }),
  });
  const [nemotron] = NVIDIA_MODELS;
  if (nemotron?.terms === undefined) throw new Error('no NVIDIA model');
  const privateTerms = { ...nemotron.terms, contentUse: 'not_used' as const };
  /**
   * NVIDIA as it would be registered under a contract that allows company data: made up for this
   * test (no such contract exists). It shows the data policy, not the code, keeps data off it.
   */
  const contracted = createProviderRegistry({
    providers: [{ ...NVIDIA_PROVIDER, maxSensitivity: 'confidential' }, VERTEX_AI_PROVIDER],
    models: [
      {
        ...nemotron,
        structuredOutput: true,
        maxSensitivity: 'confidential',
        terms: privateTerms,
      },
      ...VERTEX_AI_MODELS,
    ],
    adapters: [noop(NVIDIA_PROVIDER), noop(VERTEX_AI_PROVIDER)],
  });
  const policy = harnessTaskPolicy({
    preferredProviders: [NVIDIA_PROVIDER.id],
    environments: ['dev'],
    maxCostMicroUsd: 10_000,
  });
  const trial = harnessDataPolicy([
    { provider: NVIDIA_PROVIDER.id, environment: 'dev', maxSensitivity: 'public' },
  ]);
  const route = (
    registry: typeof contracted,
    sensitivity: 'public' | 'confidential',
    dataPolicy = trial,
    extra: { maxCostMicroUsd?: number } = {},
  ) =>
    routeModel(
      registry,
      policy,
      'dev',
      {
        capability: 'text_generation',
        inputModalities: ['text'],
        outputModality: 'text',
        sensitivity,
        estimatedInputTokens: 500,
        maxOutputTokens: 500,
        strategy: 'cost_optimized',
        ...extra,
      },
      new Set(),
      () => 'available',
      dataPolicy,
    );
  const providers = (decision: ReturnType<typeof route>) =>
    decision.status === 'selected' ? decision.candidates.map((c) => c.provider.id) : [];

  it('sends private company data only where the data policy allows, and falls back on its own', () => {
    // Every task a person gives is private: routed as `confidential`.
    expect(sensitivityOfData('company_private')).toBe('confidential');
    expect(sensitivityOfData('synthetic')).toBe('public');
    // Even with terms that would allow it, the data policy keeps company data off NVIDIA: Gemini.
    expect(providers(route(contracted, 'confidential'))).toEqual([VERTEX_AI_PROVIDER.id]);
    // Public, synthetic or test data: NVIDIA first, Gemini as the fallback.
    expect(providers(route(contracted, 'public'))).toEqual([
      NVIDIA_PROVIDER.id,
      VERTEX_AI_PROVIDER.id,
    ]);
  });

  it('is configuration per environment and provider: a contract changes the policy, not the code', () => {
    const withContract = dataPolicyFromEnv({ AI_DATA_POLICY: 'nvidia:confidential' }, 'dev', trial);
    expect(withContract.entries).toEqual([
      { provider: 'nvidia', environment: 'dev', maxSensitivity: 'confidential' },
    ]);
    expect(providers(route(contracted, 'confidential', withContract))[0]).toBe(NVIDIA_PROVIDER.id);
    // The data policy can never go past what a provider's recorded terms allow (the trial ones).
    const real = createProviderRegistry({
      providers: [NVIDIA_PROVIDER, VERTEX_AI_PROVIDER],
      models: [...NVIDIA_MODELS, ...VERTEX_AI_MODELS],
      adapters: [noop(NVIDIA_PROVIDER), noop(VERTEX_AI_PROVIDER)],
    });
    expect(providers(route(real, 'confidential', withContract))).toEqual([VERTEX_AI_PROVIDER.id]);
    // Unset: the server's defaults. Malformed: refused, never guessed.
    expect(dataPolicyFromEnv({}, 'dev', trial)).toEqual(trial);
    expect(() => dataPolicyFromEnv({ AI_DATA_POLICY: 'nvidia' }, 'dev', trial)).toThrow();
    expect(() => dataPolicyFromEnv({ AI_DATA_POLICY: 'nvidia:secret' }, 'dev', trial)).toThrow();
  });

  it('refuses a call no authorized provider may receive, before looking at anything else', () => {
    const only = createProviderRegistry({
      providers: [{ ...NVIDIA_PROVIDER, maxSensitivity: 'confidential' }],
      models: [
        {
          ...nemotron,
          maxSensitivity: 'confidential',
          terms: privateTerms,
        },
      ],
      adapters: [noop(NVIDIA_PROVIDER)],
    });
    expect(route(only, 'confidential')).toEqual({
      status: 'none',
      reason: 'data_policy_not_allowed',
    });
  });

  it('never takes NVIDIA as free: a price above the cap, or no known price, moves the call on', () => {
    const priced = (pricing: (typeof nemotron)['pricing']) =>
      createProviderRegistry({
        providers: [NVIDIA_PROVIDER, VERTEX_AI_PROVIDER],
        models: [{ ...nemotron, pricing }, ...VERTEX_AI_MODELS],
        adapters: [noop(NVIDIA_PROVIDER), noop(VERTEX_AI_PROVIDER)],
      });
    // A paid endpoint whose price is over the call's cap: the next compatible model.
    const expensive = priced({
      ...nemotron.pricing,
      inputMicroUsdPerMillionTokens: 50_000_000,
      outputMicroUsdPerMillionTokens: 50_000_000,
    } as (typeof nemotron)['pricing']);
    expect(providers(route(expensive, 'public'))).toEqual([VERTEX_AI_PROVIDER.id]);
    // No known price: it cannot be shown to respect the cap, so it is left out.
    const unknown = priced({ status: 'unknown' } as (typeof nemotron)['pricing']);
    expect(providers(route(unknown, 'public'))).toEqual([VERTEX_AI_PROVIDER.id]);
  });

  it('routes existing conversation agents through the Harness as well: no provider or model pinned', () => {
    const conversation = harnessConversationPolicy({
      preferredProviders: [NVIDIA_PROVIDER.id],
      environments: ['dev'],
      maxModelCalls: DEFAULT_HARNESS_LIMITS.maxModelCalls,
    });
    expect(HARNESS_CONVERSATION_POLICY_REF).toEqual({ id: 'conversation_agent', version: 2 });
    expect(conversation).not.toHaveProperty('allowedProviders');
    expect(conversation).not.toHaveProperty('allowedModels');
    expect(conversation).toMatchObject({
      fallback: 'compatible',
      maxCalls: 3,
      allowedCapabilities: ['text_generation'],
      allowedModalities: ['text'],
    });
  });
});

describe('Task limits (ADR-0100)', () => {
  it('stops a task past its time before any model is asked, and says why', async () => {
    let asked = 0;
    const shaped = createHarnessAgentWork(
      {
        agentWork: async () => {
          asked += 1;
          return { maxOutputTokens: 100, sensitivity: 'confidential' as const };
        },
      },
      { now: () => new Date('2026-09-30T08:11:00Z') },
    );
    const node = { id: 'work' } as ExecutionNode;
    const late = { id: 'e', createdAt: '2026-09-30T08:00:00Z', nodes: [] } as unknown as Execution;
    expect(await shaped.agentWork({} as TenantContext, late, node)).toEqual({
      stop: 'task_time_limit_reached',
    });
    expect(asked).toBe(0);
    const onTime = {
      id: 'e',
      createdAt: '2026-09-30T08:05:00Z',
      nodes: [],
    } as unknown as Execution;
    expect(await shaped.agentWork({} as TenantContext, onTime, node)).toMatchObject({
      strategy: 'cost_optimized',
      sensitivity: 'confidential',
    });
  });

  it('never lowers what a call carries', () => {
    const shaped = withHarnessProfile(
      { maxOutputTokens: 1, sensitivity: 'restricted' as const },
      'Clasifica',
    );
    expect(shaped.sensitivity).toBe('restricted');
    const unset: { maxOutputTokens: number; sensitivity?: 'public' } = { maxOutputTokens: 1 };
    expect(withHarnessProfile(unset, 'Clasifica').sensitivity).toBe('confidential');
  });
});

describe('Tool levels A/B/C (Geovet 2026-09-30)', () => {
  const registry = createToolRegistry(TOOL_CATALOGUE);
  const tool = (id: string, version: number) => {
    const found = registry.resolve(id, version);
    if (found === undefined) throw new Error(`no tool ${id}@${version}`);
    return found.version;
  };
  const decide = (
    id: string,
    version: number,
    extra: Partial<Parameters<typeof authorizeToolUse>[0]> = {},
  ) =>
    authorizeToolUse({
      tool: tool(id, version),
      granted: true,
      toolCallsUsed: 0,
      maxToolCalls: DEFAULT_HARNESS_LIMITS.maxToolCalls,
      ...extra,
    });

  it('runs a reversible change inside MelonOffice by itself, and asks a person for the rest', () => {
    // Handing a conversation to a person: internal, low risk, reversible.
    expect(toolLevelOf(tool('conversation_handoff', 1))).toBe('B');
    expect(decide('conversation_handoff', 1)).toEqual({
      decision: 'allow',
      level: 'B',
      reason: 'automatic',
    });
    // Sending a message outside MelonOffice: level C, a person approves.
    expect(decide('message_send', 3)).toEqual({
      decision: 'approval_required',
      level: 'C',
      reason: 'sensitive_action',
    });
    // A tool whose own policy asks for approval stays with a person.
    expect(decide('follow_up_schedule', 2)).toMatchObject({ decision: 'approval_required' });
  });

  it('never lets an agent decide alone: no grant, no budget, or a denied tool is refused', () => {
    expect(decide('conversation_handoff', 1, { granted: false })).toMatchObject({
      decision: 'deny',
      reason: 'not_granted',
    });
    expect(
      decide('conversation_handoff', 1, { toolCallsUsed: DEFAULT_HARNESS_LIMITS.maxToolCalls }),
    ).toMatchObject({ decision: 'deny', reason: 'tool_call_limit_reached' });
    const critical = { ...tool('conversation_handoff', 1), riskLevel: 'critical' as const };
    expect(
      authorizeToolUse({ tool: critical, granted: true, toolCallsUsed: 0, maxToolCalls: 5 }),
    ).toMatchObject({ decision: 'deny', reason: 'tool_denied' });
    // An organization may keep level B for a person.
    expect(decide('conversation_handoff', 1, { policy: { automatic: ['A'] } })).toEqual({
      decision: 'approval_required',
      level: 'B',
      reason: 'organization_policy',
    });
  });
});
