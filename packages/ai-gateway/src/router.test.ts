import type {
  AIModelDefinition,
  AIProviderDefinition,
  AIRoutingStrategy,
  ModelPolicy,
  PolicyId,
} from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import type { ProviderAdapter } from './adapter.js';
import { costMicroUsd } from './cost.js';
import { AIConfigError } from './errors.js';
import { createProviderHealthTracker } from './health.js';
import { checkModelPolicy, DEFAULT_MODEL_POLICY } from './policy.js';
import { createProviderRegistry } from './registry.js';
import { checkAIRequest } from './request.js';
import { routeModel, type RouteRequest } from './router.js';

/**
 * The LLM Router (ADR-0072): routing strategies order the models that fit, and never bring back
 * one a rule left out; provider health is learned from calls and skips a failing provider.
 */

const provider = (id: string, extra: Partial<AIProviderDefinition> = {}): AIProviderDefinition => ({
  id,
  name: `Test ${id}`,
  status: 'active',
  access: 'official',
  capabilities: ['text_generation', 'structured_output', 'reasoning'],
  modalities: ['text'],
  environments: ['dev'],
  credential: { provider: `${id}_api`, scopes: [] },
  maxSensitivity: 'confidential',
  ...extra,
});

const price = (input: number, output: number, cached?: number) =>
  ({
    status: 'known',
    currency: 'USD',
    inputMicroUsdPerMillionTokens: input,
    outputMicroUsdPerMillionTokens: output,
    ...(cached === undefined ? {} : { cachedInputMicroUsdPerMillionTokens: cached }),
    source: 'test fixture',
    asOf: '2026-09-29',
  }) as const;

const model = (
  providerId: string,
  modelId: string,
  extra: Partial<AIModelDefinition> = {},
): AIModelDefinition => ({
  providerId,
  modelId,
  version: 'v1',
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
  pricing: price(1_000_000, 4_000_000),
  environments: ['dev'],
  maxSensitivity: 'confidential',
  ...extra,
});

const adapter = (providerId: string): ProviderAdapter => ({
  providerId,
  adapterVersion: '1',
  capabilities: () => ['text_generation', 'structured_output', 'reasoning'],
  health: async () => 'available',
  generate: async () => ({ status: 'error', kind: 'unavailable' }),
});

/** Four models with different price, quality and speed, on two providers. */
const registry = createProviderRegistry({
  providers: [provider('gem'), provider('deep', { maxSensitivity: 'internal' })],
  models: [
    // Cheapest, basic quality, fast.
    model('gem', 'lite', { quality: 'basic', latency: 'fast', pricing: price(100_000, 400_000) }),
    // Standard quality, cheaper than `pro`.
    model('deep', 'chat', {
      quality: 'standard',
      pricing: price(300_000, 1_000_000),
      maxSensitivity: 'internal',
      priority: 5,
    }),
    // High quality, most expensive, slow.
    model('gem', 'pro', { quality: 'high', latency: 'slow', pricing: price(2_000_000, 8_000_000) }),
    // High quality reasoning, mid price, slow.
    model('deep', 'reasoner', {
      quality: 'high',
      latency: 'slow',
      capabilities: ['text_generation', 'reasoning'],
      pricing: price(600_000, 2_000_000),
      maxSensitivity: 'internal',
      priority: 1,
    }),
  ],
  adapters: [adapter('gem'), adapter('deep')],
});

const policy = (extra: Partial<ModelPolicy> = {}): ModelPolicy => ({
  ...DEFAULT_MODEL_POLICY,
  id: 'test_policy' as PolicyId,
  maxSensitivity: 'confidential',
  ...extra,
});

const route: RouteRequest = {
  capability: 'text_generation',
  inputModalities: ['text'],
  outputModality: 'text',
  sensitivity: 'internal',
  estimatedInputTokens: 1_000,
  maxOutputTokens: 500,
};

const order = (strategy?: AIRoutingStrategy, extra: Partial<RouteRequest> = {}, p = policy()) => {
  const decision = routeModel(registry, p, 'dev', {
    ...route,
    ...extra,
    ...(strategy === undefined ? {} : { strategy }),
  });
  if (decision.status !== 'selected') throw new Error(decision.reason);
  return decision.candidates.map((c) => `${c.provider.id}/${c.model.modelId}`);
};

describe('routing strategies', () => {
  it('balanced (the default) picks the cheapest model of at least standard quality', () => {
    expect(order()).toEqual(['deep/chat', 'deep/reasoner', 'gem/pro', 'gem/lite']);
    const decision = routeModel(registry, policy(), 'dev', route);
    expect(decision).toMatchObject({ status: 'selected', strategy: 'balanced' });
  });

  it('cost_optimized picks the cheapest that fits, whatever its quality', () => {
    expect(order('cost_optimized')[0]).toBe('gem/lite');
  });

  it('quality_first picks the best, then the cheapest among equals', () => {
    expect(order('quality_first').slice(0, 2)).toEqual(['deep/reasoner', 'gem/pro']);
  });

  it('latency_first picks the fastest, then the cheapest', () => {
    expect(order('latency_first')[0]).toBe('gem/lite');
    expect(order('latency_first').slice(-2)).toEqual(['deep/reasoner', 'gem/pro']);
  });

  it('reliability_first puts healthy providers first, then the model priority', () => {
    expect(order('reliability_first')[0]).toBe('deep/reasoner');
    const decision = routeModel(
      registry,
      policy(),
      'dev',
      { ...route, strategy: 'reliability_first' },
      new Set(),
      (id) => (id === 'deep' ? 'degraded' : 'available'),
    );
    if (decision.status !== 'selected') throw new Error(decision.reason);
    expect(decision.candidates[0]?.provider.id).toBe('gem');
  });

  it('takes the policy strategy unless the request asks for one', () => {
    expect(order(undefined, {}, policy({ strategy: 'cost_optimized' }))[0]).toBe('gem/lite');
    expect(order('quality_first', {}, policy({ strategy: 'cost_optimized' }))[0]).toBe(
      'deep/reasoner',
    );
  });

  it('keeps the preferred list first under every strategy', () => {
    const preferred = policy({ preferred: ['gem/pro'] });
    for (const s of ['cost_optimized', 'balanced', 'latency_first'] as const) {
      expect(order(s, {}, preferred)[0]).toBe('gem/pro');
    }
  });

  it('never brings back a model the rules left out: sensitivity, capability, budget, context', () => {
    // Confidential data: the provider capped at `internal` is out whatever the strategy.
    expect(order('reliability_first', { sensitivity: 'confidential' })).toEqual([
      'gem/lite',
      'gem/pro',
    ]);
    expect(order('cost_optimized', { capability: 'reasoning' })).toEqual(['deep/reasoner']);
    // A budget: the best that fits it, never a dearer one.
    expect(order('quality_first', { maxCostMicroUsd: 1_000 })).toEqual(['deep/chat', 'gem/lite']);
    expect(
      routeModel(registry, policy(), 'dev', { ...route, estimatedInputTokens: 200_000 }),
    ).toEqual({ status: 'none', reason: 'requirements_unmet' });
    expect(
      routeModel(registry, policy({ allowedProviders: ['deep'] }), 'dev', {
        ...route,
        sensitivity: 'confidential',
      }),
    ).toEqual({ status: 'none', reason: 'sensitivity_not_allowed' });
  });

  it('leaves out a disabled model and a disabled provider', () => {
    const disabled = createProviderRegistry({
      providers: [provider('gem'), provider('deep', { status: 'disabled' })],
      models: [
        model('gem', 'lite', { status: 'disabled' }),
        model('gem', 'pro'),
        model('deep', 'x'),
      ],
      adapters: [adapter('gem'), adapter('deep')],
    });
    const decision = routeModel(disabled, policy(), 'dev', route);
    if (decision.status !== 'selected') throw new Error(decision.reason);
    expect(decision.candidates.map((c) => c.model.modelId)).toEqual(['pro']);
  });

  it('refuses unknown strategies in a policy and in a request', () => {
    expect(() => checkModelPolicy(policy({ strategy: 'fastest' as never }))).toThrow(AIConfigError);
    expect(
      checkAIRequest({
        requestId: 'r1',
        executionId: '33333333-3333-4333-8333-333333333333',
        specialistId: '44444444-4444-4444-8444-444444444444',
        taskType: 'summarise',
        capability: 'text_generation',
        messages: [{ role: 'user', content: [{ type: 'text', text: 'Hi' }] }],
        outputModality: 'text',
        maxOutputTokens: 10,
        sensitivity: 'internal',
        strategy: 'cheapest',
      }),
    ).toBe('invalid_request');
  });

  it('refuses a model with a bad priority, display name or cached price', () => {
    const build = (extra: Partial<AIModelDefinition>) => () =>
      createProviderRegistry({
        providers: [provider('gem')],
        models: [model('gem', 'x', extra)],
        adapters: [adapter('gem')],
      });
    expect(build({ priority: -1 })).toThrow(AIConfigError);
    expect(build({ displayName: '' })).toThrow(AIConfigError);
    expect(build({ pricing: { ...price(1, 1), cachedInputMicroUsdPerMillionTokens: -1 } })).toThrow(
      AIConfigError,
    );
    expect(build({ displayName: 'Gem X', priority: 3 })).not.toThrow();
  });
});

describe('cost with cached input', () => {
  it('charges cached input at its own price only when the model has one', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 0, cachedInputTokens: 600_000 };
    expect(costMicroUsd(price(1_000_000, 0, 100_000), usage)).toBe(460_000);
    // No cached price: every input token at the input price, never under-charged.
    expect(costMicroUsd(price(1_000_000, 0), usage)).toBe(1_000_000);
    // A provider claiming more cached tokens than input is capped at the input.
    expect(
      costMicroUsd(price(1_000_000, 0, 0), {
        inputTokens: 10,
        outputTokens: 0,
        cachedInputTokens: 99,
      }),
    ).toBe(0);
    expect(costMicroUsd({ status: 'unknown' }, usage)).toBeUndefined();
  });
});

describe('provider health', () => {
  it('skips a provider after repeated transient failures, then tries it again as degraded', () => {
    let at = 0;
    const health = createProviderHealthTracker({
      failureThreshold: 3,
      windowMs: 10_000,
      cooldownMs: 5_000,
      now: () => at,
    });
    health.record('gem', 'rate_limited');
    expect(health.status('gem')).toBe('degraded');
    health.record('gem', 'timeout');
    expect(health.unavailable().size).toBe(0);
    health.record('gem', 'server_error');
    expect([...health.unavailable()]).toEqual(['gem']);
    expect(health.status('gem')).toBe('unavailable');
    expect(
      routeModel(
        registry,
        policy({ allowedProviders: ['gem'] }),
        'dev',
        route,
        health.unavailable(),
      ),
    ).toEqual({
      status: 'none',
      reason: 'provider_unavailable',
    });
    at = 5_001;
    expect(health.unavailable().size).toBe(0);
    expect(health.status('gem')).toBe('degraded');
    health.record('gem', 'success');
    expect(health.status('gem')).toBe('available');
  });

  it('counts only transient failures, within the window', () => {
    let at = 0;
    const health = createProviderHealthTracker({
      failureThreshold: 2,
      windowMs: 1_000,
      now: () => at,
    });
    // A refused request says nothing about the provider.
    health.record('deep', 'invalid_request');
    health.record('deep', 'authentication');
    health.record('deep', 'context_overflow');
    expect(health.status('deep')).toBe('available');
    health.record('deep', 'unavailable');
    at = 2_000;
    health.record('deep', 'unavailable');
    // The first failure is outside the window: one failure, not two.
    expect(health.unavailable().size).toBe(0);
  });
});

describe('preferred providers and a quality floor (ADR-0100)', () => {
  it('evaluates a preferred provider first, then falls back to the others in strategy order', () => {
    const p = policy({ preferredProviders: ['gem'] });
    expect(order('cost_optimized', {}, p)).toEqual([
      'gem/lite',
      'gem/pro',
      'deep/chat',
      'deep/reasoner',
    ]);
    const decision = routeModel(registry, p, 'dev', route);
    expect(decision).toMatchObject({ status: 'selected', reason: 'preferred' });
  });

  it('never brings back a preferred provider a rule left out', () => {
    // `deep` takes at most internal data: a confidential call never reaches it.
    const p = policy({ preferredProviders: ['deep'] });
    expect(order(undefined, { sensitivity: 'confidential' }, p)).toEqual(['gem/pro', 'gem/lite']);
    // Down: the next provider serves.
    const down = routeModel(registry, p, 'dev', route, new Set(['deep']));
    expect(down.status === 'selected' && down.candidates.map((c) => c.provider.id)).toEqual([
      'gem',
      'gem',
    ]);
    // Not supporting what the call needs (reasoning): only the model that does.
    expect(order(undefined, { capability: 'reasoning' }, p)).toEqual(['deep/reasoner']);
  });

  it("applies the policy's quality floor, and the higher of it and the call's", () => {
    const p = policy({ minimumQuality: 'standard' });
    expect(order('cost_optimized', {}, p)).not.toContain('gem/lite');
    expect(order('cost_optimized', { quality: 'high' }, p)).toEqual(['deep/reasoner', 'gem/pro']);
    expect(
      routeModel(registry, policy({ minimumQuality: 'high' }), 'dev', {
        ...route,
        sensitivity: 'confidential',
        capability: 'reasoning',
      }),
    ).toEqual({ status: 'none', reason: 'sensitivity_not_allowed' });
  });

  it('refuses a policy with an unknown preferred provider or floor', () => {
    expect(() => checkModelPolicy(policy({ preferredProviders: ['Bad Id'] }))).toThrow(
      AIConfigError,
    );
    expect(() => checkModelPolicy(policy({ minimumQuality: 'best' as never }))).toThrow(
      AIConfigError,
    );
  });
});
