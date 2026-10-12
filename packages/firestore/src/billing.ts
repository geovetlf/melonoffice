import type { Timestamp as FirestoreTimestamp } from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import type {
  BillingAccount,
  IsoTimestamp,
  PlanRef,
  Subscription,
  SubscriptionStatus,
} from '@melonoffice/domain';

/**
 * Collections (ADR-0022). Read and written only by the API, never by clients. They hold no card,
 * bank or payment token data: that belongs to the payment provider. This file holds only their
 * shape, which an organization's creation writes; the store that reads them, and with it the
 * billing package, is `@melonoffice/firestore/billing`, so the worker never loads billing.
 */
export const BILLING_ACCOUNTS = 'billingAccounts';
export const SUBSCRIPTIONS = 'subscriptions';

/** `billingAccounts/{organizationId}`: the id makes one account per organization. */
export interface AccountDocument {
  readonly subscriptionId: string;
  readonly createdAt: FirestoreTimestamp;
  readonly updatedAt: FirestoreTimestamp;
}

/** `subscriptions/{subscriptionId}`: its own collection, so past subscriptions keep their history. */
export interface SubscriptionDocument {
  readonly organizationId: string;
  readonly plan: PlanRef;
  readonly status: SubscriptionStatus;
  readonly createdAt: FirestoreTimestamp;
  readonly updatedAt: FirestoreTimestamp;
}

const at = (value: IsoTimestamp): FirestoreTimestamp => Timestamp.fromDate(new Date(value));

export const toAccountDocument = (account: BillingAccount): AccountDocument => ({
  subscriptionId: account.subscriptionId,
  createdAt: at(account.createdAt),
  updatedAt: at(account.updatedAt),
});

export const toSubscriptionDocument = (subscription: Subscription): SubscriptionDocument => ({
  organizationId: subscription.organizationId,
  plan: { id: subscription.plan.id, version: subscription.plan.version },
  status: subscription.status,
  createdAt: at(subscription.createdAt),
  updatedAt: at(subscription.updatedAt),
});
