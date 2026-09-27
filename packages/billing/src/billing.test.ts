import { actAsGia, type AuthenticatedContext } from '@melonoffice/auth';
import type {
  CreditWallet,
  CreditWalletId,
  IsoTimestamp,
  MembershipStatus,
  Organization,
  OrganizationId,
  Subscription,
  SubscriptionId,
  SubscriptionStatus,
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
import { openBilling } from './account.js';
import { BillingError } from './errors.js';
import {
  canTransition,
  changePlan,
  isPlanInForce,
  isSubscriptionStatus,
  SUBSCRIPTION_STATUSES,
  transition,
} from './lifecycle.js';
import { createBillingService } from './service.js';
import { InMemoryBillingStore } from './store.js';

const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;

/** An empty wallet, as the credits package opens one (ADR-0023); its contents do not matter here. */
const CREDITS = (organization: Organization): CreditWallet => ({
  id: `wallet-${organization.id}` as CreditWalletId,
  organizationId: organization.id,
  balance: 0,
  createdAt: organization.createdAt,
  updatedAt: organization.createdAt,
});
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const NOW = new Date('2026-09-27T12:00:00Z');
const LATER = '2026-09-28T12:00:00.000Z' as IsoTimestamp;
const PLAN = { id: 'entrepreneur', version: 1 } as const;
const OTHER_PLAN = { id: 'business', version: 1 } as const;

const as = (userId: UserId): AuthenticatedContext =>
  Object.freeze({ actor: 'user', userId, emailVerified: true });

const ALLOWED: [SubscriptionStatus, SubscriptionStatus][] = [
  ['trialing', 'active'],
  ['trialing', 'canceled'],
  ['active', 'past_due'],
  ['active', 'canceled'],
  ['past_due', 'active'],
  ['past_due', 'canceled'],
];

const subscription = (status: SubscriptionStatus): Subscription =>
  Object.freeze({
    id: '33333333-3333-4333-8333-333333333333' as SubscriptionId,
    organizationId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa' as OrganizationId,
    plan: PLAN,
    status,
    createdAt: NOW.toISOString() as IsoTimestamp,
    updatedAt: NOW.toISOString() as IsoTimestamp,
  });

async function codeOf(run: () => unknown): Promise<string> {
  try {
    await run();
  } catch (error) {
    if (error instanceof BillingError) return error.code;
    throw error;
  }
  return 'accepted';
}

/** Alice owns A and Bob owns B, each opened on the default plan like the API does. */
async function world() {
  const billing = new InMemoryBillingStore();
  const store = new InMemoryTenancyStore(() => NOW, undefined, billing);
  const open = (organization: Organization) => openBilling(organization, PLAN);
  const a = await createOrganization(as(ALICE), { name: 'A' }, store, {
    billing: open,
    credits: CREDITS,
  });
  const b = await createOrganization(as(BOB), { name: 'B' }, store, {
    billing: open,
    credits: CREDITS,
  });
  const service = createBillingService({ billing, organizations: store });
  const tenantA = await resolveTenant(as(ALICE), a.organization.id, store);
  const tenantB = await resolveTenant(as(BOB), b.organization.id, store);
  return { billing, store, a, b, service, tenantA, tenantB };
}

describe('subscription lifecycle', () => {
  it.each(ALLOWED)('allows %s → %s', (from, to) => {
    const before = subscription(from);
    const after = transition(before, to, LATER);
    expect(after).toEqual({ ...before, status: to, updatedAt: LATER });
    expect(Object.isFrozen(after)).toBe(true);
    expect(before.status).toBe(from);
  });

  it('refuses every other transition, including staying put, without changing anything', async () => {
    let refused = 0;
    for (const from of SUBSCRIPTION_STATUSES) {
      for (const to of SUBSCRIPTION_STATUSES) {
        if (ALLOWED.some(([f, t]) => f === from && t === to)) continue;
        const before = subscription(from);
        expect(canTransition(from, to)).toBe(false);
        expect(await codeOf(() => transition(before, to, LATER))).toBe('invalid_transition');
        expect(before).toEqual(subscription(from));
        refused += 1;
      }
    }
    expect(refused).toBe(SUBSCRIPTION_STATUSES.length ** 2 - ALLOWED.length);
  });

  it('keeps canceled final and refuses unknown statuses', async () => {
    for (const to of SUBSCRIPTION_STATUSES) expect(canTransition('canceled', to)).toBe(false);
    for (const unknown of ['free', 'paused', '', '__proto__', 'toString']) {
      expect(isSubscriptionStatus(unknown)).toBe(false);
      expect(canTransition('active', unknown as SubscriptionStatus)).toBe(false);
      expect(canTransition(unknown as SubscriptionStatus, 'active')).toBe(false);
      expect(
        await codeOf(() =>
          transition(subscription('active'), unknown as SubscriptionStatus, LATER),
        ),
      ).toBe('invalid_transition');
    }
  });

  it('puts the plan in force only while trialing or active', () => {
    expect(SUBSCRIPTION_STATUSES.filter(isPlanInForce)).toEqual(['trialing', 'active']);
  });

  it('changes plan without touching the original, and never on a canceled subscription', async () => {
    const before = subscription('active');
    const after = changePlan(before, OTHER_PLAN, LATER);
    expect(after).toEqual({ ...before, plan: OTHER_PLAN, updatedAt: LATER });
    expect(before.plan).toEqual(PLAN);
    expect(await codeOf(() => changePlan(subscription('canceled'), OTHER_PLAN, LATER))).toBe(
      'subscription_canceled',
    );
    for (const plan of [{ id: 'Business', version: 1 }, { id: 'business', version: 0 }, {}]) {
      expect(await codeOf(() => changePlan(before, plan as typeof PLAN, LATER))).toBe(
        'invalid_plan',
      );
    }
  });
});

describe('openBilling', () => {
  it('opens one account and an active subscription on the given plan, for that organization', async () => {
    const { a } = await world();
    const { account, subscription: first } = a.billing;
    expect(account).toEqual({
      organizationId: a.organization.id,
      subscriptionId: first.id,
      createdAt: a.organization.createdAt,
      updatedAt: a.organization.createdAt,
    });
    expect(first).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      organizationId: a.organization.id,
      plan: PLAN,
      status: 'active',
      createdAt: a.organization.createdAt,
      updatedAt: a.organization.createdAt,
    });
    expect(Object.isFrozen(first.plan)).toBe(true);
    expect(Object.keys(account).sort()).toEqual(
      ['createdAt', 'organizationId', 'subscriptionId', 'updatedAt'].sort(),
    );
  });

  it('refuses a malformed plan', async () => {
    const { a } = await world();
    expect(await codeOf(() => openBilling(a.organization, { id: '', version: 1 }))).toBe(
      'invalid_plan',
    );
  });

  it('never opens a second account for an organization', async () => {
    const { billing, a } = await world();
    expect(() => billing.openNow(openBilling(a.organization, PLAN))).toThrow(
      'billing already exists',
    );
  });
});

describe('BillingService', () => {
  it('shows each organization its own subscription', async () => {
    const { service, tenantA, tenantB, a, b } = await world();
    expect(await service.billingOf(tenantA)).toEqual({
      status: 'present',
      organizationId: a.organization.id,
      subscription: a.billing.subscription,
      planInForce: true,
    });
    expect(await service.billingOf(tenantB)).toMatchObject({
      organizationId: b.organization.id,
      subscription: { id: b.billing.subscription.id },
    });
  });

  it('refuses a context that did not come from resolveTenant, even pointing at another organization', async () => {
    const { service, tenantA, b } = await world();
    for (const forged of [
      { ...tenantA },
      { ...tenantA, organizationId: b.organization.id },
    ] as TenantContext[]) {
      expect(await service.billingOf(forged)).toEqual({
        status: 'unavailable',
        reason: 'unresolved_tenant',
      });
    }
  });

  it.each<MembershipStatus>(['suspended', 'revoked'])(
    'gives a %s member no tenant, so no billing',
    async (status) => {
      const { store, a } = await world();
      store.put({ ...a.membership, status });
      const refused = await resolveTenant(as(ALICE), a.organization.id, store).catch(
        (error: unknown) => (isTenancyError(error) ? error.code : 'other'),
      );
      expect(refused).toBe('organization_forbidden');
    },
  );

  it('answers nothing once the organization is suspended', async () => {
    const { store, service, tenantA, a } = await world();
    store.put({ ...a.organization, status: 'suspended' });
    expect(await service.billingOf(tenantA)).toEqual({
      status: 'unavailable',
      reason: 'organization_inactive',
    });
  });

  it('never invents billing for an organization without it', async () => {
    const { billing, service, tenantA, a } = await world();
    billing.removeAccount(a.organization.id);
    expect(await service.billingOf(tenantA)).toEqual({
      status: 'unavailable',
      reason: 'billing_missing',
    });
    expect(await service.currentPlan(a.organization.id)).toBeUndefined();
  });

  it('refuses a missing subscription, and one that is not the organization', async () => {
    const { billing, service, tenantA, a, b } = await world();
    billing.put({ ...a.billing.account, subscriptionId: 'missing' as SubscriptionId });
    expect(await service.billingOf(tenantA)).toEqual({
      status: 'unavailable',
      reason: 'subscription_missing',
    });
    // A's account pointing at B's subscription never shows or applies B's plan.
    billing.put({ ...a.billing.account, subscriptionId: b.billing.subscription.id });
    expect(await service.billingOf(tenantA)).toEqual({
      status: 'unavailable',
      reason: 'subscription_invalid',
    });
    expect(await service.currentPlan(a.organization.id)).toBeUndefined();
  });

  it.each([
    ['an unknown status', { status: 'free' }],
    ['a malformed plan', { plan: { id: 'Entrepreneur!', version: 1 } }],
  ])('refuses a stored subscription with %s', async (_name, change) => {
    const { billing, service, tenantA, a } = await world();
    billing.put({ ...a.billing.subscription, ...change } as Subscription);
    expect(await service.billingOf(tenantA)).toEqual({
      status: 'unavailable',
      reason: 'subscription_invalid',
    });
    expect(await service.currentPlan(a.organization.id)).toBeUndefined();
  });

  it.each<[SubscriptionStatus, boolean]>([
    ['trialing', true],
    ['active', true],
    ['past_due', false],
    ['canceled', false],
  ])('with a %s subscription, the plan in force is given: %s', async (status, inForce) => {
    const { billing, service, tenantA, a } = await world();
    billing.put({ ...a.billing.subscription, status });
    expect(await service.billingOf(tenantA)).toMatchObject({ planInForce: inForce });
    expect(await service.currentPlan(a.organization.id)).toEqual(inForce ? PLAN : undefined);
  });

  it('gives the plan billing records, even one entitlements may not know', async () => {
    const { billing, service, a } = await world();
    billing.put(changePlan(a.billing.subscription, { id: 'nonexistent', version: 9 }, LATER));
    expect(await service.currentPlan(a.organization.id)).toEqual({ id: 'nonexistent', version: 9 });
  });

  it('gives GIA exactly its user organization billing', async () => {
    const { store, service, tenantA, a } = await world();
    const gia = await resolveTenant(actAsGia(as(ALICE)), a.organization.id, store);
    expect(await service.billingOf(gia)).toEqual(await service.billingOf(tenantA));
  });
});
