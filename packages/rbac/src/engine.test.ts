import { actAsGia, type AuthenticatedContext } from '@melonoffice/auth';
import type {
  CreditWallet,
  CreditWalletId,
  InitialBilling,
  MembershipStatus,
  Organization,
  OrganizationId,
  OrganizationStatus,
  SubscriptionId,
  UserId,
} from '@melonoffice/domain';
import {
  createOrganization,
  InMemoryCommercialStore,
  InMemoryTenancyStore,
  resolveCommercialContext,
  membershipIdOf,
  resolveTenant,
  TenancyError,
  type TenantContext,
} from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import {
  createAuthorizationService,
  createCommercialAuthorization,
  type RbacDecision,
} from './engine.js';
import { isPermission, PERMISSIONS } from './permissions.js';
import { COMMERCIAL_ROLES, ROLES } from './roles.js';

const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const CAROL = '33333333-3333-4333-8333-333333333333' as UserId;
const rbac = createAuthorizationService();
/** Billing is not RBAC's concern; organizations just need some. */
const BILLING = (organization: Organization): InitialBilling => {
  const subscriptionId = `sub-${organization.id}` as SubscriptionId;
  const at = organization.createdAt;
  return {
    account: { organizationId: organization.id, subscriptionId, createdAt: at, updatedAt: at },
    subscription: {
      id: subscriptionId,
      organizationId: organization.id,
      plan: { id: 'test-plan', version: 1 },
      status: 'active',
      createdAt: at,
      updatedAt: at,
    },
  };
};

/** An empty wallet, as the credits package opens one (ADR-0023); its contents do not matter here. */
const CREDITS = (organization: Organization): CreditWallet => ({
  id: `wallet-${organization.id}` as CreditWalletId,
  organizationId: organization.id,
  balance: 0,
  createdAt: organization.createdAt,
  updatedAt: organization.createdAt,
});

const as = (userId: UserId): AuthenticatedContext =>
  Object.freeze({ actor: 'user', userId, emailVerified: true });

/** Alice owns A, Bob owns B, Carol has no membership anywhere. */
async function world() {
  const store = new InMemoryTenancyStore();
  const a = await createOrganization(as(ALICE), { name: 'A' }, store, {
    billing: BILLING,
    credits: CREDITS,
  });
  const b = await createOrganization(as(BOB), { name: 'B' }, store, {
    billing: BILLING,
    credits: CREDITS,
  });
  return { store, a, b, orgA: a.organization.id, orgB: b.organization.id };
}

/** Tenancy then RBAC, the way every caller does it. A tenancy refusal is a denial too. */
async function decide(
  store: InMemoryTenancyStore,
  auth: AuthenticatedContext,
  organization: string,
  permission: string,
  resource?: OrganizationId,
): Promise<string> {
  let tenant: TenantContext;
  try {
    tenant = await resolveTenant(auth, organization, store);
  } catch (error) {
    if (error instanceof TenancyError) return `DENY ${error.code}`;
    throw error;
  }
  const decision = rbac.authorize(
    tenant,
    permission,
    resource === undefined ? undefined : { organizationId: resource },
  );
  return decision.allowed ? 'ALLOW' : `DENY ${decision.reason}`;
}

describe('catalogue', () => {
  it('describes every permission with a stable resource.action id', () => {
    for (const [id, definition] of Object.entries(PERMISSIONS)) {
      expect(id).toBe(`${definition.resource}.${definition.action}`);
      expect(definition.description.length).toBeGreaterThan(0);
    }
  });

  it('lists exactly what owner may do: no wildcard, only catalogue permissions', () => {
    expect(ROLES.owner).toEqual([
      'organization.read',
      'organization.update',
      'activity.read',
      'gia.ask',
      'decision.evaluate',
      'knowledge.read',
      'knowledge.read_restricted',
      'knowledge.propose',
      'knowledge.manage',
      'knowledge.capture',
      'document.read',
      'document.upload',
      'entitlement.read',
      'billing.read',
      'execution.read',
      'execution.start',
      'execution.cancel',
      'department.read',
      'specialist.read',
      'specialist.manage',
      'specialist.task',
      'tool.read',
      'tool.execute',
      'approval.read',
      'approval.approve',
      'ai.generate',
      'credits.read',
      'ai_usage.read',
      'plan.read',
      'plan.create',
      'workflow.read',
      'workflow.manage',
      'conversation.read',
      'conversation.manage',
      'conversation.send',
      'conversation.assist',
      'contact.read',
      'contact.manage',
      'opportunity.read',
      'opportunity.manage',
      'pipeline.manage',
      'follow_up.read',
      'follow_up.manage',
      'forecast.read',
      'forecast.run',
      'report.read',
      'channel.read',
      'channel.create',
      'channel.update',
      'channel.disconnect',
      'channel.delete',
      'relationship.read',
      'relationship.manage',
      'brand.manage',
    ]);
    // An organization role never holds a commercial permission (ADR-0086).
    expect(ROLES.owner.some((p) => p.startsWith('commercial.') || p.startsWith('customer.'))).toBe(
      false,
    );
    for (const permissions of Object.values(ROLES)) {
      for (const permission of permissions) expect(isPermission(permission)).toBe(true);
    }
  });

  it('knows nothing that is not in the catalogue, including prototype names', () => {
    for (const value of ['organization.*', '*', 'toString', '__proto__', 'constructor', '', 1]) {
      expect(isPermission(value)).toBe(false);
    }
  });

  it('refuses a role catalogue that grants an unknown permission', () => {
    expect(() => createAuthorizationService({ owner: ['everything' as never] })).toThrow(
      'role owner grants unknown permission everything',
    );
  });
});

describe('decision matrix: identity + tenant + membership + role + permission + resource', () => {
  type Row = {
    who: 'alice' | 'bob' | 'carol' | 'gia-for-alice';
    org: 'A' | 'B' | 'missing';
    membership?: MembershipStatus;
    organization?: OrganizationStatus;
    role?: string;
    permission: string;
    resource?: 'A' | 'B';
    expected: string;
  };
  const rows: Row[] = [
    { who: 'alice', org: 'A', permission: 'organization.read', expected: 'ALLOW' },
    { who: 'alice', org: 'A', permission: 'organization.read', resource: 'A', expected: 'ALLOW' },
    { who: 'bob', org: 'B', permission: 'organization.read', expected: 'ALLOW' },
    { who: 'gia-for-alice', org: 'A', permission: 'organization.read', expected: 'ALLOW' },
    {
      who: 'alice',
      org: 'B',
      permission: 'organization.read',
      expected: 'DENY organization_forbidden',
    },
    {
      who: 'gia-for-alice',
      org: 'B',
      permission: 'organization.read',
      expected: 'DENY organization_forbidden',
    },
    {
      who: 'carol',
      org: 'A',
      permission: 'organization.read',
      expected: 'DENY organization_forbidden',
    },
    {
      who: 'alice',
      org: 'missing',
      permission: 'organization.read',
      expected: 'DENY organization_forbidden',
    },
    {
      who: 'alice',
      org: 'A',
      membership: 'suspended',
      permission: 'organization.read',
      expected: 'DENY organization_forbidden',
    },
    {
      who: 'alice',
      org: 'A',
      membership: 'revoked',
      permission: 'organization.read',
      expected: 'DENY organization_forbidden',
    },
    {
      who: 'alice',
      org: 'A',
      organization: 'suspended',
      permission: 'organization.read',
      expected: 'DENY organization_forbidden',
    },
    {
      who: 'alice',
      org: 'A',
      permission: 'organization.read',
      resource: 'B',
      expected: 'DENY cross_tenant',
    },
    {
      who: 'gia-for-alice',
      org: 'A',
      permission: 'organization.read',
      resource: 'B',
      expected: 'DENY cross_tenant',
    },
    {
      who: 'alice',
      org: 'A',
      permission: 'organization.delete',
      expected: 'DENY unknown_permission',
    },
    { who: 'alice', org: 'A', permission: 'organization.*', expected: 'DENY unknown_permission' },
    {
      who: 'alice',
      org: 'A',
      role: 'admin',
      permission: 'organization.read',
      expected: 'DENY unknown_role',
    },
    {
      who: 'alice',
      org: 'A',
      role: 'constructor',
      permission: 'organization.read',
      expected: 'DENY unknown_role',
    },
    {
      who: 'gia-for-alice',
      org: 'A',
      role: 'admin',
      permission: 'organization.read',
      expected: 'DENY unknown_role',
    },
  ];

  it.each(rows)(
    '$who in $org (membership $membership, organization $organization, role $role) asks $permission on $resource → $expected',
    async (row) => {
      const { store, a, orgA, orgB } = await world();
      if (row.membership !== undefined || row.role !== undefined) {
        store.put({
          ...a.membership,
          status: row.membership ?? 'active',
          role: row.role ?? a.membership.role,
        });
      }
      if (row.organization !== undefined)
        store.put({ ...a.organization, status: row.organization });
      const auth = {
        alice: as(ALICE),
        bob: as(BOB),
        carol: as(CAROL),
        'gia-for-alice': actAsGia(as(ALICE)),
      }[row.who];
      const org = { A: orgA, B: orgB, missing: '99999999-9999-4999-8999-999999999999' }[row.org];
      const resource = row.resource === undefined ? undefined : { A: orgA, B: orgB }[row.resource];
      expect(await decide(store, auth, org, row.permission, resource)).toBe(row.expected);
    },
  );
});

describe('authorize', () => {
  it('is deterministic: the same tenant and permission always give the same answer', async () => {
    const { store, orgA } = await world();
    const tenant = await resolveTenant(as(ALICE), orgA, store);
    const answers = Array.from({ length: 5 }, () => rbac.authorize(tenant, 'organization.read'));
    expect(new Set(answers.map((d) => JSON.stringify(d))).size).toBe(1);
  });

  it('never trusts a context that did not come from resolveTenant', async () => {
    const { store, orgA, orgB, a, b } = await world();
    const real = await resolveTenant(as(ALICE), orgA, store);
    const forged: TenantContext[] = [
      { ...real },
      { ...real, organizationId: orgB },
      { ...real, userId: BOB },
      { ...real, membershipId: b.membership.id },
      { ...real, membershipId: membershipIdOf(orgB, ALICE) },
      { ...real, role: 'owner' },
      { ...real, actor: 'user' },
      {
        actor: 'gia',
        userId: ALICE,
        organizationId: orgA,
        membershipId: a.membership.id,
        membershipStatus: 'active',
        role: 'owner',
      },
    ];
    for (const tenant of forged) {
      expect(rbac.authorize(tenant, 'organization.read')).toEqual<RbacDecision>({
        allowed: false,
        reason: 'unresolved_tenant',
      });
      expect(rbac.permissionsOf(tenant).size).toBe(0);
    }
    expect(rbac.authorize(real, 'organization.read').allowed).toBe(true);
  });

  it('gives GIA exactly the permissions of the user it acts for, and nothing more', async () => {
    const { store, orgA } = await world();
    const user = await resolveTenant(as(ALICE), orgA, store);
    const gia = await resolveTenant(actAsGia(as(ALICE)), orgA, store);
    expect(gia.actor).toBe('gia');
    expect([...rbac.permissionsOf(gia)]).toEqual([...rbac.permissionsOf(user)]);
    for (const permission of Object.keys(PERMISSIONS)) {
      expect(rbac.authorize(gia, permission)).toEqual(rbac.authorize(user, permission));
    }
  });

  it('denies a role that exists but does not list the permission', async () => {
    const { store, orgA } = await world();
    const tenant = await resolveTenant(as(ALICE), orgA, store);
    const none = createAuthorizationService({ owner: [] });
    expect(none.authorize(tenant, 'organization.read')).toEqual({
      allowed: false,
      reason: 'permission_denied',
    });
  });

  it('cannot be widened through the set permissionsOf returns', async () => {
    const { store, orgA } = await world();
    const tenant = await resolveTenant(as(ALICE), orgA, store);
    const none = createAuthorizationService({ owner: [] });
    (none.permissionsOf(tenant) as Set<string>).add('organization.read');
    expect(none.authorize(tenant, 'organization.read').allowed).toBe(false);
  });
});

describe('the commercial layer (ADR-0085)', () => {
  it('15. a partner or agency context is never a tenant: RBAC grants it nothing in any organization', async () => {
    const at = '2026-09-29T12:00:00Z' as Organization['createdAt'];
    const accountId = 'aaaaaaaa-0000-4000-8000-00000000000a' as never;
    const store = new InMemoryCommercialStore();
    store.putAccount({
      id: accountId,
      type: 'partner',
      name: 'Partner',
      status: 'active',
      createdAt: at,
      updatedAt: at,
    });
    store.putMembership({
      id: 'm' as never,
      commercialAccountId: accountId,
      userId: ALICE,
      role: 'owner',
      status: 'active',
      createdAt: at,
      updatedAt: at,
    });
    const commercial = await resolveCommercialContext(
      { actor: 'user', userId: ALICE, emailVerified: true },
      accountId,
      store,
    );
    // Even with a role named like an organization role, and shaped like a tenant.
    const asTenant = {
      ...commercial,
      actor: 'user',
      organizationId: '99999999-9999-4999-8999-999999999999',
    } as unknown as TenantContext;
    const rbac = createAuthorizationService();
    expect(rbac.authorize(asTenant, 'organization.read')).toEqual<RbacDecision>({
      allowed: false,
      reason: 'unresolved_tenant',
    });
    expect(rbac.permissionsOf(asTenant).size).toBe(0);
  });
});

describe('commercial authorization (ADR-0086)', () => {
  const at = '2026-09-29T12:00:00Z' as Organization['createdAt'];
  const PARTNER = 'aaaaaaaa-0000-4000-8000-00000000000a' as never;
  const ORG = 'eeeeeeee-0000-4000-8000-00000000000e' as OrganizationId;
  async function contextAs(role: string, type: 'partner' | 'agency' = 'partner') {
    const store = new InMemoryCommercialStore();
    store.putAccount({
      id: PARTNER,
      type,
      name: 'P',
      status: 'active',
      createdAt: at,
      updatedAt: at,
    });
    store.putMembership({
      id: 'm' as never,
      commercialAccountId: PARTNER,
      userId: ALICE,
      role,
      status: 'active',
      createdAt: at,
      updatedAt: at,
    });
    return resolveCommercialContext(
      { actor: 'user', userId: ALICE, emailVerified: true },
      PARTNER,
      store,
    );
  }
  const access = (scopes: string[], account = PARTNER) =>
    ({
      commercialAccountId: account,
      organizationId: ORG,
      relationshipId: 'r',
      mode: 'reseller',
      scopes: new Set(scopes),
    }) as never;
  const commercial = createCommercialAuthorization();

  it('gives admins management and support only reads, as Geovet decided', async () => {
    const admin = await contextAs('partner.admin');
    const support = await contextAs('partner.support');
    for (const permission of COMMERCIAL_ROLES['partner.admin']) {
      expect(
        commercial.authorize(admin, permission, access(['summary', 'branding', 'usage', 'billing']))
          .allowed,
      ).toBe(true);
    }
    expect(commercial.authorize(support, 'commercial.read').allowed).toBe(true);
    expect(commercial.authorize(support, 'commercial.manage_members')).toEqual({
      allowed: false,
      reason: 'permission_denied',
    });
    expect(commercial.authorize(support, 'commercial.invite_customer').allowed).toBe(false);
  });

  it('reads inside a customer only within the scopes that customer granted, for its own account', async () => {
    const admin = await contextAs('partner.admin');
    expect(commercial.authorize(admin, 'customer.read_summary')).toEqual({
      allowed: false,
      reason: 'cross_account',
    });
    expect(commercial.authorize(admin, 'customer.read_summary', access([]))).toEqual({
      allowed: false,
      reason: 'scope_not_granted',
    });
    expect(
      commercial.authorize(
        admin,
        'customer.read_summary',
        access(['summary'], 'bbbbbbbb-0000-4000-8000-00000000000b' as never),
      ),
    ).toEqual({ allowed: false, reason: 'cross_account' });
  });

  it("changes a white-label customer's brand only with its branding scope, and never as an agency or support (ADR-0087)", async () => {
    const admin = await contextAs('partner.admin');
    expect(commercial.authorize(admin, 'customer.manage_brand', access(['summary']))).toEqual({
      allowed: false,
      reason: 'scope_not_granted',
    });
    expect(commercial.authorize(admin, 'customer.manage_brand', access(['branding'])).allowed).toBe(
      true,
    );
    expect(
      commercial.authorize(
        admin,
        'customer.manage_brand',
        access(['branding'], 'bbbbbbbb-0000-4000-8000-00000000000b' as never),
      ),
    ).toEqual({ allowed: false, reason: 'cross_account' });
    const support = await contextAs('partner.support');
    expect(commercial.authorize(support, 'customer.manage_brand', access(['branding']))).toEqual({
      allowed: false,
      reason: 'permission_denied',
    });
    expect(COMMERCIAL_ROLES['agency.admin']).not.toContain('customer.manage_brand');
  });

  it('refuses a role of another account type, an unknown role, a forged context and organization permissions', async () => {
    expect(commercial.authorize(await contextAs('agency.admin'), 'commercial.read')).toEqual({
      allowed: false,
      reason: 'role_not_for_account_type',
    });
    expect(commercial.authorize(await contextAs('owner'), 'commercial.read')).toEqual({
      allowed: false,
      reason: 'unknown_role',
    });
    const admin = await contextAs('partner.admin');
    expect(commercial.authorize({ ...admin }, 'commercial.read')).toEqual({
      allowed: false,
      reason: 'unresolved_commercial_context',
    });
    expect(commercial.authorize(admin, 'knowledge.read')).toEqual({
      allowed: false,
      reason: 'permission_denied',
    });
    expect(commercial.authorize(admin, 'credits.grant')).toEqual({
      allowed: false,
      reason: 'unknown_permission',
    });
  });
});
