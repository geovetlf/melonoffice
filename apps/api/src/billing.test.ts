import { changePlan, createBillingService, transition } from '@melonoffice/billing';
import type { OrganizationId, PlanRef, Subscription, UserId } from '@melonoffice/domain';
import {
  createEntitlementService,
  createPlanCatalog,
  DEFAULT_PLAN,
  PLAN_CATALOG,
  type PlanConfig,
  type PlanId,
} from '@melonoffice/entitlements';
import {
  createAuthorizationService,
  type AuthorizationService,
  type Permission,
} from '@melonoffice/rbac';
import { resolveTenant } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { setupApp, STORES, type Stores } from './test-api.js';

interface View {
  organization: { id: string };
}

const MISSING_ORG = '99999999-9999-4999-8999-999999999999';

/** Test-only: an active plan with one capability on. It never ships. */
const TEST_PLAN: PlanConfig = {
  id: 'test-capable' as PlanId,
  version: 1,
  status: 'active',
  visibility: 'hidden',
  purchasable: false,
  entitlements: { 'users.max': 1, 'automations.enabled': true },
};
const TEST_PLAN_REF: PlanRef = { id: TEST_PLAN.id, version: TEST_PLAN.version };
const CATALOG = createPlanCatalog([...PLAN_CATALOG, TEST_PLAN]);

async function subscriptionOf(stores: Stores, organizationId: OrganizationId) {
  const account = await stores.billing.findAccount(organizationId);
  const subscription =
    account === undefined
      ? undefined
      : await stores.billing.findSubscription(account.subscriptionId);
  if (subscription === undefined) throw new Error('missing subscription');
  return subscription;
}

describe.each(STORES)('billing with storage in %s', (_name, createStores) => {
  async function setup(
    options: { authorization?: AuthorizationService; createBody?: Record<string, unknown> } = {},
  ) {
    const stores = createStores();
    const billingService = createBillingService({
      billing: stores.billing,
      organizations: stores.tenancy,
    });
    const entitlements = createEntitlementService({
      organizations: stores.tenancy,
      plans: billingService,
      catalog: CATALOG,
    });
    const ctx = setupApp(stores, options.authorization, entitlements);
    const aliceId = (await ctx.register('token-alice')) as UserId;
    const bobId = (await ctx.register('token-bob')) as UserId;
    const create = async (token: string, body: unknown) =>
      ctx.app.request(
        '/v1/organizations',
        ctx.as(token, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        }),
      );
    const orgA = (
      (await (await create('token-alice', { ...options.createBody, name: 'A' })).json()) as View
    ).organization.id as OrganizationId;
    const orgB = ((await (await create('token-bob', { name: 'B' })).json()) as View).organization
      .id as OrganizationId;
    const get = async (token: string, path: string, init: RequestInit = {}) => {
      const response = await ctx.app.request(path, ctx.as(token, init));
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    const billing = (token: string, id: string, init: RequestInit = {}) =>
      get(token, `/v1/organizations/${encodeURIComponent(id)}/billing`, init);
    const entitlementsOf = (token: string, id: string) =>
      get(token, `/v1/organizations/${encodeURIComponent(id)}/entitlements`);
    /** Stores A's subscription changed, the way a provider sync would. */
    const updateA = async (change: (subscription: Subscription) => Subscription) =>
      stores.putBilling(change(await subscriptionOf(stores, orgA)));
    const events = async (action: string) =>
      (await stores.auditEvents()).filter((e) => e.action === action);
    return {
      ...ctx,
      stores,
      billingService,
      entitlements,
      aliceId,
      bobId,
      orgA,
      orgB,
      create,
      billing,
      entitlementsOf,
      updateA,
      events,
    };
  }

  describe('organization creation opens billing', () => {
    it('opens one account and an active subscription on the default plan, and audits it', async () => {
      const { stores, orgA, aliceId, events } = await setup();
      const subscription = await subscriptionOf(stores, orgA);
      expect(subscription).toMatchObject({
        organizationId: orgA,
        plan: DEFAULT_PLAN,
        status: 'active',
      });
      const created = (await events('billing.subscription_created')).filter(
        (e) => e.organizationId === orgA,
      );
      expect(created).toEqual([
        expect.objectContaining({
          result: 'success',
          actor: { type: 'user', userId: aliceId, via: 'direct' },
          organizationId: orgA,
          target: { type: 'subscription', id: subscription.id },
          plan: DEFAULT_PLAN,
          source: 'api',
        }),
      ]);
      const organizationCreated = (await events('organization.create')).find(
        (e) => e.organizationId === orgA,
      );
      expect(created[0]?.occurredAt).toBe(organizationCreated?.occurredAt);
    });

    it('ignores any plan, status, subscription or account the client sends', async () => {
      const { stores, orgA } = await setup({
        createBody: {
          plan: TEST_PLAN_REF,
          planId: 'corporate',
          status: 'trialing',
          subscription: { id: MISSING_ORG, status: 'trialing', plan: TEST_PLAN_REF },
          subscriptionId: MISSING_ORG,
          billingAccount: { subscriptionId: MISSING_ORG },
        },
      });
      const subscription = await subscriptionOf(stores, orgA);
      expect(subscription.id).not.toBe(MISSING_ORG);
      expect(subscription).toMatchObject({ plan: DEFAULT_PLAN, status: 'active' });
    });

    it('opens no billing when the creation is refused', async () => {
      const { create, events } = await setup();
      expect((await create('token-alice', { name: 'Second' })).status).toBe(409);
      expect(await events('billing.subscription_created')).toHaveLength(2);
    });
  });

  describe('GET /v1/organizations/:organizationId/billing', () => {
    it('1. shows the owner their organization subscription, and nothing about payment', async () => {
      const { billing, stores, orgA } = await setup();
      const subscription = await subscriptionOf(stores, orgA);
      expect(await billing('token-alice', orgA)).toEqual({
        status: 200,
        body: {
          organizationId: orgA,
          status: 'present',
          subscription: {
            id: subscription.id,
            plan: DEFAULT_PLAN,
            status: 'active',
            createdAt: subscription.createdAt,
            updatedAt: subscription.updatedAt,
          },
          planInForce: true,
        },
      });
    });

    it('2 and 6. never shows another organization billing, whatever id is sent, and audits it', async () => {
      const { billing, orgA, orgB, bobId, events } = await setup();
      for (const target of [orgA, MISSING_ORG, 'org-a', orgA.toUpperCase(), `${orgA}_x`]) {
        expect(await billing('token-bob', target)).toEqual({
          status: 403,
          body: { error: 'organization_forbidden' },
        });
      }
      expect((await billing('token-alice', orgB)).status).toBe(403);
      expect(await events('tenancy.resolve')).toContainEqual(
        expect.objectContaining({
          actor: { type: 'user', userId: bobId, via: 'direct' },
          requestedOrganizationId: orgA,
          reason: 'organization_forbidden',
        }),
      );
    });

    it.each(['suspended', 'revoked'] as const)(
      '3 and 4. refuses a %s membership',
      async (status) => {
        const { billing, put, tenancy, orgA, aliceId } = await setup();
        const membership = await tenancy.findMembership(orgA, aliceId);
        if (membership === undefined) throw new Error('missing membership');
        await put({ ...membership, status });
        expect(await billing('token-alice', orgA)).toEqual({
          status: 403,
          body: { error: 'organization_forbidden' },
        });
      },
    );

    it('5. refuses a suspended organization', async () => {
      const { billing, put, tenancy, orgA } = await setup();
      const organization = await tenancy.findOrganization(orgA);
      if (organization === undefined) throw new Error('missing organization');
      await put({ ...organization, status: 'suspended' });
      expect((await billing('token-alice', orgA)).status).toBe(403);
    });

    it('refuses no token and a forged token', async () => {
      const { app, orgA } = await setup();
      expect((await app.request(`/v1/organizations/${orgA}/billing`)).status).toBe(401);
      const forged = await app.request(`/v1/organizations/${orgA}/billing`, {
        headers: { authorization: 'Bearer forged' },
      });
      expect(forged.status).toBe(401);
    });

    it('refuses a member whose role lacks billing.read, and audits it', async () => {
      const { billing, orgA, events } = await setup({
        authorization: createAuthorizationService({ owner: ['entitlement.read'] }),
      });
      expect(await billing('token-alice', orgA)).toEqual({
        status: 403,
        body: { error: 'permission_denied' },
      });
      expect(await events('authorization.check')).toContainEqual(
        expect.objectContaining({ permission: 'billing.read', reason: 'permission_denied' }),
      );
    });

    it('7. answers an organization without billing explicitly, inventing nothing', async () => {
      const { billing, entitlementsOf, stores, orgA, lines } = await setup();
      await stores.removeBilling(orgA);
      expect(await billing('token-alice', orgA)).toEqual({
        status: 200,
        body: { organizationId: orgA, status: 'unavailable', reason: 'billing_missing' },
      });
      expect((await entitlementsOf('token-alice', orgA)).body).toEqual({
        organizationId: orgA,
        status: 'unavailable',
        reason: 'plan_missing',
      });
      expect(lines.join('\n')).toContain('"reason":"billing_missing"');
    });

    it('8. shows an unknown plan as recorded, and entitlements grant nothing for it', async () => {
      const { billing, entitlementsOf, updateA, orgA } = await setup();
      await updateA((s) => changePlan(s, { id: 'nonexistent', version: 1 }, s.updatedAt));
      expect((await billing('token-alice', orgA)).body).toMatchObject({
        subscription: { plan: { id: 'nonexistent', version: 1 } },
      });
      expect((await entitlementsOf('token-alice', orgA)).body).toMatchObject({
        status: 'unavailable',
        reason: 'plan_unknown',
      });
    });

    it('9. refuses a stored subscription with an invalid status, safely', async () => {
      const { billing, entitlementsOf, updateA, orgA } = await setup();
      await updateA((s) => ({ ...s, status: 'free' }) as unknown as Subscription);
      const read = await billing('token-alice', orgA);
      // Firestore refuses the record when reading it (500); memory reports it invalid.
      if (read.status === 200) {
        expect(read.body).toEqual({
          organizationId: orgA,
          status: 'unavailable',
          reason: 'subscription_invalid',
        });
        expect((await entitlementsOf('token-alice', orgA)).body).toMatchObject({
          reason: 'plan_missing',
        });
      } else {
        expect(read).toEqual({ status: 500, body: { error: 'internal_error' } });
        expect((await entitlementsOf('token-alice', orgA)).status).toBe(500);
      }
    });

    it('10, 11 and 12. ignores plan, status, subscription and organization values in the query and headers', async () => {
      const { app, as, stores, orgA, orgB } = await setup();
      const subscription = await subscriptionOf(stores, orgA);
      const response = await app.request(
        `/v1/organizations/${orgA}/billing?plan=test-capable&status=trialing&subscriptionId=${MISSING_ORG}&organizationId=${orgB}`,
        as('token-alice', {
          headers: {
            'x-plan-id': 'test-capable',
            'x-subscription-status': 'canceled',
            'x-subscription-id': MISSING_ORG,
            'x-organization-id': orgB,
          },
        }),
      );
      expect(await response.json()).toMatchObject({
        organizationId: orgA,
        subscription: { id: subscription.id, plan: DEFAULT_PLAN, status: 'active' },
      });
    });

    it('10, 11 and 12. offers no way to change plan, status, subscription or account', async () => {
      const { app, as, stores, orgA } = await setup();
      const before = await subscriptionOf(stores, orgA);
      const change = {
        plan: TEST_PLAN_REF,
        status: 'canceled',
        subscriptionId: MISSING_ORG,
        billingAccount: {},
      };
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        for (const path of [
          `/v1/organizations/${orgA}/billing`,
          `/v1/organizations/${orgA}/billing/subscription`,
          `/v1/organizations/${orgA}/subscription`,
          `/v1/organizations/${orgA}/billing/checkout`,
          `/v1/organizations/${orgA}/billing/payment`,
          '/v1/billing/webhook',
        ]) {
          const response = await app.request(
            path,
            as('token-alice', {
              method,
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(change),
            }),
          );
          expect(response.status).toBe(404);
        }
      }
      expect(await subscriptionOf(stores, orgA)).toEqual(before);
    });
  });

  describe('billing decides the plan, entitlements resolve it', () => {
    it('a plan change in billing is what entitlements show, with no rule copied', async () => {
      const { entitlementsOf, updateA, orgA, orgB } = await setup();
      expect((await entitlementsOf('token-alice', orgA)).body).toMatchObject({
        plan: DEFAULT_PLAN,
        capabilities: { 'automations.enabled': false },
      });
      await updateA((s) => changePlan(s, TEST_PLAN_REF, s.updatedAt));
      expect((await entitlementsOf('token-alice', orgA)).body).toMatchObject({
        plan: TEST_PLAN_REF,
        capabilities: { 'automations.enabled': true },
      });
      expect((await entitlementsOf('token-bob', orgB)).body).toMatchObject({ plan: DEFAULT_PLAN });
    });

    it('past_due and canceled put no plan in force; back to active restores it', async () => {
      const { billing, entitlementsOf, updateA, orgA } = await setup();
      await updateA((s) => transition(s, 'past_due', s.updatedAt));
      expect((await billing('token-alice', orgA)).body).toMatchObject({
        subscription: { status: 'past_due' },
        planInForce: false,
      });
      expect((await entitlementsOf('token-alice', orgA)).body).toMatchObject({
        reason: 'plan_missing',
      });
      await updateA((s) => transition(s, 'active', s.updatedAt));
      expect((await entitlementsOf('token-alice', orgA)).body).toMatchObject({ status: 'active' });
      await updateA((s) => transition(s, 'canceled', s.updatedAt));
      expect((await entitlementsOf('token-alice', orgA)).body).toMatchObject({
        reason: 'plan_missing',
      });
    });
  });

  describe('RBAC, billing and entitlements are asked separately; each can deny', () => {
    // How a future feature route combines them. There is no combined engine.
    async function decide(options: {
      permitted: boolean;
      member: boolean;
      subscription: 'active' | 'canceled' | 'none';
      entitled: boolean;
    }) {
      const { stores, billingService, entitlements, orgA, aliceId, bobId, updateA } = await setup();
      await updateA((s) =>
        changePlan(s, options.entitled ? TEST_PLAN_REF : DEFAULT_PLAN, s.updatedAt),
      );
      if (options.subscription === 'canceled') {
        await updateA((s) => transition(s, 'canceled', s.updatedAt));
      }
      if (options.subscription === 'none') await stores.removeBilling(orgA);
      const permissions: Permission[] = options.permitted ? ['billing.read'] : [];
      const rbac = createAuthorizationService({ owner: permissions });
      const userId = options.member ? aliceId : bobId;
      const tenant = await resolveTenant(
        { actor: 'user', userId, emailVerified: true },
        orgA,
        stores.tenancy,
      ).catch(() => undefined);
      if (tenant === undefined) return 'DENY (tenancy)';
      if (!rbac.authorize(tenant, 'billing.read').allowed) return 'DENY (permission)';
      const state = await billingService.billingOf(tenant);
      if (state.status !== 'present' || !state.planInForce) return 'DENY (billing)';
      const capability = await entitlements.hasCapability(tenant, 'automations.enabled');
      return capability.enabled ? 'ALLOW' : 'DENY (entitlement)';
    }

    const all = { permitted: true, member: true, subscription: 'active', entitled: true } as const;

    it('permission, tenancy, active billing and the capability: ALLOW', async () => {
      expect(await decide(all)).toBe('ALLOW');
    });

    it('without the permission: DENY', async () => {
      expect(await decide({ ...all, permitted: false })).toBe('DENY (permission)');
    });

    it('without tenancy: DENY', async () => {
      expect(await decide({ ...all, member: false })).toBe('DENY (tenancy)');
    });

    it('without valid billing: DENY', async () => {
      expect(await decide({ ...all, subscription: 'canceled' })).toBe('DENY (billing)');
      expect(await decide({ ...all, subscription: 'none' })).toBe('DENY (billing)');
    });

    it('without the entitlement: DENY', async () => {
      expect(await decide({ ...all, entitled: false })).toBe('DENY (entitlement)');
    });
  });
});
