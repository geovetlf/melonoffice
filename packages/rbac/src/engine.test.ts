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
  InMemoryTenancyStore,
  membershipIdOf,
  resolveTenant,
  TenancyError,
  type TenantContext,
} from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { createAuthorizationService, type RbacDecision } from './engine.js';
import { isPermission, PERMISSIONS } from './permissions.js';
import { ROLES } from './roles.js';

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
      'entitlement.read',
      'billing.read',
      'execution.read',
      'execution.start',
      'execution.cancel',
      'department.read',
      'specialist.read',
      'tool.read',
      'tool.execute',
      'approval.read',
      'approval.approve',
      'ai.generate',
      'credits.read',
      'plan.read',
      'plan.create',
      'workflow.read',
      'workflow.manage',
      'conversation.read',
      'conversation.manage',
      'conversation.send',
      'conversation.assist',
      'contact.read',
      'channel.read',
      'channel.create',
      'channel.update',
      'channel.disconnect',
      'channel.delete',
    ]);
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
