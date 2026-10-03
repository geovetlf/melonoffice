import type { Firestore, Timestamp as FirestoreTimestamp } from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import type {
  CreditPurchase,
  CreditPurchaseStatus,
  CreditPurchaseStore,
} from '@melonoffice/credits';
import type { IsoTimestamp, OrganizationId, UserId } from '@melonoffice/domain';

/**
 * `creditPurchases/{purchaseId}` (ADR-0126): one document per purchase of a credit pack. Read and
 * written only by the server, never by clients. Found by id only, so no index is needed.
 */
export const CREDIT_PURCHASES = 'creditPurchases';

const STATUSES: readonly string[] = ['awaiting_payment', 'fulfilled', 'failed'];

interface PurchaseDocument {
  readonly organizationId: string;
  readonly pack: { readonly id: string; readonly version: number };
  readonly credits: number;
  readonly price: { readonly currency: string; readonly amountMinor: number };
  readonly status: CreditPurchaseStatus;
  readonly provider: string;
  readonly checkoutRef: string;
  readonly buyer: string;
  readonly paymentRef: string | null;
  readonly failure: string | null;
  readonly createdAt: FirestoreTimestamp;
  readonly updatedAt: FirestoreTimestamp;
}

const at = (value: IsoTimestamp): FirestoreTimestamp => Timestamp.fromDate(new Date(value));
const iso = (value: FirestoreTimestamp): IsoTimestamp =>
  value.toDate().toISOString() as IsoTimestamp;
const whole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

const toDocument = (p: CreditPurchase): PurchaseDocument => ({
  organizationId: p.organizationId,
  pack: { id: p.pack.id, version: p.pack.version },
  credits: p.credits,
  price: { currency: p.price.currency, amountMinor: p.price.amountMinor },
  status: p.status,
  provider: p.provider,
  checkoutRef: p.checkoutRef,
  buyer: p.buyer,
  paymentRef: p.paymentRef ?? null,
  failure: p.failure ?? null,
  createdAt: at(p.createdAt),
  updatedAt: at(p.updatedAt),
});

// Stored values are checked, not trusted.
function toPurchase(id: string, d: PurchaseDocument): CreditPurchase {
  if (
    !STATUSES.includes(d.status) ||
    !whole(d.credits) ||
    !whole(d.price?.amountMinor) ||
    typeof d.price.currency !== 'string'
  ) {
    throw new Error('invalid credit purchase record');
  }
  return Object.freeze({
    id,
    organizationId: d.organizationId as OrganizationId,
    pack: Object.freeze({ id: d.pack.id, version: d.pack.version }),
    credits: d.credits,
    price: Object.freeze({ currency: d.price.currency, amountMinor: d.price.amountMinor }),
    status: d.status,
    provider: d.provider,
    checkoutRef: d.checkoutRef,
    buyer: d.buyer as UserId,
    ...(d.paymentRef === null ? {} : { paymentRef: d.paymentRef }),
    ...(d.failure === null ? {} : { failure: d.failure }),
    createdAt: iso(d.createdAt),
    updatedAt: iso(d.updatedAt),
  });
}

export class FirestoreCreditPurchaseStore implements CreditPurchaseStore {
  constructor(private readonly db: Firestore) {}

  #doc(id: string) {
    return this.db.collection(CREDIT_PURCHASES).doc(id);
  }

  async find(id: string): Promise<CreditPurchase | undefined> {
    if (!/^[0-9a-f]{40}$/.test(id)) return undefined;
    const snapshot = await this.#doc(id).get();
    return snapshot.exists ? toPurchase(id, snapshot.data() as PurchaseDocument) : undefined;
  }

  async create(purchase: CreditPurchase): Promise<boolean> {
    try {
      await this.#doc(purchase.id).create(toDocument(purchase));
      return true;
    } catch (error) {
      // ALREADY_EXISTS: another request created it first.
      if ((error as { code?: unknown }).code === 6) return false;
      throw error;
    }
  }

  async update(purchase: CreditPurchase, from: CreditPurchaseStatus): Promise<boolean> {
    const doc = this.#doc(purchase.id);
    return this.db.runTransaction(async (t) => {
      const snapshot = await t.get(doc);
      if ((snapshot.data() as PurchaseDocument | undefined)?.status !== from) return false;
      t.set(doc, toDocument(purchase));
      return true;
    });
  }
}
