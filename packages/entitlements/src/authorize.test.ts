import { describe, expect, it } from 'vitest';
import { authorize, type AuthorizationRequest } from './authorize.js';
import { checkLimit } from './limits.js';
import { PLAN_CATALOG, type PlanConfig } from './plans.js';
import { resolveEntitlements } from './resolve.js';
import { actions, fixturePlan, NOW, ORG, OTHER_ORG, principal } from './test-fixtures.js';

const launchPlan = PLAN_CATALOG.find((plan) => plan.status === 'active');
if (launchPlan === undefined) throw new Error('no active plan');

const noFlags = new Set<string>();
const voiceFlag = new Set(['gia-voice']);

function request(plan: PlanConfig, overrides: Partial<AuthorizationRequest>): AuthorizationRequest {
  return {
    principal: principal(),
    action: actions.inviteMember,
    entitlements: resolveEntitlements({ orgId: ORG, plan, now: NOW }),
    releaseFlags: noFlags,
    ...overrides,
  };
}

/**
 * The same flows run against the launch plan and a fixture plan (plan §11A.4),
 * so the engine is proven for a second plan without shipping one.
 */
describe.each([
  {
    name: 'launch plan',
    plan: launchPlan,
    users: 1,
    agents: 0,
    departments: [] as string[],
    voice: false,
    credits: 0,
  },
  {
    name: 'fixture plan',
    plan: fixturePlan,
    users: 5,
    agents: 5,
    departments: ['marketing', 'finance'],
    voice: true,
    credits: 1000,
  },
])('key flows on the $name', ({ plan, users, agents, departments, voice, credits }) => {
  it('user invites stop at users.max', () => {
    expect(authorize(request(plan, { usage: users - 1 }))).toEqual({ allowed: true });
    expect(authorize(request(plan, { usage: users }))).toEqual({
      allowed: false,
      reason: 'limit_reached',
    });
  });

  it('specialists stop at the per-department cap', () => {
    const create = { action: actions.createSpecialist, scope: 'marketing' };
    if (agents > 0)
      expect(authorize(request(plan, { ...create, usage: agents - 1 }))).toEqual({ allowed: true });
    expect(authorize(request(plan, { ...create, usage: agents }))).toEqual({
      allowed: false,
      reason: 'limit_reached',
    });
  });

  it('only allowed department types can be opened', () => {
    for (const department of departments) {
      expect(
        authorize(request(plan, { action: actions.openDepartment, listItem: department })),
      ).toEqual({
        allowed: true,
      });
    }
    expect(
      authorize(request(plan, { action: actions.openDepartment, listItem: 'unknown' })),
    ).toEqual({
      allowed: false,
      reason: 'not_in_allowed_list',
    });
  });

  it('GIA voice needs the entitlement and the release flag', () => {
    const decision = authorize(
      request(plan, { action: actions.useVoice, releaseFlags: voiceFlag }),
    );
    expect(decision).toEqual(
      voice ? { allowed: true } : { allowed: false, reason: 'not_entitled' },
    );
  });

  it('the monthly credit grant comes from the plan', () => {
    const effective = resolveEntitlements({ orgId: ORG, plan, now: NOW });
    expect(effective.values['credits.monthlyIncluded']).toBe(credits);
  });
});

describe('authorize', () => {
  it('denies a request for another organization', () => {
    expect(
      authorize(request(fixturePlan, { principal: principal({ orgId: OTHER_ORG }), usage: 0 })),
    ).toEqual({
      allowed: false,
      reason: 'cross_tenant',
    });
  });

  it('denies without the role permission', () => {
    expect(
      authorize(
        request(fixturePlan, { principal: principal({ permissions: new Set() }), usage: 0 }),
      ),
    ).toEqual({
      allowed: false,
      reason: 'missing_permission',
    });
  });

  it('never lets GIA or a specialist run a governance action, even with the permission', () => {
    for (const kind of ['gia', 'specialist'] as const) {
      expect(
        authorize(
          request(fixturePlan, { principal: principal({ kind }), action: actions.changePlan }),
        ),
      ).toEqual({
        allowed: false,
        reason: 'governance_requires_user',
      });
    }
    expect(authorize(request(fixturePlan, { action: actions.changePlan }))).toEqual({
      allowed: true,
    });
  });

  it('lets GIA act only with the user permissions it carries', () => {
    const gia = principal({ kind: 'gia', permissions: new Set(['members.invite']) });
    expect(authorize(request(fixturePlan, { principal: gia, usage: 0 }))).toEqual({
      allowed: true,
    });
    expect(
      authorize(
        request(fixturePlan, {
          principal: gia,
          action: actions.createSpecialist,
          scope: 'marketing',
          usage: 0,
        }),
      ),
    ).toEqual({ allowed: false, reason: 'missing_permission' });
  });

  it('needs the release flag even when entitled', () => {
    expect(authorize(request(fixturePlan, { action: actions.useVoice }))).toEqual({
      allowed: false,
      reason: 'not_released',
    });
  });

  it('fails closed when usage, scope or the list item is missing or invalid', () => {
    expect(authorize(request(fixturePlan, {}))).toEqual({
      allowed: false,
      reason: 'usage_unknown',
    });
    expect(authorize(request(fixturePlan, { usage: -1 }))).toEqual({
      allowed: false,
      reason: 'usage_unknown',
    });
    expect(authorize(request(fixturePlan, { usage: 0, requested: 0 }))).toEqual({
      allowed: false,
      reason: 'usage_unknown',
    });
    expect(authorize(request(fixturePlan, { action: actions.createSpecialist, usage: 0 }))).toEqual(
      {
        allowed: false,
        reason: 'usage_unknown',
      },
    );
    expect(authorize(request(fixturePlan, { action: actions.openDepartment }))).toEqual({
      allowed: false,
      reason: 'not_in_allowed_list',
    });
  });

  it('checks a multi-unit request against what remains', () => {
    expect(authorize(request(fixturePlan, { usage: 3, requested: 2 }))).toEqual({ allowed: true });
    expect(authorize(request(fixturePlan, { usage: 3, requested: 3 }))).toEqual({
      allowed: false,
      reason: 'limit_reached',
    });
  });
});

describe('checkLimit', () => {
  const effective = resolveEntitlements({ orgId: ORG, plan: fixturePlan, now: NOW });

  it('reports what remains', () => {
    expect(checkLimit(effective, 'users.max', 2)).toEqual({
      allowed: true,
      limit: 5,
      used: 2,
      remaining: 3,
    });
    expect(checkLimit(effective, 'users.max', 7)).toEqual({
      allowed: false,
      limit: 5,
      used: 7,
      remaining: 0,
    });
  });

  it('never caps an unlimited value', () => {
    const plan = {
      ...fixturePlan,
      entitlements: { ...fixturePlan.entitlements, 'users.max': 'unlimited' as const },
    };
    const unlimited = resolveEntitlements({ orgId: ORG, plan, now: NOW });
    expect(checkLimit(unlimited, 'users.max', 1_000_000)).toMatchObject({
      allowed: true,
      remaining: 'unlimited',
    });
  });

  it('rejects invalid usage', () => {
    expect(() => checkLimit(effective, 'users.max', -1)).toThrow();
    expect(() => checkLimit(effective, 'users.max', 0, 0)).toThrow();
  });
});
