import type { AuditService } from '@melonoffice/audit';
import { actorOf } from '@melonoffice/audit';
import type { IsoTimestamp, OrganizationId, UserId } from '@melonoffice/domain';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { createHash } from 'node:crypto';
import { isCreditAmount, isReferenceId } from './ledger.js';
import type { CreditService } from './service.js';

/**
 * Buying credits (D-12, ADR-0126). A purchase adds credits to the same wallet and ledger
 * (`purchased` bucket), never to a second system, and never changes the plan. The credits arrive
 * only after the payment provider confirms the payment, once per purchase, whatever retries.
 *
 * Nothing here sets a price: the pack catalogue is configuration, empty until the owner decides
 * packs and prices, and no payment provider is connected yet. Until both exist, `start` refuses.
 */

/** An amount of money in its currency's minor unit (cents), never a float. */
export interface Money {
  /** ISO 4217, upper case. */
  readonly currency: string;
  readonly amountMinor: number;
}

/** A pack of credits that can be bought. Versioned: a purchase keeps the version it was sold at. */
export interface CreditPack {
  readonly id: string;
  readonly version: number;
  readonly credits: number;
  readonly price: Money;
}

/**
 * The packs on sale. Empty: pack sizes and prices are a pending product decision (D-12), and
 * nothing may be sold until they are set.
 */
export const CREDIT_PACKS: readonly CreditPack[] = [];

/**
 * One payment provider behind the Payment Router: a card processor, a local method or dLocal
 * later. It opens a checkout; the provider's signed notification later becomes a
 * `VerifiedPayment` in its own adapter, never here.
 */
export interface PaymentProvider {
  readonly id: string;
  /** The currencies it can charge. */
  readonly currencies: readonly string[];
  createCheckout(input: {
    readonly purchaseId: string;
    readonly organizationId: OrganizationId;
    readonly amount: Money;
    readonly description: string;
  }): Promise<{ readonly checkoutRef: string; readonly url?: string }>;
}

/** Chooses the provider that will charge a purchase. Undefined: none can. */
export interface PaymentRouter {
  route(input: {
    readonly organizationId: OrganizationId;
    readonly amount: Money;
  }): PaymentProvider | undefined;
}

/** The first provider that charges the currency. With no providers, nothing is routed. */
export const createPaymentRouter = (providers: readonly PaymentProvider[]): PaymentRouter => ({
  route: ({ amount }) => providers.find((p) => p.currencies.includes(amount.currency)),
});

export type CreditPurchaseStatus = 'awaiting_payment' | 'fulfilled' | 'failed';

export interface CreditPurchase {
  readonly id: string;
  readonly organizationId: OrganizationId;
  readonly pack: { readonly id: string; readonly version: number };
  readonly credits: number;
  readonly price: Money;
  readonly status: CreditPurchaseStatus;
  readonly provider: string;
  readonly checkoutRef: string;
  readonly buyer: UserId;
  /** The provider's id of the payment that settled it. */
  readonly paymentRef?: string;
  readonly failure?: string;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/** A payment the provider's adapter verified (its signature, its origin) before handing it on. */
export interface VerifiedPayment {
  readonly providerId: string;
  /** The provider's unique id for this payment. */
  readonly paymentRef: string;
  readonly purchaseId: string;
  readonly amount: Money;
  readonly status: 'succeeded' | 'failed';
}

export interface CreditPurchaseStore {
  find(id: string): Promise<CreditPurchase | undefined>;
  /** Creates it, or returns false when a purchase with that id exists. */
  create(purchase: CreditPurchase): Promise<boolean>;
  /** Replaces it only while its status is still `from`; false otherwise. */
  update(purchase: CreditPurchase, from: CreditPurchaseStatus): Promise<boolean>;
}

export type PurchaseErrorCode =
  | 'unresolved_tenant'
  | 'organization_inactive'
  | 'invalid_request'
  | 'pack_unavailable'
  | 'payments_unavailable'
  | 'purchase_conflict'
  | 'purchase_not_found'
  | 'payment_mismatch';

export class PurchaseError extends Error {
  override readonly name = 'PurchaseError';
  constructor(readonly code: PurchaseErrorCode) {
    super(code);
  }
}

export type PaymentOutcome =
  | { readonly status: 'fulfilled'; readonly purchase: CreditPurchase; readonly replayed: boolean }
  | { readonly status: 'failed'; readonly purchase: CreditPurchase; readonly replayed: boolean };

export interface CreditPurchaseService {
  /** The packs on sale, with the wallet's balance, so a person sees both before confirming. */
  catalogue(): readonly CreditPack[];
  /**
   * Starts buying a pack: one purchase per `requestKey`, so a double click or a retry opens one
   * checkout. Nothing is credited here.
   */
  start(
    tenant: TenantContext,
    request: { readonly packId: string; readonly requestKey: string },
  ): Promise<{
    readonly purchase: CreditPurchase;
    readonly url?: string;
    readonly replayed: boolean;
  }>;
  /**
   * Applies a verified payment: on success the pack's credits are added once; a repeated
   * notification replays; a declined attempt leaves the purchase open; a payment that does not
   * match the purchase credits nothing and closes it as failed, for a person to review.
   */
  confirm(payment: VerifiedPayment): Promise<PaymentOutcome>;
}

export interface CreditPurchaseServiceOptions {
  readonly store: CreditPurchaseStore;
  readonly credits: Pick<CreditService, 'grantPurchase'>;
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly router: PaymentRouter;
  readonly audit: AuditService;
  readonly packs?: readonly CreditPack[];
  readonly now?: () => Date;
}

/** A purchase's id: from the organization and the caller's key, so a retry finds the same one. */
export const purchaseIdOf = (organizationId: OrganizationId, requestKey: string): string =>
  createHash('sha256')
    .update(`purchase\n${organizationId}\n${requestKey}`)
    .digest('hex')
    .slice(0, 40);

const isMoney = (m: Money): boolean =>
  /^[A-Z]{3}$/.test(m.currency) && Number.isSafeInteger(m.amountMinor) && m.amountMinor > 0;

export function createCreditPurchaseService({
  store,
  credits,
  organizations,
  router,
  audit,
  packs = CREDIT_PACKS,
  now = () => new Date(),
}: CreditPurchaseServiceOptions): CreditPurchaseService {
  const onSale = packs.filter((p) => isCreditAmount(p.credits) && isMoney(p.price));
  const iso = () => now().toISOString() as IsoTimestamp;

  async function fulfil(purchase: CreditPurchase, paymentRef: string): Promise<PaymentOutcome> {
    // The ledger credits a purchase once (`purchase:<id>`), so a crash between this grant and
    // the status below is repaired by the next notification, never credited twice.
    await credits.grantPurchase({
      organizationId: purchase.organizationId,
      purchaseId: purchase.id,
      credits: purchase.credits,
      buyer: purchase.buyer,
    });
    const done: CreditPurchase = Object.freeze({
      ...purchase,
      status: 'fulfilled',
      paymentRef,
      updatedAt: iso(),
    });
    if (!(await store.update(done, 'awaiting_payment'))) {
      const current = await store.find(purchase.id);
      if (current === undefined) throw new PurchaseError('purchase_not_found');
      return {
        status: current.status === 'failed' ? 'failed' : 'fulfilled',
        purchase: current,
        replayed: true,
      };
    }
    return { status: 'fulfilled', purchase: done, replayed: false };
  }

  return {
    catalogue: () => onSale,

    async start(tenant, { packId, requestKey }) {
      if (!isResolvedTenant(tenant)) throw new PurchaseError('unresolved_tenant');
      if (!isReferenceId(requestKey)) throw new PurchaseError('invalid_request');
      const organization = await organizations.findOrganization(tenant.organizationId);
      if (organization?.id !== tenant.organizationId || organization.status !== 'active') {
        throw new PurchaseError('organization_inactive');
      }
      const id = purchaseIdOf(organization.id, requestKey);
      const existing = await store.find(id);
      if (existing !== undefined) {
        if (existing.organizationId !== organization.id || existing.pack.id !== packId) {
          throw new PurchaseError('purchase_conflict');
        }
        return { purchase: existing, replayed: true };
      }
      const deny = async (code: PurchaseErrorCode) => {
        await audit.record({
          action: 'credits.purchase_started',
          result: 'denied',
          actor: actorOf(tenant),
          organizationId: organization.id,
          target: { type: 'credit_purchase', id },
          reason: code,
          source: 'api',
        });
        return new PurchaseError(code);
      };
      const pack = onSale.find((p) => p.id === packId);
      if (pack === undefined) throw await deny('pack_unavailable');
      const provider = router.route({ organizationId: organization.id, amount: pack.price });
      if (provider === undefined) throw await deny('payments_unavailable');
      const checkout = await provider.createCheckout({
        purchaseId: id,
        organizationId: organization.id,
        amount: pack.price,
        description: `${pack.credits} credits`,
      });
      const at = iso();
      const purchase: CreditPurchase = Object.freeze({
        id,
        organizationId: organization.id,
        pack: { id: pack.id, version: pack.version },
        credits: pack.credits,
        price: pack.price,
        status: 'awaiting_payment',
        provider: provider.id,
        checkoutRef: checkout.checkoutRef,
        buyer: tenant.userId,
        createdAt: at,
        updatedAt: at,
      });
      if (!(await store.create(purchase))) {
        const raced = await store.find(id);
        if (raced === undefined || raced.pack.id !== packId)
          throw new PurchaseError('purchase_conflict');
        return { purchase: raced, replayed: true };
      }
      await audit.record({
        action: 'credits.purchase_started',
        result: 'success',
        actor: actorOf(tenant),
        organizationId: organization.id,
        target: { type: 'credit_purchase', id },
        reason: 'pack',
        reference: pack.id,
        source: 'api',
      });
      return {
        purchase,
        ...(checkout.url === undefined ? {} : { url: checkout.url }),
        replayed: false,
      };
    },

    async confirm(payment) {
      const purchase = await store.find(payment.purchaseId);
      if (purchase === undefined) throw new PurchaseError('purchase_not_found');
      if (purchase.status === 'fulfilled') {
        // A repeated notification, or another payment for a purchase already paid: never twice.
        return { status: 'fulfilled', purchase, replayed: true };
      }
      if (purchase.status === 'failed') return { status: 'failed', purchase, replayed: true };
      const fail = async (code: string): Promise<PaymentOutcome> => {
        const failed: CreditPurchase = Object.freeze({
          ...purchase,
          status: 'failed',
          paymentRef: payment.paymentRef,
          failure: code,
          updatedAt: iso(),
        });
        if (!(await store.update(failed, 'awaiting_payment'))) {
          const current = (await store.find(purchase.id)) ?? purchase;
          return {
            status: current.status === 'fulfilled' ? 'fulfilled' : 'failed',
            purchase: current,
            replayed: true,
          };
        }
        await audit.record({
          action: 'credits.purchase_failed',
          result: 'failure',
          actor: { type: 'system', id: 'runtime', initiatedBy: purchase.buyer, via: 'runtime' },
          organizationId: purchase.organizationId,
          target: { type: 'credit_purchase', id: purchase.id },
          reason: code,
          source: 'api',
        });
        return { status: 'failed', purchase: failed, replayed: false };
      };
      const matches =
        payment.providerId === purchase.provider &&
        payment.amount.currency === purchase.price.currency &&
        payment.amount.amountMinor === purchase.price.amountMinor;
      // Money was taken that does not match what was sold: nothing is credited, and the purchase
      // is closed for a person to review.
      if (!matches) return fail('payment_mismatch');
      if (payment.status !== 'succeeded') {
        // A declined attempt does not end the purchase: the buyer may pay again on the same
        // checkout, and that payment must still be credited.
        await audit.record({
          action: 'credits.purchase_failed',
          result: 'failure',
          actor: { type: 'system', id: 'runtime', initiatedBy: purchase.buyer, via: 'runtime' },
          organizationId: purchase.organizationId,
          target: { type: 'credit_purchase', id: purchase.id },
          reason: 'payment_failed',
          source: 'api',
        });
        return { status: 'failed', purchase, replayed: false };
      }
      return fulfil(purchase, payment.paymentRef);
    },
  };
}

/** For tests and local runs only. */
export class InMemoryCreditPurchaseStore implements CreditPurchaseStore {
  readonly #items = new Map<string, CreditPurchase>();

  async find(id: string): Promise<CreditPurchase | undefined> {
    return this.#items.get(id);
  }

  async create(purchase: CreditPurchase): Promise<boolean> {
    if (this.#items.has(purchase.id)) return false;
    this.#items.set(purchase.id, purchase);
    return true;
  }

  async update(purchase: CreditPurchase, from: CreditPurchaseStatus): Promise<boolean> {
    if (this.#items.get(purchase.id)?.status !== from) return false;
    this.#items.set(purchase.id, purchase);
    return true;
  }
}
