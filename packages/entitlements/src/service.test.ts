import { actAsGia, type AuthenticatedContext } from '@melonoffice/auth';
import type {
  InitialBilling,
  MembershipStatus,
  Organization,
  OrganizationId,
  PlanRef,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import {
  createOrganization,
  InMemoryTenancyStore,
  isTenancyError,
  resolveTenant,
  type TenantContext,
} from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { createPlanCatalog, DEFAULT_PLAN, findPlan, PLAN_CATALOG, type PlanId } from './plans.js';
import { ENTITLEMENT_KEYS, kindOf } from './registry.js';
import {
  CAPABILITY_KEYS,
  createEntitlementService,
  LIMIT_KEYS,
  type EntitlementService,
  type PlanSource,
} from './service.js';
import { fixturePlan } from './test-fixtures.js';

const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const FIXTURE: PlanRef = { id: fixturePlan.id, version: fixturePlan.version };
/** The real catalogue plus the test-only fixture plan, which switches some capabilities on. */
const CATALOG = createPlanCatalog([...PLAN_CATALOG, fixturePlan]);

const as = (userId: UserId): AuthenticatedContext =>
  Object.freeze({ actor: 'user', userId, emailVerified: true });

/**
 * Stands in for billing (ADR-0022), which says which plan is in force for each organization.
 * Entitlements only resolves the reference; it never picks one.
 */
class Plans implements PlanSource {
  readonly byOrganization = new Map<string, PlanRef>();
  async currentPlan(organizationId: OrganizationId): Promise<PlanRef | undefined> {
    return this.byOrganization.get(organizationId);
  }
}

/** Tenancy needs billing to create an organization; its contents do not matter here. */
const BILLING = (organization: Organization): InitialBilling => {
  const subscriptionId = `sub-${organization.id}` as SubscriptionId;
  const at = organization.createdAt;
  return {
    account: { organizationId: organization.id, subscriptionId, createdAt: at, updatedAt: at },
    subscription: {
      id: subscriptionId,
      organizationId: organization.id,
      plan: DEFAULT_PLAN,
      status: 'active',
      createdAt: at,
      updatedAt: at,
    },
  };
};

/** Alice owns A on the default plan; Bob owns B on the fixture plan. */
async function world() {
  const store = new InMemoryTenancyStore();
  const a = await createOrganization(as(ALICE), { name: 'A' }, store, { billing: BILLING });
  const b = await createOrganization(as(BOB), { name: 'B' }, store, { billing: BILLING });
  const plans = new Plans();
  plans.byOrganization.set(a.organization.id, DEFAULT_PLAN);
  plans.byOrganization.set(b.organization.id, FIXTURE);
  const service = createEntitlementService({ organizations: store, plans, catalog: CATALOG });
  const tenantA = await resolveTenant(as(ALICE), a.organization.id, store);
  const tenantB = await resolveTenant(as(BOB), b.organization.id, store);
  return { store, plans, a, b, service, tenantA, tenantB };
}

/** Puts organization A on another plan, or none, as billing would. */
async function withPlanOfA(plan: PlanRef | undefined) {
  const w = await world();
  if (plan === undefined) w.plans.byOrganization.delete(w.a.organization.id);
  else w.plans.byOrganization.set(w.a.organization.id, plan);
  return w;
}

async function everyAnswer(service: EntitlementService, tenant: TenantContext) {
  return {
    entitlements: await service.entitlementsOf(tenant),
    capability: await service.hasCapability(tenant, 'gia.text'),
    limit: await service.getLimit(tenant, 'users.max'),
  };
}

describe('default plan', () => {
  it('is Emprendedor version 1, active in the catalogue and frozen', () => {
    expect(DEFAULT_PLAN).toEqual({ id: 'entrepreneur', version: 1 });
    expect(Object.isFrozen(DEFAULT_PLAN)).toBe(true);
    expect(findPlan(PLAN_CATALOG, DEFAULT_PLAN.id as PlanId, DEFAULT_PLAN.version)?.status).toBe(
      'active',
    );
  });
});

describe('capability and limit catalogue', () => {
  it('comes from the entitlement registry only: features are capabilities, limits are limits', () => {
    expect(CAPABILITY_KEYS.length + LIMIT_KEYS.length).toBeLessThanOrEqual(ENTITLEMENT_KEYS.length);
    for (const key of CAPABILITY_KEYS) expect(kindOf(key)).toBe('feature');
    for (const key of LIMIT_KEYS) expect(kindOf(key)).toBe('limit');
    expect(Object.isFrozen(CAPABILITY_KEYS)).toBe(true);
    expect(Object.isFrozen(LIMIT_KEYS)).toBe(true);
  });
});

describe('EntitlementService', () => {
  it('gives an organization on the default plan exactly the decided values (D-22, D-12)', async () => {
    const { service, tenantA, a } = await world();
    const state = await service.entitlementsOf(tenantA);
    expect(state).toMatchObject({
      status: 'active',
      organizationId: a.organization.id,
      plan: { id: 'entrepreneur', version: 1 },
    });
    if (state.status !== 'active') throw new Error('expected active');
    expect(state.values['users.max']).toBe(1);
    // Every commercial value is still pending (D-12), so every capability is off.
    for (const key of CAPABILITY_KEYS) expect(state.values[key]).toBe(false);
    for (const key of LIMIT_KEYS.filter((k) => k !== 'users.max')) {
      expect(state.values[key]).toBe(0);
    }
  });

  it('answers capabilities from the plan: on, off, or unknown', async () => {
    const { service, tenantA, tenantB } = await world();
    expect(await service.hasCapability(tenantB, 'gia.text')).toEqual({
      enabled: true,
      capability: 'gia.text',
    });
    expect(await service.hasCapability(tenantA, 'gia.text')).toEqual({
      enabled: false,
      reason: 'not_entitled',
    });
    for (const unknown of ['gia.unlimited', 'giaPremium', '', 'users.max', '__proto__']) {
      expect(await service.hasCapability(tenantB, unknown)).toEqual({
        enabled: false,
        reason: 'unknown_capability',
      });
    }
  });

  it('answers limits from the plan; an unset limit is 0, never unlimited', async () => {
    const { service, tenantA, tenantB } = await world();
    expect(await service.getLimit(tenantA, 'users.max')).toEqual({
      available: true,
      limit: 'users.max',
      value: 1,
    });
    expect(await service.getLimit(tenantB, 'users.max')).toMatchObject({ value: 5 });
    expect(await service.getLimit(tenantA, 'agents.max')).toMatchObject({ value: 0 });
    for (const unknown of ['users.unlimited', 'gia.text', 'agents.perDepartmentMax', 'toString']) {
      expect(await service.getLimit(tenantA, unknown)).toEqual({
        available: false,
        reason: 'unknown_limit',
      });
    }
  });

  it('keeps organizations apart: each tenant sees only its own organization plan', async () => {
    const { service, tenantA, tenantB, a, b } = await world();
    expect(await service.entitlementsOf(tenantA)).toMatchObject({
      organizationId: a.organization.id,
      plan: DEFAULT_PLAN,
    });
    expect(await service.entitlementsOf(tenantB)).toMatchObject({
      organizationId: b.organization.id,
      plan: FIXTURE,
    });
  });

  it('refuses a context that did not come from resolveTenant, even pointing at another organization', async () => {
    const { service, tenantA, b } = await world();
    const forged = [
      { ...tenantA },
      { ...tenantA, organizationId: b.organization.id },
      Object.freeze({ ...tenantA, organizationId: b.organization.id }),
    ] as TenantContext[];
    for (const tenant of forged) {
      expect(await everyAnswer(service, tenant)).toEqual({
        entitlements: { status: 'unavailable', reason: 'unresolved_tenant' },
        capability: { enabled: false, reason: 'unresolved_tenant' },
        limit: { available: false, reason: 'unresolved_tenant' },
      });
    }
  });

  it.each<MembershipStatus>(['suspended', 'revoked'])(
    'gives a %s member no tenant, so no entitlements',
    async (status) => {
      const { store, a } = await world();
      store.put({ ...a.membership, status });
      const refused = await resolveTenant(as(ALICE), a.organization.id, store).catch(
        (error: unknown) => (isTenancyError(error) ? error.code : 'other'),
      );
      expect(refused).toBe('organization_forbidden');
    },
  );

  it('denies everything once the organization is suspended', async () => {
    const { store, service, tenantA, a } = await world();
    store.put({ ...a.organization, status: 'suspended' });
    expect(await everyAnswer(service, tenantA)).toEqual({
      entitlements: { status: 'unavailable', reason: 'organization_inactive' },
      capability: { enabled: false, reason: 'organization_inactive' },
      limit: { available: false, reason: 'organization_inactive' },
    });
  });

  it.each([
    ['plan_missing', undefined],
    ['plan_unknown', { id: 'nonexistent', version: 1 }],
    ['plan_unknown', { id: 'entrepreneur', version: 99 }],
    ['plan_inactive', { id: 'business', version: 1 }],
    ['plan_inactive', { id: 'corporate', version: 1 }],
  ] as const)(
    'denies everything with %s, never falling back to a default plan',
    async (reason, plan) => {
      const { service, tenantA } = await withPlanOfA(plan);
      expect(await everyAnswer(service, tenantA)).toEqual({
        entitlements: { status: 'unavailable', reason },
        capability: { enabled: false, reason },
        limit: { available: false, reason },
      });
    },
  );

  it('gives GIA exactly what its user organization has, and nothing more', async () => {
    const { store, service, tenantA, tenantB, a, b } = await world();
    const giaA = await resolveTenant(actAsGia(as(ALICE)), a.organization.id, store);
    const giaB = await resolveTenant(actAsGia(as(BOB)), b.organization.id, store);
    expect(giaA.actor).toBe('gia');
    expect(await everyAnswer(service, giaA)).toEqual(await everyAnswer(service, tenantA));
    expect(await everyAnswer(service, giaB)).toEqual(await everyAnswer(service, tenantB));
    for (const bypass of ['giaUnlimited', 'giaPremium', 'giaAdmin', 'gia.admin']) {
      expect(await service.hasCapability(giaB, bypass)).toMatchObject({ enabled: false });
    }
  });

  it('returns frozen state: a caller cannot raise its own limits or switch capabilities on', async () => {
    const { service, tenantA } = await world();
    const state = await service.entitlementsOf(tenantA);
    if (state.status !== 'active') throw new Error('expected active');
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.values)).toBe(true);
    expect(Object.isFrozen(state.plan)).toBe(true);
    expect(() => {
      (state.values as Record<string, unknown>)['gia.text'] = true;
    }).toThrow();
    expect(() => {
      (state.plan as { id: string }).id = 'corporate';
    }).toThrow();
    expect(await service.hasCapability(tenantA, 'gia.text')).toMatchObject({ enabled: false });
  });

  it('reads the plan at each call, so a later plan change applies without restarting', async () => {
    const { plans, service, tenantA, a } = await world();
    expect(await service.hasCapability(tenantA, 'gia.text')).toMatchObject({ enabled: false });
    plans.byOrganization.set(a.organization.id, FIXTURE);
    expect(await service.hasCapability(tenantA, 'gia.text')).toMatchObject({ enabled: true });
  });
});
