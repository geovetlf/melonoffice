import { describe, expect, it } from 'vitest';
import {
  customerCreditsOf,
  providerCostCreditPolicy,
  type CustomerCreditInput,
} from './pricing.js';

const input = (providerCostMicroUsd: number): CustomerCreditInput => ({
  capability: 'text_to_speech',
  provider: 'p',
  model: 'm',
  operation: 'speak',
  providerCostMicroUsd,
});

describe('customer credit pricing (ADR-0081)', () => {
  it('charges the provider cost at the rate, rounded up, for any capability', () => {
    const policy = providerCostCreditPolicy(10_000);
    expect(policy).toMatchObject({ id: 'provider_cost_at_rate', version: '10000' });
    expect(customerCreditsOf(policy, input(0))).toBe(0);
    expect(customerCreditsOf(policy, input(1))).toBe(1);
    expect(customerCreditsOf(policy, input(20_001))).toBe(3);
  });

  it('refuses a rate that is not one, and a policy answer that is not whole credits', () => {
    expect(() => providerCostCreditPolicy(0)).toThrow('credit_rate');
    expect(() => providerCostCreditPolicy(1.5)).toThrow('credit_rate');
    for (const credits of [-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() =>
        customerCreditsOf({ id: 'x', version: 'v1', credits: () => credits }, input(1)),
      ).toThrow('credits');
    }
    expect(() =>
      customerCreditsOf({ id: 'free text', version: 'v1', credits: () => 0 }, input(1)),
    ).toThrow('credit_policy');
  });
});
