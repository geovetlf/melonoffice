import {
  InMemoryUsageSink,
  type AIUsageSink,
  type CustomerCreditPolicy,
} from '@melonoffice/ai-usage';
import { createCreditService, InMemoryCreditStore, openWallet } from '@melonoffice/credits';
import { createAuditService, InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import {
  DEFAULT_DEPARTMENT_CATALOGUE,
  departmentIdOf,
  InMemoryDepartmentRepository,
  provisionDepartments,
} from '@melonoffice/departments';
import type {
  AIModelDefinition,
  AIProviderDefinition,
  DepartmentTypeId,
  DeploymentEnvironment,
  Execution,
  InitialBilling,
  IsoTimestamp,
  ModelPolicy,
  Organization,
  OrganizationId,
  PolicyId,
  Specialist,
  SpecialistStatus,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import { createExecutionService, InMemoryExecutionRepository } from '@melonoffice/execution';
import { createLogger } from '@melonoffice/observability';
import { createAuthorizationService, ROLES } from '@melonoffice/rbac';
import {
  applySpecialistStatus,
  createSpecialistService,
  InMemorySpecialistRepository,
  newSpecialist,
} from '@melonoffice/specialists';
import {
  createOrganization,
  InMemoryTenancyStore,
  membershipIdOf,
  resolveRuntimeTenant,
  resolveTenant,
  type TenantContext,
} from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import {
  ProviderCredential,
  retryAfterMsOf,
  type ProviderAdapter,
  type ProviderCall,
  type ProviderOutcome,
  type ProviderStreamEvent,
} from './adapter.js';
import type { AICreditsPort } from './credits.js';
import {
  ASSIST_MODEL_POLICIES,
  createAIGateway,
  MAX_RETRY_WAIT_MS,
  retryDelayMs,
} from './gateway.js';
import { createModelPolicyCatalogue, DEFAULT_MODEL_POLICY } from './policy.js';
import { createProviderRegistry } from './registry.js';
import {
  estimateInputTokens,
  inputModalitiesOf,
  type AIRequest,
  type AssistedAIRequest,
} from './request.js';
import type { AIToolDefinition } from './tools.js';

const T0 = new Date('2026-09-27T12:00:00Z');
const AT = T0.toISOString() as IsoTimestamp;
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
/** Credential-shaped test values, built at run time so secret scanners do not flag the source. */
const fake = (...parts: string[]) => parts.join('');
const LEAKED_KEY = fake('sk', '-abcdefghijklmnopqrstuvwxyz123456');
const SECRET_VALUE = fake('super', '-secret-', 'provider-value');

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

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing value');
  return value;
};

// Test fixtures only: MelonOffice's real catalogue is empty until the launch provider (D-7).
const provider = (
  id: string,
  overrides: Partial<AIProviderDefinition> = {},
): AIProviderDefinition => ({
  id,
  name: `Test ${id}`,
  status: 'active',
  access: 'official',
  capabilities: ['text_generation', 'reasoning', 'structured_output', 'image_understanding'],
  modalities: ['text', 'image'],
  environments: ['dev'],
  credential: { provider: `${id}_api`, scopes: ['generate'] },
  maxSensitivity: 'confidential',
  ...overrides,
});

const model = (
  providerId: string,
  modelId: string,
  overrides: Partial<AIModelDefinition> = {},
): AIModelDefinition => ({
  providerId,
  modelId,
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
  ...overrides,
});

const MODELS: AIModelDefinition[] = [
  model('alpha', 'alpha-large', {
    capabilities: ['text_generation', 'reasoning', 'structured_output', 'image_understanding'],
    inputModalities: ['text', 'image'],
    structuredOutput: true,
    quality: 'high',
    maxSensitivity: 'confidential',
  }),
  model('alpha', 'alpha-small', {
    latency: 'fast',
    pricing: {
      status: 'known',
      currency: 'USD',
      inputMicroUsdPerMillionTokens: 100_000,
      outputMicroUsdPerMillionTokens: 400_000,
      source: 'test fixture',
      asOf: '2026-09-01',
    },
  }),
  model('alpha', 'alpha-retired', { status: 'disabled' }),
  model('beta', 'beta-text'),
  model('beta', 'beta-unpriced', { pricing: { status: 'unknown' } }),
];

type Script = Record<string, (() => ProviderOutcome | Promise<ProviderOutcome>)[]>;
type StreamScript = Record<string, (() => AsyncIterable<ProviderStreamEvent>)[]>;

const OK = (text = 'Summary ready.'): ProviderOutcome => ({
  status: 'success',
  output: { text },
  usage: { inputTokens: 1_000, outputTokens: 500 },
  finishReason: 'stop',
  providerRequestId: 'prov-req-1',
});

/** A fake official adapter: answers from a script per model, and records what it was sent. */
function fakeAdapter(
  providerId: string,
  script: Script,
  calls: ProviderCall[],
  streams: StreamScript = {},
): ProviderAdapter {
  // What a real adapter would resolve through infrastructure; it must never leave the adapter.
  const credential = new ProviderCredential(SECRET_VALUE);
  return {
    providerId,
    adapterVersion: `${providerId}-adapter-1`,
    capabilities: () => [
      'text_generation',
      'reasoning',
      'structured_output',
      'image_understanding',
      'embeddings',
    ],
    health: async () => 'available',
    async generate(call) {
      calls.push(call);
      if (credential.reveal() !== SECRET_VALUE) throw new Error('credential lost');
      const next = script[call.model.id]?.shift();
      return next === undefined ? OK() : next();
    },
    async *stream(call) {
      calls.push(call);
      const next = streams[call.model.id]?.shift();
      if (next !== undefined) {
        yield* next();
        return;
      }
      yield { type: 'text', text: 'Summary ' };
      yield { type: 'text', text: 'ready.' };
      yield { type: 'end', outcome: OK() };
    },
  };
}

/** A test double of the Credits engine's port: a balance per organization. */
function fakeCredits(initial: number) {
  const balances = new Map<string, number>();
  const spent = new Map<string, number>();
  const port: AICreditsPort = {
    async balanceOf(tenant) {
      return { status: 'present', balance: balances.get(tenant.organizationId) ?? initial };
    },
    async consume(tenant, { amount, referenceId }) {
      const key = `${tenant.organizationId}\n${referenceId}`;
      const balance = balances.get(tenant.organizationId) ?? initial;
      if (spent.has(key)) return { balance, replayed: true };
      if (amount > balance) throw new Error('credits_insufficient');
      balances.set(tenant.organizationId, balance - amount);
      spent.set(key, amount);
      return { balance: balance - amount, replayed: false };
    },
    async refund() {
      throw new Error('not used');
    },
  };
  return { port, spent, balances };
}

interface WorldOptions {
  readonly roles?: Record<string, readonly string[]>;
  readonly environment?: DeploymentEnvironment | undefined;
  readonly script?: Script;
  readonly policies?: readonly ModelPolicy[];
  readonly defaultPolicy?: ModelPolicy;
  readonly balance?: number;
  readonly credits?: 'none' | 'no_rate';
  readonly providers?: AIProviderDefinition[];
  readonly models?: AIModelDefinition[];
  /** Use the real Credits engine (PR #20) instead of the test double. */
  readonly realCredits?: boolean;
  readonly usage?: AIUsageSink;
  readonly streams?: StreamScript;
  readonly creditPolicy?: CustomerCreditPolicy;
}

async function world(options: WorldOptions = {}) {
  const now = () => T0;
  const audit = new InMemoryAuditStore();
  const departments = new InMemoryDepartmentRepository();
  const creditStore = new InMemoryCreditStore(audit);
  const tenancy = new InMemoryTenancyStore(now, audit, undefined, departments, creditStore);
  const creditService = createCreditService({ store: creditStore, organizations: tenancy, now });
  const provision = (organization: Organization) =>
    provisionDepartments(organization, DEFAULT_DEPARTMENT_CATALOGUE);
  const a = await createOrganization(as(ALICE), { name: 'A' }, tenancy, {
    billing: BILLING,
    credits: openWallet,
    departments: provision,
  });
  const b = await createOrganization(as(BOB), { name: 'B' }, tenancy, {
    billing: BILLING,
    credits: openWallet,
    departments: provision,
  });
  const orgA = a.organization.id;
  const orgB = b.organization.id;
  const authorization = createAuthorizationService((options.roles ?? ROLES) as never);
  const specialistRepository = new InMemorySpecialistRepository();
  const specialists = createSpecialistService({
    repository: specialistRepository,
    departments,
    organizations: tenancy,
    authorization,
  });
  const executionRepository = new InMemoryExecutionRepository(audit);
  const executions = createExecutionService({
    repository: executionRepository,
    organizations: tenancy,
    assignments: specialists.assignments,
    authorization,
    audit: createAuditService(audit, now),
    now,
  });
  const calls: ProviderCall[] = [];
  const script = options.script ?? {};
  const registry = createProviderRegistry({
    providers: options.providers ?? [
      provider('alpha'),
      provider('beta', {
        capabilities: ['text_generation', 'embeddings'],
        modalities: ['text'],
        maxSensitivity: 'internal',
      }),
    ],
    models: options.models ?? MODELS,
    adapters: [
      fakeAdapter('alpha', script, calls, options.streams),
      fakeAdapter('beta', script, calls, options.streams),
    ],
  });
  const credits = fakeCredits(options.balance ?? 1_000);
  const logLines: string[] = [];
  const sleeps: number[] = [];
  const gateway = createAIGateway({
    executions: executionRepository,
    organizations: tenancy,
    specialists,
    authorization,
    registry,
    policies: createModelPolicyCatalogue(
      options.policies ?? [],
      options.defaultPolicy ?? { ...DEFAULT_MODEL_POLICY, backoffMs: 0 },
    ),
    environment: 'environment' in options ? options.environment : 'dev',
    ...(options.credits === 'none'
      ? {}
      : {
          credits: {
            port: options.realCredits ? creditService : credits.port,
            rate: options.credits === 'no_rate' ? undefined : { microUsdPerCredit: 1_000 },
            ...(options.creditPolicy === undefined ? {} : { policy: options.creditPolicy }),
          },
        }),
    audit: createAuditService(audit, now),
    logger: createLogger({ service: 'test', sink: (line) => logLines.push(line) }),
    timeoutMs: 50,
    now,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
    ...(options.usage === undefined ? {} : { usage: options.usage }),
  });
  const tenantA = await resolveTenant(as(ALICE), orgA, tenancy);
  const tenantB = await resolveTenant(as(BOB), orgB, tenancy);
  const giaA = await resolveTenant(as(ALICE, 'gia'), orgA, tenancy);

  async function seed(
    org: OrganizationId,
    by: UserId,
    {
      status = 'active',
      permissions = ['organization.read'],
      policy,
    }: {
      status?: SpecialistStatus;
      permissions?: string[];
      policy?: { id: string; version: number };
    } = {},
  ): Promise<Specialist> {
    const departmentId = departmentIdOf(org, 'research' as DepartmentTypeId);
    const write = newSpecialist(
      {
        organizationId: org,
        displayName: 'María',
        configuration: {
          departmentId,
          mainRoleId: 'market_researcher',
          roleVersion: 1,
          capabilities: [],
          skills: [],
          tools: [],
          permissions,
          policies: policy === undefined ? {} : { model: policy },
        } as never,
      },
      must(await departments.find(org, departmentId)),
      by,
      AT,
    );
    await specialistRepository.create(write);
    let current = write.specialist;
    for (const to of status === 'draft'
      ? []
      : ['active', ...(status === 'active' ? [] : [status])]) {
      current = await specialistRepository.update(org, current.identity.id, (s) =>
        applySpecialistStatus(s, { from: s.status, to: to as SpecialistStatus }, AT),
      );
    }
    return current;
  }

  async function running(tenant: TenantContext, s: Specialist): Promise<Execution> {
    const execution = await executions.create(tenant, {
      mode: 'execute',
      input: { type: 'task', id: 'task-1' },
      specialistId: s.identity.id,
      specialistVersion: s.version,
      departmentId: s.configuration.departmentId,
      versionSnapshot: {
        schemaVersion: 1,
        components: [{ kind: 'specialist', id: s.identity.id, version: '1' }],
      },
      nodes: [{ id: 'n0', type: 'agent', label: 'Think' }],
    });
    return executions.start(tenant, execution.id);
  }

  const events = (action?: string) =>
    audit.events().filter((e) => action === undefined || e.action === action);

  return {
    creditService,
    audit,
    events,
    logLines,
    sleeps,
    orgA,
    orgB,
    tenantA,
    tenantB,
    giaA,
    tenancy,
    a,
    gateway,
    calls,
    credits,
    executions,
    specialistRepository,
    seed,
    running,
  };
}

const requestFor = (
  execution: Execution,
  overrides: Partial<Record<keyof AIRequest, unknown>> = {},
): AIRequest =>
  ({
    requestId: 'req-1',
    executionId: execution.id,
    nodeId: 'n0',
    specialistId: execution.specialistId,
    taskType: 'summarise_document',
    capability: 'text_generation',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarise the melon market.' }] }],
    outputModality: 'text',
    maxOutputTokens: 1_000,
    sensitivity: 'internal',
    ...overrides,
  }) as AIRequest;

async function setup(
  options: WorldOptions = {},
  seedOptions: Parameters<Awaited<ReturnType<typeof world>>['seed']>[2] = {},
) {
  const w = await world(options);
  const specialist = await w.seed(w.orgA, ALICE, seedOptions);
  const execution = await w.running(w.tenantA, specialist);
  const call = (overrides: Partial<Record<keyof AIRequest, unknown>> = {}, tenant = w.tenantA) =>
    w.gateway.generate(tenant, requestFor(execution, overrides));
  return { w, specialist, execution, call };
}

const onlyModels = (...models: string[]): ModelPolicy => ({
  ...DEFAULT_MODEL_POLICY,
  id: 'test_policy' as PolicyId,
  allowedModels: models,
  backoffMs: 0,
});

describe('AI gateway: the happy path', () => {
  it('routes, calls the adapter, accounts usage, cost and credits, and says which versions answered', async () => {
    const { w, call } = await setup({ defaultPolicy: onlyModels('alpha/alpha-small') });
    const response = await call();
    expect(response).toMatchObject({
      status: 'completed',
      requestId: 'req-1',
      provider: 'alpha',
      model: 'alpha-small',
      versions: {
        adapter: 'alpha-adapter-1',
        model: '2026-09-01',
        policy: { id: 'test_policy', version: 1 },
      },
      output: { text: 'Summary ready.' },
      usage: { inputTokens: 1_000, outputTokens: 500 },
      finishReason: 'stop',
      // 1000 × 0.1 + 500 × 0.4 = 300 micro-USD; 1 credit per 1000 micro-USD, rounded up.
      cost: { actualMicroUsd: 300 },
      credits: { state: 'consumed', consumed: 1 },
      providerRequestId: 'prov-req-1',
      attempts: 1,
      fallbackFrom: null,
    });
    expect(w.credits.spent.get(`${w.orgA}\nai:req-1`)).toBe(1);
    expect(w.calls).toHaveLength(1);
    expect(w.calls[0]).toMatchObject({
      requestId: 'req-1',
      model: { id: 'alpha-small', version: '2026-09-01' },
      credential: { provider: 'alpha_api', scopes: ['generate'] },
    });
    // Successful calls are observed, not audited one by one.
    expect(w.events().filter((e) => e.action.startsWith('ai.'))).toEqual([]);
  });

  it('charges a request once, even when it is repeated', async () => {
    const { w, call } = await setup({ defaultPolicy: onlyModels('alpha/alpha-small') });
    await call();
    await call();
    expect([...w.credits.spent.values()]).toEqual([1]);
    expect(w.calls[0]?.idempotencyKey).toBe(w.calls[1]?.idempotencyKey);
  });

  it('chooses deterministically among compatible models', async () => {
    const first = await setup();
    const second = await setup();
    const a = await first.call();
    const b = await second.call();
    expect(a.status === 'completed' && b.status === 'completed').toBe(true);
    if (a.status === 'completed' && b.status === 'completed') {
      expect(`${a.provider}/${a.model}`).toBe(`${b.provider}/${b.model}`);
    }
  });
});

describe('AI gateway: the 20 security cases of the X4 brief', () => {
  it("1. a request on another organization's execution is denied", async () => {
    const { w, call } = await setup();
    expect(await call({}, w.tenantB)).toMatchObject({
      status: 'denied',
      code: 'execution_not_found',
    });
    expect(w.calls).toHaveLength(0);
  });

  it('2. a tenant injected into the request or its metadata is refused', async () => {
    const { w, call } = await setup();
    expect(await call({ organizationId: w.orgB } as never)).toMatchObject({
      status: 'denied',
      code: 'authority_in_input',
    });
    expect(await call({ metadata: { tenantId: w.orgB } })).toMatchObject({
      code: 'authority_in_input',
    });
    expect(await call({ metadata: { userId: 'x' } })).toMatchObject({ code: 'authority_in_input' });
    expect(await call({ provider: 'alpha' } as never)).toMatchObject({ code: 'invalid_request' });
    expect(w.calls).toHaveLength(0);
  });

  it('3. an API key in the input is refused', async () => {
    const { w, call } = await setup();
    const text = `Use this key: "${LEAKED_KEY}" to fetch the data.`;
    expect(
      await call({ messages: [{ role: 'user', content: [{ type: 'text', text }] }] }),
    ).toMatchObject({ status: 'denied', code: 'secret_in_input' });
    expect(
      await call({
        messages: [
          { role: 'user', content: [{ type: 'text', text: 'Authorization: Bearer abcdefghijkl' }] },
        ],
      }),
    ).toMatchObject({ code: 'secret_in_input' });
    expect(w.calls).toHaveLength(0);
  });

  it('4. a secret in the metadata is refused', async () => {
    const { w, call } = await setup();
    expect(await call({ metadata: { note: LEAKED_KEY } })).toMatchObject({
      code: 'secret_in_input',
    });
    expect(await call({ metadata: { apiKey: 'x' } })).toMatchObject({ code: 'authority_in_input' });
    expect(w.calls).toHaveLength(0);
  });

  it('5. a specialist other than the execution’s, or one whose permissions the user lacks, is denied', async () => {
    const { w, call } = await setup();
    const other = await w.seed(w.orgA, ALICE);
    expect(await call({ specialistId: other.identity.id })).toMatchObject({
      code: 'specialist_mismatch',
    });
    // A test-only role, not a product one (D-27): it may call AI but lacks billing.read.
    const needy = await setup(
      { roles: { ...ROLES, analyst: ['organization.read', 'execution.read', 'ai.generate'] } },
      { permissions: ['billing.read'] },
    );
    needy.w.tenancy.put({
      id: membershipIdOf(needy.w.orgA, BOB),
      organizationId: needy.w.orgA,
      userId: BOB,
      status: 'active',
      role: 'analyst' as never,
      createdAt: AT,
      updatedAt: AT,
    });
    // The owner holds the specialist's permission; Bob and GIA acting for Bob do not.
    expect((await needy.call()).status).toBe('completed');
    for (const actor of ['user', 'gia'] as const) {
      const bob = await resolveTenant(as(BOB, actor), needy.w.orgA, needy.w.tenancy);
      expect(await needy.call({ requestId: `req-${actor}` }, bob)).toMatchObject({
        status: 'denied',
        code: 'specialist_not_eligible',
      });
    }
    expect(needy.w.calls).toHaveLength(1);
  });

  it('6. a disabled specialist is denied', async () => {
    const { w, specialist, call } = await setup();
    await w.specialistRepository.update(w.orgA, specialist.identity.id, (s) =>
      applySpecialistStatus(s, { from: 'active', to: 'disabled' }, AT),
    );
    expect(await call()).toMatchObject({ status: 'denied', code: 'specialist_not_eligible' });
    expect(w.calls).toHaveLength(0);
  });

  it('7. a disabled model is denied', async () => {
    const { w, call } = await setup({ defaultPolicy: onlyModels('alpha/alpha-retired') });
    expect(await call()).toMatchObject({ status: 'denied', code: 'model_disabled' });
    expect(w.calls).toHaveLength(0);
  });

  it('8. a provider the policy does not allow is denied', async () => {
    const { call } = await setup({
      defaultPolicy: { ...DEFAULT_MODEL_POLICY, backoffMs: 0, allowedProviders: ['gamma'] },
    });
    expect(await call()).toMatchObject({ status: 'denied', code: 'provider_not_allowed' });
  });

  it('9. a model the policy does not allow is denied', async () => {
    const { call } = await setup({ defaultPolicy: onlyModels('beta/not-a-model') });
    expect(await call()).toMatchObject({ status: 'denied', code: 'model_not_allowed' });
  });

  it('10. insufficient credits are denied before any provider is called', async () => {
    const { w, call } = await setup({ balance: 0 });
    expect(await call()).toMatchObject({ status: 'denied', code: 'credits_insufficient' });
    expect(w.calls).toHaveLength(0);
  });

  it('11. a cost or credit limit that no model meets is denied', async () => {
    const { w, call } = await setup();
    expect(await call({ maxCostMicroUsd: 1 })).toMatchObject({ code: 'cost_limit_exceeded' });
    expect(await call({ maxCredits: 0 })).toMatchObject({ code: 'credit_limit_exceeded' });
    const capped = await setup({
      defaultPolicy: { ...onlyModels('alpha/alpha-large'), maxCostMicroUsd: 10 },
    });
    expect(await capped.call()).toMatchObject({ code: 'cost_limit_exceeded' });
    expect(w.calls).toHaveLength(0);
  });

  it('12. an unknown environment is denied, and dev never implies prod', async () => {
    const unknown = await setup({ environment: undefined });
    expect(await unknown.call()).toMatchObject({ code: 'environment_unknown' });
    const prod = await setup({ environment: 'prod' });
    expect(await prod.call()).toMatchObject({ code: 'environment_not_allowed' });
    expect([...unknown.w.calls, ...prod.w.calls]).toHaveLength(0);
  });

  it('13. a capability no model supports is denied', async () => {
    const { call } = await setup();
    expect(await call({ capability: 'image_generation', outputModality: 'image' })).toMatchObject({
      code: 'capability_unsupported',
    });
    expect(
      await call({
        capability: 'image_understanding',
        messages: [{ role: 'user', content: [{ type: 'audio', ref: { type: 'file', id: 'f1' } }] }],
      }),
    ).toMatchObject({ code: 'modality_unsupported' });
  });

  it('14. an unavailable provider falls back only when the policy allows it', async () => {
    const script = (): Script => ({
      'alpha-large': [() => ({ status: 'error', kind: 'unavailable' })],
    });
    const policy = { ...onlyModels('alpha/alpha-large', 'beta/beta-text'), maxAttempts: 1 };
    const allowed = await setup({ defaultPolicy: policy, script: script() });
    expect(await allowed.call({ quality: 'standard' })).toMatchObject({
      status: 'completed',
      provider: 'beta',
      model: 'beta-text',
      fallbackFrom: 'alpha/alpha-large',
      attempts: 2,
    });
    const strict = await setup({
      defaultPolicy: { ...policy, fallback: 'none' },
      script: script(),
    });
    expect(await strict.call()).toMatchObject({
      status: 'failed',
      code: 'unavailable',
      attempts: 1,
    });
    expect(strict.w.calls).toHaveLength(1);
    // Never to a model the request could not use: beta cannot see confidential data.
    const sensitive = await setup({
      defaultPolicy: { ...policy, maxSensitivity: 'confidential' },
      script: script(),
    });
    expect(await sensitive.call({ sensitivity: 'confidential' })).toMatchObject({
      status: 'failed',
      code: 'unavailable',
    });
    expect(sensitive.w.calls.map((c) => c.model.id)).toEqual(['alpha-large']);
  });

  it('15. a permanent provider error is not retried and does not fall back', async () => {
    const { w, call } = await setup({
      defaultPolicy: onlyModels('alpha/alpha-large', 'beta/beta-text'),
      script: {
        'alpha-large': [() => ({ status: 'error', kind: 'invalid_request', httpStatus: 400 })],
      },
    });
    expect(await call()).toMatchObject({ status: 'failed', code: 'invalid_request', attempts: 1 });
    expect(w.calls).toHaveLength(1);
    expect(w.events('ai.request_failed')[0]).toMatchObject({
      result: 'failure',
      reason: 'invalid_request',
    });
    expect([...w.credits.spent.values()]).toEqual([]);
  });

  it('16. a transient 429 is retried according to the policy', async () => {
    const limited = (): ProviderOutcome => ({
      status: 'error',
      kind: 'rate_limited',
      httpStatus: 429,
    });
    const { w, call } = await setup({
      defaultPolicy: onlyModels('alpha/alpha-large'),
      script: { 'alpha-large': [limited, limited] },
    });
    expect(await call()).toMatchObject({ status: 'completed', attempts: 3 });
    expect(w.calls).toHaveLength(3);
    const exhausted = await setup({
      defaultPolicy: { ...onlyModels('alpha/alpha-large'), maxAttempts: 2 },
      script: { 'alpha-large': [limited, limited, limited] },
    });
    expect(await exhausted.call()).toMatchObject({
      status: 'failed',
      code: 'rate_limited',
      attempts: 2,
    });
  });

  it('17. a fallback is recorded in the audit log', async () => {
    const { w, call, execution } = await setup({
      defaultPolicy: { ...onlyModels('alpha/alpha-large', 'beta/beta-text'), maxAttempts: 1 },
      script: {
        'alpha-large': [() => ({ status: 'error', kind: 'server_error', httpStatus: 503 })],
      },
    });
    await call({ quality: 'standard' });
    expect(w.events('ai.provider_fallback')).toEqual([
      expect.objectContaining({
        result: 'success',
        organizationId: w.orgA,
        target: { type: 'execution', id: execution.id },
        model: { provider: 'beta', id: 'beta-text' },
        previousModel: { provider: 'alpha', id: 'alpha-large' },
        reason: 'server_error',
        requestId: 'req-1',
      }),
    ]);
  });

  it('18–19. no secret reaches logs or audit, whatever happens', async () => {
    const { w, call } = await setup({
      defaultPolicy: { ...onlyModels('alpha/alpha-large', 'beta/beta-text'), maxAttempts: 1 },
      script: {
        'alpha-large': [() => ({ status: 'error', kind: 'authentication', httpStatus: 401 })],
      },
    });
    await call({ quality: 'standard' });
    await call({ metadata: { note: LEAKED_KEY } });
    await call({
      requestId: 'req-2',
      messages: [{ role: 'user', content: [{ type: 'text', text: `key ${LEAKED_KEY}` }] }],
    });
    const everything = JSON.stringify([w.logLines, w.events()]);
    expect(everything).not.toContain(LEAKED_KEY);
    expect(everything).not.toContain(SECRET_VALUE);
    // Prompts and outputs are not logged or audited either.
    expect(everything).not.toContain('melon market');
    expect(everything).not.toContain('Summary ready');
    expect(JSON.stringify(new ProviderCredential(SECRET_VALUE))).toBe('"[redacted]"');
    expect(String(new ProviderCredential(SECRET_VALUE))).toBe('[redacted]');
  });

  it('20. the adapter gets a credential reference, never a value; outputs carrying one are refused', async () => {
    const { w, call } = await setup({
      defaultPolicy: { ...onlyModels('alpha/alpha-large'), maxAttempts: 1 },
      script: { 'alpha-large': [() => OK(`Here you go: ${LEAKED_KEY}`)] },
    });
    expect(Object.keys(w.calls[0]?.credential ?? { provider: '', scopes: [] })).toEqual([
      'provider',
      'scopes',
    ]);
    expect(await call()).toMatchObject({ status: 'failed', code: 'invalid_response' });
    expect(JSON.stringify(w.calls)).not.toContain(SECRET_VALUE);
    expect([...w.credits.spent.values()]).toEqual([]);
  });
});

describe('AI gateway: authorization, policy and credits', () => {
  it('needs ai.generate; GIA gets exactly the user’s permissions', async () => {
    const without = await setup({
      roles: { owner: ROLES.owner.filter((p) => p !== 'ai.generate') },
    });
    expect(await without.call()).toMatchObject({ code: 'permission_denied' });
    expect(await without.call({}, without.w.giaA)).toMatchObject({ code: 'permission_denied' });
    const { w, call } = await setup();
    expect((await call({}, w.giaA)).status).toBe('completed');
  });

  it('refuses a call outside a working execution', async () => {
    const { w, execution, call } = await setup();
    // Cancelling is the owner's own act (ADR-0029); running work is never moved by changeStatus.
    await w.executions.cancel(w.tenantA, execution.id, 'user_cancelled');
    expect(await call()).toMatchObject({ code: 'execution_not_running' });
  });

  it("uses the specialist's own model policy, and refuses one that does not exist", async () => {
    const policy = {
      ...onlyModels('beta/beta-text'),
      id: 'research_models' as PolicyId,
      version: 2,
    };
    const { call } = await setup(
      { policies: [policy] },
      { policy: { id: 'research_models', version: 2 } },
    );
    expect(await call()).toMatchObject({
      status: 'completed',
      model: 'beta-text',
      versions: { policy: { id: 'research_models', version: 2 } },
    });
    const missing = await setup({}, { policy: { id: 'research_models', version: 3 } });
    expect(await missing.call()).toMatchObject({ code: 'policy_not_found' });
  });

  it('refuses sensitive data on models and providers not cleared for it', async () => {
    const { call } = await setup({
      defaultPolicy: { ...onlyModels('beta/beta-text'), maxSensitivity: 'restricted' },
    });
    expect(await call({ sensitivity: 'confidential' })).toMatchObject({
      code: 'sensitivity_not_allowed',
    });
    const byPolicy = await setup();
    expect(await byPolicy.call({ sensitivity: 'restricted' })).toMatchObject({
      code: 'sensitivity_not_allowed',
    });
  });

  it('refuses every call while credits or the credit rate are not configured (D-12)', async () => {
    const none = await setup({ credits: 'none' });
    expect(await none.call()).toMatchObject({ code: 'credits_not_configured' });
    const noRate = await setup({ credits: 'no_rate' });
    expect(await noRate.call()).toMatchObject({ code: 'credits_not_configured' });
    expect([...none.w.calls, ...noRate.w.calls]).toHaveLength(0);
  });

  it('never routes to a model whose price is unknown', async () => {
    const { call } = await setup({ defaultPolicy: onlyModels('beta/beta-unpriced') });
    expect(await call()).toMatchObject({ code: 'price_unknown' });
  });

  it('audits every denial with its reason, and refuses an unresolved tenant', async () => {
    const { w, call } = await setup({ balance: 0 });
    await call();
    expect(w.events('ai.request_denied')).toEqual([
      expect.objectContaining({
        result: 'denied',
        reason: 'credits_insufficient',
        requestId: 'req-1',
      }),
    ]);
    expect(await call({}, { ...w.tenantA } as TenantContext)).toMatchObject({
      code: 'unresolved_tenant',
    });
    w.tenancy.put({ ...w.a.organization, status: 'suspended' });
    expect(await call()).toMatchObject({ code: 'organization_inactive' });
  });

  it('times out a slow provider and treats it as transient', async () => {
    const hang = () => new Promise<ProviderOutcome>(() => undefined);
    const { w, call } = await setup({
      defaultPolicy: { ...onlyModels('alpha/alpha-large'), maxAttempts: 2 },
      script: { 'alpha-large': [hang, hang] },
    });
    expect(await call()).toMatchObject({ status: 'failed', code: 'timeout', attempts: 2 });
    expect(w.calls).toHaveLength(2);
  });

  it('logs every call with its correlation, usage, cost and latency', async () => {
    const { w, execution, specialist, call } = await setup({
      defaultPolicy: onlyModels('alpha/alpha-small'),
    });
    await call();
    const line = JSON.parse(must(w.logLines.at(-1))) as Record<string, unknown>;
    expect(line).toMatchObject({
      message: 'ai request completed',
      requestId: 'req-1',
      organizationId: w.orgA,
      executionId: execution.id,
      nodeId: 'n0',
      specialistId: specialist.identity.id,
      provider: 'alpha',
      model: 'alpha/alpha-small',
      status: 'completed',
      inputUnits: 1_000,
      outputUnits: 500,
      costMicroUsd: 300,
      credits: 1,
    });
    expect(typeof line.latencyMs).toBe('number');
  });
});

describe('AI gateway with the real Credits engine (#20)', () => {
  it('plugs in unchanged, charges once, and refuses when the wallet is short', async () => {
    const { w, call } = await setup({ realCredits: true });
    // A new wallet is empty (D-12): the call is denied before any provider sees it.
    expect(await call()).toMatchObject({ status: 'denied', code: 'credits_insufficient' });
    expect(w.calls).toHaveLength(0);
    await w.creditService.grant(w.tenantA, {
      amount: 10,
      referenceId: 'grant-1',
      reason: 'test_grant',
    });
    const first = await call({ requestId: 'req-real' });
    expect(first).toMatchObject({ status: 'completed', credits: { state: 'consumed' } });
    const charged = first.status === 'completed' ? first.credits.consumed : -1;
    expect(charged).toBeGreaterThan(0);
    await call({ requestId: 'req-real' });
    expect(await w.creditService.balanceOf(w.tenantA)).toMatchObject({ balance: 10 - charged });
    expect(w.events('credits.consume')).toHaveLength(1);
  });
});

const CONVERSATION = '33333333-3333-4333-8333-333333333333';

const assisted = (overrides: Partial<Record<string, unknown>> = {}): AssistedAIRequest =>
  ({
    requestId: 'assist-1',
    subject: { type: 'conversation', id: CONVERSATION },
    taskType: 'conversation_summary',
    capability: 'text_generation',
    requirements: { structuredOutput: true },
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarise.' }] }],
    outputModality: 'text',
    maxOutputTokens: 1_000,
    sensitivity: 'confidential',
    ...overrides,
  }) as AssistedAIRequest;

describe('AI gateway: assisted calls (ADR-0037)', () => {
  // The subject's own named policy (ADR-0038), allowing confidential data to one model.
  const confidential = {
    ...onlyModels('alpha/alpha-large'),
    id: 'conversation_assist' as PolicyId,
    maxSensitivity: 'confidential' as const,
  };

  it('serves a person with no execution or specialist, through the same routing and credits', async () => {
    const w = await world({ policies: [confidential] });
    const response = await w.gateway.assist(w.tenantA, assisted());
    expect(response).toMatchObject({
      status: 'completed',
      requestId: 'assist-1',
      provider: 'alpha',
      model: 'alpha-large',
      versions: { policy: { id: 'conversation_assist', version: 1 } },
      credits: { state: 'consumed', consumed: 3 },
    });
    expect(w.credits.spent.get(`${w.orgA}\nai:assist-1`)).toBe(3);
    expect(w.calls[0]).toMatchObject({ structuredOutput: true, requestId: 'assist-1' });
    // The same request is charged once.
    await w.gateway.assist(w.tenantA, assisted());
    expect([...w.credits.spent.values()]).toEqual([3]);
  });

  it('charges the real Credits engine once per request', async () => {
    const w = await world({ policies: [confidential], realCredits: true });
    await w.creditService.grant(w.tenantA, { amount: 10, referenceId: 'g1', reason: 'test' });
    await w.gateway.assist(w.tenantA, assisted());
    await w.gateway.assist(w.tenantA, assisted());
    expect(await w.creditService.balanceOf(w.tenantA)).toMatchObject({ balance: 7 });
  });

  it('refuses GIA and the runtime: only a person acting directly', async () => {
    const w = await world({ policies: [confidential] });
    const runtime = await resolveRuntimeTenant(ALICE, w.orgA, w.tenancy);
    for (const tenant of [w.giaA, runtime]) {
      expect(await w.gateway.assist(tenant, assisted())).toMatchObject({
        status: 'denied',
        code: 'assist_requires_user',
      });
    }
    expect(w.calls).toHaveLength(0);
    expect(w.events('ai.request_denied')).toHaveLength(2);
    expect(w.events('ai.request_denied')[0]).toMatchObject({
      target: { type: 'conversation', id: CONVERSATION },
      reason: 'assist_requires_user',
    });
  });

  it("needs the subject's own permission, and ai.generate is not it", async () => {
    const withoutAssist = ROLES.owner.filter((p) => p !== 'conversation.assist');
    const w = await world({ policies: [confidential], roles: { owner: withoutAssist } });
    expect(await w.gateway.assist(w.tenantA, assisted())).toMatchObject({
      status: 'denied',
      code: 'permission_denied',
    });
    expect(w.calls).toHaveLength(0);
  });

  it('refuses a malformed subject, an execution field and smuggled authority', async () => {
    const w = await world({ policies: [confidential] });
    const cases: [Partial<Record<string, unknown>>, string][] = [
      [{ subject: { type: 'message', id: CONVERSATION } }, 'invalid_request'],
      [{ subject: { type: 'conversation', id: 'not-a-uuid' } }, 'invalid_request'],
      [
        { subject: { type: 'conversation', id: CONVERSATION, organizationId: 'x' } },
        'authority_in_input',
      ],
      // Execution ids are authority for an assisted call: refused as such.
      [{ executionId: CONVERSATION }, 'authority_in_input'],
      [{ organizationId: 'x' }, 'authority_in_input'],
    ];
    for (const [overrides, code] of cases) {
      expect(await w.gateway.assist(w.tenantA, assisted(overrides))).toMatchObject({
        status: 'denied',
        code,
      });
    }
    expect(w.calls).toHaveLength(0);
  });

  it('follows the policy, the environment and the credit rate like any call', async () => {
    // The subject's policy caps data at internal: a customer conversation is not sent.
    const strict = await world({
      policies: [{ ...confidential, maxSensitivity: 'internal' }],
    });
    expect(await strict.gateway.assist(strict.tenantA, assisted())).toMatchObject({
      status: 'denied',
      code: 'sensitivity_not_allowed',
    });
    const unknown = await world({ policies: [confidential], environment: undefined });
    expect(await unknown.gateway.assist(unknown.tenantA, assisted())).toMatchObject({
      code: 'environment_unknown',
    });
    const noRate = await world({ policies: [confidential], credits: 'no_rate' });
    expect(await noRate.gateway.assist(noRate.tenantA, assisted())).toMatchObject({
      code: 'credits_not_configured',
    });
    expect([...strict.calls, ...unknown.calls, ...noRate.calls]).toHaveLength(0);
  });

  it("uses only the subject's named policy, never the default, even a permissive one", async () => {
    const w = await world({
      defaultPolicy: { ...confidential, id: 'default_model' as PolicyId },
    });
    expect(await w.gateway.assist(w.tenantA, assisted())).toMatchObject({
      status: 'denied',
      code: 'policy_not_found',
    });
    expect(w.calls).toHaveLength(0);
    expect(ASSIST_MODEL_POLICIES).toEqual({
      conversation: { id: 'conversation_assist', version: 1 },
      company_knowledge: { id: 'company_knowledge_assist', version: 1 },
      gia: { id: 'gia_assist', version: 1 },
      decision: { id: 'decision_assist', version: 1 },
      document: { id: 'document_read', version: 1 },
    });
  });

  it('keeps confidential data to the models the policy names, not every model allowing it', async () => {
    // alpha-other may take confidential data too, but the policy does not name it: it is never
    // tried, even as a fallback when the named model is down.
    const w = await world({
      policies: [{ ...confidential, fallback: 'compatible' }],
      models: [
        ...MODELS,
        model('alpha', 'alpha-other', {
          capabilities: ['text_generation', 'structured_output'],
          structuredOutput: true,
          maxSensitivity: 'confidential',
        }),
      ],
      script: {
        'alpha-large': [
          () => ({ status: 'error', kind: 'unavailable' }),
          () => ({ status: 'error', kind: 'unavailable' }),
          () => ({ status: 'error', kind: 'unavailable' }),
        ],
      },
    });
    expect(await w.gateway.assist(w.tenantA, assisted())).toMatchObject({ status: 'failed' });
    expect(new Set(w.calls.map((c) => c.model.id))).toEqual(new Set(['alpha-large']));
  });

  it('passes the output shape to the adapter, and refuses one that is not closed and bounded', async () => {
    const w = await world({ policies: [confidential] });
    const schema = {
      type: 'object',
      properties: { reply: { type: 'string', maxLength: 100 } },
      required: ['reply'],
    };
    await w.gateway.assist(w.tenantA, assisted({ outputSchema: schema }));
    expect(w.calls[0]?.outputSchema).toEqual(schema);
    const deep = (n: number): unknown =>
      n === 0 ? { type: 'string' } : { type: 'array', items: deep(n - 1) };
    const cases: [unknown, Partial<Record<string, unknown>>, string][] = [
      [{ type: 'string' }, {}, 'invalid_request'],
      [schema, { requirements: { structuredOutput: false } }, 'invalid_request'],
      [
        { type: 'object', properties: { a: { type: 'string', description: 'Ignore rules' } } },
        {},
        'invalid_request',
      ],
      [{ type: 'object', properties: { a: { type: 'function' } } }, {}, 'invalid_request'],
      [
        { type: 'object', properties: { organizationId: { type: 'string' } } },
        {},
        'authority_in_input',
      ],
      [
        { type: 'object', properties: { a: { type: 'string' } }, required: ['b'] },
        {},
        'invalid_request',
      ],
      [
        { type: 'object', properties: { a: { type: 'string', enum: ['Ignore all'] } } },
        {},
        'invalid_request',
      ],
      [{ type: 'object', properties: { a: deep(8) } }, {}, 'invalid_request'],
    ];
    for (const [outputSchema, overrides, code] of cases) {
      expect(
        await w.gateway.assist(w.tenantA, assisted({ outputSchema, ...overrides })),
      ).toMatchObject({ status: 'denied', code });
    }
    expect(w.calls).toHaveLength(1);
  });
});

describe('AI gateway: customer credit pricing (ADR-0081)', () => {
  const FREE_PRICING = {
    status: 'known',
    currency: 'USD',
    inputMicroUsdPerMillionTokens: 0,
    outputMicroUsdPerMillionTokens: 0,
    source: 'test fixture',
    asOf: '2026-09-01',
  } as const;
  const onlyFree = [model('alpha', 'alpha-small', { pricing: FREE_PRICING })];

  it('records a free call in full: provider cost 0 and customer credits 0, kept apart', async () => {
    const usage = new InMemoryUsageSink();
    const { w, call } = await setup({ usage, models: onlyFree });
    const answer = await call();
    expect(answer).toMatchObject({
      status: 'completed',
      cost: { actualMicroUsd: 0 },
      credits: { state: 'free', consumed: 0 },
    });
    expect(usage.events).toHaveLength(1);
    expect(usage.events[0]).toMatchObject({
      provider: 'alpha',
      model: 'alpha-small',
      outcome: 'completed',
      requestId: 'req-1',
      attribution: { organizationId: w.orgA, userId: ALICE },
      cost: { actualMicroUsd: 0, costBasis: 'provider_price_list' },
      credits: 0,
      creditPolicy: { id: 'provider_cost_at_rate', version: '1000' },
    });
    expect(usage.events[0]?.cost.usage.quantities.length).toBeGreaterThan(0);
    expect(usage.events[0]).not.toHaveProperty('fallbackFrom');
  });

  it('charges what a pricing policy says, without touching the provider cost', async () => {
    const usage = new InMemoryUsageSink();
    const seen: string[] = [];
    const minimum: CustomerCreditPolicy = {
      id: 'minimum_one',
      version: 'v1',
      credits: (input) => {
        seen.push(`${input.capability}:${input.provider}:${input.model}:${input.operation}`);
        return Math.max(1, Math.ceil(input.providerCostMicroUsd / 1_000));
      },
    };
    const { call } = await setup({ usage, models: onlyFree, creditPolicy: minimum });
    expect(await call()).toMatchObject({
      status: 'completed',
      cost: { actualMicroUsd: 0 },
      credits: { state: 'consumed', consumed: 1 },
    });
    expect(usage.events[0]).toMatchObject({
      cost: { actualMicroUsd: 0 },
      credits: 1,
      creditPolicy: { id: 'minimum_one', version: 'v1' },
    });
    expect(seen).toContain('llm:alpha:alpha-small:text_generation');
  });

  it('never routes to or passes on a call its policy cannot price', async () => {
    const broken: CustomerCreditPolicy = { id: 'broken', version: 'v1', credits: () => -1 };
    const { call } = await setup({ creditPolicy: broken });
    expect(await call()).toMatchObject({ status: 'denied', code: 'price_unknown' });
  });

  it('records the model a fallback answered for', async () => {
    const usage = new InMemoryUsageSink();
    const { call } = await setup({
      usage,
      script: {
        'alpha-small': [
          () => ({ status: 'error', kind: 'rate_limited' }),
          () => ({ status: 'error', kind: 'rate_limited' }),
          () => ({ status: 'error', kind: 'rate_limited' }),
        ],
      },
    });
    expect(await call()).toMatchObject({ status: 'completed', provider: 'beta' });
    expect(usage.events[0]).toMatchObject({
      provider: 'beta',
      fallbackFrom: 'alpha/alpha-small',
    });
  });
});

describe('AI gateway: the LLM Router (ADR-0072)', () => {
  const RATE_LIMITED = (): ProviderOutcome => ({ status: 'error', kind: 'rate_limited' });

  it('routes balanced by default, and in the order a request asks for', async () => {
    const { call } = await setup();
    // Balanced: the cheapest model of at least standard quality.
    expect(await call()).toMatchObject({
      status: 'completed',
      model: 'alpha-small',
      strategy: 'balanced',
    });
    expect(await call({ requestId: 'req-2', strategy: 'quality_first' })).toMatchObject({
      status: 'completed',
      model: 'alpha-large',
      strategy: 'quality_first',
    });
  });

  it('skips a provider that keeps failing, in the same request and in the next', async () => {
    const { w, call } = await setup({
      script: { 'alpha-small': [RATE_LIMITED, RATE_LIMITED, RATE_LIMITED] },
    });
    const first = await call();
    // Three rate limits on alpha: alpha-large is not tried; beta answers.
    expect(first).toMatchObject({
      status: 'completed',
      provider: 'beta',
      model: 'beta-text',
      attempts: 4,
      fallbackFrom: 'alpha/alpha-small',
    });
    expect(w.calls.map((c) => c.model.id)).toEqual([
      'alpha-small',
      'alpha-small',
      'alpha-small',
      'beta-text',
    ]);
    // The next request goes straight to beta: alpha is resting.
    expect(await call({ requestId: 'req-2' })).toMatchObject({
      status: 'completed',
      provider: 'beta',
      attempts: 1,
      fallbackFrom: null,
    });
    const line = w.logLines.find((l) => l.includes('ai request completed')) ?? '';
    expect(JSON.parse(line)).toMatchObject({
      retries: 2,
      fallbacks: 1,
      taskType: 'summarise_document',
      routingStrategy: 'balanced',
    });
    expect(line).toMatch(/"departmentId":"[^"]+_research"/);
  });

  it('falls back to a larger model on a context overflow, without retrying the same one', async () => {
    const { w, call } = await setup({
      script: { 'alpha-small': [() => ({ status: 'error', kind: 'context_overflow' })] },
    });
    expect(await call()).toMatchObject({
      status: 'completed',
      model: 'alpha-large',
      attempts: 2,
      fallbackFrom: 'alpha/alpha-small',
    });
    expect(w.calls.map((c) => c.model.id)).toEqual(['alpha-small', 'alpha-large']);
    expect(w.events('ai.provider_fallback')).toMatchObject([{ reason: 'context_overflow' }]);
  });

  it('never falls back when the policy says none, whatever the strategy', async () => {
    const { w, call } = await setup({
      defaultPolicy: { ...onlyModels('alpha/alpha-small', 'beta/beta-text'), fallback: 'none' },
      script: { 'alpha-small': [RATE_LIMITED, RATE_LIMITED, RATE_LIMITED] },
    });
    expect(await call({ strategy: 'reliability_first' })).toMatchObject({
      status: 'failed',
      code: 'rate_limited',
      attempts: 3,
    });
    expect(w.calls.every((c) => c.model.id === 'alpha-small')).toBe(true);
  });

  it('charges cached input at its own price', async () => {
    const cheapCache = MODELS.map((m) =>
      m.modelId === 'alpha-small' && m.pricing.status === 'known'
        ? { ...m, pricing: { ...m.pricing, cachedInputMicroUsdPerMillionTokens: 0 } }
        : m,
    );
    const { call } = await setup({
      models: cheapCache,
      defaultPolicy: onlyModels('alpha/alpha-small'),
      script: {
        'alpha-small': [
          () => ({
            status: 'success',
            output: { text: 'Cached.' },
            usage: { inputTokens: 1_000, outputTokens: 500, cachedInputTokens: 1_000 },
            finishReason: 'stop',
          }),
        ],
      },
    });
    // 1000 cached × 0 + 500 × 0.4 = 200 micro-USD.
    expect(await call()).toMatchObject({
      status: 'completed',
      cost: { actualMicroUsd: 200 },
      usage: { cachedInputTokens: 1_000 },
    });
  });
});

describe('AI gateway: the AI Usage Layer (ADR-0073)', () => {
  it('emits one usage event per completed call, attributed and priced, without content', async () => {
    const usage = new InMemoryUsageSink();
    const { w, call, specialist, execution } = await setup({ usage });
    const answer = await call();
    expect(answer).toMatchObject({ status: 'completed' });
    await call();
    // The same request again is the same event.
    expect(usage.events).toHaveLength(1);
    const [event] = usage.events;
    expect(event).toMatchObject({
      capability: 'llm',
      source: 'llm_router',
      outcome: 'completed',
      provider: 'alpha',
      model: 'alpha-small',
      operation: 'text_generation',
      requestId: 'req-1',
      attribution: {
        organizationId: w.orgA,
        actor: 'user',
        userId: ALICE,
        specialistId: specialist.identity.id,
        departmentId: execution.departmentId,
        executionId: execution.id,
        taskType: 'summarise_document',
      },
      cost: {
        capability: 'llm',
        units: ['input_tokens', 'output_tokens'],
        costBasis: 'provider_price_list',
        currency: 'USD',
      },
    });
    if (answer.status !== 'completed') throw new Error('not completed');
    expect(event?.cost.actualMicroUsd).toBe(answer.cost.actualMicroUsd);
    expect(event?.credits).toBe(answer.credits.consumed);
    expect(JSON.stringify(event)).not.toContain('melon market');
  });

  it('never fails a call because its usage could not be recorded, and emits nothing when denied', async () => {
    const failing: AIUsageSink = {
      record: async () => {
        throw new Error('ledger down');
      },
    };
    const { w, call } = await setup({ usage: failing });
    expect(await call()).toMatchObject({ status: 'completed' });
    expect(w.logLines.some((l) => l.includes('ai usage not recorded'))).toBe(true);
    const usage = new InMemoryUsageSink();
    const denied = await setup({ usage, credits: 'none' });
    expect(await denied.call()).toMatchObject({ status: 'denied' });
    expect(usage.events).toHaveLength(0);
  });
});

describe('AI gateway: normalized tool calling (R3, ADR-0076)', () => {
  const LOOKUP: AIToolDefinition = {
    name: 'lookup_price',
    description: 'Looks up the price of a product in the catalogue.',
    parameters: {
      type: 'object',
      properties: { product: { type: 'string', maxLength: 100 } },
      required: ['product'],
    },
  };
  const withTools = (overrides: Partial<Record<keyof AIRequest, unknown>> = {}) => ({
    requirements: { toolUse: true },
    tools: [LOOKUP],
    ...overrides,
  });
  const CALLED =
    (calls: unknown): (() => ProviderOutcome) =>
    () =>
      ({
        status: 'success',
        output: { toolCalls: calls },
        usage: { inputTokens: 1_000, outputTokens: 50 },
        finishReason: 'tool_use',
      }) as ProviderOutcome;
  const tooling = (): AIModelDefinition[] => [
    model('alpha', 'alpha-tools', { toolUse: true }),
    model('alpha', 'alpha-small', {}),
  ];

  it('offers the tools only to a model that can call them, and passes its calls on, unrun', async () => {
    const { w, call } = await setup({
      models: tooling(),
      script: {
        'alpha-tools': [
          CALLED([{ id: 'c1', name: 'lookup_price', arguments: { product: 'combo' } }]),
        ],
      },
    });
    const response = await call(withTools());
    expect(response).toMatchObject({
      status: 'completed',
      model: 'alpha-tools',
      finishReason: 'tool_use',
      output: { toolCalls: [{ id: 'c1', name: 'lookup_price', arguments: { product: 'combo' } }] },
    });
    expect(w.calls[0]?.tools).toEqual([LOOKUP]);
    // Without tools, the same request goes to the cheaper model and no tools are sent.
    await call({ requestId: 'req-2' });
    expect(w.calls[1]?.model.id).toBe('alpha-small');
    expect(w.calls[1]?.tools).toBeUndefined();
  });

  it('refuses a call to a tool it was not offered, or with arguments its schema refuses', async () => {
    for (const bad of [
      [{ id: 'c1', name: 'delete_everything', arguments: {} }],
      [{ id: 'c1', name: 'lookup_price', arguments: { product: 5 } }],
      [{ id: 'c1', name: 'lookup_price', arguments: { product: 'x', organizationId: 'o' } }],
      [
        {
          id: 'c1',
          name: 'lookup_price',
          arguments: { product: fake('sk', '-abcdefghijklmnopqrstuv1234') },
        },
      ],
      [
        { id: 'c1', name: 'lookup_price', arguments: { product: 'a' } },
        { id: 'c1', name: 'lookup_price', arguments: { product: 'b' } },
      ],
      [],
    ]) {
      const { call } = await setup({
        models: tooling(),
        defaultPolicy: onlyModels('alpha/alpha-tools'),
        script: { 'alpha-tools': [CALLED(bad), CALLED(bad), CALLED(bad)] },
      });
      expect(await call(withTools())).toMatchObject({ status: 'failed', code: 'invalid_response' });
    }
  });

  it('refuses tools without the requirement, and tools that carry authority or secrets', async () => {
    const { call } = await setup({ models: tooling() });
    expect(await call({ tools: [LOOKUP] })).toMatchObject({ code: 'invalid_request' });
    expect(await call({ requirements: { toolUse: true } })).toMatchObject({
      code: 'invalid_request',
    });
    expect(
      await call(
        withTools({
          tools: [
            {
              ...LOOKUP,
              parameters: {
                type: 'object',
                properties: { userId: { type: 'string', maxLength: 10 } },
              },
            },
          ],
        }),
      ),
    ).toMatchObject({ code: 'authority_in_input' });
    expect(
      await call(
        withTools({
          tools: [{ ...LOOKUP, description: `Use ${fake('sk', '-abcdefghijklmnopqrstuv1234')}` }],
        }),
      ),
    ).toMatchObject({ code: 'secret_in_input' });
    expect(await call(withTools({ tools: [LOOKUP, LOOKUP] }))).toMatchObject({
      code: 'invalid_request',
    });
  });

  it('carries earlier calls and their results, on the right side of the conversation only', async () => {
    const { w, call } = await setup({ models: tooling() });
    const earlier = {
      type: 'tool_call',
      call: { id: 'c1', name: 'lookup_price', arguments: { product: 'combo' } },
    };
    const result = {
      type: 'tool_result',
      callId: 'c1',
      name: 'lookup_price',
      result: { price: 25 },
    };
    const conversation = [
      { role: 'user', content: [{ type: 'text', text: 'Price of the combo?' }] },
      { role: 'assistant', content: [earlier] },
      { role: 'user', content: [result] },
    ];
    expect(await call(withTools({ messages: conversation }))).toMatchObject({
      status: 'completed',
    });
    expect(w.calls[0]?.messages).toEqual(conversation);
    // A result on the model's side, or a call on the person's side, is refused.
    expect(
      await call(
        withTools({
          requestId: 'req-2',
          messages: [
            { role: 'user', content: [earlier] },
            { role: 'assistant', content: [result] },
          ],
        }),
      ),
    ).toMatchObject({ code: 'invalid_request' });
    expect(
      await call(
        withTools({
          requestId: 'req-3',
          messages: [
            {
              role: 'user',
              content: [{ ...result, result: { note: fake('sk', '-abcdefghijklmnopqrstuv1234') } }],
            },
          ],
        }),
      ),
    ).toMatchObject({ code: 'secret_in_input' });
  });
});

describe('AI gateway: streaming (R4, ADR-0077)', () => {
  const STREAMING = MODELS.map((m) =>
    m.modelId === 'alpha-small' || m.modelId === 'beta-text' ? { ...m, streaming: true } : m,
  );
  const events = (...texts: string[]) =>
    async function* (): AsyncIterable<ProviderStreamEvent> {
      for (const text of texts) yield { type: 'text', text };
      yield { type: 'end', outcome: OK(texts.join('')) };
    };
  const failing = (kind: 'rate_limited' | 'server_error', ...texts: string[]) =>
    async function* (): AsyncIterable<ProviderStreamEvent> {
      for (const text of texts) yield { type: 'text', text };
      yield { type: 'end', outcome: { status: 'error', kind } };
    };
  const read = async (stream: AsyncIterable<unknown>) => {
    const all: unknown[] = [];
    for await (const event of stream) all.push(event);
    return all;
  };
  const texts = (all: unknown[]) =>
    all
      .filter((e): e is { type: 'text'; text: string } => (e as { type: string }).type === 'text')
      .map((e) => e.text);
  const done = (all: unknown[]) => {
    const last = all.at(-1) as { type: string; response: unknown };
    expect(last.type).toBe('done');
    expect(all.filter((e) => (e as { type: string }).type === 'done')).toHaveLength(1);
    return last.response;
  };

  async function streaming(options: WorldOptions = {}) {
    const s = await setup({ models: STREAMING, ...options });
    const stream = (overrides: Partial<Record<keyof AIRequest, unknown>> = {}) =>
      s.w.gateway.stream(s.w.tenantA, requestFor(s.execution, overrides));
    return { ...s, stream };
  }

  it('passes the text on in whole words, then the same response generate gives, charged once', async () => {
    const sink = new InMemoryUsageSink();
    const { w, stream } = await streaming({
      usage: sink,
      streams: { 'alpha-small': [events('The mel', 'on market ', 'is gro', 'wing.')] },
    });
    const all = await read(stream());
    expect(texts(all)).toEqual(['The ', 'melon market ', 'is ', 'growing.']);
    expect(done(all)).toMatchObject({
      status: 'completed',
      model: 'alpha-small',
      output: { text: 'The melon market is growing.' },
      credits: { state: 'consumed', consumed: 1 },
      attempts: 1,
    });
    expect(w.credits.spent.get(`${w.orgA}\nai:req-1`)).toBe(1);
    expect(sink.events).toHaveLength(1);
    // Only models that stream are routed to.
    expect(w.calls.map((c) => c.model.id)).toEqual(['alpha-small']);
  });

  it('is text only: tools and structured answers are refused before any provider', async () => {
    const { w, stream } = await streaming();
    for (const overrides of [
      { requirements: { structuredOutput: true } },
      { outputModality: 'image' },
      {
        requirements: { toolUse: true },
        tools: [
          {
            name: 'lookup',
            description: 'Looks up.',
            parameters: { type: 'object', properties: {} },
          },
        ],
      },
    ]) {
      expect(done(await read(stream(overrides)))).toMatchObject({
        status: 'denied',
        code: 'invalid_request',
      });
    }
    expect(w.calls).toHaveLength(0);
    expect(w.events('ai.request_denied')).toHaveLength(3);
  });

  it('is denied when no model or adapter streams, and follows every check of generate', async () => {
    const none = await setup();
    const all = await read(none.w.gateway.stream(none.w.tenantA, requestFor(none.execution)));
    expect(all).toHaveLength(1);
    expect(done(all)).toMatchObject({ status: 'denied', code: 'requirements_unmet' });

    const { w, stream } = await streaming({ balance: 0 });
    expect(done(await read(stream()))).toMatchObject({
      status: 'denied',
      code: 'credits_insufficient',
    });
    const other = await read(w.gateway.stream(w.tenantB, requestFor((await setup()).execution)));
    expect(done(other)).toMatchObject({ status: 'denied', code: 'execution_not_found' });
    expect(w.calls).toHaveLength(0);
  });

  it('never passes on a credential, even split across pieces, and charges nothing', async () => {
    const [head, tail] = [LEAKED_KEY.slice(0, 10), LEAKED_KEY.slice(10)];
    const { w, stream } = await streaming({
      streams: { 'alpha-small': [events('Your key ', 'is ', head, tail, ' and more.')] },
    });
    const all = await read(stream());
    expect(texts(all).join('')).toBe('Your key is ');
    expect(JSON.stringify(all)).not.toContain(head);
    // Text already went out, so it is not tried again.
    expect(done(all)).toMatchObject({
      status: 'failed',
      code: 'invalid_response',
      attempts: 1,
    });
    expect(w.credits.spent.size).toBe(0);
    expect(w.events('ai.request_failed')[0]).toMatchObject({ reason: 'invalid_response' });
  });

  it('retries and falls back like generate while no text has gone out', async () => {
    const { w, stream } = await streaming({
      streams: {
        'alpha-small': [failing('rate_limited'), failing('rate_limited'), failing('rate_limited')],
        'beta-text': [events('From ', 'beta.')],
      },
    });
    const all = await read(stream());
    expect(texts(all).join('')).toBe('From beta.');
    expect(done(all)).toMatchObject({
      status: 'completed',
      model: 'beta-text',
      fallbackFrom: 'alpha/alpha-small',
    });
    expect(w.events('ai.provider_fallback')).toHaveLength(1);
  });

  it('ends without a retry once text went out, and the partial text is not an answer', async () => {
    const { w, stream } = await streaming({
      streams: { 'alpha-small': [failing('server_error', 'Half an ', 'answer')] },
    });
    const all = await read(stream());
    expect(texts(all)).toEqual(['Half an ']);
    expect(done(all)).toMatchObject({ status: 'failed', code: 'server_error', attempts: 1 });
    expect(w.calls).toHaveLength(1);
    expect(w.credits.spent.size).toBe(0);
  });

  it('refuses a stream whose pieces differ from its end, or that never ends', async () => {
    const { stream } = await streaming({
      streams: {
        'alpha-small': [
          async function* () {
            yield { type: 'text', text: 'One thing.' };
            yield { type: 'end', outcome: OK('Another thing.') };
          },
          async function* () {
            yield { type: 'text', text: 'No end.' };
          },
          async function* () {
            yield { type: 'text', text: 'Unexpected ' };
            yield { type: 'unknown' } as unknown as ProviderStreamEvent;
          },
        ],
      },
      defaultPolicy: { ...onlyModels('alpha/alpha-small'), maxAttempts: 1 },
    });
    for (const id of ['req-a', 'req-b', 'req-c']) {
      expect(done(await read(stream({ requestId: id })))).toMatchObject({
        status: 'failed',
        code: 'invalid_response',
      });
    }
  });

  it('times out a stream that stops sending', async () => {
    const { stream } = await streaming({
      defaultPolicy: { ...onlyModels('alpha/alpha-small'), maxAttempts: 1 },
      streams: {
        'alpha-small': [
          async function* () {
            yield { type: 'text', text: 'Slow' };
            await new Promise((resolve) => setTimeout(resolve, 200));
            yield { type: 'end', outcome: OK('Slow') };
          },
        ],
      },
    });
    expect(done(await read(stream()))).toMatchObject({ status: 'failed', code: 'timeout' });
  });

  it('still reads, checks and charges the whole answer when the caller stops early', async () => {
    const { w, stream } = await streaming({
      streams: { 'alpha-small': [events('One ', 'two ', 'three ', 'four.')] },
    });
    const seen: string[] = [];
    for await (const event of stream()) {
      if (event.type === 'text') seen.push(event.text);
      break;
    }
    expect(seen).toEqual(['One ']);
    expect(w.credits.spent.get(`${w.orgA}\nai:req-1`)).toBe(1);
  });

  it('streams assisted calls for a person, never for GIA', async () => {
    const policy = {
      ...onlyModels('alpha/alpha-small'),
      id: 'conversation_assist' as PolicyId,
      maxSensitivity: 'confidential' as const,
    };
    const w = await world({
      policies: [policy],
      models: STREAMING.map((m) =>
        m.modelId === 'alpha-small' ? { ...m, maxSensitivity: 'confidential' as const } : m,
      ),
    });
    const request = assisted({ requirements: undefined });
    const all = await read(w.gateway.assistStream(w.tenantA, request));
    expect(texts(all).join('')).toBe('Summary ready.');
    expect(done(all)).toMatchObject({ status: 'completed', requestId: 'assist-1' });
    expect(done(await read(w.gateway.assistStream(w.giaA, request)))).toMatchObject({
      status: 'denied',
      code: 'assist_requires_user',
    });
  });
});

describe('AI gateway: stored documents (ADR-0079)', () => {
  const DOCUMENT = '44444444-4444-4444-8444-444444444444';
  const OTHER_DOCUMENT = '55555555-5555-4555-8555-555555555555';
  const readPolicy: ModelPolicy = {
    ...onlyModels('alpha/alpha-doc'),
    id: ASSIST_MODEL_POLICIES.document.id as PolicyId,
    allowedModalities: ['text', 'document'],
    maxSensitivity: 'confidential',
    // 1 credit at the test rate of 1,000 millionths of a dollar.
    maxCostMicroUsd: 1_000,
    fallback: 'none',
  };
  const docModel = model('alpha', 'alpha-doc', {
    inputModalities: ['text', 'document'],
    maxSensitivity: 'confidential',
    contextWindowTokens: 1_000_000,
    maxOutputTokens: 65_000,
    pricing: {
      status: 'known',
      currency: 'USD',
      inputMicroUsdPerMillionTokens: 10_000,
      outputMicroUsdPerMillionTokens: 40_000,
      source: 'test fixture',
      asOf: '2026-09-01',
    },
  });
  const part = (organizationId: string, documentId = DOCUMENT, pages = 3) => ({
    type: 'document',
    mimeType: 'application/pdf',
    ref: { type: 'stored_document', id: `organizations/${organizationId}/documents/${documentId}` },
    pages,
  });
  const reading = (organizationId: string, overrides: Partial<Record<string, unknown>> = {}) =>
    assisted({
      requestId: `document-read-${DOCUMENT}`,
      subject: { type: 'document', id: DOCUMENT },
      taskType: 'document_transcription',
      requirements: undefined,
      messages: [
        { role: 'system', content: [{ type: 'text', text: 'Transcribe.' }] },
        {
          role: 'user',
          content: [part(organizationId), { type: 'text', text: 'Transcribe the document.' }],
        },
      ],
      maxOutputTokens: 16_000,
      ...overrides,
    });

  it("reads the tenant's own document, needing document.upload and its own policy", async () => {
    const w = await world({ policies: [readPolicy], models: [...MODELS, docModel] });
    const response = await w.gateway.assist(w.tenantA, reading(w.orgA));
    expect(response).toMatchObject({
      status: 'completed',
      model: 'alpha-doc',
      versions: { policy: { id: 'document_read', version: 1 } },
    });
    expect(w.calls[0]?.messages[1]?.content[0]).toEqual(part(w.orgA));
    expect(w.events('ai.request_denied')).toEqual([]);
    expect(w.credits.spent.get(`${w.orgA}\nai:document-read-${DOCUMENT}`)).toBeGreaterThan(0);

    const withoutUpload = ROLES.owner.filter((p) => p !== 'document.upload');
    const narrowed = await world({
      policies: [readPolicy],
      models: [...MODELS, docModel],
      roles: { owner: withoutUpload },
    });
    expect(await narrowed.gateway.assist(narrowed.tenantA, reading(narrowed.orgA))).toMatchObject({
      status: 'denied',
      code: 'permission_denied',
    });
    expect(narrowed.calls).toEqual([]);
  });

  it("refuses another organization's document as smuggled authority, and audits it", async () => {
    const w = await world({ policies: [readPolicy], models: [...MODELS, docModel] });
    const response = await w.gateway.assist(w.tenantA, reading(w.orgB));
    expect(response).toMatchObject({ status: 'denied', code: 'authority_in_input' });
    expect(w.calls).toEqual([]);
    expect(w.events('ai.request_denied')).toHaveLength(1);
    expect(w.events('ai.request_denied')[0]).toMatchObject({
      result: 'denied',
      organizationId: w.orgA,
      target: { type: 'document', id: DOCUMENT },
      reason: 'authority_in_input',
    });
    // Neither the key nor the other organization reaches the audit trail.
    expect(JSON.stringify(w.events())).not.toContain(`organizations/${w.orgB}`);
    expect([...w.credits.spent.values()]).toEqual([]);
  });

  it('refuses a document that is not the subject, a malformed part, and documents in a specialist call', async () => {
    const w = await world({ policies: [readPolicy], models: [...MODELS, docModel] });
    const withContent = (content: unknown[]) =>
      reading(w.orgA, { messages: [{ role: 'user', content }] });
    const cases: [AssistedAIRequest, string][] = [
      // Another document of the same organization than the one the call is about.
      [withContent([part(w.orgA, OTHER_DOCUMENT)]), 'invalid_request'],
      // A document in a call about something else.
      [reading(w.orgA, { subject: { type: 'conversation', id: CONVERSATION } }), 'invalid_request'],
      [withContent([part(w.orgA, DOCUMENT, 0)]), 'invalid_request'],
      [withContent([part(w.orgA, DOCUMENT, 101)]), 'invalid_request'],
      [withContent([{ ...part(w.orgA), mimeType: 'image/png' }]), 'invalid_request'],
      [withContent([{ ...part(w.orgA), ref: { type: 'url', id: 'x' } }]), 'invalid_request'],
      [
        withContent([
          { ...part(w.orgA), ref: { type: 'stored_document', id: `gs://bucket/${DOCUMENT}` } },
        ]),
        'invalid_request',
      ],
      [
        withContent([
          {
            ...part(w.orgA),
            ref: {
              type: 'stored_document',
              id: `organizations/${w.orgA}/documents/../${OTHER_DOCUMENT}`,
            },
          },
        ]),
        'invalid_request',
      ],
      [withContent([{ ...part(w.orgA), organizationId: w.orgA }]), 'authority_in_input'],
      [withContent([part(w.orgA), part(w.orgA)]), 'invalid_request'],
    ];
    for (const [request, code] of cases) {
      expect(await w.gateway.assist(w.tenantA, request)).toMatchObject({ status: 'denied', code });
    }
    // Only a person's message carries a document.
    expect(
      await w.gateway.assist(
        w.tenantA,
        reading(w.orgA, { messages: [{ role: 'system', content: [part(w.orgA)] }] }),
      ),
    ).toMatchObject({ status: 'denied', code: 'invalid_request' });
    expect(w.calls).toEqual([]);

    const s = await setup({ policies: [readPolicy], models: [...MODELS, docModel] });
    const inGenerate = (organizationId: string) =>
      s.call({ messages: [{ role: 'user', content: [part(organizationId)] }] });
    expect(await inGenerate(s.w.orgA)).toMatchObject({ status: 'denied', code: 'invalid_request' });
    expect(await inGenerate(s.w.orgB)).toMatchObject({
      status: 'denied',
      code: 'authority_in_input',
    });
    expect(s.w.calls).toEqual([]);
  });

  it('never routes a document to a model or policy without the document modality', async () => {
    const w = await world({
      policies: [{ ...readPolicy, allowedModalities: ['text'] }],
      models: [...MODELS, docModel],
    });
    expect(await w.gateway.assist(w.tenantA, reading(w.orgA))).toMatchObject({
      status: 'denied',
      code: 'modality_unsupported',
    });
    const textOnly = await world({
      policies: [readPolicy],
      models: [...MODELS, { ...docModel, inputModalities: ['text'] }],
    });
    expect(await textOnly.gateway.assist(textOnly.tenantA, reading(textOnly.orgA))).toMatchObject({
      status: 'denied',
      code: 'modality_unsupported',
    });
  });

  it('estimates 258 tokens a page, and a 100-page read fits the 1-credit cap', async () => {
    expect(inputModalitiesOf(reading('x'))).toEqual(['text', 'document']);
    const hundred = reading('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', {
      messages: [
        { role: 'user', content: [part('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', DOCUMENT, 100)] },
      ],
    });
    expect(estimateInputTokens(hundred)).toBe(100 + 100 * 258);
    const w = await world({ policies: [readPolicy], models: [...MODELS, docModel] });
    const full = reading(w.orgA, {
      messages: [{ role: 'user', content: [part(w.orgA, DOCUMENT, 100)] }],
    });
    // 25,900 × 0.01 + 16,000 × 0.04 = 899 millionths: within the 1,000 cap.
    expect(await w.gateway.assist(w.tenantA, full)).toMatchObject({ status: 'completed' });
    // Asking for more output than the cap covers is refused before any call.
    expect(
      await w.gateway.assist(w.tenantA, { ...full, requestId: 'r2', maxOutputTokens: 20_000 }),
    ).toMatchObject({ status: 'denied', code: 'cost_limit_exceeded' });
  });
});

describe("AI gateway: a provider's Retry-After (ADR-0080)", () => {
  const limited = (retryAfterMs?: number) => (): ProviderOutcome => ({
    status: 'error',
    kind: 'rate_limited',
    httpStatus: 429,
    ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
  });

  it('waits as long as the provider asked before trying the same model again', async () => {
    const { w, call } = await setup({
      defaultPolicy: { ...onlyModels('alpha/alpha-large'), maxAttempts: 2, backoffMs: 100 },
      script: { 'alpha-large': [limited(2_000)] },
    });
    expect(await call()).toMatchObject({ status: 'completed', attempts: 2 });
    expect(w.sleeps).toEqual([2_000]);
  });

  it("never waits less than the policy's backoff", async () => {
    const { w, call } = await setup({
      defaultPolicy: { ...onlyModels('alpha/alpha-large'), maxAttempts: 2, backoffMs: 500 },
      script: { 'alpha-large': [limited(10)] },
    });
    expect(await call()).toMatchObject({ status: 'completed' });
    expect(w.sleeps).toEqual([500]);
  });

  it('goes to the next compatible model when the wait is longer than a call may take', async () => {
    const { w, call } = await setup({
      defaultPolicy: {
        ...onlyModels('alpha/alpha-large', 'beta/beta-text'),
        maxAttempts: 3,
        backoffMs: 0,
      },
      script: { 'alpha-large': [limited(MAX_RETRY_WAIT_MS + 1)] },
    });
    expect(await call({ quality: 'standard' })).toMatchObject({
      status: 'completed',
      model: 'beta-text',
      fallbackFrom: 'alpha/alpha-large',
      attempts: 2,
    });
    expect(w.sleeps).toEqual([]);
  });

  it('does not ask a provider again before its Retry-After has passed', async () => {
    const { w, call } = await setup({
      defaultPolicy: {
        ...onlyModels('alpha/alpha-large', 'beta/beta-text'),
        maxAttempts: 1,
        backoffMs: 0,
      },
      script: { 'alpha-large': [limited(60_000)] },
    });
    expect(await call({ quality: 'standard' })).toMatchObject({ model: 'beta-text' });
    // The next call skips alpha at once: it said when it takes calls again.
    expect(await call({ requestId: 'req-2', quality: 'standard' })).toMatchObject({
      model: 'beta-text',
    });
    expect(w.calls.map((c) => c.model.id)).toEqual(['alpha-large', 'beta-text', 'beta-text']);
  });

  it('reads Retry-After in seconds or as a date, bounded', () => {
    const now = Date.parse('2026-09-29T12:00:00Z');
    expect(retryAfterMsOf('3', now)).toBe(3_000);
    expect(retryAfterMsOf('Tue, 29 Sep 2026 12:00:05 GMT', now)).toBe(5_000);
    expect(retryAfterMsOf('Tue, 29 Sep 2026 11:59:00 GMT', now)).toBe(0);
    expect(retryAfterMsOf('999999999', now)).toBe(86_400_000);
    expect(retryAfterMsOf(null, now)).toBeUndefined();
    expect(retryAfterMsOf('soon', now)).toBeUndefined();
    expect(retryDelayMs(500, undefined)).toBe(500);
    expect(retryDelayMs(500, 2_000)).toBe(2_000);
    expect(retryDelayMs(500, MAX_RETRY_WAIT_MS + 1)).toBeUndefined();
  });
});
