import type {
  AIServicePricing,
  AIUsage,
  AIUsageCapability,
  CostResult,
  UsageRate,
} from '@melonoffice/domain';
import { isCapabilityId, isDimension, isUnit, isUsageCode } from './capabilities.js';
import { AIUsageError } from './errors.js';

/**
 * The AI Cost Engine (ADR-0073): one engine for every AI capability. It does not know tokens,
 * images or seconds; calculators do. A calculator reads one shape of price; `unit_rates` reads
 * any linear price per unit (tokens, images, seconds, characters, pages, queries, actions), and
 * a capability whose price has another shape registers its own calculator here, not a new
 * engine. Every cost comes out as the same `CostResult`.
 *
 * An unknown price, a usage in a unit the price does not list, or a calculator that cannot say
 * gives no cost (`null`, `price_unknown`): a cost is never guessed.
 */
type KnownPricing = Extract<AIServicePricing, { status: 'known' }>;

export interface UsageCalculator {
  readonly id: string;
  /** The cost in millionths of a US dollar, rounded up; undefined when it cannot be computed. */
  calculate(
    pricing: Extract<AIServicePricing, { status: 'known' }>,
    usage: AIUsage,
  ): number | undefined;
}

export interface CostQuery {
  readonly capability: AIUsageCapability;
  readonly provider: string;
  readonly model: string;
  readonly operation: string;
  readonly pricing: AIServicePricing;
  readonly usage: AIUsage;
  /** What the operation was expected to cost before it ran, when known. */
  readonly estimatedMicroUsd?: number | null;
}

export interface AICostEngine {
  /** The cost of what an operation used. */
  cost(query: CostQuery): CostResult;
  /** The most an operation may cost, from the usage it may reach at most. */
  estimate(pricing: AIServicePricing, usage: AIUsage): number | undefined;
  /** Refuses a price no calculator here can read, or one that is not well-formed. */
  checkPricing(pricing: AIServicePricing): void;
}

/** The rates that apply to a unit: the one whose `when` matches the most dimensions. */
function rateFor(rates: readonly UsageRate[], unit: string, usage: AIUsage): UsageRate | undefined {
  let best: UsageRate | undefined;
  let bestSpecificity = -1;
  for (const rate of rates) {
    if (rate.unit !== unit) continue;
    const when = Object.entries(rate.when ?? {});
    if (!when.every(([k, v]) => usage.dimensions?.[k] === v)) continue;
    if (when.length > bestSpecificity) {
      best = rate;
      bestSpecificity = when.length;
    }
  }
  return best;
}

const gcd = (a: bigint, b: bigint): bigint => (b === 0n ? a : gcd(b, a % b));

/**
 * Linear prices per unit. Summed exactly (as a fraction) and rounded up once, so an operation is
 * never under-charged by rounding. A unit used with no price line for it: no cost.
 */
export const UNIT_RATES_CALCULATOR: UsageCalculator = Object.freeze({
  id: 'unit_rates',
  calculate(pricing: KnownPricing, usage: AIUsage) {
    let numerator = 0n;
    let denominator = 1n;
    for (const { unit, quantity } of usage.quantities) {
      if (quantity === 0) continue;
      const rate = rateFor(pricing.rates, unit, usage);
      if (rate === undefined) return undefined;
      // Fractional quantities (seconds) are counted in millionths, then rounded up at the end.
      const scaledQuantity = BigInt(Math.round(quantity * 1_000_000));
      const scaledPer = BigInt(rate.per) * 1_000_000n;
      numerator = numerator * scaledPer + scaledQuantity * BigInt(rate.microUsd) * denominator;
      denominator *= scaledPer;
      const divisor = gcd(numerator, denominator);
      if (divisor > 1n) {
        numerator /= divisor;
        denominator /= divisor;
      }
    }
    const whole = numerator / denominator;
    const cost = Number(numerator % denominator === 0n ? whole : whole + 1n);
    return Number.isSafeInteger(cost) ? cost : undefined;
  },
});

function checkUsage(usage: AIUsage): void {
  if (!Array.isArray(usage.quantities)) throw new AIUsageError('invalid_usage', 'quantities');
  const seen = new Set<string>();
  for (const q of usage.quantities) {
    if (!isUnit(q.unit)) throw new AIUsageError('invalid_usage', 'unit');
    if (seen.has(q.unit)) throw new AIUsageError('invalid_usage', 'duplicate_unit');
    seen.add(q.unit);
    if (typeof q.quantity !== 'number' || !Number.isFinite(q.quantity) || q.quantity < 0) {
      throw new AIUsageError('invalid_usage', 'quantity');
    }
  }
  for (const [k, v] of Object.entries(usage.dimensions ?? {})) {
    if (!isDimension(k) || !isUsageCode(v)) throw new AIUsageError('invalid_usage', 'dimension');
  }
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function createAICostEngine(
  calculators: readonly UsageCalculator[] = [UNIT_RATES_CALCULATOR],
): AICostEngine {
  const byId = new Map<string, UsageCalculator>();
  for (const calculator of calculators) {
    if (byId.has(calculator.id)) throw new AIUsageError('duplicate_calculator', calculator.id);
    byId.set(calculator.id, calculator);
  }

  function checkPricing(pricing: AIServicePricing): void {
    if (pricing.status === 'unknown') return;
    if (pricing.status !== 'known' || pricing.currency !== 'USD') {
      throw new AIUsageError('invalid_pricing', 'status');
    }
    if (!byId.has(pricing.calculator)) {
      throw new AIUsageError('unknown_calculator', pricing.calculator);
    }
    if (!isUsageCode(pricing.version) || !DATE.test(pricing.effectiveAt)) {
      throw new AIUsageError('invalid_pricing', 'version');
    }
    if (typeof pricing.source !== 'string' || pricing.source.length === 0) {
      throw new AIUsageError('invalid_pricing', 'source');
    }
    for (const rate of pricing.rates) {
      if (!isUnit(rate.unit)) throw new AIUsageError('invalid_pricing', 'unit');
      if (!Number.isSafeInteger(rate.microUsd) || rate.microUsd < 0) {
        throw new AIUsageError('invalid_pricing', 'microUsd');
      }
      if (!Number.isSafeInteger(rate.per) || rate.per < 1) {
        throw new AIUsageError('invalid_pricing', 'per');
      }
      for (const [k, v] of Object.entries(rate.when ?? {})) {
        if (!isDimension(k) || !isUsageCode(v)) throw new AIUsageError('invalid_pricing', 'when');
      }
    }
  }

  function amount(pricing: AIServicePricing, usage: AIUsage): number | undefined {
    checkUsage(usage);
    if (pricing.status !== 'known') return undefined;
    checkPricing(pricing);
    return byId.get(pricing.calculator)?.calculate(pricing, usage);
  }

  return Object.freeze({
    checkPricing,
    estimate: amount,
    cost(query: CostQuery): CostResult {
      if (!isCapabilityId(query.capability)) throw new AIUsageError('invalid_usage', 'capability');
      for (const code of [query.provider, query.model, query.operation]) {
        if (!isUsageCode(code)) throw new AIUsageError('invalid_usage', 'code');
      }
      const actual = amount(query.pricing, query.usage);
      const known = query.pricing.status === 'known' && actual !== undefined;
      return Object.freeze({
        capability: query.capability,
        provider: query.provider,
        model: query.model,
        operation: query.operation,
        usage: query.usage,
        units: Object.freeze(query.usage.quantities.map((q) => q.unit)),
        estimatedMicroUsd: query.estimatedMicroUsd ?? null,
        actualMicroUsd: known ? actual : null,
        currency: 'USD',
        pricingVersion: query.pricing.status === 'known' ? query.pricing.version : null,
        pricingEffectiveAt: query.pricing.status === 'known' ? query.pricing.effectiveAt : null,
        costBasis: known ? 'provider_price_list' : 'price_unknown',
      });
    },
  });
}
