import type { IsoTimestamp, UserId } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { resolveEntitlements, limitForScope, type AddOn } from './resolve.js';
import { fixturePlan, NOW, ORG } from './test-fixtures.js';

const OPERATOR = 'user-operator' as UserId;
const LATER = '2026-10-26T12:00:00Z' as IsoTimestamp;
const EARLIER = '2026-08-26T12:00:00Z' as IsoTimestamp;

const extraSpecialists: AddOn = {
  id: 'addon-1',
  grants: {
    'agents.max': 2,
    'agents.perDepartmentMax': { default: 1, byScope: {} },
    'departments.allowed': ['research'],
    'automations.enabled': true,
  },
  expiresAt: LATER,
};

describe('resolveEntitlements', () => {
  it('starts from deny and applies the plan', () => {
    const { values, planId, planVersion, orgId } = resolveEntitlements({
      orgId: ORG,
      plan: fixturePlan,
      now: NOW,
    });
    expect({ orgId, planId, planVersion }).toEqual({
      orgId: ORG,
      planId: fixturePlan.id,
      planVersion: 1,
    });
    expect(values['agents.max']).toBe(10);
    expect(values['gia.voice']).toBe(true);
    expect(values['automations.enabled']).toBe(false);
    expect(values['storage.bytesMax']).toBe(0);
  });

  it('grants nothing from a plan that is not active', () => {
    const { values } = resolveEntitlements({
      orgId: ORG,
      plan: { ...fixturePlan, status: 'prepared', visibility: 'hidden', purchasable: false },
      now: NOW,
    });
    expect(values['agents.max']).toBe(0);
    expect(values['gia.text']).toBe(false);
  });

  it('adds active add-ons on top of the plan', () => {
    const { values } = resolveEntitlements({
      orgId: ORG,
      plan: fixturePlan,
      addOns: [extraSpecialists],
      now: NOW,
    });
    expect(values['agents.max']).toBe(12);
    expect(values['agents.perDepartmentMax']).toEqual({ default: 4, byScope: { marketing: 6 } });
    expect(values['departments.allowed']).toEqual(['marketing', 'finance', 'research']);
    expect(values['automations.enabled']).toBe(true);
  });

  it('ignores add-ons that expired, have an unreadable date, or are not allowed by the plan', () => {
    const expired = { ...extraSpecialists, expiresAt: EARLIER };
    const unreadable = { ...extraSpecialists, expiresAt: 'soon' as IsoTimestamp };
    for (const addOn of [expired, unreadable]) {
      const { values } = resolveEntitlements({
        orgId: ORG,
        plan: fixturePlan,
        addOns: [addOn],
        now: NOW,
      });
      expect(values['agents.max']).toBe(10);
    }
    const noAddOns = {
      ...fixturePlan,
      entitlements: { ...fixturePlan.entitlements, 'addons.allowed': false },
    };
    const { values } = resolveEntitlements({
      orgId: ORG,
      plan: noAddOns,
      addOns: [extraSpecialists],
      now: NOW,
    });
    expect(values['agents.max']).toBe(10);
  });

  it('treats unlimited as absorbing when adding', () => {
    const plan = {
      ...fixturePlan,
      entitlements: { ...fixturePlan.entitlements, 'agents.max': 'unlimited' as const },
    };
    const { values } = resolveEntitlements({
      orgId: ORG,
      plan,
      addOns: [extraSpecialists],
      now: NOW,
    });
    expect(values['agents.max']).toBe('unlimited');
  });

  it('applies audited overrides after add-ons and requires a reason', () => {
    const { values } = resolveEntitlements({
      orgId: ORG,
      plan: fixturePlan,
      addOns: [extraSpecialists],
      overrides: [{ key: 'agents.max', value: 1, reason: 'support case', approvedBy: OPERATOR }],
      now: NOW,
    });
    expect(values['agents.max']).toBe(1);
    expect(() =>
      resolveEntitlements({
        orgId: ORG,
        plan: fixturePlan,
        overrides: [{ key: 'agents.max', value: 1, reason: ' ', approvedBy: OPERATOR }],
        now: NOW,
      }),
    ).toThrow(/reason/);
    expect(() =>
      resolveEntitlements({
        orgId: ORG,
        plan: fixturePlan,
        overrides: [{ key: 'agents.max', value: true, reason: 'x', approvedBy: OPERATOR }],
        now: NOW,
      }),
    ).toThrow(/invalid value/);
  });

  it('lets a company lower a limit but never raise it', () => {
    const lowered = resolveEntitlements({
      orgId: ORG,
      plan: fixturePlan,
      companyLimits: { 'agents.max': 4 },
      now: NOW,
    });
    expect(lowered.values['agents.max']).toBe(4);
    const raised = resolveEntitlements({
      orgId: ORG,
      plan: fixturePlan,
      companyLimits: { 'agents.max': 50 },
      now: NOW,
    });
    expect(raised.values['agents.max']).toBe(10);
    const plan = {
      ...fixturePlan,
      entitlements: { ...fixturePlan.entitlements, 'agents.max': 'unlimited' as const },
    };
    const capped = resolveEntitlements({
      orgId: ORG,
      plan,
      companyLimits: { 'agents.max': 7 },
      now: NOW,
    });
    expect(capped.values['agents.max']).toBe(7);
  });

  it('rejects invalid company limits', () => {
    expect(() =>
      resolveEntitlements({
        orgId: ORG,
        plan: fixturePlan,
        companyLimits: { 'agents.max': -1 },
        now: NOW,
      }),
    ).toThrow(/invalid value/);
  });

  it('returns a frozen result', () => {
    const effective = resolveEntitlements({ orgId: ORG, plan: fixturePlan, now: NOW });
    expect(Object.isFrozen(effective)).toBe(true);
    expect(Object.isFrozen(effective.values)).toBe(true);
    expect(Object.isFrozen(effective.values['departments.allowed'])).toBe(true);
  });

  it('does not modify the plan it resolves', () => {
    const before = JSON.stringify(fixturePlan);
    resolveEntitlements({ orgId: ORG, plan: fixturePlan, addOns: [extraSpecialists], now: NOW });
    expect(JSON.stringify(fixturePlan)).toBe(before);
    expect(Object.isFrozen(fixturePlan.entitlements)).toBe(false);
    expect(Object.isFrozen(fixturePlan.entitlements['departments.allowed'])).toBe(false);
  });

  it('reads a per-scope cap with a fallback', () => {
    const effective = resolveEntitlements({ orgId: ORG, plan: fixturePlan, now: NOW });
    expect(limitForScope(effective, 'agents.perDepartmentMax', 'marketing')).toBe(5);
    expect(limitForScope(effective, 'agents.perDepartmentMax', 'finance')).toBe(3);
  });
});
