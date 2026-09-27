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
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
}

/**
 * - `grant`: credits added (positive amount).
 * - `consume`: credits spent (negative amount).
 * - `refund`: credits given back for an earlier `consume` (positive, at most what it spent).
 * - `adjustment`: an internal correction (positive or negative). No code can post one yet.
 */
export type CreditEntryType = 'grant' | 'consume' | 'refund' | 'adjustment';

/** One movement in the append-only ledger. Never updated or deleted. */
export interface CreditLedgerEntry {
  /** Derived from the organization and `referenceId`, so the same operation is one entry. */
  readonly id: CreditEntryId;
  readonly organizationId: OrganizationId;
  readonly walletId: CreditWalletId;
  readonly type: CreditEntryType;
  /** Signed whole credits: positive adds, negative subtracts. Never 0. */
  readonly amount: number;
  readonly balanceAfter: number;
  /** The caller's idempotency key for this operation. */
  readonly referenceId: string;
  /** A stable code saying why, never free text. */
  readonly reason: string;
  /** For a `refund`: the `consume` entry it gives credits back for. */
  readonly refundOf?: CreditEntryId;
  readonly createdAt: IsoTimestamp;
}
