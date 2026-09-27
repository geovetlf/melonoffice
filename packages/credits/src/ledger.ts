import type {
  CreditEntryId,
  CreditEntryType,
  CreditLedgerEntry,
  CreditWallet,
  CreditWalletId,
  IsoTimestamp,
  Organization,
  OrganizationId,
} from '@melonoffice/domain';
import { createHash, randomUUID } from 'node:crypto';
import { CreditsError } from './errors.js';

/**
 * The largest amount one operation may move, and the largest balance a wallet may hold. Whole
 * credits only, far below 2^53 so every sum stays exact.
 */
export const MAX_CREDIT_AMOUNT = 1_000_000_000_000;
export const MAX_CREDIT_BALANCE = 1_000_000_000_000_000;

const REFERENCE = /^[A-Za-z0-9._:-]{1,128}$/;
// Same shape as an audit reason code, so every reason can be recorded.
const REASON = /^[a-z][a-z_]{0,63}$/;

/** A positive whole number of credits within range. Anything else, strings included, is refused. */
export const isCreditAmount = (value: unknown): value is number =>
  typeof value === 'number' &&
  Number.isSafeInteger(value) &&
  value >= 1 &&
  value <= MAX_CREDIT_AMOUNT;

export const isReferenceId = (value: unknown): value is string =>
  typeof value === 'string' && REFERENCE.test(value);

export const isReasonCode = (value: unknown): value is string =>
  typeof value === 'string' && REASON.test(value);

/**
 * The ledger entry id of an operation: a hash of the organization and the caller's reference, so
 * the same operation always lands on the same entry, and two organizations never share one.
 */
export function entryIdOf(organizationId: OrganizationId, referenceId: string): CreditEntryId {
  return createHash('sha256')
    .update(`${organizationId}\n${referenceId}`)
    .digest('hex') as CreditEntryId;
}

/** The empty wallet a new organization gets (ADR-0023). No plan comes with credits (D-12). */
export function openWallet(organization: Organization): CreditWallet {
  return Object.freeze({
    id: randomUUID() as CreditWalletId,
    organizationId: organization.id,
    balance: 0,
    createdAt: organization.createdAt,
    updatedAt: organization.createdAt,
  });
}

/**
 * One accounting operation, as a caller asks for it. Amounts are given as positive numbers; the
 * ledger's sign comes from the type (grant and refund add, consume subtracts). An adjustment
 * carries its own sign.
 */
export type CreditOperation =
  | {
      readonly type: 'grant' | 'consume';
      readonly amount: number;
      readonly referenceId: string;
      readonly reason: string;
    }
  | {
      readonly type: 'refund';
      readonly amount: number;
      readonly referenceId: string;
      readonly reason: string;
      /** The `referenceId` of the `consume` being refunded. */
      readonly refundOf: string;
    }
  | {
      readonly type: 'adjustment';
      /** Signed: positive adds, negative subtracts. Never 0. */
      readonly amount: number;
      readonly referenceId: string;
      readonly reason: string;
    };

/** What the ledger already holds that an operation depends on, read in the same transaction. */
export interface LedgerState {
  readonly wallet: CreditWallet | undefined;
  /** The entry already stored under this operation's id, if the operation was seen before. */
  readonly existing: CreditLedgerEntry | undefined;
  /** For a refund: the `consume` entry it refunds, and how much was already refunded for it. */
  readonly original?: CreditLedgerEntry | undefined;
  readonly alreadyRefunded?: number;
}

export type Posting =
  | { readonly kind: 'posted'; readonly wallet: CreditWallet; readonly entry: CreditLedgerEntry }
  | { readonly kind: 'replayed'; readonly entry: CreditLedgerEntry };

const SIGN: Record<Exclude<CreditEntryType, 'adjustment'>, 1 | -1> = {
  grant: 1,
  refund: 1,
  consume: -1,
};

/** Checks the operation's shape and returns its signed ledger amount. */
function signedAmount(operation: CreditOperation): number {
  if (!isReferenceId(operation.referenceId)) throw new CreditsError('invalid_reference');
  if (!isReasonCode(operation.reason)) throw new CreditsError('invalid_reason');
  if (operation.type === 'adjustment') {
    const { amount } = operation;
    if (typeof amount !== 'number' || !isCreditAmount(Math.abs(amount))) {
      throw new CreditsError('invalid_amount');
    }
    return amount;
  }
  if (!isCreditAmount(operation.amount)) throw new CreditsError('invalid_amount');
  if (!Object.hasOwn(SIGN, operation.type)) throw new Error('unknown credit operation');
  return SIGN[operation.type] * operation.amount;
}

/**
 * Decides one operation against the current ledger state. Pure and deterministic: it changes
 * nothing, and the caller writes the new wallet and entry together, or neither.
 *
 * - The same `referenceId` with the same parameters replays the stored entry: nothing moves twice.
 * - The same `referenceId` with different parameters is `credits_reference_conflict`.
 * - The balance never goes below 0 (`credits_insufficient`) or above the maximum.
 * - A refund needs an earlier `consume` in the same wallet and never returns more than it spent.
 */
export function applyOperation(
  organizationId: OrganizationId,
  operation: CreditOperation,
  state: LedgerState,
  at: IsoTimestamp,
): Posting {
  const amount = signedAmount(operation);
  const id = entryIdOf(organizationId, operation.referenceId);
  const refundOf =
    operation.type === 'refund' ? entryIdOf(organizationId, operation.refundOf) : undefined;
  if (operation.type === 'refund' && !isReferenceId(operation.refundOf)) {
    throw new CreditsError('credits_refund_invalid');
  }

  const { existing, wallet } = state;
  if (existing !== undefined) {
    const same =
      existing.id === id &&
      existing.organizationId === organizationId &&
      existing.type === operation.type &&
      existing.amount === amount &&
      existing.reason === operation.reason &&
      existing.refundOf === refundOf;
    if (!same) throw new CreditsError('credits_reference_conflict');
    return { kind: 'replayed', entry: existing };
  }

  if (wallet?.organizationId !== organizationId) throw new CreditsError('credits_wallet_missing');

  if (operation.type === 'refund') {
    const { original } = state;
    if (
      original === undefined ||
      original.id !== refundOf ||
      original.organizationId !== organizationId ||
      original.walletId !== wallet.id ||
      original.type !== 'consume'
    ) {
      throw new CreditsError('credits_refund_invalid');
    }
    const refundable = -original.amount - (state.alreadyRefunded ?? 0);
    if (amount > refundable) throw new CreditsError('credits_refund_invalid');
  }

  const balance = wallet.balance + amount;
  if (balance < 0) throw new CreditsError('credits_insufficient');
  if (balance > MAX_CREDIT_BALANCE) throw new CreditsError('credits_balance_limit');

  const entry: CreditLedgerEntry = Object.freeze({
    id,
    organizationId,
    walletId: wallet.id,
    type: operation.type,
    amount,
    balanceAfter: balance,
    referenceId: operation.referenceId,
    reason: operation.reason,
    ...(refundOf === undefined ? {} : { refundOf }),
    createdAt: at,
  });
  return {
    kind: 'posted',
    wallet: Object.freeze({ ...wallet, balance, updatedAt: at }),
    entry,
  };
}

export type LedgerProblem =
  | 'balance_mismatch'
  | 'negative_balance'
  | 'foreign_entry'
  | 'running_balance_mismatch'
  | 'refund_exceeds_consume';

/**
 * Checks a wallet against its whole ledger, oldest entry first: the entries belong to it, the
 * running balance matches every `balanceAfter`, never dips below 0, adds up to the balance, and no
 * consume is refunded beyond what it spent. Returns the problems found, none when consistent.
 */
export function verifyLedger(
  wallet: CreditWallet,
  entries: readonly CreditLedgerEntry[],
): readonly LedgerProblem[] {
  const problems = new Set<LedgerProblem>();
  const refunded = new Map<string, number>();
  const consumed = new Map<string, number>();
  let running = 0;
  for (const entry of entries) {
    if (entry.organizationId !== wallet.organizationId || entry.walletId !== wallet.id) {
      problems.add('foreign_entry');
    }
    running += entry.amount;
    if (running !== entry.balanceAfter) problems.add('running_balance_mismatch');
    if (running < 0) problems.add('negative_balance');
    if (entry.type === 'consume') consumed.set(entry.id, -entry.amount);
    if (entry.type === 'refund' && entry.refundOf !== undefined) {
      refunded.set(entry.refundOf, (refunded.get(entry.refundOf) ?? 0) + entry.amount);
    }
  }
  for (const [consume, amount] of refunded) {
    if (amount > (consumed.get(consume) ?? 0)) problems.add('refund_exceeds_consume');
  }
  if (running !== wallet.balance) problems.add('balance_mismatch');
  if (wallet.balance < 0) problems.add('negative_balance');
  return [...problems];
}
