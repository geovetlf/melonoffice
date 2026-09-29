import type { AIModelPricing, AIServicePricing, AIUsage } from '@melonoffice/domain';
import { UNIT_RATES_CALCULATOR } from './engine.js';

/**
 * Language models in the AI Usage Layer (ADR-0073): their token prices and token counts as unit
 * rates and quantities, so the one cost engine prices them like any other capability. Cached
 * input has its own unit only when the model has a cached price; otherwise it is counted as any
 * other input, so a call is never under-charged.
 */
export const LLM_CAPABILITY = 'llm';

export const TOKEN_UNITS = Object.freeze({
  input: 'input_tokens',
  cachedInput: 'cached_input_tokens',
  output: 'output_tokens',
});

export function llmPricing(pricing: AIModelPricing): AIServicePricing {
  if (pricing.status !== 'known') return Object.freeze({ status: 'unknown' });
  const per = 1_000_000;
  return Object.freeze({
    status: 'known',
    currency: 'USD',
    calculator: UNIT_RATES_CALCULATOR.id,
    rates: Object.freeze([
      { unit: TOKEN_UNITS.input, microUsd: pricing.inputMicroUsdPerMillionTokens, per },
      { unit: TOKEN_UNITS.output, microUsd: pricing.outputMicroUsdPerMillionTokens, per },
      ...(pricing.cachedInputMicroUsdPerMillionTokens === undefined
        ? []
        : [
            {
              unit: TOKEN_UNITS.cachedInput,
              microUsd: pricing.cachedInputMicroUsdPerMillionTokens,
              per,
            },
          ]),
    ]),
    version: pricing.asOf,
    effectiveAt: pricing.asOf,
    source: pricing.source,
  });
}

export function llmUsage(
  pricing: AIModelPricing,
  usage: {
    readonly inputTokens: number;
    readonly outputTokens: number;
    readonly cachedInputTokens?: number;
  },
): AIUsage {
  const cached =
    pricing.status === 'known' && pricing.cachedInputMicroUsdPerMillionTokens !== undefined
      ? Math.min(usage.cachedInputTokens ?? 0, usage.inputTokens)
      : 0;
  return Object.freeze({
    quantities: Object.freeze([
      { unit: TOKEN_UNITS.input, quantity: usage.inputTokens - cached },
      ...(cached > 0 ? [{ unit: TOKEN_UNITS.cachedInput, quantity: cached }] : []),
      { unit: TOKEN_UNITS.output, quantity: usage.outputTokens },
    ]),
  });
}
