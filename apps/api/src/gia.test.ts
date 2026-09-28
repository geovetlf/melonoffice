import {
  createModelPolicyCatalogue,
  createProviderRegistry,
  DEFAULT_MODEL_POLICY,
  type ProviderAdapter,
  type ProviderCall,
  type ProviderOutcome,
} from '@melonoffice/ai-gateway';
import { createCreditService } from '@melonoffice/credits';
import type { AIModelDefinition, OrganizationId, PolicyId, UserId } from '@melonoffice/domain';
import { createAuthorizationService, ROLES } from '@melonoffice/rbac';
import { resolveTenant } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

// Test fixtures only: a fake provider, so no test calls a real model.
const MODEL: AIModelDefinition = {
  providerId: 'alpha',
  modelId: 'alpha-ok',
  version: '2026-09-01',
  status: 'active',
  capabilities: ['text_generation'],
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

const ANSWER = {
  answer: 'Hoy recibiste un mensaje de un cliente. Puedes verlo en Conversaciones.',
  department: 'sales',
  screen: 'conversations',
  proposedAction: 'Responder al cliente desde Conversaciones',
  facts: [],
};

function fakeProvider() {
  const calls: ProviderCall[] = [];
  const state = {
    answer: (): ProviderOutcome => ({
      status: 'success',
      output: { text: JSON.stringify(ANSWER) },
      usage: { inputTokens: 1_000, outputTokens: 500 },
      finishReason: 'stop',
    }),
  };
  const adapter: ProviderAdapter = {
    providerId: 'alpha',
    adapterVersion: '1.0.0',
    capabilities: () => ['text_generation'],
    health: async () => 'available',
    async generate(call) {
      calls.push(call);
      return state.answer();
    },
  };
  return { calls, state, adapter };
}

const registryWith = (adapter: ProviderAdapter) =>
  createProviderRegistry({
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

// GIA's own named policy (ADR-0052), here allowing the fake model, at most 1 credit a message.
const policies = () =>
  createModelPolicyCatalogue([
    {
      ...DEFAULT_MODEL_POLICY,
      id: 'gia_assist' as PolicyId,
      maxSensitivity: 'confidential',
      allowedModels: ['alpha/alpha-ok'],
      maxCostMicroUsd: 10_000,
      maxAttempts: 2,
      backoffMs: 0,
    },
  ]);

type Json = Record<string, unknown>;

describe.each(STORES)('GIA chat with storage in %s (ADR-0052)', (_name, createStores) => {
  async function setup(
    options: {
      configured?: boolean;
      authorization?: ReturnType<typeof createAuthorizationService>;
    } = {},
  ) {
    const stores: Stores = createStores();
    const provider = fakeProvider();
    const ctx = setupApp(stores, options.authorization, undefined, undefined, undefined, {
      ...(options.configured === false
        ? {}
        : {
            ai: {
              environment: 'dev',
              registry: registryWith(provider.adapter),
              policies: policies(),
              // 1 credit = US$0.01 (D-12).
              creditRate: { microUsdPerCredit: 10_000 },
            },
          }),
    });
    const aliceId = (await ctx.register('token-alice')) as UserId;
    await ctx.register('token-bob');
    const post = async (token: string, path: string, body: unknown) => {
      const response = await ctx.app.request(
        path,
        ctx.as(token, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      return { status: response.status, body: (await response.json()) as Json };
    };
    const create = async (token: string, name: string) =>
      ((await post(token, '/v1/organizations', { name })).body.organization as { id: string })
        .id as OrganizationId;
    const orgA = await create('token-alice', 'Pollería X');
    const orgB = await create('token-bob', 'Tienda B');
    const tenantA = await resolveTenant(
      { actor: 'user', userId: aliceId, emailVerified: true },
      orgA,
      stores.tenancy,
    );
    const credits = createCreditService({ store: stores.credits, organizations: stores.tenancy });
    await credits.grant(tenantA, { amount: 10, referenceId: 'grant-1', reason: 'test_grant' });
    const ask = (token: string, org: string, body: Json) =>
      post(token, `/v1/organizations/${org}/gia/messages`, body);
    return { ...ctx, stores, provider, orgA, orgB, tenantA, credits, ask };
  }

  const body = (message = '¿Qué pasó hoy?', requestKey = 'click-0001') => ({
    message,
    requestKey,
    locale: 'es',
  });

  it('answers from the company context, charges 1 credit and shows in the activity', async () => {
    const t = await setup();
    const answer = await t.ask('token-alice', t.orgA, body());
    expect(answer).toEqual({
      status: 200,
      body: {
        answer: ANSWER.answer,
        department: 'sales',
        screen: 'conversations',
        proposedAction: ANSWER.proposedAction,
        proposedFacts: 0,
        context: {
          facts: 1,
          activity: true,
          missing: ['what_you_do', 'main_products', 'customers', 'areas', 'goals', 'tone'],
        },
        replayed: false,
        generatedBy: 'ai',
      },
    });
    // The business's name, from Company Brain, reached the model; no other organization did.
    const sent = JSON.stringify(t.provider.calls[0]);
    expect(sent).toContain('Pollería X');
    expect(sent).not.toContain('Tienda B');
    // 1,000 input + 500 output tokens at the fixture prices = 3,000 micro-USD: 1 credit.
    expect(await t.credits.balanceOf(t.tenantA)).toMatchObject({ balance: 9 });
    // The same click again is answered once and charged once.
    expect((await t.ask('token-alice', t.orgA, body())).body.replayed).toBe(true);
    expect(t.provider.calls).toHaveLength(1);
    expect(await t.credits.balanceOf(t.tenantA)).toMatchObject({ balance: 9 });

    const activity = await t.app.request(
      `/v1/organizations/${t.orgA}/activity?period=today`,
      t.as('token-alice'),
    );
    const items = ((await activity.json()) as { items: { action: string; actor: string }[] }).items;
    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'gia.message_answered', actor: 'you' }),
      ]),
    );
    // The audit trail never holds the question or the answer.
    const events = (await t.stores.auditEvents()).filter((e) => e.organizationId === t.orgA);
    expect(JSON.stringify(events)).not.toContain('Qué pasó');
    expect(JSON.stringify(events)).not.toContain('mensaje de un cliente');
  });

  it('says so when the organization has no credits, and calls no model', async () => {
    const t = await setup();
    expect(await t.ask('token-bob', t.orgB, body())).toEqual({
      status: 409,
      body: { error: 'ai_credits_insufficient' },
    });
    expect(t.provider.calls).toHaveLength(0);
  });

  it('is not available where no model is configured', async () => {
    const t = await setup({ configured: false });
    expect(await t.ask('token-alice', t.orgA, body())).toEqual({
      status: 503,
      body: { error: 'ai_not_available' },
    });
  });

  it("refuses another organization's members, a role without gia.ask and a bad body", async () => {
    const t = await setup();
    expect((await t.ask('token-bob', t.orgA, body())).status).toBe(403);
    expect(await t.ask('token-alice', t.orgA, { ...body(), extra: 1 })).toEqual({
      status: 400,
      body: { error: 'invalid_request' },
    });
    expect(await t.ask('token-alice', t.orgA, body(''))).toEqual({
      status: 400,
      body: { error: 'invalid_request', field: 'message' },
    });
    const u = await setup({
      authorization: createAuthorizationService({
        owner: ROLES.owner.filter((p) => p !== 'gia.ask'),
      }),
    });
    expect((await u.ask('token-alice', u.orgA, body())).status).toBe(403);
    expect(t.provider.calls).toHaveLength(0);
    expect(u.provider.calls).toHaveLength(0);
  });

  it('keeps facts the person states as proposals to confirm', async () => {
    const t = await setup();
    t.provider.state.answer = () => ({
      status: 'success',
      output: {
        text: JSON.stringify({
          ...ANSWER,
          facts: [
            {
              domain: 'business_model',
              key: 'description',
              valueType: 'text',
              text: 'Pollería familiar en Lima',
              confidence: 0.95,
            },
          ],
        }),
      },
      usage: { inputTokens: 1_000, outputTokens: 500 },
      finishReason: 'stop',
    });
    const answer = await t.ask('token-alice', t.orgA, body('Somos una pollería familiar en Lima'));
    expect(answer.body).toMatchObject({ proposedFacts: 1 });
    const gaps = await t.app.request(`/v1/organizations/${t.orgA}/brain/gaps`, t.as('token-alice'));
    const found = (await gaps.json()) as {
      questions: { id: string }[];
      toConfirm: { key: string; verification: string }[];
    };
    expect(found.questions.map((q) => q.id)).not.toContain('what_you_do');
    expect(found.toConfirm).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'description', verification: 'proposed' }),
      ]),
    );
  });
});
