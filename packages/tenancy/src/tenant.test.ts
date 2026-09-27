import { buildAuditEvent, InMemoryAuditStore } from '@melonoffice/audit';
import { actAsGia, type AuthenticatedContext } from '@melonoffice/auth';
import type { Membership, Organization, OrganizationId, UserId } from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { TenancyError } from './errors.js';
import { isOrganizationId, membershipIdOf } from './ids.js';
import { InMemoryTenancyStore } from './memory.js';
import {
  createOrganization,
  isResolvedTenant,
  listMyOrganizations,
  parseOrganizationName,
  resolveTenant,
} from './tenant.js';

const NOW = new Date('2026-09-26T12:00:00Z');
const ALICE = '11111111-1111-4111-8111-111111111111' as UserId;
const BOB = '22222222-2222-4222-8222-222222222222' as UserId;
const MISSING_ORG = '99999999-9999-4999-8999-999999999999';
/** Tenancy stores the plan reference as given; which plans exist is entitlements' business. */
const PLAN = { id: 'test-plan', version: 1 } as const;

const userContext = (userId: UserId): AuthenticatedContext =>
  Object.freeze({ actor: 'user', userId, emailVerified: true });

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TenancyError) return error.code;
    throw error;
  }
  return 'accepted';
}

/** Alice owns organization A and Bob owns organization B. */
async function setup() {
  const store = new InMemoryTenancyStore(() => NOW);
  const alice = userContext(ALICE);
  const bob = userContext(BOB);
  const a = await createOrganization(alice, { name: 'Org A' }, store, { plan: PLAN });
  const b = await createOrganization(bob, { name: 'Org B' }, store, { plan: PLAN });
  return { store, alice, bob, orgA: a.organization.id, orgB: b.organization.id, a, b };
}

describe('createOrganization', () => {
  it('creates an active organization with the caller as its active owner', async () => {
    const store = new InMemoryTenancyStore(() => NOW);
    const { organization, membership } = await createOrganization(
      userContext(ALICE),
      { name: '  Acme  ' },
      store,
      { plan: PLAN },
    );
    expect(organization).toEqual({
      id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      name: 'Acme',
      status: 'active',
      createdBy: ALICE,
      plan: { id: 'test-plan', version: 1 },
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(membership).toEqual({
      id: `${organization.id}_${ALICE}`,
      organizationId: organization.id,
      userId: ALICE,
      status: 'active',
      role: 'owner',
      createdAt: NOW.toISOString(),
      updatedAt: NOW.toISOString(),
    });
    expect(await store.findOrganization(organization.id)).toEqual(organization);
    expect(await store.findMembership(organization.id, ALICE)).toEqual(membership);
  });

  it('requires a well-formed plan reference, chosen by the server', async () => {
    const store = new InMemoryTenancyStore(() => NOW);
    for (const plan of [
      undefined,
      { id: '', version: 1 },
      { id: 'Entrepreneur', version: 1 },
      { id: 'entrepreneur', version: 0 },
      { id: 'entrepreneur', version: 1.5 },
    ]) {
      await expect(
        createOrganization(userContext(ALICE), { name: 'Acme' }, store, {
          plan: plan as unknown as { id: string; version: number },
        }),
      ).rejects.toThrow('invalid plan reference');
    }
    expect(await store.membershipsOfUser(ALICE)).toEqual([]);
  });

  it('never derives the id from the name or the user', async () => {
    const store = new InMemoryTenancyStore();
    const { organization } = await createOrganization(userContext(ALICE), { name: 'acme' }, store, {
      plan: PLAN,
    });
    expect(organization.id).not.toContain('acme');
    expect(organization.id).not.toContain(ALICE);
    expect(isOrganizationId(organization.id)).toBe(true);
  });

  it('allows the same name in different organizations', async () => {
    const store = new InMemoryTenancyStore();
    const a = await createOrganization(userContext(ALICE), { name: 'Acme' }, store, { plan: PLAN });
    const b = await createOrganization(userContext(BOB), { name: 'Acme' }, store, { plan: PLAN });
    expect(a.organization.id).not.toBe(b.organization.id);
  });

  it('lets each user create one organization, even under concurrent calls', async () => {
    const store = new InMemoryTenancyStore();
    const alice = userContext(ALICE);
    const results = await Promise.all(
      Array.from({ length: 5 }, () =>
        codeOf(createOrganization(alice, { name: 'Acme' }, store, { plan: PLAN })),
      ),
    );
    expect(results.filter((r) => r === 'accepted')).toHaveLength(1);
    expect(results.filter((r) => r === 'organization_limit_reached')).toHaveLength(4);
    expect(await store.membershipsOfUser(ALICE)).toHaveLength(1);
  });

  it('refuses GIA: only the user may create an organization', async () => {
    const store = new InMemoryTenancyStore();
    expect(
      await codeOf(
        createOrganization(actAsGia(userContext(ALICE)), { name: 'Acme' }, store, { plan: PLAN }),
      ),
    ).toBe('requires_user');
    expect(await store.membershipsOfUser(ALICE)).toHaveLength(0);
  });

  it('takes the creator from the context only, never from the input', async () => {
    const store = new InMemoryTenancyStore();
    const input = { name: 'Acme', creator: BOB, userId: BOB, organizationId: MISSING_ORG };
    const { organization, membership } = await createOrganization(
      userContext(ALICE),
      input,
      store,
      { plan: PLAN },
    );
    expect(organization.createdBy).toBe(ALICE);
    expect(membership.userId).toBe(ALICE);
    expect(organization.id).not.toBe(MISSING_ORG);
    expect(await store.membershipsOfUser(BOB)).toHaveLength(0);
  });
});

describe('parseOrganizationName', () => {
  it.each([
    ['trims and keeps inner spaces', '  Acme  Corp ', 'Acme  Corp'],
    ['accepts non-Latin names', 'Compañía Ñandú 株式会社', 'Compañía Ñandú 株式会社'],
    ['normalizes to NFC', 'Café', 'Café'],
    ['accepts exactly 100 characters', 'x'.repeat(100), 'x'.repeat(100)],
  ])('%s', (_name, input, expected) => {
    expect(parseOrganizationName(input)).toBe(expected);
  });

  it.each([
    ['a missing name', undefined],
    ['a number', 42],
    ['an empty string', ''],
    ['only spaces', '   '],
    ['101 characters', 'x'.repeat(101)],
    ['a control character', 'Acme\nCorp'],
    ['a bidi override', 'Acme‮proC'],
  ])('refuses %s', (_name, input) => {
    expect(() => parseOrganizationName(input)).toThrow('invalid_organization_name');
  });
});

describe('resolveTenant (cross-tenant)', () => {
  it('user A in organization A is allowed', async () => {
    const { store, alice, orgA, a } = await setup();
    const tenant = await resolveTenant(alice, orgA, store);
    expect(tenant).toEqual({
      actor: 'user',
      userId: ALICE,
      organizationId: orgA,
      membershipId: a.membership.id,
      membershipStatus: 'active',
      role: 'owner',
    });
    expect(Object.isFrozen(tenant)).toBe(true);
  });

  it('marks only the exact contexts it returns as resolved', async () => {
    const { store, alice, orgA, orgB } = await setup();
    const tenant = await resolveTenant(alice, orgA, store);
    expect(isResolvedTenant(tenant)).toBe(true);
    expect(isResolvedTenant({ ...tenant })).toBe(false);
    expect(isResolvedTenant({ ...tenant, organizationId: orgB })).toBe(false);
  });

  it('user A in organization B, without a membership, is refused', async () => {
    const { store, alice, orgB } = await setup();
    expect(await codeOf(resolveTenant(alice, orgB, store))).toBe('organization_forbidden');
  });

  it('user B in organization B is allowed', async () => {
    const { store, bob, orgB } = await setup();
    expect((await resolveTenant(bob, orgB, store)).organizationId).toBe(orgB);
  });

  it('a modified organization id never elevates: every forgery gets the same refusal', async () => {
    const { store, alice, orgA, orgB } = await setup();
    for (const forged of [
      orgB,
      MISSING_ORG,
      orgA.toUpperCase(),
      `${orgA} `,
      `${orgA}/../${orgB}`,
      'org-a',
      '*',
    ]) {
      expect(await codeOf(resolveTenant(alice, forged, store))).toBe('organization_forbidden');
    }
  });

  it('a modified user id does not change identity: access follows the context alone', async () => {
    const { store, alice, orgB } = await setup();
    // A caller can only change what it sends; the context comes from the verified token.
    const forgedRequest = { organizationId: orgB, userId: BOB };
    const tenant = resolveTenant(alice, forgedRequest.organizationId, store);
    expect(await codeOf(tenant)).toBe('organization_forbidden');
  });

  it('needs an organization to be chosen', async () => {
    const { store, alice } = await setup();
    expect(await codeOf(resolveTenant(alice, undefined, store))).toBe('organization_required');
    expect(await codeOf(resolveTenant(alice, '', store))).toBe('organization_required');
  });

  it.each(['suspended', 'revoked'] as const)('refuses a %s membership', async (status) => {
    const { store, alice, orgA, a } = await setup();
    store.put({ ...a.membership, status });
    expect(await codeOf(resolveTenant(alice, orgA, store))).toBe('organization_forbidden');
  });

  it('refuses a suspended organization, even for an active owner', async () => {
    const { store, alice, orgA, a } = await setup();
    store.put({ ...a.organization, status: 'suspended' });
    expect(await codeOf(resolveTenant(alice, orgA, store))).toBe('organization_forbidden');
  });

  it('refuses a membership record that belongs to someone else', async () => {
    const { store, alice, orgB, b } = await setup();
    // A mis-keyed record: stored under Alice's key but naming Bob.
    const misKeyed: Membership = { ...b.membership, id: membershipIdOf(orgB, ALICE) };
    store.put(misKeyed);
    expect(await codeOf(resolveTenant(alice, orgB, store))).toBe('organization_forbidden');
  });

  it('GIA acting for A resolves exactly like A, and no further', async () => {
    const { store, alice, orgA, orgB } = await setup();
    const gia = actAsGia(alice);
    const tenant = await resolveTenant(gia, orgA, store);
    expect(tenant).toMatchObject({ actor: 'gia', userId: ALICE, organizationId: orgA });
    expect(await codeOf(resolveTenant(gia, orgB, store))).toBe('organization_forbidden');
  });
});

describe('listMyOrganizations', () => {
  it("lists only the caller's active organizations", async () => {
    const { store, alice, bob, a, b } = await setup();
    expect(await listMyOrganizations(alice, store)).toEqual([
      { organization: a.organization, membership: a.membership },
    ]);
    expect(await listMyOrganizations(bob, store)).toEqual([
      { organization: b.organization, membership: b.membership },
    ]);
  });

  it('leaves out suspended or revoked memberships and suspended organizations', async () => {
    const { store, alice, a } = await setup();
    const second: Organization = {
      ...a.organization,
      id: '33333333-3333-4333-8333-333333333333' as OrganizationId,
    };
    store.put(second);
    store.put({ ...a.membership, id: membershipIdOf(second.id, ALICE), organizationId: second.id });
    expect(await listMyOrganizations(alice, store)).toHaveLength(2);
    store.put({ ...a.membership, status: 'revoked' });
    store.put({ ...second, status: 'suspended' });
    expect(await listMyOrganizations(alice, store)).toEqual([]);
  });

  it('is empty for a user without memberships', async () => {
    const store = new InMemoryTenancyStore();
    expect(await listMyOrganizations(userContext(ALICE), store)).toEqual([]);
  });
});

describe('creation audit (atomic)', () => {
  it('stores the creation events together with the organization', async () => {
    const audit = new InMemoryAuditStore();
    const store = new InMemoryTenancyStore(() => NOW, audit);
    const { organization } = await createOrganization(userContext(ALICE), { name: 'Acme' }, store, {
      plan: PLAN,
      audit: ({ organization: created }) => [
        buildAuditEvent(
          {
            action: 'organization.create',
            result: 'success',
            actor: { type: 'user', userId: ALICE, via: 'direct' },
            organizationId: created.id,
            source: 'api',
          },
          NOW,
        ),
      ],
    });
    expect(audit.events().map((e) => e.organizationId)).toEqual([organization.id]);
  });

  it('creates nothing when the events cannot be built', async () => {
    const audit = new InMemoryAuditStore();
    const store = new InMemoryTenancyStore(() => NOW, audit);
    const failing = createOrganization(userContext(ALICE), { name: 'Acme' }, store, {
      plan: PLAN,
      audit: () => {
        throw new Error('audit unavailable');
      },
    });
    await expect(failing).rejects.toThrow('audit unavailable');
    expect(await store.membershipsOfUser(ALICE)).toEqual([]);
    expect(audit.events()).toEqual([]);
    // The user was not marked as a creator, so a later attempt still works.
    await createOrganization(userContext(ALICE), { name: 'Acme' }, store, { plan: PLAN });
  });
});
