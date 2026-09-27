import type { CreditService } from '@melonoffice/credits';
import type { DeploymentEnvironment, Organization, OrganizationId } from '@melonoffice/domain';
import { OWNER_ROLE, resolveTenant, type TenancyStore } from '@melonoffice/tenancy';

/**
 * The one DEV test grant approved with D-12 (2026-09-27, ADR-0038): 500 credits to the test
 * organization MOpruebas, to try assisted AI. Fixed here, not an input: no other organization,
 * amount or environment can be named, and it is not a plan's credits (still pending).
 *
 * The reference makes it idempotent: running it again replays the same ledger entry and moves
 * nothing. It goes through the Credits engine's own `grant`, audited as `credits.grant` in the
 * same write, like every credit movement.
 */
export const DEV_TEST_GRANT = Object.freeze({
  organizationName: 'MOpruebas',
  amount: 500,
  referenceId: 'dev-test-grant:cv5:1',
  reason: 'dev_test_grant',
});

export interface DevTestGrantResult {
  readonly organizationId: OrganizationId;
  readonly balance: number;
  /** True when the grant had already been made: nothing moved. */
  readonly replayed: boolean;
}

export class DevTestGrantError extends Error {
  override readonly name = 'DevTestGrantError';

  constructor(
    readonly code:
      | 'not_dev'
      | 'organization_not_found'
      | 'organization_ambiguous'
      | 'organization_inactive'
      | 'owner_not_active',
  ) {
    super(code);
  }
}

/**
 * Makes the DEV test grant. Server side only: run by the owner of the DEV project from Cloud Shell
 * (`grant-dev-credits.ts`), never by an API route or a normal user. It acts as the organization's
 * creator, who must still be its active owner, so the ledger and the audit log name a real
 * member, and the tenant is resolved like any other.
 */
export async function grantDevTestCredits(input: {
  readonly environment: DeploymentEnvironment | undefined;
  /** Every organization with exactly this name. */
  readonly organizationsNamed: (name: string) => Promise<readonly Organization[]>;
  readonly tenancy: TenancyStore;
  readonly credits: Pick<CreditService, 'grant'>;
}): Promise<DevTestGrantResult> {
  if (input.environment !== 'dev') throw new DevTestGrantError('not_dev');
  const found = await input.organizationsNamed(DEV_TEST_GRANT.organizationName);
  const matching = found.filter((o) => o.name === DEV_TEST_GRANT.organizationName);
  if (matching.length === 0) throw new DevTestGrantError('organization_not_found');
  if (matching.length > 1) throw new DevTestGrantError('organization_ambiguous');
  const [organization] = matching as [Organization];
  if (organization.status !== 'active') throw new DevTestGrantError('organization_inactive');
  let tenant;
  try {
    tenant = await resolveTenant(
      { actor: 'user', userId: organization.createdBy, emailVerified: false },
      organization.id,
      input.tenancy,
    );
  } catch {
    throw new DevTestGrantError('owner_not_active');
  }
  if (tenant.role !== OWNER_ROLE) throw new DevTestGrantError('owner_not_active');
  const result = await input.credits.grant(tenant, {
    amount: DEV_TEST_GRANT.amount,
    referenceId: DEV_TEST_GRANT.referenceId,
    reason: DEV_TEST_GRANT.reason,
  });
  return { organizationId: organization.id, balance: result.balance, replayed: result.replayed };
}
