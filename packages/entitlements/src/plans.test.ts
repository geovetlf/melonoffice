import { describe, expect, it } from 'vitest';
import { createPlanCatalog, findPlan, PLAN_CATALOG, validatePlan, type PlanId } from './plans.js';
import { defaultValues, ENTITLEMENT_KEYS } from './registry.js';
import { resolveEntitlements } from './resolve.js';
import { fixturePlan, NOW, ORG } from './test-fixtures.js';

const active = PLAN_CATALOG.filter((plan) => plan.status === 'active');
const prepared = PLAN_CATALOG.filter((plan) => plan.status === 'prepared');

describe('plan catalogue', () => {
  it('has exactly one active, public and purchasable plan', () => {
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ visibility: 'public', purchasable: true });
    expect(PLAN_CATALOG.filter((plan) => plan.purchasable)).toEqual(active);
  });

  it('keeps the other plans prepared, hidden and not purchasable', () => {
    expect(prepared).toHaveLength(2);
    for (const plan of prepared) {
      expect(plan).toMatchObject({ visibility: 'hidden', purchasable: false, entitlements: {} });
    }
  });

  it('defines only the decided launch values: owner only (D-22), everything else pending (D-12)', () => {
    // Adding a commercial value here needs Geovet's decision; update this test with it.
    expect(active[0]?.entitlements).toEqual({ 'users.max': 1 });
  });

  it('resolves every pending launch value to deny or zero', () => {
    const plan = active[0];
    if (plan === undefined) throw new Error('no active plan');
    const { values } = resolveEntitlements({ orgId: ORG, plan, now: NOW });
    const defaults = defaultValues();
    for (const key of ENTITLEMENT_KEYS) {
      if (key === 'users.max') continue;
      expect(values[key], key).toEqual(defaults[key]);
    }
    expect(values['users.max']).toBe(1);
  });

  it('finds a plan only by its exact id and version', () => {
    const plan = active[0];
    if (plan === undefined) throw new Error('no active plan');
    expect(findPlan(PLAN_CATALOG, plan.id, plan.version)).toBe(plan);
    expect(findPlan(PLAN_CATALOG, plan.id, plan.version + 1)).toBeUndefined();
  });

  it('rejects invalid plans', () => {
    expect(() => validatePlan({ ...fixturePlan, version: 0 })).toThrow(/version/);
    expect(() =>
      validatePlan({ ...fixturePlan, status: 'prepared', visibility: 'public' }),
    ).toThrow(/prepared plan/);
    expect(() =>
      validatePlan({ ...fixturePlan, status: 'prepared', visibility: 'hidden', purchasable: true }),
    ).toThrow(/prepared plan/);
    expect(() => validatePlan({ ...fixturePlan, entitlements: { 'users.max': -3 } })).toThrow(
      /invalid value/,
    );
    expect(() => createPlanCatalog([fixturePlan, fixturePlan])).toThrow(/defined twice/);
    expect(() =>
      createPlanCatalog([fixturePlan, { ...fixturePlan, id: 'other' as PlanId }]),
    ).not.toThrow();
  });
});
