import type { OrganizationId, PlanRef, Subscription } from '@melonoffice/domain';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { isPlanInForce, isPlanRef, isSubscriptionStatus } from './lifecycle.js';
import type { BillingStore } from './store.js';

/**
 * Why an organization has no usable billing. None of them is ever replaced by an invented
 * subscription or a default plan.
 *
 * - `unresolved_tenant`: the context did not come from `resolveTenant()`.
 * - `organization_inactive`: the organization is missing or not active.
 * - `billing_missing`: the organization has no billing account (created before billing existed).
 * - `subscription_missing`: the account points at no subscription.
 * - `subscription_invalid`: the stored subscription is not this organization's, or has an unknown
 *   status or a malformed plan.
 */
export type BillingUnavailableReason =
  | 'unresolved_tenant'
  | 'organization_inactive'
  | 'billing_missing'
  | 'subscription_missing'
  | 'subscription_invalid';

export type OrganizationBilling =
  | {
      readonly status: 'present';
      readonly organizationId: OrganizationId;
      readonly subscription: Subscription;
      /** Whether the subscription's plan is in force, so entitlements apply (`trialing`, `active`). */
      readonly planInForce: boolean;
    }
  | { readonly status: 'unavailable'; readonly reason: BillingUnavailableReason };

/**
 * The commercial state of an organization (ADR-0022). It knows nothing about HTTP, payments,
 * credits or usage, and nothing about what a plan grants: that is entitlements'.
 */
export interface BillingService {
  /** The caller's organization billing. The organization always comes from the resolved tenant. */
  billingOf(tenant: TenantContext): Promise<OrganizationBilling>;
  /**
   * The plan in force for an organization, for entitlements: the current subscription's plan
   * while it is `trialing` or `active`, and nothing otherwise. Never a default. Callers pass an
   * organization they already resolved from a tenant.
   */
  currentPlan(organizationId: OrganizationId): Promise<PlanRef | undefined>;
}

export interface BillingServiceOptions {
  readonly billing: BillingStore;
  /** Only `findOrganization` is used, to refuse inactive organizations. */
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
}

type Read =
  | { readonly subscription: Subscription }
  | {
      readonly reason: Exclude<
        BillingUnavailableReason,
        'unresolved_tenant' | 'organization_inactive'
      >;
    };

export function createBillingService({
  billing,
  organizations,
}: BillingServiceOptions): BillingService {
  // Stored records are checked, not trusted: a mismatch is refused, never repaired.
  async function read(organizationId: OrganizationId): Promise<Read> {
    const account = await billing.findAccount(organizationId);
    if (account?.organizationId !== organizationId) return { reason: 'billing_missing' };
    const subscription = await billing.findSubscription(account.subscriptionId);
    if (subscription === undefined) return { reason: 'subscription_missing' };
    if (
      subscription.id !== account.subscriptionId ||
      subscription.organizationId !== organizationId ||
      !isSubscriptionStatus(subscription.status) ||
      !isPlanRef(subscription.plan)
    ) {
      return { reason: 'subscription_invalid' };
    }
    return { subscription };
  }

  return {
    async billingOf(tenant) {
      if (!isResolvedTenant(tenant)) return { status: 'unavailable', reason: 'unresolved_tenant' };
      const organization = await organizations.findOrganization(tenant.organizationId);
      if (organization?.id !== tenant.organizationId || organization.status !== 'active') {
        return { status: 'unavailable', reason: 'organization_inactive' };
      }
      const result = await read(organization.id);
      if ('reason' in result) return { status: 'unavailable', reason: result.reason };
      return Object.freeze({
        status: 'present',
        organizationId: organization.id,
        subscription: result.subscription,
        planInForce: isPlanInForce(result.subscription.status),
      });
    },

    async currentPlan(organizationId) {
      const result = await read(organizationId);
      if ('reason' in result || !isPlanInForce(result.subscription.status)) return undefined;
      const { plan } = result.subscription;
      return Object.freeze({ id: plan.id, version: plan.version });
    },
  };
}
