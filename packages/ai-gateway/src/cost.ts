import { createAICostEngine, llmPricing, llmUsage } from '@melonoffice/ai-usage';
import type { AIModelPricing } from '@melonoffice/domain';
import type { ProviderUsage } from './adapter.js';

/** The one AI Cost Engine (ADR-0073); language models are priced through its LLM calculator. */
const engine = createAICostEngine();

/**
 * The cost of a number of tokens, in millionths of a US dollar, rounded up. Undefined when the
 * model's price is unknown: an unknown price is never guessed. Cached input is priced at its own
 * price only when the model has one; otherwise as any other input.
 */
export function costMicroUsd(pricing: AIModelPricing, usage: ProviderUsage): number | undefined {
  return engine.estimate(llmPricing(pricing), llmUsage(pricing, usage));
}

/**
 * How many millionths of a US dollar one credit covers. The gateway takes it as configuration:
 * without one, no real call is charged or made.
 */
export interface CreditRate {
  readonly microUsdPerCredit: number;
}

/**
 * MelonOffice's credit rate (D-12, approved 2026-09-27): 1 credit = US$0.01. A call is charged
 * its real cost at this rate, rounded up to whole credits (`creditsFor`), never less.
 */
export const CREDIT_RATE: CreditRate = Object.freeze({ microUsdPerCredit: 10_000 });

/** Whole credits for a cost, rounded up so a call is never under-charged. */
export const creditsFor = (cost: number, rate: CreditRate): number =>
  Math.ceil(cost / rate.microUsdPerCredit);
