import { InMemoryUsageSink, type AIUsageSink } from '@melonoffice/ai-usage';
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
  type ProviderAdapter,
  type ProviderCall,
  type ProviderOutcome,
} from './adapter.js';
import type { AICreditsPort } from './credits.js';
import { ASSIST_MODEL_POLICIES, createAIGateway } from './gateway.js';
import { createModelPolicyCatalogue, DEFAULT_MODEL_POLICY } from './policy.js';
import { createProviderRegistry } from './registry.js';
import type { AIRequest, AssistedAIRequest } from './request.js';
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

const OK = (text = 'Summary ready.'): ProviderOutcome => ({
  status: 'success',
  output: { text },
  usage: { inputTokens: 1_000, outputTokens: 500 },
  finishReason: 'stop',
  providerRequestId: 'prov-req-1',
});

/** A fake official adapter: answers from a script per model, and records what it was sent. */
function fakeAdapter(providerId: string, script: Script, calls: ProviderCall[]): ProviderAdapter {
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
    adapters: [fakeAdapter('alpha', script, calls), fakeAdapter('beta', script, calls)],
  });
  const credits = fakeCredits(options.balance ?? 1_000);
  const logLines: string[] = [];
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
          },
        }),
    audit: createAuditService(audit, now),
    logger: createLogger({ service: 'test', sink: (line) => logLines.push(line) }),
    timeoutMs: 50,
    now,
    sleep: async () => undefined,
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
