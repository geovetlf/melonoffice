import {
  createModelPolicyCatalogue,
  createProviderRegistry,
  DEFAULT_MODEL_POLICY,
  type ProviderAdapter,
  type ProviderCall,
  type ProviderOutcome,
} from '@melonoffice/ai-gateway';
import { dateIn } from '@melonoffice/conversations';
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
    return { ...ctx, stores, provider, orgA, orgB, tenantA, credits, ask, post };
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
        proposedFollowUp: null,
        proposedAgentTask: null,
        forecast: null,
        links: [],
        context: {
          facts: 1,
          activity: true,
          commercial: true,
          forecast: false,
          agents: true,
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

  it('prepares a task for an active agent; only the person’s confirmation assigns it (AE-3)', async () => {
    const t = await setup();
    const base = `/v1/organizations/${t.orgA}`;
    const created = await t.post('token-alice', `${base}/specialists`, {
      templateId: 'commercial',
      displayName: 'Lucía',
    });
    const agentId = created.body.id as string;
    // A draft agent is not offered to GIA.
    const draft = await t.ask('token-alice', t.orgA, body('Hola', 'click-ae3-00'));
    expect(JSON.stringify(t.provider.calls[0])).toContain('(no active agents)');
    expect(draft.body.proposedAgentTask).toBeNull();
    await t.post('token-alice', `${base}/specialists/${agentId}/status`, {
      from: 'draft',
      to: 'active',
    });
    t.provider.state.answer = () => ({
      status: 'success',
      output: {
        text: JSON.stringify({
          ...ANSWER,
          answer: 'Le preparé la tarea a Lucía. Confírmala para enviársela.',
          agentTask: {
            agent: 'a_a',
            request: 'Prepara una propuesta de catering para 50 personas.',
          },
        }),
      },
      usage: { inputTokens: 1_000, outputTokens: 500 },
      finishReason: 'stop',
    });
    const answer = await t.ask(
      'token-alice',
      t.orgA,
      body('Pídele a Lucía una propuesta de catering para 50 personas', 'click-ae3-01'),
    );
    expect(answer.body).toMatchObject({
      proposedAgentTask: {
        agentId,
        agentName: 'Lucía',
        department: 'sales',
        request: 'Prepara una propuesta de catering para 50 personas.',
      },
      context: { agents: true },
    });
    const sent = JSON.stringify(t.provider.calls[1]);
    expect(sent).toContain('a_a \\"Lucía\\" (department sales)');
    expect(sent).not.toContain(agentId);
    // Nothing was assigned: the agent has no task until the person confirms.
    const list = async () =>
      (await (
        await t.app.request(`${base}/specialists/${agentId}/tasks`, t.as('token-alice'))
      ).json()) as { tasks: { request: string }[] };
    expect((await list()).tasks).toEqual([]);
    const confirmed = await t.post('token-alice', `${base}/specialists/${agentId}/tasks`, {
      request: (answer.body.proposedAgentTask as { request: string }).request,
      idempotencyKey: 'gia-click-ae3-01',
    });
    expect(confirmed.status).toBe(202);
    expect((await list()).tasks.map((task) => task.request)).toEqual([
      'Prepara una propuesta de catering para 50 personas.',
    ]);
  });

  // C4: GIA's commercial intelligence, on the real C1/C2 services and storage.
  async function restaurant(t: Awaited<ReturnType<typeof setup>>) {
    const base = `/v1/organizations/${t.orgA}`;
    const send = async (method: string, path: string, body: unknown) => {
      const response = await t.app.request(
        `${base}${path}`,
        t.as('token-alice', {
          method,
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
      return (await response.json()) as Json;
    };
    await send('PUT', '/business-profile', {
      businessType: 'restaurant',
      country: 'PE',
      currency: 'PEN',
      timeZone: 'America/Lima',
      city: 'Lima',
    });
    const today = dateIn('America/Lima', new Date());
    const day = (offset: number) =>
      new Date(Date.parse(`${today}T00:00:00Z`) + offset * 86_400_000).toISOString().slice(0, 10);
    const contact = async (displayName: string, phone: string, stage: 'lead' | 'customer') =>
      (await send('POST', '/customers', { displayName, phone, stage })).id as string;
    const ana = await contact('Ana', '+51911111111', 'lead');
    const beto = await contact('Beto', '+51922222222', 'lead');
    await contact('Carla', '+51933333333', 'lead');
    const diego = await contact('Diego', '+51944444444', 'customer');
    const elena = await contact('Elena', '+51955555555', 'customer');
    const boda = (
      await send('POST', '/opportunities', {
        contactId: ana,
        title: 'Catering boda',
        value: { amountMinor: 1_200_000 },
        nextAction: { text: 'Enviar cotización final', dueOn: day(-3) },
      })
    ).id as string;
    const cumple = (
      await send('POST', '/opportunities', {
        contactId: beto,
        title: 'Cumpleaños 50 personas',
        value: { amountMinor: 800_000 },
        expectedCloseOn: day(3),
      })
    ).id as string;
    await send('POST', '/opportunities', {
      contactId: elena,
      title: 'Pedido semanal',
      value: { amountMinor: 150_000 },
      nextAction: { text: 'Llamar', dueOn: day(5) },
    });
    const won = (
      await send('POST', '/opportunities', {
        contactId: diego,
        title: 'Almuerzo corporativo',
        value: { amountMinor: 250_000 },
      })
    ).id as string;
    await send('PATCH', `/opportunities/${won}`, { revision: 1, stageId: 'won' });
    return { base, boda, cumple, day };
  }

  const answering = (t: Awaited<ReturnType<typeof setup>>, links: string[]) => {
    t.provider.state.answer = () => ({
      status: 'success',
      output: {
        text: JSON.stringify({
          answer:
            'Hoy atiende primero Catering boda (S/ 12,000.00): la próxima acción venció hace 3 días. Luego Cumpleaños 50 personas (S/ 8,000.00): cierra en 3 días.',
          department: 'sales',
          screen: 'department',
          proposedAction: 'Enviar la cotización final a Ana',
          facts: [],
          links,
        }),
      },
      usage: { inputTokens: 1_000, outputTokens: 500 },
      finishReason: 'stop',
    });
  };

  it('tells a restaurant what to attend to today, with real links, 1 credit and no change', async () => {
    const t = await setup();
    const r = await restaurant(t);
    const read = async () =>
      JSON.stringify([
        (await (
          await t.app.request(`${r.base}/opportunities`, t.as('token-alice'))
        ).json()) as Json,
        (await (await t.app.request(`${r.base}/customers`, t.as('token-alice'))).json()) as Json,
      ]);
    const before = await read();
    const eventsBefore = (await t.stores.auditEvents()).length;
    answering(t, ['o_a', 'o_b', 'pipeline']);

    const answer = await t.ask(
      'token-alice',
      t.orgA,
      body('¿Qué debería atender hoy?', 'click-c4-01'),
    );
    expect(answer.body).toMatchObject({
      links: [
        { kind: 'opportunity', id: r.boda, label: 'Catering boda' },
        { kind: 'opportunity', id: r.cumple, label: 'Cumpleaños 50 personas' },
        { kind: 'pipeline' },
      ],
      context: { commercial: true },
      generatedBy: 'ai',
    });
    const sent = JSON.stringify(t.provider.calls[0]);
    expect(sent).toContain(`next action was due ${r.day(-3)}, 3 days late`);
    expect(sent).toContain(`expected to close in 3 days (${r.day(3)})`);
    expect(sent).toMatch(/Open value \(pipeline\): S\/\s21,500\.00 \(3 opportunities\)/);
    expect(sent).toMatch(/Sold \(won value\): all time S\/\s2,500\.00 \(1 opportunity\)/);
    expect(sent).toContain('Contacts: 3 leads, 2 customers, 0 inactive.');
    // Company Brain's business context reaches the model beside the commercial records.
    expect(sent).toContain('Pollería X');
    expect(sent).not.toContain('Tienda B');

    // 1 credit, one audited answer naming its source; nothing commercial changed.
    expect(await t.credits.balanceOf(t.tenantA)).toMatchObject({ balance: 9 });
    expect(t.provider.calls).toHaveLength(1);
    expect(await read()).toBe(before);
    const events = (await t.stores.auditEvents()).slice(eventsBefore);
    expect(events.filter((e) => e.action === 'gia.message_answered')).toEqual([
      expect.objectContaining({ result: 'success', reason: 'commercial_context' }),
    ]);
    expect(events.some((e) => /^(contact|opportunity|pipeline)\./.test(e.action))).toBe(false);
    expect(JSON.stringify(events)).not.toMatch(/Catering|atender|12,000/);
  });

  it('gives a role without commercial permissions nothing commercial', async () => {
    const t = await setup({
      authorization: createAuthorizationService({
        owner: ROLES.owner.filter(
          (p) => !['opportunity.read', 'contact.read', 'conversation.read'].includes(p),
        ),
      }),
    });
    await restaurant(t);
    answering(t, ['o_a', 'leads']);
    const answer = await t.ask('token-alice', t.orgA, body('¿Cuánto vendí?', 'click-c4-02'));
    expect(answer.body).toMatchObject({ links: [] });
    const sent = JSON.stringify(t.provider.calls[0]);
    expect(sent).toContain('Opportunities, pipeline and sales: the person may NOT read them.');
    expect(sent).toContain('No tienes permisos para consultar esa información.');
    expect(sent).not.toContain('Catering');
    expect(sent).not.toContain('Ana');
  });

  it('answers with a clear error, and charges nothing, when the model fails', async () => {
    const t = await setup();
    await restaurant(t);
    t.provider.state.answer = () => ({ status: 'error', kind: 'unavailable' });
    const answer = await t.ask('token-alice', t.orgA, body('¿Cómo van mis ventas?', 'click-c4-03'));
    expect(answer.status).toBeGreaterThanOrEqual(500);
    expect(await t.credits.balanceOf(t.tenantA)).toMatchObject({ balance: 10 });
  });
});
