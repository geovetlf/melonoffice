import type { AIModelPricing } from '@melonoffice/domain';
import type { ProviderUsage } from './adapter.js';

/**
 * The cost of a number of tokens, in millionths of a US dollar, rounded up. Undefined when the
 * model's price is unknown: an unknown price is never guessed.
 */
export function costMicroUsd(pricing: AIModelPricing, usage: ProviderUsage): number | undefined {
  if (pricing.status !== 'known') return undefined;
  return Math.ceil(
    (usage.inputTokens * pricing.inputMicroUsdPerMillionTokens +
      usage.outputTokens * pricing.outputMicroUsdPerMillionTokens) /
      1_000_000,
  );
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
