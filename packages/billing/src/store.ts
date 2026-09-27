import type {
  BillingAccount,
  InitialBilling,
  OrganizationId,
  Subscription,
  SubscriptionId,
} from '@melonoffice/domain';

/**
 * Where billing accounts and subscriptions are read: Firestore in the API (ADR-0022), memory in
 * tests. There is no write here: accounts and first subscriptions are created with their
 * organization by the tenancy store, and nothing else changes them yet.
 */
export interface BillingStore {
  findAccount(organizationId: OrganizationId): Promise<BillingAccount | undefined>;
  findSubscription(id: SubscriptionId): Promise<Subscription | undefined>;
}

/** For tests and local runs only. */
export class InMemoryBillingStore implements BillingStore {
  readonly #accounts = new Map<string, BillingAccount>();
  readonly #subscriptions = new Map<string, Subscription>();

  /** Called by the memory tenancy store when it creates an organization. */
  openNow({ account, subscription }: InitialBilling): void {
    if (this.#accounts.has(account.organizationId) || this.#subscriptions.has(subscription.id)) {
      throw new Error('billing already exists');
    }
    this.#accounts.set(account.organizationId, account);
    this.#subscriptions.set(subscription.id, subscription);
  }

  async findAccount(organizationId: OrganizationId): Promise<BillingAccount | undefined> {
    return this.#accounts.get(organizationId);
  }

  async findSubscription(id: SubscriptionId): Promise<Subscription | undefined> {
    return this.#subscriptions.get(id);
  }

  /** Test hook: stores a record as given, the way a provider sync or an operator change would. */
  put(record: BillingAccount | Subscription): void {
    if ('status' in record) this.#subscriptions.set(record.id, Object.freeze({ ...record }));
    else this.#accounts.set(record.organizationId, Object.freeze({ ...record }));
  }

  /** Test hook: removes an organization's account, as for an organization created before billing. */
  removeAccount(organizationId: OrganizationId): void {
    this.#accounts.delete(organizationId);
  }
}
