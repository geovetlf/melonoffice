import type { AIServicePricing, AIUsage, UsageRate } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { AI_USAGE_CAPABILITIES, isCapabilityId } from './capabilities.js';
import { createAICostEngine, UNIT_RATES_CALCULATOR, type UsageCalculator } from './engine.js';
import { AIUsageError } from './errors.js';
import { llmPricing, llmUsage, TOKEN_UNITS } from './llm.js';

/**
 * The AI Cost Engine (ADR-0073): one engine prices any capability in its own units, through
 * calculators; a cost it cannot account for is never guessed. Prices here are test fixtures.
 */

const priced = (rates: readonly UsageRate[], calculator = 'unit_rates') =>
  ({
    status: 'known',
    currency: 'USD',
    calculator,
    rates,
    version: 'fixture-1',
    effectiveAt: '2026-09-29',
    source: 'test fixture',
  }) as const;

const engine = createAICostEngine();

const cost = (pricing: AIServicePricing, usage: AIUsage, capability = 'image_generation') =>
  engine.cost({
    capability,
    provider: 'prov',
    model: 'model-x',
    operation: 'generate',
    pricing,
    usage,
  });

describe('AI Cost Engine', () => {
  it('prices a language model call in tokens', () => {
    const result = cost(
      priced([
        { unit: 'input_tokens', microUsd: 270_000, per: 1_000_000 },
        { unit: 'output_tokens', microUsd: 1_100_000, per: 1_000_000 },
      ]),
      {
        quantities: [
          { unit: 'input_tokens', quantity: 18_000 },
          { unit: 'output_tokens', quantity: 3_000 },
        ],
      },
      'llm',
    );
    // 18000 × 0.27 + 3000 × 1.10 = 4860 + 3300.
    expect(result).toMatchObject({
      capability: 'llm',
      actualMicroUsd: 8_160,
      currency: 'USD',
      units: ['input_tokens', 'output_tokens'],
      pricingVersion: 'fixture-1',
      pricingEffectiveAt: '2026-09-29',
      costBasis: 'provider_price_list',
    });
  });

  it('prices images and video by the matching dimensions, the most specific line first', () => {
    const images = priced([
      { unit: 'images', microUsd: 20_000, per: 1 },
      { unit: 'images', microUsd: 40_000, per: 1, when: { modelTier: 'hd' } },
    ]);
    expect(cost(images, { quantities: [{ unit: 'images', quantity: 4 }] }).actualMicroUsd).toBe(
      80_000,
    );
    expect(
      cost(images, {
        quantities: [{ unit: 'images', quantity: 4 }],
        dimensions: { modelTier: 'hd' },
      }).actualMicroUsd,
    ).toBe(160_000);
    const video = priced([
      { unit: 'seconds', microUsd: 100_000, per: 1, when: { resolution: '720p' } },
      { unit: 'seconds', microUsd: 250_000, per: 1, when: { resolution: '1080p' } },
    ]);
    expect(
      cost(
        video,
        { quantities: [{ unit: 'seconds', quantity: 12 }], dimensions: { resolution: '1080p' } },
        'video_transformation',
      ).actualMicroUsd,
    ).toBe(3_000_000);
    // A resolution with no price line: no cost, never a guess from another line.
    expect(
      cost(
        video,
        { quantities: [{ unit: 'seconds', quantity: 12 }], dimensions: { resolution: '4k' } },
        'video_transformation',
      ),
    ).toMatchObject({ actualMicroUsd: null, costBasis: 'price_unknown' });
  });

  it('counts fractional units exactly and rounds up once', () => {
    const speech = priced([{ unit: 'audio_seconds', microUsd: 100, per: 60 }]);
    // 90.5 s at 100 per 60 s = 150.83…, rounded up once.
    expect(
      cost(speech, { quantities: [{ unit: 'audio_seconds', quantity: 90.5 }] }, 'speech_to_text')
        .actualMicroUsd,
    ).toBe(151);
    const chars = priced([
      { unit: 'characters', microUsd: 1, per: 3 },
      { unit: 'audio_seconds', microUsd: 1, per: 3 },
    ]);
    // 1/3 + 1/3 = 2/3 → 1, not 2 as two separate roundings would give.
    expect(
      cost(
        chars,
        {
          quantities: [
            { unit: 'characters', quantity: 1 },
            { unit: 'audio_seconds', quantity: 1 },
          ],
        },
        'text_to_speech',
      ).actualMicroUsd,
    ).toBe(1);
  });

  it('gives no cost for an unknown price or a unit the price does not list', () => {
    expect(
      cost({ status: 'unknown' }, { quantities: [{ unit: 'pages', quantity: 3 }] }, 'ocr'),
    ).toMatchObject({ actualMicroUsd: null, costBasis: 'price_unknown', pricingVersion: null });
    const pages = priced([{ unit: 'pages', microUsd: 1_500, per: 1 }]);
    expect(
      cost(
        pages,
        {
          quantities: [
            { unit: 'pages', quantity: 3 },
            { unit: 'images', quantity: 1 },
          ],
        },
        'ocr',
      ).actualMicroUsd,
    ).toBeNull();
    // A unit used zero times needs no price.
    expect(
      cost(
        pages,
        {
          quantities: [
            { unit: 'pages', quantity: 3 },
            { unit: 'images', quantity: 0 },
          ],
        },
        'ocr',
      ).actualMicroUsd,
    ).toBe(4_500);
  });

  it('takes a calculator of its own for a price of another shape, without a new engine', () => {
    const perSession: UsageCalculator = {
      id: 'per_session_minimum',
      calculate: (pricing, usage) => {
        const sessions = usage.quantities.find((q) => q.unit === 'sessions')?.quantity ?? 0;
        const rate = pricing.rates.find((r) => r.unit === 'sessions');
        return rate === undefined ? undefined : Math.max(1, sessions) * rate.microUsd;
      },
    };
    const withBrowser = createAICostEngine([UNIT_RATES_CALCULATOR, perSession]);
    expect(
      withBrowser.cost({
        capability: 'browser_automation',
        provider: 'prov',
        model: 'browser-1',
        operation: 'run',
        pricing: priced([{ unit: 'sessions', microUsd: 5_000, per: 1 }], 'per_session_minimum'),
        usage: { quantities: [{ unit: 'sessions', quantity: 0 }] },
      }).actualMicroUsd,
    ).toBe(5_000);
    expect(() => createAICostEngine([UNIT_RATES_CALCULATOR, UNIT_RATES_CALCULATOR])).toThrow(
      AIUsageError,
    );
    expect(() => engine.checkPricing(priced([], 'per_session_minimum'))).toThrow(AIUsageError);
  });

  it('refuses bad prices and usage, and ids that are not codes', () => {
    expect(() => engine.checkPricing(priced([{ unit: 'images', microUsd: -1, per: 1 }]))).toThrow(
      AIUsageError,
    );
    expect(() => engine.checkPricing(priced([{ unit: 'images', microUsd: 1, per: 0 }]))).toThrow(
      AIUsageError,
    );
    expect(() =>
      cost({ status: 'unknown' }, { quantities: [{ unit: 'images', quantity: -1 }] }),
    ).toThrow(AIUsageError);
    expect(() =>
      cost({ status: 'unknown' }, { quantities: [{ unit: 'Free text!', quantity: 1 }] }),
    ).toThrow(AIUsageError);
    expect(() => cost({ status: 'unknown' }, { quantities: [] }, 'Image Generation')).toThrow(
      AIUsageError,
    );
  });

  it('names every capability asked for so far, all well-formed', () => {
    expect(AI_USAGE_CAPABILITIES).toContain('llm');
    expect(AI_USAGE_CAPABILITIES).toContain('video_transformation');
    expect(AI_USAGE_CAPABILITIES).toContain('computer_use');
    expect(AI_USAGE_CAPABILITIES.every(isCapabilityId)).toBe(true);
    expect(new Set(AI_USAGE_CAPABILITIES).size).toBe(AI_USAGE_CAPABILITIES.length);
  });
});

describe('language models in the usage layer', () => {
  const tokens = {
    status: 'known',
    currency: 'USD',
    inputMicroUsdPerMillionTokens: 1_000_000,
    outputMicroUsdPerMillionTokens: 4_000_000,
    source: 'test fixture',
    asOf: '2026-09-29',
  } as const;

  it('turns token prices and counts into unit rates and quantities', () => {
    const usage = { inputTokens: 1_000, outputTokens: 200, cachedInputTokens: 600 };
    // No cached price: cached input counted as input.
    expect(llmUsage(tokens, usage).quantities).toEqual([
      { unit: TOKEN_UNITS.input, quantity: 1_000 },
      { unit: TOKEN_UNITS.output, quantity: 200 },
    ]);
    const cachedPrice = { ...tokens, cachedInputMicroUsdPerMillionTokens: 100_000 };
    expect(llmUsage(cachedPrice, usage).quantities).toEqual([
      { unit: TOKEN_UNITS.input, quantity: 400 },
      { unit: TOKEN_UNITS.cachedInput, quantity: 600 },
      { unit: TOKEN_UNITS.output, quantity: 200 },
    ]);
    // 400 × 1 + 600 × 0.1 + 200 × 4 = 1260.
    expect(engine.estimate(llmPricing(cachedPrice), llmUsage(cachedPrice, usage))).toBe(1_260);
    expect(llmPricing({ status: 'unknown' })).toEqual({ status: 'unknown' });
  });
});
