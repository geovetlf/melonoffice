import { inspect } from 'node:util';
import type {
  AIModelDefinition,
  AIProviderDefinition,
  ModelPolicy,
  PolicyId,
} from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import {
  allowsFallback,
  isTransient,
  ProviderCredential,
  type ProviderAdapter,
} from './adapter.js';
import { costMicroUsd, creditsFor } from './cost.js';
import { creditReferenceOf } from './credits.js';
import { AIConfigError } from './errors.js';
import { checkModelPolicy, createModelPolicyCatalogue, DEFAULT_MODEL_POLICY } from './policy.js';
import {
  AI_MODEL_CATALOGUE,
  AI_PROVIDER_CATALOGUE,
  createProviderRegistry,
  defaultProviderRegistry,
} from './registry.js';
import {
  checkAIRequest,
  estimateInputTokens,
  inputModalitiesOf,
  type AIRequest,
} from './request.js';
import { checkProviderSuccess } from './response.js';
import { routeModel, type RouteRequest } from './router.js';
import { looksLikeSecretText } from './secrets.js';

/** Credential-shaped test values, built at run time so secret scanners do not flag the source. */
const fake = (...parts: string[]) => parts.join('');
const LEAKED_KEY = fake('sk', '-abcdefghijklmnopqrstuvwxyz123456');

const provider = (
  id: string,
  overrides: Partial<AIProviderDefinition> = {},
): AIProviderDefinition => ({
  id,
  name: `Test ${id}`,
  status: 'active',
  access: 'official',
  capabilities: ['text_generation'],
  modalities: ['text'],
  environments: ['dev'],
  credential: { provider: `${id}_api`, scopes: [] },
  maxSensitivity: 'internal',
  ...overrides,
});

const model = (
  providerId: string,
  modelId: string,
  overrides: Partial<AIModelDefinition> = {},
): AIModelDefinition => ({
  providerId,
  modelId,
  version: '1',
  status: 'active',
  capabilities: ['text_generation'],
  inputModalities: ['text'],
  outputModalities: ['text'],
  contextWindowTokens: 10_000,
  maxOutputTokens: 1_000,
  structuredOutput: false,
  toolUse: false,
  streaming: false,
  quality: 'standard',
  latency: 'standard',
  pricing: {
    status: 'known',
    currency: 'USD',
    inputMicroUsdPerMillionTokens: 1_000_000,
    outputMicroUsdPerMillionTokens: 2_000_000,
    source: 'test fixture',
    asOf: '2026-09-01',
  },
  environments: ['dev'],
  maxSensitivity: 'internal',
  ...overrides,
});

const adapter = (providerId: string, capabilities = ['text_generation']): ProviderAdapter => ({
  providerId,
  adapterVersion: '1.0.0',
  generate: async () => ({ status: 'error', kind: 'unavailable' }),
  capabilities: () => capabilities as never,
  health: async () => 'available',
});

const registryOf = (models: AIModelDefinition[], providers = [provider('alpha')]) =>
  createProviderRegistry({ providers, models, adapters: providers.map((p) => adapter(p.id)) });

const policy = (overrides: Partial<ModelPolicy> = {}): ModelPolicy => ({
  ...DEFAULT_MODEL_POLICY,
  id: 'test_policy' as PolicyId,
  ...overrides,
});

const route: RouteRequest = {
  capability: 'text_generation',
  inputModalities: ['text'],
  outputModality: 'text',
  sensitivity: 'internal',
  estimatedInputTokens: 100,
  maxOutputTokens: 100,
};

describe('provider registry', () => {
  it('is empty until the launch provider is decided (D-7)', () => {
    expect(AI_PROVIDER_CATALOGUE).toEqual([]);
    expect(AI_MODEL_CATALOGUE).toEqual([]);
    const registry = defaultProviderRegistry();
    expect(registry.models()).toEqual([]);
    expect(routeModel(registry, DEFAULT_MODEL_POLICY, 'dev', route)).toEqual({
      status: 'none',
      reason: 'no_model_available',
    });
  });

  it('refuses intermediaries and anything but official APIs', () => {
    for (const id of ['openrouter', 'replicate', 'fal-ai', 'together', 'huggingface', 'hf']) {
      expect(() => registryOf([], [provider(id)])).toThrow(AIConfigError);
    }
    expect(() => registryOf([], [provider('alpha', { name: 'Alpha via OpenRouter' })])).toThrow(
      /intermediary/,
    );
    expect(() => registryOf([], [provider('alpha', { access: 'reseller' as never })])).toThrow(
      /provider.access/,
    );
  });

  it('holds credential references only, never a value', () => {
    const withValue = provider('alpha', {
      credential: { provider: 'alpha_api', scopes: [], value: LEAKED_KEY } as never,
    });
    expect(() => registryOf([], [withValue])).toThrow(/provider.credential/);
  });

  it('refuses a model that claims more than its provider', () => {
    expect(() => registryOf([model('alpha', 'm', { capabilities: ['embeddings'] })])).toThrow(
      /capabilities/,
    );
    expect(() => registryOf([model('alpha', 'm', { maxSensitivity: 'restricted' })])).toThrow(
      /maxSensitivity/,
    );
    expect(() => registryOf([model('beta', 'm')])).toThrow(/model.provider/);
  });

  it('needs exactly one capable adapter per provider', () => {
    const p = provider('alpha');
    expect(() => createProviderRegistry({ providers: [p], models: [], adapters: [] })).toThrow(
      /adapter.missing/,
    );
    expect(() =>
      createProviderRegistry({ providers: [p], models: [], adapters: [adapter('alpha', [])] }),
    ).toThrow(/adapter.capabilities/);
    expect(() =>
      createProviderRegistry({
        providers: [p],
        models: [],
        adapters: [adapter('alpha'), adapter('alpha')],
      }),
    ).toThrow(/adapter.duplicate/);
  });

  it('refuses a malformed price and accepts an unknown one', () => {
    const bad = { status: 'known', currency: 'EUR' } as never;
    expect(() => registryOf([model('alpha', 'm', { pricing: bad })])).toThrow(/pricing/);
    expect(
      registryOf([model('alpha', 'm', { pricing: { status: 'unknown' } })]).models(),
    ).toHaveLength(1);
  });

  it('is frozen and sorted', () => {
    const registry = registryOf([model('alpha', 'z'), model('alpha', 'a')]);
    expect(registry.models().map((r) => r.model.modelId)).toEqual(['a', 'z']);
    expect(Object.isFrozen(registry.models()[0]?.model.capabilities)).toBe(true);
  });
});

describe('model policies', () => {
  it('checks every field', () => {
    expect(() => checkModelPolicy(policy({ maxAttempts: 0 }))).toThrow(AIConfigError);
    expect(() => checkModelPolicy(policy({ maxAttempts: 6 }))).toThrow(AIConfigError);
    expect(() => checkModelPolicy(policy({ backoffMs: 60_000 }))).toThrow(AIConfigError);
    expect(() => checkModelPolicy(policy({ allowedModels: ['no-slash'] }))).toThrow(AIConfigError);
  });

  it('resolves the default, or exactly the named version, never a guess', () => {
    const v2 = policy({ version: 2 });
    const catalogue = createModelPolicyCatalogue([v2]);
    expect(catalogue.resolve(undefined)?.id).toBe(DEFAULT_MODEL_POLICY.id);
    expect(catalogue.resolve({ id: 'test_policy', version: 2 })?.version).toBe(2);
    expect(catalogue.resolve({ id: 'test_policy', version: 1 })).toBeUndefined();
    expect(() => createModelPolicyCatalogue([v2, v2])).toThrow(/duplicate/);
  });
});

describe('router', () => {
  const registry = registryOf([
    model('alpha', 'cheap', { quality: 'basic', latency: 'fast' }),
    model('alpha', 'best', { quality: 'high' }),
    model('alpha', 'unpriced', { quality: 'high', pricing: { status: 'unknown' } }),
    model('alpha', 'prod-only', { environments: ['prod'] }),
  ]);

  it('is deterministic: preferred first, then quality, cost, latency and id', () => {
    const pick = (p: ModelPolicy) => {
      const decision = routeModel(registry, p, 'dev', route);
      return decision.status === 'selected'
        ? decision.candidates.map((c) => c.model.modelId)
        : decision.reason;
    };
    expect(pick(policy())).toEqual(['best', 'unpriced', 'cheap']);
    expect(pick(policy())).toEqual(pick(policy()));
    expect(pick(policy({ preferred: ['alpha/cheap'] }))).toEqual(['cheap', 'best', 'unpriced']);
  });

  it('never lets dev imply prod', () => {
    const only = policy({ allowedModels: ['alpha/prod-only'] });
    expect(routeModel(registry, only, 'dev', route)).toMatchObject({
      reason: 'environment_not_allowed',
    });
  });

  it('leaves out an unknown price whenever there is a cost limit', () => {
    const decision = routeModel(registry, policy(), 'dev', { ...route, maxCostMicroUsd: 1_000 });
    expect(decision.status).toBe('selected');
    if (decision.status === 'selected') {
      expect(decision.candidates.map((c) => c.model.modelId)).not.toContain('unpriced');
    }
    const onlyUnpriced = policy({ allowedModels: ['alpha/unpriced'] });
    expect(
      routeModel(registry, onlyUnpriced, 'dev', { ...route, maxCostMicroUsd: 1_000_000 }),
    ).toMatchObject({ reason: 'cost_limit_exceeded' });
  });

  it('refuses data above what a model is cleared for, and skips providers that are down', () => {
    expect(
      routeModel(registry, policy(), 'dev', { ...route, sensitivity: 'restricted' }),
    ).toMatchObject({ reason: 'sensitivity_not_allowed' });
    expect(routeModel(registry, policy(), 'dev', route, new Set(['alpha']))).toMatchObject({
      reason: 'provider_unavailable',
    });
  });
});

describe('requests', () => {
  const base = {
    requestId: 'req-1',
    executionId: '11111111-1111-4111-8111-111111111111',
    specialistId: '22222222-2222-4222-8222-222222222222',
    taskType: 'summarise',
    capability: 'text_generation',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello there' }] }],
    outputModality: 'text',
    maxOutputTokens: 100,
    sensitivity: 'internal',
  };

  it('accepts a well-formed request and refuses anything else', () => {
    expect(checkAIRequest(base)).toBeUndefined();
    expect(checkAIRequest({ ...base, extra: 1 })).toBe('invalid_request');
    expect(checkAIRequest({ ...base, capability: 'mind_reading' })).toBe('invalid_request');
    expect(checkAIRequest({ ...base, messages: [] })).toBe('invalid_request');
    expect(checkAIRequest(null)).toBe('invalid_request');
  });

  it('calls authority and secrets by their name, wherever they are', () => {
    expect(checkAIRequest({ ...base, organizationId: 'x' })).toBe('authority_in_input');
    expect(checkAIRequest({ ...base, requirements: { apiKey: 'x' } })).toBe('authority_in_input');
    const secret = [{ role: 'user', content: [{ type: 'text', text: `use "${LEAKED_KEY}"` }] }];
    expect(checkAIRequest({ ...base, messages: secret })).toBe('secret_in_input');
    expect(checkAIRequest({ ...base, messages: secret, capability: 'nope' })).toBe(
      'secret_in_input',
    );
  });

  it('estimates tokens and modalities deterministically', () => {
    const request = {
      ...base,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: '12345678' },
            { type: 'image', ref: { type: 'document', id: 'doc-1' } },
          ],
        },
      ],
    } as AIRequest;
    expect(estimateInputTokens(request)).toBe(1_002);
    expect(inputModalitiesOf(request)).toEqual(['text', 'image']);
  });

  it('spots credentials in free text', () => {
    expect(looksLikeSecretText(`key: ${LEAKED_KEY}.`)).toBe(true);
    expect(looksLikeSecretText(fake('Bearer ', 'abcdefghijklmnop'))).toBe(true);
    expect(looksLikeSecretText(fake('-----BEGIN RSA ', 'PRIVATE KEY-----'))).toBe(true);
    expect(looksLikeSecretText('A normal sentence about melons.')).toBe(false);
  });
});

describe('provider answers, errors and credentials', () => {
  const ok = {
    status: 'success' as const,
    output: { text: 'Fine.' },
    usage: { inputTokens: 1, outputTokens: 1 },
    finishReason: 'stop' as const,
  };

  it('passes only well-formed answers without secrets', () => {
    expect(checkProviderSuccess(ok)).toBe(true);
    expect(checkProviderSuccess({ ...ok, output: { text: LEAKED_KEY } })).toBe(false);
    expect(checkProviderSuccess({ ...ok, output: { structured: { k: LEAKED_KEY } } })).toBe(false);
    expect(checkProviderSuccess({ ...ok, output: { text: 'x', html: 'y' } as never })).toBe(false);
    expect(checkProviderSuccess({ ...ok, usage: { inputTokens: -1, outputTokens: 0 } })).toBe(
      false,
    );
    expect(checkProviderSuccess({ ...ok, finishReason: 'exploded' as never })).toBe(false);
  });

  it('retries only transient errors, and falls back only where another model may help', () => {
    for (const kind of ['timeout', 'network', 'rate_limited', 'server_error'] as const) {
      expect(isTransient(kind)).toBe(true);
    }
    for (const kind of ['invalid_request', 'content_policy', 'authentication'] as const) {
      expect(isTransient(kind)).toBe(false);
    }
    expect(allowsFallback('authentication')).toBe(true);
    expect(allowsFallback('invalid_request')).toBe(false);
    expect(allowsFallback('content_policy')).toBe(false);
  });

  it('never prints a resolved credential', () => {
    const credential = new ProviderCredential(LEAKED_KEY);
    for (const printed of [
      JSON.stringify({ credential }),
      String(credential),
      `${credential}`,
      inspect(credential),
    ]) {
      expect(printed).not.toContain(LEAKED_KEY);
    }
    expect(credential.reveal()).toBe(LEAKED_KEY);
  });
});

describe('cost and credits', () => {
  const pricing = model('alpha', 'm').pricing;

  it('rounds up, and never guesses an unknown price', () => {
    expect(costMicroUsd(pricing, { inputTokens: 1, outputTokens: 1 })).toBe(3);
    expect(costMicroUsd(pricing, { inputTokens: 0, outputTokens: 0 })).toBe(0);
    expect(
      costMicroUsd({ status: 'unknown' }, { inputTokens: 1, outputTokens: 1 }),
    ).toBeUndefined();
    expect(creditsFor(1, { microUsdPerCredit: 1_000 })).toBe(1);
    expect(creditsFor(2_001, { microUsdPerCredit: 1_000 })).toBe(3);
  });

  it('charges a request under one ledger reference', () => {
    expect(creditReferenceOf('req-1')).toBe('ai:req-1');
  });
});

describe("a model's recorded terms (ADR-0080)", () => {
  const terms = {
    offering: 'free_prototyping',
    production: 'requires_license',
    contentUse: 'may_be_used',
    source: 'https://example.com/terms',
    verifiedAt: '2026-09-29',
  } as const;
  const publicOnly = { maxSensitivity: 'public' as const, terms };

  it('registers a model with terms that fit where it runs and what it receives', () => {
    expect(registryOf([model('alpha', 'free', publicOnly)]).models()).toHaveLength(1);
    expect(
      registryOf([
        model('alpha', 'paid', {
          environments: ['dev', 'prod'],
          terms: { ...terms, offering: 'paid', production: 'allowed', contentUse: 'not_used' },
        }),
      ]).models(),
    ).toHaveLength(1);
  });

  it('refuses production for a model whose terms do not allow it', () => {
    for (const production of ['not_allowed', 'requires_license', 'unknown'] as const) {
      expect(() =>
        registryOf([
          model('alpha', 'free', {
            ...publicOnly,
            environments: ['dev', 'prod'],
            terms: { ...terms, production },
          }),
        ]),
      ).toThrow(AIConfigError);
    }
  });

  it('gives a model whose provider may use or keep what it is sent public data only', () => {
    for (const contentUse of ['may_be_used', 'unknown'] as const) {
      expect(() =>
        registryOf([
          model('alpha', 'free', { maxSensitivity: 'internal', terms: { ...terms, contentUse } }),
        ]),
      ).toThrow(AIConfigError);
    }
  });

  it('keeps a model the terms do not allow, or no longer offered, out of routing', () => {
    for (const offering of ['not_allowed', 'unavailable'] as const) {
      expect(() =>
        registryOf([model('alpha', 'm', { ...publicOnly, terms: { ...terms, offering } })]),
      ).toThrow(AIConfigError);
      expect(
        registryOf([
          model('alpha', 'm', { ...publicOnly, status: 'retired', terms: { ...terms, offering } }),
        ]).models(),
      ).toHaveLength(1);
    }
  });

  it('refuses terms without an official https source and a date, or with extra fields', () => {
    for (const bad of [
      { ...terms, source: 'blog post' },
      { ...terms, verifiedAt: 'yesterday' },
      { ...terms, offering: 'unlimited' },
      { ...terms, rateLimit: '40 rpm' },
    ]) {
      expect(() =>
        registryOf([model('alpha', 'm', { maxSensitivity: 'public', terms: bad as never })]),
      ).toThrow(AIConfigError);
    }
  });

  it('routes public data only to such a model', () => {
    const registry = registryOf([model('alpha', 'free', publicOnly)]);
    expect(routeModel(registry, DEFAULT_MODEL_POLICY, 'dev', route)).toEqual({
      status: 'none',
      reason: 'sensitivity_not_allowed',
    });
    expect(
      routeModel(registry, DEFAULT_MODEL_POLICY, 'dev', { ...route, sensitivity: 'public' }),
    ).toMatchObject({ status: 'selected' });
  });
});
