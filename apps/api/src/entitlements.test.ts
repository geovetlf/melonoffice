import type { Organization, OrganizationId, PlanRef, UserId } from '@melonoffice/domain';
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
  membership: { id: string };
}

const MISSING_ORG = '99999999-9999-4999-8999-999999999999';

/** Test-only: an active plan that switches one capability on. It never ships. */
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

describe.each(STORES)('entitlements with storage in %s', (_name, createStores) => {
  async function setup(
    options: {
      stores?: Stores;
      authorization?: AuthorizationService;
      /** Extra fields Alice sends when she creates organization A. */
      createBody?: Record<string, unknown>;
    } = {},
  ) {
    const stores = options.stores ?? createStores();
    const ctx = setupApp(
      stores,
      options.authorization,
      createEntitlementService({ organizations: stores.tenancy, catalog: CATALOG }),
    );
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
    const read = async (token: string, id: string, init: RequestInit = {}) => {
      const response = await ctx.app.request(
        `/v1/organizations/${encodeURIComponent(id)}/entitlements`,
        ctx.as(token, init),
      );
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    };
    /** Changes organization A's plan the way an operator would (there is no API for it). */
    const setPlanOfA = async (plan: PlanRef | undefined) => {
      const organization = await stores.tenancy.findOrganization(orgA);
      if (organization === undefined) throw new Error('missing organization');
      const rest = Object.fromEntries(
        Object.entries(organization).filter(([key]) => key !== 'plan'),
      ) as unknown as Organization;
      await stores.put(plan === undefined ? rest : { ...rest, plan });
    };
    const events = async (action: string) =>
      (await stores.auditEvents()).filter((e) => e.action === action);
    return { ...ctx, stores, aliceId, bobId, orgA, orgB, create, read, setPlanOfA, events };
  }

  describe('plan assignment at creation', () => {
    it('gives every new organization the default plan, stored with it', async () => {
      const { tenancy, orgA, orgB } = await setup();
      expect((await tenancy.findOrganization(orgA))?.plan).toEqual(DEFAULT_PLAN);
      expect((await tenancy.findOrganization(orgB))?.plan).toEqual(DEFAULT_PLAN);
    });

    it('ignores any plan, capability or limit the client sends', async () => {
      const { tenancy, orgA, events } = await setup({
        createBody: {
          plan: TEST_PLAN_REF,
          planId: 'corporate',
          planVersion: 2,
          entitlements: { 'automations.enabled': true },
          capabilities: ['automations.enabled'],
          limits: { 'users.max': 'unlimited' },
        },
      });
      expect((await tenancy.findOrganization(orgA))?.plan).toEqual(DEFAULT_PLAN);
      expect((await events('plan.assign')).map((e) => e.plan)).toEqual([
        DEFAULT_PLAN,
        DEFAULT_PLAN,
      ]);
    });

    it('records plan.assign in the same write as the organization and its membership', async () => {
      const { events, aliceId, orgA } = await setup();
      const actor = { type: 'user', userId: aliceId, via: 'direct' };
      expect((await events('plan.assign')).filter((e) => e.organizationId === orgA)).toEqual([
        expect.objectContaining({
          result: 'success',
          actor,
          organizationId: orgA,
          target: { type: 'organization', id: orgA },
          plan: { id: 'entrepreneur', version: 1 },
          source: 'api',
        }),
      ]);
      const created = (await events('organization.create')).find((e) => e.organizationId === orgA);
      const assigned = (await events('plan.assign')).find((e) => e.organizationId === orgA);
      expect(assigned?.occurredAt).toBe(created?.occurredAt);
    });

    it('records no plan.assign when the creation is refused', async () => {
      const { create, events } = await setup();
      expect((await create('token-alice', { name: 'Second' })).status).toBe(409);
      expect(await events('plan.assign')).toHaveLength(2);
    });
  });

  describe('GET /v1/organizations/:organizationId/entitlements', () => {
    it('shows the owner the plan, its capabilities and its limits as state, not usage', async () => {
      const { read, orgA } = await setup();
      const { status, body } = await read('token-alice', orgA);
      expect(status).toBe(200);
      expect(body).toMatchObject({
        organizationId: orgA,
        status: 'active',
        plan: { id: 'entrepreneur', version: 1 },
      });
      const capabilities = body.capabilities as Record<string, unknown>;
      const limits = body.limits as Record<string, unknown>;
      expect(Object.values(capabilities).every((on) => on === false)).toBe(true);
      expect(limits['users.max']).toBe(1);
      expect(limits['agents.max']).toBe(0);
      expect(Object.keys(body).sort()).toEqual(
        ['capabilities', 'limits', 'organizationId', 'plan', 'status'].sort(),
      );
    });

    it('shows each organization its own plan', async () => {
      const { read, orgA, orgB, setPlanOfA } = await setup();
      await setPlanOfA(TEST_PLAN_REF);
      expect((await read('token-alice', orgA)).body).toMatchObject({ plan: TEST_PLAN_REF });
      expect((await read('token-bob', orgB)).body).toMatchObject({ plan: DEFAULT_PLAN });
    });

    it.each([
      ['no token', undefined, 401, 'missing_token'],
      ['a forged token', 'forged', 401, 'invalid_token'],
    ])('refuses %s', async (_name, token, status, error) => {
      const { app, orgA } = await setup();
      const response = await app.request(
        `/v1/organizations/${orgA}/entitlements`,
        token === undefined ? {} : { headers: { authorization: `Bearer ${token}` } },
      );
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual({ error });
    });

    it('never shows another organization entitlements, and audits the attempt', async () => {
      const { read, orgA, orgB, bobId, events } = await setup();
      for (const target of [orgA, MISSING_ORG, 'org-a', orgA.toUpperCase()]) {
        expect(await read('token-bob', target)).toEqual({
          status: 403,
          body: { error: 'organization_forbidden' },
        });
      }
      expect(await read('token-alice', orgB)).toEqual({
        status: 403,
        body: { error: 'organization_forbidden' },
      });
      expect(await events('tenancy.resolve')).toContainEqual(
        expect.objectContaining({
          result: 'denied',
          actor: { type: 'user', userId: bobId, via: 'direct' },
          requestedOrganizationId: orgA,
          reason: 'organization_forbidden',
        }),
      );
    });

    it.each(['suspended', 'revoked'] as const)('refuses a %s membership', async (status) => {
      const { read, put, tenancy, orgA, aliceId } = await setup();
      const membership = await tenancy.findMembership(orgA, aliceId);
      if (membership === undefined) throw new Error('missing membership');
      await put({ ...membership, status });
      expect((await read('token-alice', orgA)).status).toBe(403);
    });

    it('refuses a suspended organization', async () => {
      const { read, put, tenancy, orgA } = await setup();
      const organization = await tenancy.findOrganization(orgA);
      if (organization === undefined) throw new Error('missing organization');
      await put({ ...organization, status: 'suspended' });
      expect((await read('token-alice', orgA)).status).toBe(403);
    });

    it('refuses a member whose role lacks entitlement.read, and audits it', async () => {
      const { read, orgA, events } = await setup({
        authorization: createAuthorizationService({ owner: ['organization.read'] }),
      });
      expect(await read('token-alice', orgA)).toEqual({
        status: 403,
        body: { error: 'permission_denied' },
      });
      expect(await events('authorization.check')).toContainEqual(
        expect.objectContaining({
          organizationId: orgA,
          permission: 'entitlement.read',
          reason: 'permission_denied',
        }),
      );
    });

    it.each([
      ['plan_missing', undefined],
      ['plan_unknown', { id: 'nonexistent', version: 1 }],
      ['plan_inactive', { id: 'business', version: 1 }],
    ] as const)('answers %s explicitly, with no capabilities or limits', async (reason, plan) => {
      const { read, setPlanOfA, orgA, lines } = await setup();
      await setPlanOfA(plan);
      expect(await read('token-alice', orgA)).toEqual({
        status: 200,
        body: { organizationId: orgA, status: 'unavailable', reason },
      });
      expect(lines.join('\n')).toContain(`"reason":"${reason}"`);
    });

    it('ignores plan, capability and organization values in the query and headers', async () => {
      const { app, as, orgA, orgB, setPlanOfA } = await setup();
      await setPlanOfA(undefined);
      const response = await app.request(
        `/v1/organizations/${orgA}/entitlements?planId=test-capable&planVersion=1&organizationId=${orgB}`,
        as('token-alice', {
          headers: {
            'x-plan-id': 'test-capable',
            'x-plan-version': '1',
            'x-organization-id': orgB,
            'x-capabilities': 'automations.enabled',
          },
        }),
      );
      expect(await response.json()).toEqual({
        organizationId: orgA,
        status: 'unavailable',
        reason: 'plan_missing',
      });
    });

    it('offers no way to change a plan, capability or limit', async () => {
      const { app, as, orgA, tenancy } = await setup();
      const change = { plan: TEST_PLAN_REF, capabilities: { 'automations.enabled': true } };
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        for (const path of [
          `/v1/organizations/${orgA}/entitlements`,
          `/v1/organizations/${orgA}/plan`,
          `/v1/organizations/${orgA}`,
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
      expect((await tenancy.findOrganization(orgA))?.plan).toEqual(DEFAULT_PLAN);
    });
  });

  describe('RBAC and entitlements stay separate and both must allow', () => {
    // How a future feature route combines them: RBAC for the member, entitlements for the plan.
    // Each is asked on its own; neither implies the other.
    async function decide(permitted: boolean, entitled: boolean) {
      const { stores, orgA, aliceId, setPlanOfA } = await setup();
      await setPlanOfA(entitled ? TEST_PLAN_REF : DEFAULT_PLAN);
      const permissions: Permission[] = permitted ? ['entitlement.read'] : [];
      const rbac = createAuthorizationService({ owner: permissions });
      const entitlements = createEntitlementService({
        organizations: stores.tenancy,
        catalog: CATALOG,
      });
      const tenant = await resolveTenant(
        { actor: 'user', userId: aliceId, emailVerified: true },
        orgA,
        stores.tenancy,
      );
      const permission = rbac.authorize(tenant, 'entitlement.read');
      const capability = await entitlements.hasCapability(tenant, 'automations.enabled');
      return {
        permission: permission.allowed,
        capability: capability.enabled,
        decision: permission.allowed && capability.enabled ? 'ALLOW' : 'DENY',
      };
    }

    it('permission without capability: DENY', async () => {
      expect(await decide(true, false)).toEqual({
        permission: true,
        capability: false,
        decision: 'DENY',
      });
    });

    it('capability without permission: DENY', async () => {
      expect(await decide(false, true)).toEqual({
        permission: false,
        capability: true,
        decision: 'DENY',
      });
    });

    it('permission and capability: ALLOW', async () => {
      expect(await decide(true, true)).toEqual({
        permission: true,
        capability: true,
        decision: 'ALLOW',
      });
    });

    it('neither: DENY', async () => {
      expect((await decide(false, false)).decision).toBe('DENY');
    });
  });
});
