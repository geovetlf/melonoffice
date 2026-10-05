import {
  ASSIST_MODEL_POLICIES,
  createModelPolicyCatalogue,
  createProviderRegistry,
  DEFAULT_MODEL_POLICY,
  type ProviderAdapter,
  type ProviderCall,
} from '@melonoffice/ai-gateway';
import { createCreditService } from '@melonoffice/credits';
import type { AIModelDefinition, OrganizationId, PolicyId, UserId } from '@melonoffice/domain';
import { resolveTenant } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

/**
 * GIA drafts a workflow from a person's words (Block 3 F2, ADR-0171): one assisted call in GIA's
 * name with the planner's prompt, steps by role, the same dry run as `check`, and nothing stored.
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

/** Answers with what `answer` makes of the agent the context names first. */
function provider(answer: (agentId: string) => unknown) {
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
      return {
        status: 'success',
        output: { structured: answer(agent) as Record<string, unknown> },
        usage: { inputTokens: 1_000, outputTokens: 500 },
        finishReason: 'stop',
      };
    },
  };
  return { calls, adapter };
}

const PLAN = (agent: string) => ({
  summary: 'Recuperar clientes inactivos',
  objective: 'Recuperar clientes inactivos.',
  steps: [
    {
      id: 'research',
      kind: 'specialist',
      label: 'Revisar lo que sabemos',
      dependsOn: [],
      specialistId: agent,
    },
    {
      id: 'search',
      kind: 'tool',
      label: 'Buscar en el Cerebro',
      dependsOn: ['research'],
      performedBy: 'research',
      tool: { id: 'knowledge_search', version: 1 },
      input: { query: 'clientes inactivos' },
    },
  ],
});

interface Body {
  readonly [key: string]: unknown;
  readonly organization?: { readonly id: string };
}

describe.each(STORES)('workflow drafts with storage in %s (ADR-0171)', (_name, createStores) => {
  async function setup(answer: (agentId: string) => unknown = PLAN) {
    const stores: Stores = createStores();
    const fake = provider(answer);
    const ctx = setupApp(stores, undefined, undefined, undefined, undefined, {
      ai: {
        environment: 'dev',
        registry: createProviderRegistry({
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
          adapters: [fake.adapter],
        }),
        // GIA's own policy, here allowing the fake model.
        policies: createModelPolicyCatalogue([
          {
            ...DEFAULT_MODEL_POLICY,
            id: ASSIST_MODEL_POLICIES.gia.id as PolicyId,
            version: ASSIST_MODEL_POLICIES.gia.version,
            maxSensitivity: 'confidential',
            allowedModels: ['alpha/alpha-ok'],
            backoffMs: 0,
          },
        ]),
        creditRate: { microUsdPerCredit: 10_000 },
      },
    });
    const aliceId = (await ctx.register('token-alice')) as UserId;
    await ctx.register('token-bob');
    const call = async (token: string, method: string, path: string, body?: unknown) => {
      const response = await ctx.app.request(
        path,
        ctx.as(token, {
          method,
          ...(body === undefined
            ? {}
            : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
        }),
      );
      return { status: response.status, body: (await response.json()) as Body };
    };
    const orgOf = async (token: string, name: string) =>
      (await call(token, 'POST', '/v1/organizations', { name })).body.organization
        ?.id as OrganizationId;
    const orgA = await orgOf('token-alice', 'A');
    const orgB = await orgOf('token-bob', 'B');
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
    const created = await call('token-alice', 'POST', `${base}/specialists`, {
      templateId: 'commercial',
      displayName: 'Lucía',
    });
    expect(created.status).toBe(201);
    const agentId = created.body.id as string;
    await call('token-alice', 'POST', `${base}/specialists/${agentId}/status`, {
      from: 'draft',
      to: 'active',
    });
    await call('token-alice', 'POST', `${base}/specialists/${agentId}/skills/upgrade`, {
      fromVersion: 1,
      skillId: 'company_knowledge',
      version: 3,
    });
    const draft = (body: unknown, token = 'token-alice', org = orgA) =>
      call(token, 'POST', `/v1/organizations/${org}/workflows/draft`, body);
    return { draft, call, base, orgB, agentId, calls: fake.calls, stores };
  }

  it('drafts a workflow by role, checked as planning would, and stores nothing', async () => {
    const t = await setup();
    const { status, body } = await t.draft({ intent: 'Recupera clientes inactivos' });
    expect(status, JSON.stringify(body)).toBe(200);
    expect(body.status).toBe('ready');
    expect(body.name).toBe('Recuperar clientes inactivos');
    const steps = body.steps as Record<string, unknown>[];
    expect(steps[0]).not.toHaveProperty('specialistId');
    expect(steps[0]?.assignee).toEqual(expect.objectContaining({ roleId: expect.any(String) }));
    const summary = body.summary as {
      schedule: string;
      results: string[];
      changesData: boolean;
      steps: { id: string; agent?: { id: string; displayName: string }; tool?: unknown }[];
    };
    expect(summary.schedule).toBe('manual');
    expect(summary.results).toEqual(['search']);
    expect(summary.changesData).toBe(false);
    expect(summary.steps.find((s) => s.id === 'research')?.agent).toEqual(
      expect.objectContaining({ id: t.agentId, displayName: 'Lucía' }),
    );
    expect(summary.steps.find((s) => s.id === 'search')?.tool).toEqual(
      expect.objectContaining({ id: 'knowledge_search', version: 1, changesData: false }),
    );
    // One call, the planner's own instructions, and nothing saved.
    expect(t.calls).toHaveLength(1);
    expect(JSON.stringify(t.calls[0]?.messages)).toContain('You are the MelonOffice planner');
    const listed = await t.call('token-alice', 'GET', `${t.base}/workflows`);
    expect(listed.body.workflows).toEqual([]);
  });

  it('passes on a question, never shows a refused draft as valid, and answers only its owner', async () => {
    const asks = await setup(() => ({ question: '¿Qué clientes?' }));
    expect((await asks.draft({ intent: 'Gestiona mis clientes' })).body).toEqual({
      status: 'needs_clarification',
      question: '¿Qué clientes?',
    });
    const invents = await setup((agent) => ({
      ...PLAN(agent),
      steps: [
        ...PLAN(agent).steps,
        {
          id: 'mail',
          kind: 'tool',
          label: 'Enviar correo',
          dependsOn: ['research'],
          performedBy: 'research',
          tool: { id: 'email_campaign_manager', version: 1 },
          input: {},
        },
      ],
    }));
    const invalid = await invents.draft({ intent: 'Envía una campaña por email' });
    expect(invalid.body).toEqual(
      expect.objectContaining({ status: 'invalid', problem: expect.any(Object) }),
    );
    expect(invalid.body).not.toHaveProperty('summary');
    // An exact body, and another organization's route is refused before any model call.
    expect((await asks.draft({ intent: 'x', extra: 1 })).status).toBe(400);
    expect((await asks.draft({})).status).toBe(400);
    expect((await asks.draft({ intent: 'x' }, 'token-alice', asks.orgB)).status).toBe(403);
    expect((await asks.draft({ intent: ' ' })).body).toEqual({
      error: 'invalid_workflow',
      detail: 'intent',
    });
    expect(asks.calls).toHaveLength(1);
  });

  // Block 3 F3 (ADR-0177): from GIA's draft to a saved draft, with the person deciding each step.
  const CHAINED = (agent: string) => ({
    summary: 'Cada lunes, recuperar clientes inactivos',
    objective: 'Recuperar clientes inactivos.',
    steps: [
      {
        id: 'research',
        kind: 'specialist',
        label: 'Revisar a quién escribir',
        dependsOn: [],
        specialistId: agent,
      },
      {
        id: 'search',
        kind: 'tool',
        label: 'Buscar lo que sabemos',
        dependsOn: ['research'],
        performedBy: 'research',
        tool: { id: 'knowledge_search', version: 1 },
        inputFrom: { query: { step: 'research' } },
      },
      {
        id: 'offer',
        kind: 'specialist',
        label: 'Preparar la oferta',
        dependsOn: ['search'],
        specialistId: agent,
        approvalRequired: true,
      },
    ],
  });

  it('F3: keeps approvals and results between steps, saves only as the person, as a draft', async () => {
    const t = await setup(CHAINED);
    const drafted = await t.draft({ intent: 'Cada lunes recupera a los clientes inactivos' });
    expect(drafted.status, JSON.stringify(drafted.body)).toBe(200);
    expect(drafted.body.status).toBe('ready');
    const steps = drafted.body.steps as Record<string, unknown>[];
    expect(steps.find((s) => s.id === 'search')).toEqual(
      expect.objectContaining({ inputFrom: { query: { step: 'research' } } }),
    );
    expect(steps.find((s) => s.id === 'offer')).toEqual(
      // The tool is its agent's step's own work, so what waited on the tool waits on that step.
      expect.objectContaining({ approvalRequired: true, dependsOn: ['research'] }),
    );
    // Drafting stored nothing and decided nothing: no workflow, plan, approval or audit event.
    const before = (await t.stores.auditEvents()).filter((e) => e.action.startsWith('workflow.'));
    expect(before).toEqual([]);
    expect((await t.call('token-alice', 'GET', `${t.base}/workflows`)).body.workflows).toEqual([]);
    expect((await t.call('token-alice', 'GET', `${t.base}/plans`)).body.plans).toEqual([]);

    // The person saves it through the existing route: it stays a draft, in their name.
    const saved = await t.call('token-alice', 'POST', `${t.base}/workflows`, {
      name: drafted.body.name,
      steps,
    });
    expect(saved.status, JSON.stringify(saved.body)).toBe(201);
    expect(saved.body.status).toBe('draft');
    const detail = await t.call(
      'token-alice',
      'GET',
      `${t.base}/workflows/${saved.body.id as string}`,
    );
    const stored = (detail.body.current as { steps: Record<string, unknown>[] }).steps;
    expect(stored.find((s) => s.id === 'offer')?.approvalRequired).toBe(true);
    expect(stored.find((s) => s.id === 'search')?.inputFrom).toEqual({
      query: { step: 'research' },
    });
    const events = (await t.stores.auditEvents()).filter((e) => e.action.startsWith('workflow.'));
    expect(events.map((e) => [e.action, e.actor.type])).toEqual([['workflow.created', 'user']]);
    expect((await t.call('token-alice', 'GET', `${t.base}/plans`)).body.plans).toEqual([]);
    // Another organization cannot read or save into it.
    expect(
      (await t.call('token-bob', 'GET', `${t.base}/workflows/${saved.body.id as string}`)).status,
    ).toBe(403);
  });

  it('F3: names no agent it was not shown, and hides internals when the model fails', async () => {
    const invents = await setup((agent) => ({
      ...PLAN(agent),
      steps: [{ ...PLAN(agent).steps[0], specialistId: 'sales_agent' }, PLAN(agent).steps[1]],
    }));
    const invented = await invents.draft({ intent: 'Cada lunes revisa las ventas' });
    expect(invented.body.status).toBe('invalid');
    // Refused, with no agent shown as doing it, and the server refuses to save it as written.
    expect(invented.body).not.toHaveProperty('summary');
    expect(invented.body.problem).toEqual(expect.objectContaining({ reason: 'invalid_workflow' }));
    const forced = await invents.call('token-alice', 'POST', `${invents.base}/workflows`, {
      name: invented.body.name,
      steps: invented.body.steps,
    });
    expect(forced.status).toBe(400);
    expect(
      (await invents.call('token-alice', 'GET', `${invents.base}/workflows`)).body.workflows,
    ).toEqual([]);

    const broken = await setup(() => 'not a plan');
    const failed = await broken.draft({ intent: 'Cada lunes revisa las ventas' });
    expect(failed.body).toEqual({ status: 'failed', code: expect.any(String) });
    expect(JSON.stringify(failed.body)).not.toMatch(/planner|prompt|stack|alpha|token/i);
  });
});
