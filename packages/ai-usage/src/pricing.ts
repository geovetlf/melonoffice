import type { AIUsageCapability } from '@melonoffice/domain';
import { AIUsageError } from './errors.js';
import { isUsageCode } from './capabilities.js';

/**
 * Customer credit pricing (ADR-0081): how many credits the customer is charged for one AI
 * operation. It is kept apart from the provider's cost (the Cost Engine's `CostResult`), so a
 * free-to-MelonOffice call and a call charged to the customer stay two variables. Adapters never
 * price credits; the engine that charges (the gateway) asks the policy, so a new rule (a minimum,
 * a per-capability price, a free provider made paid) is a new policy, not an adapter change.
 */
export interface CustomerCreditInput {
  readonly capability: AIUsageCapability;
  readonly provider: string;
  readonly model: string;
  readonly operation: string;
  /** The provider's cost of the operation, in millionths of a US dollar. */
  readonly providerCostMicroUsd: number;
}

export interface CustomerCreditPolicy {
  /** A code naming the rule, kept on each usage event it priced. */
  readonly id: string;
  readonly version: string;
  /** Whole credits to charge; never negative. */
  credits(input: CustomerCreditInput): number;
}

/**
 * The approved rule (D-12, 1 credit = US$0.01): the provider's cost at the credit rate, rounded
 * up to whole credits. A call whose provider cost is 0 charges 0 credits; no minimum applies.
 */
export function providerCostCreditPolicy(microUsdPerCredit: number): CustomerCreditPolicy {
  if (!Number.isSafeInteger(microUsdPerCredit) || microUsdPerCredit <= 0) {
    throw new AIUsageError('invalid_usage', 'credit_rate');
  }
  return Object.freeze({
    id: 'provider_cost_at_rate',
    version: `${microUsdPerCredit}`,
    credits: (input: CustomerCreditInput) =>
      Math.ceil(Math.max(0, input.providerCostMicroUsd) / microUsdPerCredit),
  });
}

/** The policy's answer, checked: whole, non-negative credits, from a well-named policy. */
export function customerCreditsOf(
  policy: CustomerCreditPolicy,
  input: CustomerCreditInput,
): number {
  if (!isUsageCode(policy.id) || !isUsageCode(policy.version)) {
    throw new AIUsageError('invalid_usage', 'credit_policy');
  }
  const credits = policy.credits(input);
  if (!Number.isSafeInteger(credits) || credits < 0) {
    throw new AIUsageError('invalid_usage', 'credits');
  }
  return credits;
}
