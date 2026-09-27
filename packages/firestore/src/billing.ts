import type { Firestore, Timestamp as FirestoreTimestamp } from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import { isPlanRef, isSubscriptionStatus, type BillingStore } from '@melonoffice/billing';
import type {
  BillingAccount,
  IsoTimestamp,
  OrganizationId,
  PlanRef,
  Subscription,
  SubscriptionId,
  SubscriptionStatus,
} from '@melonoffice/domain';
import { isOrganizationId } from '@melonoffice/tenancy';

/**
 * Collections (ADR-0022). Read and written only by the API, never by clients. They hold no card,
 * bank or payment token data: that belongs to the payment provider.
 */
export const BILLING_ACCOUNTS = 'billingAccounts';
export const SUBSCRIPTIONS = 'subscriptions';

/** `billingAccounts/{organizationId}`: the id makes one account per organization. */
interface AccountDocument {
  readonly subscriptionId: string;
  readonly createdAt: FirestoreTimestamp;
  readonly updatedAt: FirestoreTimestamp;
}

/** `subscriptions/{subscriptionId}`: its own collection, so past subscriptions keep their history. */
interface SubscriptionDocument {
  readonly organizationId: string;
  readonly plan: PlanRef;
  readonly status: SubscriptionStatus;
  readonly createdAt: FirestoreTimestamp;
  readonly updatedAt: FirestoreTimestamp;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const at = (value: IsoTimestamp): FirestoreTimestamp => Timestamp.fromDate(new Date(value));
const iso = (timestamp: FirestoreTimestamp): IsoTimestamp =>
  timestamp.toDate().toISOString() as IsoTimestamp;

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

// Stored values are checked, not trusted: an unknown status or a malformed plan is an error,
// never a plan in force.
function toSubscription(id: string, data: SubscriptionDocument): Subscription {
  if (!isSubscriptionStatus(data.status) || !isPlanRef(data.plan)) {
    throw new Error('invalid subscription record');
  }
  return Object.freeze({
    id: id as SubscriptionId,
    organizationId: data.organizationId as OrganizationId,
    plan: Object.freeze({ id: data.plan.id, version: data.plan.version }),
    status: data.status,
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
  });
}

/** Billing accounts and subscriptions in Firestore, read only. They are created with the organization. */
export class FirestoreBillingStore implements BillingStore {
  constructor(private readonly db: Firestore) {}

  async findAccount(organizationId: OrganizationId): Promise<BillingAccount | undefined> {
    if (!isOrganizationId(organizationId)) return undefined;
    const snapshot = await this.db.collection(BILLING_ACCOUNTS).doc(organizationId).get();
    if (!snapshot.exists) return undefined;
    const data = snapshot.data() as AccountDocument;
    return Object.freeze({
      organizationId,
      subscriptionId: data.subscriptionId as SubscriptionId,
      createdAt: iso(data.createdAt),
      updatedAt: iso(data.updatedAt),
    });
  }

  async findSubscription(id: SubscriptionId): Promise<Subscription | undefined> {
    if (typeof id !== 'string' || !UUID.test(id)) return undefined;
    const snapshot = await this.db.collection(SUBSCRIPTIONS).doc(id).get();
    return snapshot.exists
      ? toSubscription(snapshot.id, snapshot.data() as SubscriptionDocument)
      : undefined;
  }
}
