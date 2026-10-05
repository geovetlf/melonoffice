// Test fixtures for this package's tests only: excluded from the build, never exported.
import {
  createAIGateway,
  createModelPolicyCatalogue,
  createProviderRegistry,
  DEFAULT_MODEL_POLICY,
  type AICreditsPort,
  type ProviderAdapter,
  type ProviderCall,
  type ProviderOutcome,
} from '@melonoffice/ai-gateway';
import { createAuditService, InMemoryAuditStore } from '@melonoffice/audit';
import type { AuthenticatedContext } from '@melonoffice/auth';
import { InMemoryCreditStore, openWallet } from '@melonoffice/credits';
import {
  DEFAULT_DEPARTMENT_CATALOGUE,
  departmentIdOf,
  InMemoryDepartmentRepository,
  provisionDepartments,
} from '@melonoffice/departments';
import type {
  AIModelDefinition,
  DepartmentTypeId,
  DeploymentEnvironment,
  Execution,
  InitialBilling,
  IsoTimestamp,
  Organization,
  OrganizationId,
  Specialist,
  SpecialistStatus,
  SubscriptionId,
  ToolDefinition,
  ToolVersion,
  UserId,
} from '@melonoffice/domain';
import { createExecutionService, InMemoryExecutionRepository } from '@melonoffice/execution';
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
  resolveRuntimeTenant,
  resolveTenant,
  type TenantContext,
} from '@melonoffice/tenancy';
import { createToolRegistry } from '@melonoffice/tools';
import { createDelegation } from './delegation.js';
import { createPlanEstimator } from './estimate.js';
import { createPlanner } from './planner.js';
import { createPlanCancellationCascade } from './cascade.js';
import { InMemoryPlanRepository } from './repository.js';
import { createPlanService } from './service.js';
import { createPlanValidator } from './validate.js';

export const T0 = new Date('2026-09-27T12:00:00Z');
export const AT = T0.toISOString() as IsoTimestamp;
export const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
export const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
/** Credential-shaped test values, built at run time so secret scanners do not flag the source. */
export const fake = (...parts: string[]): string => parts.join('');

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

export const as = (userId: UserId, actor: 'user' | 'gia' = 'user'): AuthenticatedContext =>
  Object.freeze({ actor, userId, emailVerified: true });

export const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing value');
  return value;
};

const SCHEMA = {
  type: 'object',
  properties: { query: { type: 'string', maxLength: 100 } },
} as const;

/** Tool fixtures only: MelonOffice's real catalogue is empty until tools arrive with their phase. */
export const tool = (
  id: string,
  overrides: Partial<ToolVersion> = {},
  status: ToolDefinition['status'] = 'active',
): ToolDefinition => ({
  id: id as ToolDefinition['id'],
  status,
  versions: [
    {
      toolId: id as ToolVersion['toolId'],
      version: 1,
      nameKey: `tools.${id}.name` as ToolVersion['nameKey'],
      descriptionKey: `tools.${id}.description` as ToolVersion['descriptionKey'],
      category: 'test',
      action: 'run',
      mutating: false,
      inputSchema: SCHEMA,
      outputSchema: SCHEMA,
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

export const TOOLS: readonly ToolDefinition[] = [
  tool('lookup'),
  tool('send_email', { riskLevel: 'high', mutating: true, action: 'send' }),
  tool('wipe_data', { riskLevel: 'critical', mutating: true }),
  // ADR-0159: a read that asks a person first, and reads that leave MelonOffice.
  tool('private_records', { riskLevel: 'high', action: 'read' }),
  tool('remote_lookup', { provider: { kind: 'external', id: 'remote' } }),
  tool('keyed_lookup', { credentials: [{ provider: 'remote', scopes: ['read'] }] }),
  tool('finance_report', { departmentTypes: ['finance' as DepartmentTypeId] }),
  tool('billing_lookup', { permissions: ['billing.read'] }),
  tool('staging_only', { environments: ['staging'] }),
  tool('retired', {}, 'disabled'),
  // ADR-0034: a tool only a person may invoke is never planned for the runtime.
  tool('person_only', { invocationModes: ['human'] }),
  // ADR-0161: a medium-risk read, and a read whose result has a number and a list.
  tool('ranked_lookup', { riskLevel: 'medium' }),
  tool('count_lookup', {
    outputSchema: {
      type: 'object',
      properties: {
        count: { type: 'integer' },
        topic: { type: 'string', maxLength: 100 },
        names: { type: 'array', items: { type: 'string', maxLength: 50 }, maxItems: 10 },
      },
    },
  }),
];

/** Model fixture only: MelonOffice's real catalogue is empty until the launch provider (D-7). */
const MODEL: AIModelDefinition = {
  providerId: 'alpha',
  modelId: 'alpha-large',
  version: '2026-09-01',
  status: 'active',
  capabilities: ['text_generation', 'structured_output'],
  inputModalities: ['text'],
  outputModalities: ['text'],
  contextWindowTokens: 200_000,
  maxOutputTokens: 16_000,
  structuredOutput: true,
  toolUse: false,
  streaming: false,
  quality: 'high',
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

export type Answer = () => ProviderOutcome;

export const answer =
  (structured: unknown): Answer =>
  () => ({
    status: 'success',
    output: { structured },
    usage: { inputTokens: 1_000, outputTokens: 500 },
    finishReason: 'stop',
  });

export interface WorldOptions {
  readonly roles?: Record<string, readonly string[]>;
  readonly environment?: DeploymentEnvironment | undefined;
  readonly balance?: number;
  /** A credit rate for estimates. Absent: estimates stay unknown (D-12). */
  readonly rate?: number;
}

export async function world(options: WorldOptions = {}) {
  const now = () => T0;
  const audit = new InMemoryAuditStore();
  const auditService = createAuditService(audit, now);
  const departments = new InMemoryDepartmentRepository();
  const creditStore = new InMemoryCreditStore(audit);
  const tenancy = new InMemoryTenancyStore(now, audit, undefined, departments, creditStore);
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
  const planRepository = new InMemoryPlanRepository(audit);
  const executions = createExecutionService({
    repository: executionRepository,
    organizations: tenancy,
    assignments: specialists.assignments,
    // Starting and cancelling are the owner's (ADR-0029), whatever roles a test gives planning.
    authorization: createAuthorizationService(),
    audit: auditService,
    cascade: createPlanCancellationCascade({ repository: planRepository, now }),
    now,
  });
  const environment = 'environment' in options ? options.environment : 'dev';
  const tools = createToolRegistry(TOOLS);

  // The model's answers, in order; each planning call takes the next one.
  const answers: Answer[] = [];
  const calls: ProviderCall[] = [];
  const adapter: ProviderAdapter = {
    providerId: 'alpha',
    adapterVersion: 'alpha-adapter-1',
    capabilities: () => ['text_generation', 'structured_output'],
    health: async () => 'available',
    async generate(call) {
      calls.push(call);
      const next = answers.shift();
      if (next === undefined) throw new Error('no scripted answer');
      return next();
    },
  };
  const registry = createProviderRegistry({
    providers: [
      {
        id: 'alpha',
        name: 'Test alpha',
        status: 'active',
        access: 'official',
        capabilities: ['text_generation', 'structured_output'],
        modalities: ['text'],
        environments: ['dev'],
        credential: { provider: 'alpha_api', scopes: ['generate'] },
        maxSensitivity: 'internal',
      },
    ],
    models: [MODEL],
    adapters: [adapter],
  });
  const policies = createModelPolicyCatalogue([], { ...DEFAULT_MODEL_POLICY, backoffMs: 0 });
  let balance = options.balance ?? 1_000;
  const consumed: number[] = [];
  const credits: AICreditsPort = {
    async balanceOf() {
      return { status: 'present', balance };
    },
    async consume(_tenant, { amount }) {
      if (amount > balance) throw new Error('credits_insufficient');
      balance -= amount;
      consumed.push(amount);
      return { balance, replayed: false };
    },
    async refund() {
      throw new Error('not used');
    },
  };
  const gateway = createAIGateway({
    executions: executionRepository,
    organizations: tenancy,
    specialists,
    authorization,
    registry,
    policies,
    environment,
    credits: { port: credits, rate: { microUsdPerCredit: 1_000 } },
    audit: auditService,
    timeoutMs: 50,
    now,
    sleep: async () => undefined,
  });
  const estimator = createPlanEstimator({
    registry,
    policies,
    environment,
    rate: options.rate === undefined ? undefined : { microUsdPerCredit: options.rate },
  });
  const validator = createPlanValidator({
    specialists,
    departments,
    tools,
    authorization,
    environment,
    estimator,
  });
  const plans = createPlanService({
    repository: planRepository,
    executions,
    validator,
    organizations: tenancy,
    authorization,
    audit: auditService,
    now,
  });
  const planner = createPlanner({
    plans,
    tools,
    executions,
    specialists,
    departments,
    gateway,
    authorization,
  });
  const delegation = createDelegation({
    plans: planRepository,
    executions,
    specialists,
    organizations: tenancy,
    authorization,
    now,
  });
  const tenantA = await resolveTenant(as(ALICE), orgA, tenancy);
  const tenantB = await resolveTenant(as(BOB), orgB, tenancy);
  const giaA = await resolveTenant(as(ALICE, 'gia'), orgA, tenancy);
  const runtimeA = await resolveRuntimeTenant(ALICE, orgA, tenancy);

  async function seed(
    org: OrganizationId,
    by: UserId,
    {
      type = 'research',
      role = 'market_researcher',
      status = 'active',
      permissions = ['organization.read'],
      toolIds = [],
    }: {
      type?: string;
      role?: string;
      status?: SpecialistStatus;
      permissions?: string[];
      toolIds?: string[];
    } = {},
  ): Promise<Specialist> {
    const departmentId = departmentIdOf(org, type as DepartmentTypeId);
    const write = newSpecialist(
      {
        organizationId: org,
        displayName: 'Specialist',
        configuration: {
          departmentId,
          mainRoleId: role,
          roleVersion: 1,
          capabilities: [],
          skills: [],
          tools: toolIds.map((id) => ({ id, version: 1 })),
          permissions,
          policies: {},
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

  async function pause(org: OrganizationId, s: Specialist): Promise<void> {
    await specialistRepository.update(org, s.identity.id, (current) =>
      applySpecialistStatus(current, { from: current.status, to: 'paused' }, AT),
    );
  }

  /** A planning execution owned by `owner` (the organization's planning specialist). */
  async function planning(tenant: TenantContext, owner: Specialist): Promise<Execution> {
    const execution = await executions.create(tenant, {
      mode: 'plan',
      input: { type: 'task', id: 'task-1' },
      specialistId: owner.identity.id,
      specialistVersion: owner.version,
      departmentId: owner.configuration.departmentId,
      versionSnapshot: {
        schemaVersion: 1,
        components: [{ kind: 'specialist', id: owner.identity.id, version: String(owner.version) }],
      },
    });
    return executions.changeStatus(tenant, execution.id, { from: 'pending', to: 'planning' });
  }

  const events = (action?: string) =>
    audit.events().filter((e) => action === undefined || e.action === action);

  return {
    audit,
    events,
    orgA,
    orgB,
    tenantA,
    tenantB,
    giaA,
    runtimeA,
    tenancy,
    authorization,
    departments,
    specialists,
    executions,
    executionRepository,
    planRepository,
    plans,
    planner,
    delegation,
    validator,
    toolRegistry: tools,
    answers,
    calls,
    consumed,
    seed,
    pause,
    planning,
  };
}

export type World = Awaited<ReturnType<typeof world>>;

/** A specialist step for `s`, with the verification every specialist step needs. */
export const specialistStep = (
  id: string,
  s: Specialist,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  kind: 'specialist',
  label: `Work ${id}`,
  dependsOn: [],
  specialistId: s.identity.id,
  verification: { policy: 'checks', expectedOutput: 'report', requiredChecks: ['sources_cited'] },
  ...overrides,
});

export const toolStep = (
  id: string,
  performedBy: string,
  toolId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  id,
  kind: 'tool',
  label: `Use ${toolId}`,
  dependsOn: [performedBy],
  performedBy,
  tool: { id: toolId, version: 1 },
  ...overrides,
});

export const proposal = (
  steps: Record<string, unknown>[],
  overrides: Record<string, unknown> = {},
): Record<string, unknown> => ({
  summary: 'Market study',
  objective: 'Study the melon market and report.',
  steps,
  ...overrides,
});
