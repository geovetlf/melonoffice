import type { IsoTimestamp, OrganizationId } from './ids.js';

/**
 * A reference to one exact version of a plan in the entitlements catalogue (ADR-0013). Billing
 * decides which plan an organization is on (ADR-0022); what the plan grants lives in code and is
 * resolved by entitlements.
 */
export interface PlanRef {
  readonly id: string;
  readonly version: number;
}

export type SubscriptionId = string & { readonly __brand: 'SubscriptionId' };

/**
 * An organization's commercial account (ADR-0022). The organization is the commercial unit, so
 * there is one account per organization, keyed by its id, and never one per user. It points at
 * the subscription in force; earlier subscriptions stay as their own records.
 *
 * Card numbers, CVVs, bank details and payment tokens are never stored here or anywhere in
 * MelonOffice: they belong to the payment provider.
 */
export interface BillingAccount {
  readonly organizationId: OrganizationId;
  /** The organization's current subscription. There is at most one. */
  readonly subscriptionId: SubscriptionId;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/** The commercial relationship in force: which plan, in which state. */
export interface Subscription {
  readonly id: SubscriptionId;
  readonly organizationId: OrganizationId;
  readonly plan: PlanRef;
  readonly status: SubscriptionStatus;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/**
 * - `trialing`: in a trial. No trial is offered yet; the state exists for the lifecycle.
 * - `active`: in good standing.
 * - `past_due`: a payment failed and is being retried.
 * - `canceled`: ended. Final.
 */
export type SubscriptionStatus = 'trialing' | 'active' | 'past_due' | 'canceled';

/** What a new organization's billing starts as, written together with the organization. */
export interface InitialBilling {
  readonly account: BillingAccount;
  readonly subscription: Subscription;
}
