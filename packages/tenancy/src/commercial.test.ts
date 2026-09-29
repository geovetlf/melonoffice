import type { AuthenticatedContext } from '@melonoffice/auth';
import type {
  CommercialAccount,
  CommercialAccountId,
  CommercialAccountType,
  CustomerAccessScope,
  CustomerRelationshipStatus,
  IsoTimestamp,
  Membership,
  Organization,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import {
  canChangeAccountStatus,
  canChangeRelationshipStatus,
  commercialMembershipIdOf,
  customerAccessOf,
  customerRelationshipIdOf,
  isResolvedCommercialContext,
  listCustomersOf,
  parseCommercialAccountName,
  parseCommissionConfig,
  parseCustomerScopes,
  resolveCommercialContext,
  type CommercialContext,
} from './commercial.js';
import { InMemoryCommercialStore } from './commercial-memory.js';
import { TenancyError } from './errors.js';
import { membershipIdOf } from './ids.js';
import type { TenancyStore } from './store.js';
import { listMyOrganizations, resolveTenant } from './tenant.js';

/**
 * The commercial relationship model (ADR-0085, phase 1). The numbered cases are the brief's
 * security tests that this phase can already answer; phase 2 adds the ones that need routes.
 */

const AT = '2026-09-29T12:00:00Z' as IsoTimestamp;
const PARTNER_ADMIN = '11111111-1111-4111-8111-111111111111' as UserId;
const AGENCY_ADMIN = '22222222-2222-4222-8222-222222222222' as UserId;
const OWNER_A = '33333333-3333-4333-8333-333333333333' as UserId;
const OWNER_B = '44444444-4444-4444-8444-444444444444' as UserId;
const PARTNER_A = 'aaaaaaaa-0000-4000-8000-00000000000a' as CommercialAccountId;
const PARTNER_B = 'bbbbbbbb-0000-4000-8000-00000000000b' as CommercialAccountId;
const AGENCY_A = 'cccccccc-0000-4000-8000-00000000000c' as CommercialAccountId;
const AGENCY_B = 'dddddddd-0000-4000-8000-00000000000d' as CommercialAccountId;
const TENANT_A = 'eeeeeeee-0000-4000-8000-00000000000e' as OrganizationId;
const TENANT_B = 'ffffffff-0000-4000-8000-00000000000f' as OrganizationId;
const TENANT_C = '12121212-0000-4000-8000-000000000012' as OrganizationId;

const user = (userId: UserId): AuthenticatedContext => ({
  actor: 'user',
  userId,
  emailVerified: true,
});

const account = (
  id: CommercialAccountId,
  type: CommercialAccountType,
  extra: Partial<CommercialAccount> = {},
): CommercialAccount => ({
  id,
  type,
  name: `${type} ${id.slice(0, 4)}`,
  status: 'active',
  createdAt: AT,
  updatedAt: AT,
  ...extra,
});

function organization(id: OrganizationId, status: Organization['status'] = 'active') {
  return { id, name: id, status, createdBy: OWNER_A, createdAt: AT, updatedAt: AT };
}

function world() {
  const store = new InMemoryCommercialStore();
  store.putAccount(account(PARTNER_A, 'partner'));
  store.putAccount(account(PARTNER_B, 'partner'));
  store.putAccount(account(AGENCY_A, 'agency'));
  store.putAccount(account(AGENCY_B, 'agency'));
  const member = (accountId: CommercialAccountId, userId: UserId, role: string) =>
    store.putMembership({
      id: commercialMembershipIdOf(accountId, userId),
      commercialAccountId: accountId,
      userId,
      role,
      status: 'active',
      createdAt: AT,
      updatedAt: AT,
    });
  member(PARTNER_A, PARTNER_ADMIN, 'partner.admin');
  member(AGENCY_A, AGENCY_ADMIN, 'agency.admin');
  const relate = (
    accountId: CommercialAccountId,
    organizationId: OrganizationId,
    status: CustomerRelationshipStatus = 'active',
    scopes: readonly CustomerAccessScope[] = [],
  ) =>
    store.putRelationship({
      id: customerRelationshipIdOf(accountId, organizationId),
      commercialAccountId: accountId,
      organizationId,
      mode: accountId === AGENCY_A ? 'agency' : 'reseller',
      status,
      scopes,
      createdAt: AT,
      updatedAt: AT,
    });
  relate(PARTNER_A, TENANT_A, 'active', ['summary', 'usage']);
  relate(AGENCY_A, TENANT_A);
  relate(PARTNER_B, TENANT_B, 'active', ['summary', 'knowledge', 'conversations']);
  const orgs = new Map<OrganizationId, Organization>([
    [TENANT_A, organization(TENANT_A)],
    [TENANT_B, organization(TENANT_B)],
    [TENANT_C, organization(TENANT_C)],
  ]);
  const memberships = new Map<string, Membership>([
    [
      membershipIdOf(TENANT_A, OWNER_A),
      {
        id: membershipIdOf(TENANT_A, OWNER_A),
        organizationId: TENANT_A,
        userId: OWNER_A,
        role: 'owner',
        status: 'active',
        createdAt: AT,
        updatedAt: AT,
      },
    ],
  ]);
  const tenancy: TenancyStore = {
    createOrganization: async () => {
      throw new Error('not used');
    },
    findOrganization: async (id) => orgs.get(id),
    findMembership: async (org, userId) => memberships.get(membershipIdOf(org, userId)),
    membershipsOfUser: async (userId) =>
      [...memberships.values()].filter((m) => m.userId === userId),
  };
  return { store, orgs, tenancy, relate, member };
}

const refused = async (promise: Promise<unknown>, code: string) => {
  await expect(promise).rejects.toBeInstanceOf(TenancyError);
  await expect(promise).rejects.toMatchObject({ code });
};

describe('commercial accounts are a layer above organizations (ADR-0085)', () => {
  it('places a person in their own active account only', async () => {
    const { store } = world();
    const context = await resolveCommercialContext(user(PARTNER_ADMIN), PARTNER_A, store);
    expect(context).toMatchObject({
      userId: PARTNER_ADMIN,
      commercialAccountId: PARTNER_A,
      accountType: 'partner',
      role: 'partner.admin',
    });
    expect(isResolvedCommercialContext(context)).toBe(true);
  });

  it('2. Partner A cannot act in Partner B, and 4. Agency A cannot act in Agency B', async () => {
    const { store } = world();
    await refused(
      resolveCommercialContext(user(PARTNER_ADMIN), PARTNER_B, store),
      'commercial_account_forbidden',
    );
    await refused(
      resolveCommercialContext(user(AGENCY_ADMIN), AGENCY_B, store),
      'commercial_account_forbidden',
    );
    await refused(
      resolveCommercialContext(user(AGENCY_ADMIN), PARTNER_A, store),
      'commercial_account_forbidden',
    );
  });

  it('refuses every other case with the same answer, so ids cannot be probed', async () => {
    const { store, member } = world();
    const gia: AuthenticatedContext = { ...user(PARTNER_ADMIN), actor: 'gia' };
    for (const requested of [undefined, '', 'not-an-id', '99999999-0000-4000-8000-000000000099']) {
      await refused(
        resolveCommercialContext(user(PARTNER_ADMIN), requested, store),
        'commercial_account_forbidden',
      );
    }
    // GIA has no commercial path, even for an administrator.
    await refused(resolveCommercialContext(gia, PARTNER_A, store), 'commercial_account_forbidden');
    // A suspended account, and a suspended membership, grant nothing.
    store.putAccount(account(PARTNER_B, 'partner', { status: 'suspended' }));
    member(PARTNER_B, PARTNER_ADMIN, 'partner.admin');
    await refused(
      resolveCommercialContext(user(PARTNER_ADMIN), PARTNER_B, store),
      'commercial_account_forbidden',
    );
    store.putMembership({
      id: commercialMembershipIdOf(PARTNER_A, PARTNER_ADMIN),
      commercialAccountId: PARTNER_A,
      userId: PARTNER_ADMIN,
      role: 'partner.admin',
      status: 'suspended',
      createdAt: AT,
      updatedAt: AT,
    });
    await refused(
      resolveCommercialContext(user(PARTNER_ADMIN), PARTNER_A, store),
      'commercial_account_forbidden',
    );
  });

  it('3. and 5. reaches a customer only through an active relationship of that exact account', async () => {
    const { store, tenancy } = world();
    const partner = await resolveCommercialContext(user(PARTNER_ADMIN), PARTNER_A, store);
    const agency = await resolveCommercialContext(user(AGENCY_ADMIN), AGENCY_A, store);
    expect(await customerAccessOf(partner, TENANT_A, store, tenancy)).toMatchObject({
      organizationId: TENANT_A,
      mode: 'reseller',
    });
    expect((await customerAccessOf(agency, TENANT_A, store, tenancy)).mode).toBe('agency');
    // Tenant B is Partner B's customer, and Tenant C nobody's.
    for (const context of [partner, agency]) {
      await refused(customerAccessOf(context, TENANT_B, store, tenancy), 'customer_forbidden');
      await refused(customerAccessOf(context, TENANT_C, store, tenancy), 'customer_forbidden');
    }
  });

  it('8. knowing an organization id is never enough', async () => {
    const { store, tenancy, relate, orgs } = world();
    const partner = await resolveCommercialContext(user(PARTNER_ADMIN), PARTNER_A, store);
    // A pending relationship (not accepted by the customer), a suspended or ended one: nothing.
    for (const status of ['pending', 'suspended', 'ended'] as const) {
      relate(PARTNER_A, TENANT_C, status, ['summary']);
      await refused(customerAccessOf(partner, TENANT_C, store, tenancy), 'customer_forbidden');
    }
    // A suspended customer: nothing, even with an active relationship.
    relate(PARTNER_A, TENANT_C, 'active', ['summary']);
    orgs.set(TENANT_C, organization(TENANT_C, 'suspended'));
    await refused(customerAccessOf(partner, TENANT_C, store, tenancy), 'customer_forbidden');
    // A commercial membership opens no organization as a tenant.
    await refused(resolveTenant(user(PARTNER_ADMIN), TENANT_A, tenancy), 'organization_forbidden');
    expect(await listMyOrganizations(user(PARTNER_ADMIN), tenancy)).toEqual([]);
  });

  it('6. and 7. grants no company memory or conversations unless the customer granted exactly that', async () => {
    const { store, tenancy } = world();
    const partner = await resolveCommercialContext(user(PARTNER_ADMIN), PARTNER_A, store);
    const agency = await resolveCommercialContext(user(AGENCY_ADMIN), AGENCY_A, store);
    const partnerScopes = (await customerAccessOf(partner, TENANT_A, store, tenancy)).scopes;
    expect([...partnerScopes]).toEqual(['summary', 'usage']);
    expect(partnerScopes.has('knowledge')).toBe(false);
    expect(partnerScopes.has('conversations')).toBe(false);
    // By default a relationship grants no scope at all.
    expect((await customerAccessOf(agency, TENANT_A, store, tenancy)).scopes.size).toBe(0);
  });

  it('9. a context built or edited by a client authorizes nothing', async () => {
    const { store, tenancy } = world();
    const real = await resolveCommercialContext(user(PARTNER_ADMIN), PARTNER_A, store);
    const forged: CommercialContext = { ...real };
    const elevated: CommercialContext = { ...real, commercialAccountId: PARTNER_B };
    expect(isResolvedCommercialContext(forged)).toBe(false);
    await refused(customerAccessOf(forged, TENANT_A, store, tenancy), 'customer_forbidden');
    await refused(customerAccessOf(elevated, TENANT_B, store, tenancy), 'customer_forbidden');
    await refused(listCustomersOf(elevated, store, tenancy), 'commercial_account_forbidden');
  });

  it("lists only the account's own active customers", async () => {
    const { store, tenancy, relate } = world();
    relate(PARTNER_A, TENANT_C, 'pending', ['summary']);
    const partner = await resolveCommercialContext(user(PARTNER_ADMIN), PARTNER_A, store);
    const customers = await listCustomersOf(partner, store, tenancy);
    expect(customers.map((c) => c.organizationId)).toEqual([TENANT_A]);
  });

  it('14. leaves Direct SaaS exactly as it was', async () => {
    const { tenancy } = world();
    const tenant = await resolveTenant(user(OWNER_A), TENANT_A, tenancy);
    expect(tenant).toMatchObject({ organizationId: TENANT_A, role: 'owner' });
    await refused(resolveTenant(user(OWNER_B), TENANT_A, tenancy), 'organization_forbidden');
  });
});

describe('commercial configuration is data, never a constant (ADR-0085)', () => {
  it('parses a commission only as given, in whole basis points', () => {
    expect(parseCommissionConfig({ model: 'commission', basisPoints: 1500 })).toEqual({
      model: 'commission',
      basisPoints: 1500,
    });
    expect(
      parseCommissionConfig({ model: 'wholesale', basisPoints: 0, agreementRef: 'agr-2026:01' }),
    ).toEqual({ model: 'wholesale', basisPoints: 0, agreementRef: 'agr-2026:01' });
    for (const bad of [
      undefined,
      null,
      [],
      {},
      { model: 'bonus', basisPoints: 10 },
      { model: 'commission' },
      { model: 'commission', basisPoints: 12.5 },
      { model: 'commission', basisPoints: -1 },
      { model: 'commission', basisPoints: 10_001 },
      { model: 'commission', basisPoints: 10, agreementRef: 'has spaces' },
    ]) {
      expect(() => parseCommissionConfig(bad)).toThrow(TenancyError);
    }
  });

  it('parses scopes as known, without repeats, in catalogue order', () => {
    expect(parseCustomerScopes(['usage', 'summary', 'usage'])).toEqual(['summary', 'usage']);
    expect(parseCustomerScopes([])).toEqual([]);
    expect(() => parseCustomerScopes(['everything'])).toThrow(TenancyError);
    expect(() => parseCustomerScopes('summary')).toThrow(TenancyError);
  });

  it('names an account like an organization', () => {
    expect(parseCommercialAccountName('  Socio Uno ')).toBe('Socio Uno');
    expect(() => parseCommercialAccountName('')).toThrow(
      expect.objectContaining({ code: 'invalid_commercial_account_name' }),
    );
  });

  it('allows only the defined status changes; closed and ended are final', () => {
    expect(canChangeAccountStatus('active', 'suspended')).toBe(true);
    expect(canChangeAccountStatus('closed', 'active')).toBe(false);
    expect(canChangeRelationshipStatus('pending', 'active')).toBe(true);
    expect(canChangeRelationshipStatus('pending', 'suspended')).toBe(false);
    expect(canChangeRelationshipStatus('ended', 'active')).toBe(false);
  });
});
