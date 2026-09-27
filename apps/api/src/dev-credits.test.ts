import type { Organization, OrganizationId, UserId } from '@melonoffice/domain';
import type { TenancyStore } from '@melonoffice/tenancy';
import { describe, expect, it } from 'vitest';
import { DEV_TEST_GRANT, grantDevTestCredits } from './dev-credits.js';

const ORG = '11111111-1111-4111-8111-111111111111' as OrganizationId;
const organization = (overrides: Partial<Organization> = {}): Organization =>
  ({
    id: ORG,
    name: 'MOpruebas',
    status: 'active',
    createdBy: 'owner-1' as UserId,
    createdAt: '2026-09-27T00:00:00.000Z',
    updatedAt: '2026-09-27T00:00:00.000Z',
    ...overrides,
  }) as Organization;

/** A tenancy store with one organization and, optionally, its owner's membership. */
const tenancy = (org: Organization, member: 'active' | 'suspended' | 'none' = 'active') =>
  ({
    findOrganization: async (id: OrganizationId) => (id === org.id ? org : undefined),
    findMembership: async (organizationId: OrganizationId, userId: UserId) =>
      member === 'none' || organizationId !== org.id || userId !== org.createdBy
        ? undefined
        : {
            id: `${organizationId}_${userId}`,
            organizationId,
            userId,
            status: member,
            role: 'owner',
          },
  }) as unknown as TenancyStore;

describe('DEV test grant (ADR-0038)', () => {
  const run = (
    found: readonly Organization[],
    store: TenancyStore,
    environment: 'dev' | 'prod' = 'dev',
  ) => {
    const grants: unknown[] = [];
    const result = grantDevTestCredits({
      environment,
      organizationsNamed: async () => found,
      tenancy: store,
      credits: {
        grant: async (tenant, request) => {
          grants.push({ organizationId: tenant.organizationId, actor: tenant.actor, ...request });
          return { entry: {} as never, balance: 500, replayed: false };
        },
      },
    });
    return { result, grants };
  };

  it('grants exactly 500 credits to MOpruebas as its active owner', async () => {
    const org = organization();
    const { result, grants } = run([org], tenancy(org));
    await expect(result).resolves.toEqual({ organizationId: ORG, balance: 500, replayed: false });
    expect(grants).toEqual([
      {
        organizationId: ORG,
        actor: 'user',
        amount: 500,
        referenceId: DEV_TEST_GRANT.referenceId,
        reason: 'dev_test_grant',
      },
    ]);
  });

  it('refuses anything else, and grants nothing', async () => {
    const org = organization();
    const cases: [ReturnType<typeof run>, string][] = [
      [run([org], tenancy(org), 'prod'), 'not_dev'],
      [run([], tenancy(org)), 'organization_not_found'],
      // A name that only looks alike is not MOpruebas.
      [run([organization({ name: 'mopruebas' })], tenancy(org)), 'organization_not_found'],
      [
        run(
          [org, organization({ id: '22222222-2222-4222-8222-222222222222' as never })],
          tenancy(org),
        ),
        'organization_ambiguous',
      ],
      [
        run(
          [organization({ status: 'suspended' })],
          tenancy(organization({ status: 'suspended' })),
        ),
        'organization_inactive',
      ],
      [run([org], tenancy(org, 'suspended')), 'owner_not_active'],
      [run([org], tenancy(org, 'none')), 'owner_not_active'],
    ];
    for (const [{ result, grants }, code] of cases) {
      await expect(result).rejects.toMatchObject({ code });
      expect(grants).toHaveLength(0);
    }
  });
});
