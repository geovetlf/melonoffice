import type { IsoTimestamp, OrganizationId } from './ids.js';

export type CreditWalletId = string & { readonly __brand: 'CreditWalletId' };
export type CreditEntryId = string & { readonly __brand: 'CreditEntryId' };

/**
 * An organization's credits (ADR-0023). One per organization; the organization owns the balance,
 * never a user. A credit is an internal accounting unit: an integer with no currency, so what a
 * credit is worth commercially can change without touching the ledger.
 */
export interface CreditWallet {
  readonly id: CreditWalletId;
  readonly organizationId: OrganizationId;
  /** Whole credits, never negative. Always equal to the sum of the wallet's ledger entries. */
  readonly balance: number;
  /**
   * Where the balance came from (D-12, ADR-0123): `included` with the plan, `purchased` on top.
   * Always adds up to `balance`. A wallet written before D-12 has none, and all its balance reads
   * as `purchased`, which nothing ever takes away.
   */
  readonly buckets?: CreditBuckets;
  /** Credits held for operations still running (ADR-0123). An expired hold holds nothing. */
  readonly holds?: readonly CreditHold[];
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/**
 * Where credits come from (D-12, ADR-0123):
 * - `included`: credits the plan gives each period;
 * - `purchased`: credits bought on top, or granted by hand. They never expire.
 */
export type CreditBucket = 'included' | 'purchased';

/** Whole credits per bucket. Never negative. */
export interface CreditBuckets {
  readonly included: number;
  readonly purchased: number;
}

/** Credits set aside for one running operation until it settles, is released or expires. */
export interface CreditHold {
  /** The `hold` ledger entry. */
  readonly entryId: CreditEntryId;
  readonly amount: number;
  readonly expiresAt: IsoTimestamp;
}

/**
 * - `grant`: credits added (positive amount).
 * - `consume`: credits spent (negative amount).
 * - `refund`: credits given back for an earlier `consume` (positive, at most what it spent).
 * - `adjustment`: an internal correction (positive or negative). No code can post one yet.
 * - `hold`: credits set aside for a running operation (amount 0: the balance does not move).
 * - `release`: a hold given back without spending anything (amount 0).
 *
 * A `consume` that settles a hold names it in `holdOf`.
 */
export type CreditEntryType = 'grant' | 'consume' | 'refund' | 'adjustment' | 'hold' | 'release';

/** One movement in the append-only ledger. Never updated or deleted. */
export interface CreditLedgerEntry {
  /** Derived from the organization and `referenceId`, so the same operation is one entry. */
  readonly id: CreditEntryId;
  readonly organizationId: OrganizationId;
  readonly walletId: CreditWalletId;
  readonly type: CreditEntryType;
  /** Signed whole credits: positive adds, negative subtracts. 0 only for `hold` and `release`. */
  readonly amount: number;
  readonly balanceAfter: number;
  /** The caller's idempotency key for this operation. */
  readonly referenceId: string;
  /** A stable code saying why, never free text. */
  readonly reason: string;
  /** For a `refund`: the `consume` entry it gives credits back for. */
  readonly refundOf?: CreditEntryId;
  /** For a `grant`: the bucket it added to. */
  readonly bucket?: CreditBucket;
  /** For a `consume` or `refund`: how much it took from, or gave back to, each bucket. */
  readonly split?: CreditBuckets;
  /** For a `hold`: how much it set aside. For a `release` or a settling `consume`: how much it freed. */
  readonly held?: number;
  /** For a `hold`: when it stops holding anything. */
  readonly expiresAt?: IsoTimestamp;
  /** For a `release` or a settling `consume`: the `hold` entry it closes. */
  readonly holdOf?: CreditEntryId;
  readonly createdAt: IsoTimestamp;
}
