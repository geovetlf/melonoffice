import {
  createAIGateway,
  createModelPolicyCatalogue,
  createProviderRegistry,
  DEFAULT_MODEL_POLICY,
  type AICreditsPort,
  type AIRequest,
  type ProviderAdapter,
  type ProviderCall,
  type ProviderOutcome,
} from '@melonoffice/ai-gateway';
import { departmentIdOf } from '@melonoffice/departments';
import type {
  AIModelDefinition,
  DepartmentTypeId,
  IsoTimestamp,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import { createExecutionService } from '@melonoffice/execution';
import { createLogger } from '@melonoffice/observability';
import { createAuthorizationService, ROLES } from '@melonoffice/rbac';
import {
  applySpecialistStatus,
  createSpecialistService,
  newSpecialist,
} from '@melonoffice/specialists';
import { resolveTenant } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

const AT = '2026-09-27T12:00:00.000Z' as IsoTimestamp;
/** Credential-shaped test values, built at run time so secret scanners do not flag the source. */
const fake = (...parts: string[]) => parts.join('');
const LEAKED_KEY = fake('sk', '-abcdefghijklmnopqrstuvwxyz123456');
const SECRET_VALUE = fake('super', '-secret-', 'provider-value');

const must = <T>(value: T | undefined): T => {
  if (value === undefined) throw new Error('missing value');
  return value;
};

// Test fixtures only: MelonOffice's real catalogue is empty until the launch provider (D-7).
const model = (modelId: string, quality: AIModelDefinition['quality']): AIModelDefinition => ({
  providerId: 'alpha',
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
  quality,
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
});

/**
 * A fake provider: `alpha-broken` throws with a secret in its message,
 * `alpha-leaky` answers with a credential in its text, and `alpha-ok` answers normally. The adapter only ever sees a credential reference.
 */
function fakeAdapter(calls: ProviderCall[]): ProviderAdapter {
  return {
    providerId: 'alpha',
    adapterVersion: '1.0.0',
    capabilities: () => ['text_generation'],
    health: async () => 'available',
    async generate(call): Promise<ProviderOutcome> {
      calls.push(call);
      if (call.model.id === 'alpha-broken') {
        // An adapter that throws is an invalid response; its message must never leak.
        throw new Error(`bad key ${SECRET_VALUE}`);
      }
      return {
        status: 'success',
        output: { text: call.model.id === 'alpha-leaky' ? `use ${LEAKED_KEY}` : 'Melons are up.' },
        usage: { inputTokens: 1_000, outputTokens: 500 },
        finishReason: 'stop',
        providerRequestId: 'prov-1',
      };
    },
  };
}

function fakeCredits(): AICreditsPort {
  let balance = 1_000;
  const seen = new Set<string>();
  return {
    balanceOf: async () => ({ status: 'present', balance }),
    async consume(_tenant, { amount, referenceId }) {
      if (seen.has(referenceId)) return { balance, replayed: true };
      seen.add(referenceId);
      balance -= amount;
      return { balance, replayed: false };
    },
    refund: async () => ({ balance, replayed: false }),
  };
}

describe.each(STORES)('AI gateway with storage in %s', (_name, createStores) => {
  async function setup(models: string[]) {
    const stores: Stores = createStores();
    const authorization = createAuthorizationService(ROLES);
    const ctx = setupApp(stores, authorization);
    const aliceId = (await ctx.register('token-alice')) as UserId;
    const response = await ctx.app.request(
      '/v1/organizations',
      ctx.as('token-alice', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'A' }),
      }),
    );
    const orgA = ((await response.json()) as { organization: { id: string } }).organization
      .id as OrganizationId;
    const tenant = await resolveTenant(
      { actor: 'user', userId: aliceId, emailVerified: true },
      orgA,
      stores.tenancy,
    );
    const specialists = createSpecialistService({
      repository: stores.specialists,
      departments: stores.departments,
      organizations: stores.tenancy,
      authorization,
    });
    const executions = createExecutionService({
      repository: stores.executions,
      organizations: stores.tenancy,
      assignments: specialists.assignments,
    });
    const department = must(
      await stores.departments.find(orgA, departmentIdOf(orgA, 'research' as DepartmentTypeId)),
    );
    const write = newSpecialist(
      {
        organizationId: orgA,
        displayName: 'María',
        configuration: {
          departmentId: department.id,
          mainRoleId: 'market_researcher',
          roleVersion: 1,
          capabilities: [],
          skills: [],
          tools: [],
          permissions: ['organization.read'],
          policies: {},
        } as never,
      },
      department,
      aliceId,
      AT,
    );
    await stores.specialists.create(write);
    const specialist = await stores.specialists.update(orgA, write.specialist.identity.id, (s) =>
      applySpecialistStatus(s, { from: 'draft', to: 'active' }, AT),
    );
    const created = await executions.create(tenant, {
      mode: 'execute',
      input: { type: 'task', id: 'task-1' },
      specialistId: specialist.identity.id,
      specialistVersion: specialist.version,
      departmentId: department.id,
      versionSnapshot: {
        schemaVersion: 1,
        components: [{ kind: 'specialist', id: specialist.identity.id, version: '1' }],
      },
      nodes: [{ id: 'n0', type: 'agent', label: 'Think' }],
    });
    const execution = await executions.changeStatus(tenant, created.id, {
      from: 'pending',
      to: 'running',
    });

    const calls: ProviderCall[] = [];
    const logLines: string[] = [];
    const gateway = createAIGateway({
      executions: stores.executions,
      organizations: stores.tenancy,
      specialists,
      authorization,
      registry: createProviderRegistry({
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
        models: [
          model('alpha-leaky', 'high'),
          model('alpha-broken', 'high'),
          model('alpha-ok', 'standard'),
        ],
        adapters: [fakeAdapter(calls)],
      }),
      policies: createModelPolicyCatalogue([], {
        ...DEFAULT_MODEL_POLICY,
        allowedModels: models,
        backoffMs: 0,
      }),
      environment: 'dev',
      credits: { port: fakeCredits(), rate: { microUsdPerCredit: 1_000 } },
      audit: stores.audit,
      logger: createLogger({ service: 'test', sink: (line) => logLines.push(line) }),
      sleep: async () => undefined,
    });
    const request = (overrides: Partial<Record<keyof AIRequest, unknown>> = {}) =>
      ({
        requestId: 'req-1',
        executionId: execution.id,
        nodeId: 'n0',
        specialistId: specialist.identity.id,
        taskType: 'summarise_document',
        capability: 'text_generation',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Summarise melons.' }] }],
        outputModality: 'text',
        maxOutputTokens: 1_000,
        sensitivity: 'internal',
        ...overrides,
      }) as AIRequest;
    return { stores, tenant, gateway, request, calls, logLines };
  }

  it('20. stores and logs no secret, whatever happens, and keeps the models it audits', async () => {
    const { stores, tenant, gateway, request, calls, logLines } = await setup([
      'alpha/alpha-leaky',
      'alpha/alpha-broken',
      'alpha/alpha-ok',
    ]);
    // A leaky answer is refused and another model answers; the fallback is audited.
    const answered = await gateway.generate(tenant, request());
    expect(answered).toMatchObject({
      status: 'completed',
      provider: 'alpha',
      model: 'alpha-ok',
      fallbackFrom: 'alpha/alpha-broken',
    });
    // A secret in the prompt is refused before any provider is called.
    const before = calls.length;
    const secret = [{ role: 'user', content: [{ type: 'text', text: `key ${LEAKED_KEY}` }] }];
    expect(
      await gateway.generate(tenant, request({ requestId: 'req-2', messages: secret })),
    ).toMatchObject({ status: 'denied', code: 'secret_in_input' });
    expect(calls).toHaveLength(before);
    // Adapters only ever received a credential reference.
    expect(JSON.stringify(calls)).not.toContain(LEAKED_KEY);
    expect(calls.every((c) => c.credential.provider === 'alpha_api')).toBe(true);

    const events = await stores.auditEvents();
    // Tried in order: broken (it throws), then leaky (a secret in its answer), then ok.
    expect(events.filter((e) => e.action === 'ai.provider_fallback')).toMatchObject([
      {
        model: { provider: 'alpha', id: 'alpha-leaky' },
        previousModel: { provider: 'alpha', id: 'alpha-broken' },
        reason: 'invalid_response',
      },
      {
        model: { provider: 'alpha', id: 'alpha-ok' },
        previousModel: { provider: 'alpha', id: 'alpha-leaky' },
        reason: 'invalid_response',
      },
    ]);
    expect(events.find((e) => e.action === 'ai.request_denied')).toMatchObject({
      reason: 'secret_in_input',
    });
    const stored = await stores.storedAudit();
    for (const leaked of [LEAKED_KEY, SECRET_VALUE, 'Summarise melons', 'Melons are up']) {
      expect(stored).not.toContain(leaked);
      expect(logLines.join('\n')).not.toContain(leaked);
    }
  });

  it('audits a call that fails on every model, without the provider’s message', async () => {
    const { stores, tenant, gateway, request, logLines } = await setup(['alpha/alpha-broken']);
    expect(await gateway.generate(tenant, request())).toMatchObject({
      status: 'failed',
      code: 'invalid_response',
    });
    expect(
      (await stores.auditEvents()).find((e) => e.action === 'ai.request_failed'),
    ).toMatchObject({
      reason: 'invalid_response',
      model: { provider: 'alpha', id: 'alpha-broken' },
    });
    expect(await stores.storedAudit()).not.toContain(SECRET_VALUE);
    expect(logLines.join('\n')).not.toContain(SECRET_VALUE);
  });
});
