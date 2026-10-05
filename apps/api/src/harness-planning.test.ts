import {
  createModelPolicyCatalogue,
  createProviderRegistry,
  DEFAULT_MODEL_POLICY,
  type ProviderAdapter,
  type ProviderCall,
} from '@melonoffice/ai-gateway';
import { createCreditService } from '@melonoffice/credits';
import type { AIModelDefinition, OrganizationId, UserId } from '@melonoffice/domain';
import { AGENT_TASK_POLICY_REF } from '@melonoffice/specialists';
import { resolveTenant } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * The Harness's plans may use tools where this server runs them (ADR-0168): its plan validator
 * is given the same tool environment as workflows and a person's own tools (ADR-0164), so a tool
 * step a model proposes is checked like any other instead of always `environment_not_allowed`.
 */

// Test fixtures only: a fake provider, so no test calls a real model.
const MODEL: AIModelDefinition = {
  providerId: 'alpha',
  modelId: 'alpha-ok',
  version: '2026-09-01',
  status: 'active',
  capabilities: ['text_generation', 'structured_output'],
  inputModalities: ['text'],
  outputModalities: ['text'],
  contextWindowTokens: 100_000,
  maxOutputTokens: 8_000,
  structuredOutput: true,
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
  maxSensitivity: 'confidential',
};

/** Proposes the routed agent's work and one search of the Company Brain it can use. */
function plannerProvider() {
  const calls: ProviderCall[] = [];
  const adapter: ProviderAdapter = {
    providerId: 'alpha',
    adapterVersion: '1.0.0',
    capabilities: () => ['text_generation', 'structured_output'],
    health: async () => 'available',
    async generate(call) {
      calls.push(call);
      const text = JSON.stringify(call.messages);
      const agent = /\\"specialistId\\":\\"([^\\"]+)\\"/.exec(text)?.[1] ?? 'none';
      const plan = {
        summary: 'Campaign',
        objective: 'Recover inactive customers.',
        steps: [
          {
            id: 'research',
            kind: 'specialist',
            label: 'Find what we know',
            dependsOn: [],
            specialistId: agent,
            verification: { policy: 'checks', expectedOutput: 'report', requiredChecks: [] },
          },
          {
            id: 'search',
            kind: 'tool',
            label: 'Search the Company Brain',
            dependsOn: ['research'],
            performedBy: 'research',
            tool: { id: 'knowledge_search', version: 1 },
            input: { query: 'inactive customers' },
          },
        ],
      };
      return {
        status: 'success',
        output: { structured: plan },
        usage: { inputTokens: 1_000, outputTokens: 500 },
        finishReason: 'stop',
      };
    },
  };
  return { calls, adapter };
}

const registryWith = (adapter: ProviderAdapter) =>
  createProviderRegistry({
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
        maxSensitivity: 'confidential',
      },
    ],
    models: [MODEL],
    adapters: [adapter],
  });

interface Body {
  readonly [key: string]: unknown;
  readonly id?: string;
  readonly organization?: { readonly id: string };
  readonly strategy?: {
    readonly verdict?: string;
    readonly plan?: { readonly mode?: string; readonly status?: string; readonly steps?: number };
    readonly handoff?: { readonly reason?: string; readonly code?: string } | null;
  };
}

describe.each(STORES)('Harness plans with storage in %s (ADR-0168)', (_name, createStores) => {
  async function setup(toolEnvironment: 'dev' | null) {
    const stores: Stores = createStores();
    const provider = plannerProvider();
    const ctx = setupApp(stores, undefined, undefined, undefined, undefined, {
      toolEnvironment,
      ai: {
        environment: 'dev',
        registry: registryWith(provider.adapter),
        // The routed agent's own policy (its template's), here allowing the fake model.
        policies: createModelPolicyCatalogue([
          {
            ...DEFAULT_MODEL_POLICY,
            id: AGENT_TASK_POLICY_REF.id,
            version: AGENT_TASK_POLICY_REF.version,
            maxSensitivity: 'confidential',
            allowedModels: ['alpha/alpha-ok'],
            backoffMs: 0,
          },
        ]),
        // 1 credit = US$0.01 (D-12).
        creditRate: { microUsdPerCredit: 10_000 },
      },
    });
    const aliceId = (await ctx.register('token-alice')) as UserId;
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await ctx.app.request(
        path,
        ctx.as('token-alice', {
          method,
          ...(body === undefined
            ? {}
            : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        }),
      );
      return { status: response.status, body: (await response.json()) as Body };
    };
    const orgA = (await call('POST', '/v1/organizations', { name: 'A' })).body.organization
      ?.id as OrganizationId;
    const base = `/v1/organizations/${orgA}`;
    await createCreditService({ store: stores.credits, organizations: stores.tenancy }).grant(
      await resolveTenant(
        { actor: 'user', userId: aliceId, emailVerified: true },
        orgA,
        stores.tenancy,
      ),
      { amount: 10, referenceId: `test-grant:${orgA}`, reason: 'test_grant' },
    );
    // A commercial agent whose skills let it search the Company Brain (company_knowledge@3).
    const created = await call('POST', `${base}/specialists`, {
      templateId: 'commercial',
      displayName: 'Lucía',
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    await call('POST', `${base}/specialists/${id}/status`, { from: 'draft', to: 'active' });
    const upgraded = await call('POST', `${base}/specialists/${id}/skills/upgrade`, {
      fromVersion: 1,
      skillId: 'company_knowledge',
      version: 3,
    });
    expect(upgraded.status).toBe(200);
    const ask = () =>
      call('POST', `${base}/harness/tasks`, {
        request: 'Prepara una campaña para recuperar clientes inactivos.',
      });
    return { ask, provider };
  }

  it('plans a tool step the agent can use where tools run', async () => {
    const { ask, provider } = await setup('dev');
    const { status, body } = await ask();
    expect(provider.calls).toHaveLength(1);
    expect(status).toBe(202);
    expect(body.strategy?.plan).toEqual(
      expect.objectContaining({ mode: 'multi_step', status: 'approval_required', steps: 2 }),
    );
    expect(body.strategy?.verdict).toBe('needs_authorization');
  });

  it('still refuses tool steps where this server runs no tools (fails closed)', async () => {
    const { ask } = await setup(null);
    const { body } = await ask();
    expect(body.strategy?.handoff).toEqual(
      expect.objectContaining({ reason: 'plan_failed', code: 'environment_not_allowed' }),
    );
  });
});
