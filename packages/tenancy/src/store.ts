import type { AuditEvent } from '@melonoffice/audit';
import type {
  CreditWallet,
  InitialBilling,
  Membership,
  Organization,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';

export interface NewOrganization {
  /** Already validated by `createOrganization()`. */
  readonly name: string;
  readonly creator: UserId;
  /**
   * The organization's billing account and first subscription (ADR-0022), built by billing for
   * the new organization. Always chosen by the server, never by the client, and stored with the
   * organization in the same write. If building them throws, nothing is created.
   */
  readonly billing: (organization: Organization) => InitialBilling;
  /**
   * The organization's credit wallet (ADR-0023), built by credits with a balance of 0 and stored
   * with the organization in the same write. No credits come with a plan.
   */
  readonly credits: (organization: Organization) => CreditWallet;
  /**
   * Audit events for the creation (ADR-0020). The store writes them together with the
   * organization, so the organization never exists without its record. If building them throws,
   * nothing is created.
   */
  readonly audit?: (created: CreatedOrganization) => readonly AuditEvent[];
}

export interface CreatedOrganization {
  readonly organization: Organization;
  /** The creator's membership: active, role `owner`. */
  readonly membership: Membership;
  readonly billing: InitialBilling;
  readonly wallet: CreditWallet;
}

/**
 * Checks that the billing built for a new organization belongs to it, so a store never writes an
 * account or subscription for another organization.
 */
export function checkInitialWallet(organization: Organization, wallet: CreditWallet): void {
  if (wallet.organizationId !== organization.id || wallet.balance !== 0) {
    throw new Error('initial wallet does not belong to the new organization or is not empty');
  }
}

export function checkInitialBilling(organization: Organization, billing: InitialBilling): void {
  const { account, subscription } = billing;
  if (
    account.organizationId !== organization.id ||
    subscription.organizationId !== organization.id ||
    account.subscriptionId !== subscription.id
  ) {
    throw new Error('initial billing does not belong to the new organization');
  }
}

/**
 * Where organizations and memberships are stored: Firestore in the API (ADR-0018), memory in
 * tests. It stores and finds; access decisions are made by `resolveTenant()`.
 */
export interface TenancyStore {
  /**
   * Creates the organization and its creator's membership together, or neither. Throws
   * `organization_limit_reached` when the creator already created one (ADR-0018), atomically,
   * so concurrent calls cannot get past it.
   */
  createOrganization(input: NewOrganization): Promise<CreatedOrganization>;
  findOrganization(id: OrganizationId): Promise<Organization | undefined>;
  /** The membership of this user in this organization, in any status. */
  findMembership(organizationId: OrganizationId, userId: UserId): Promise<Membership | undefined>;
  /** Every membership of the user, in any status. */
  membershipsOfUser(userId: UserId): Promise<readonly Membership[]>;
}
