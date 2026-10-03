import type {
  CreditBucket,
  CreditBuckets,
  CreditEntryId,
  CreditHold,
  CreditLedgerEntry,
  CreditPeriod,
  CreditRenewal,
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
      readonly type: 'grant';
      readonly amount: number;
      readonly referenceId: string;
      readonly reason: string;
      /** Where the credits go (ADR-0123). Absent: `purchased`, which never expires. */
      readonly bucket?: CreditBucket;
    }
  | {
      readonly type: 'consume';
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
    }
  | {
      /** Sets credits aside for an operation that is about to run (ADR-0123). */
      readonly type: 'hold';
      readonly amount: number;
      readonly referenceId: string;
      readonly reason: string;
      /** When the hold stops holding anything, if never settled or released. */
      readonly expiresAt: IsoTimestamp;
    }
  | {
      /**
       * Closes a hold: spends `amount` (0 releases it all). Its reference is fixed by the hold's
       * (`closingReferenceOf`), so a hold is closed once, however often this is asked.
       */
      readonly type: 'settle';
      readonly amount: number;
      readonly reason: string;
      /** The `referenceId` of the hold. */
      readonly holdOf: string;
    }
  | {
      /**
       * Opens a new plan period (ADR-0127): grants the period's included credits and removes the
       * last period's included credits that do not carry over. Its reference is fixed by the
       * period (`renewalReferenceOf`), so a period is renewed once, however often this is asked.
       */
      readonly type: 'renew';
      readonly referenceId: string;
      readonly reason: string;
      readonly period: { readonly startsAt: IsoTimestamp; readonly endsAt: IsoTimestamp };
      /** Included credits the plan gives for the period. 0 or more. */
      readonly included: number;
      /** How many of the last period's included credits may stay: a number, or `'all'`. */
      readonly carryMax: number | 'all';
    };

/** The reference of a period's renewal: a period is renewed once. */
export const renewalReferenceOf = (periodStartsAt: IsoTimestamp): string =>
  `renewal:${periodStartsAt}`;

/** The reference of the one entry that may close a hold: a settle or a release. */
export const closingReferenceOf = (holdReference: string): string => `${holdReference}:close`;

/** The most holds one wallet keeps open at once (one per running operation). */
export const MAX_OPEN_HOLDS = 200;

/** A wallet's buckets. One written before D-12 has none: all of its balance is `purchased`. */
export const bucketsOf = (wallet: Pick<CreditWallet, 'balance' | 'buckets'>): CreditBuckets =>
  wallet.buckets ?? { included: 0, purchased: wallet.balance };

/** The holds still holding at `at`. */
export const liveHolds = (wallet: Pick<CreditWallet, 'holds'>, at: IsoTimestamp): CreditHold[] =>
  (wallet.holds ?? []).filter((h) => h.expiresAt > at);

/** What can be spent or held now: the balance less every live hold. */
export const availableOf = (
  wallet: Pick<CreditWallet, 'balance' | 'holds'>,
  at: IsoTimestamp,
): number => wallet.balance - liveHolds(wallet, at).reduce((sum, h) => sum + h.amount, 0);

/**
 * The order credits are spent in by default (ADR-0123, confirmed by the owner for now on
 * 2026-10-03): what the plan included first, then what was bought, so bought credits last
 * longest. It is configuration (`LedgerOptions.consumptionOrder`), not a rule of the ledger.
 */
export const DEFAULT_CONSUMPTION_ORDER: readonly CreditBucket[] = Object.freeze([
  'included',
  'purchased',
]);
/** @deprecated The default order; use `DEFAULT_CONSUMPTION_ORDER`. */
export const CONSUMPTION_ORDER = DEFAULT_CONSUMPTION_ORDER;

/** Whether an order names every bucket exactly once. */
export const isConsumptionOrder = (value: unknown): value is readonly CreditBucket[] =>
  Array.isArray(value) &&
  value.length === 2 &&
  value.includes('included') &&
  value.includes('purchased');

/** How the ledger applies its configurable policies (ADR-0127). */
export interface LedgerOptions {
  /** The order credits are spent in. Default: `DEFAULT_CONSUMPTION_ORDER`. */
  readonly consumptionOrder?: readonly CreditBucket[];
}

/** How `amount` is taken from the buckets, in `order`. */
function take(
  buckets: CreditBuckets,
  amount: number,
  order: readonly CreditBucket[],
): CreditBuckets {
  let left = amount;
  const split = { included: 0, purchased: 0 };
  for (const bucket of order) {
    const part = Math.min(buckets[bucket], left);
    split[bucket] = part;
    left -= part;
  }
  if (left > 0) throw new CreditsError('credits_insufficient');
  return split;
}

const minus = (a: CreditBuckets, b: CreditBuckets): CreditBuckets => ({
  included: a.included - b.included,
  purchased: a.purchased - b.purchased,
});
const plus = (a: CreditBuckets, b: CreditBuckets): CreditBuckets => ({
  included: a.included + b.included,
  purchased: a.purchased + b.purchased,
});

/** What the ledger already holds that an operation depends on, read in the same transaction. */
export interface LedgerState {
  readonly wallet: CreditWallet | undefined;
  /** The entry already stored under this operation's id, if the operation was seen before. */
  readonly existing: CreditLedgerEntry | undefined;
  /** For a refund: the `consume` entry it refunds, and how much was already refunded for it. */
  readonly original?: CreditLedgerEntry | undefined;
  readonly alreadyRefunded?: number;
  /** For a settle: the `hold` entry it closes. */
  readonly hold?: CreditLedgerEntry | undefined;
}

export type Posting =
  | { readonly kind: 'posted'; readonly wallet: CreditWallet; readonly entry: CreditLedgerEntry }
  | { readonly kind: 'replayed'; readonly entry: CreditLedgerEntry };

const SIGN: Record<'grant' | 'refund' | 'consume', 1 | -1> = {
  grant: 1,
  refund: 1,
  consume: -1,
};

/** Checks the operation's shape and returns its signed ledger amount. */
function signedAmount(operation: CreditOperation): number {
  const reference = operation.type === 'settle' ? operation.holdOf : operation.referenceId;
  if (!isReferenceId(reference)) throw new CreditsError('invalid_reference');
  // A hold's closing reference must be valid too, so every hold can be closed.
  if (
    (operation.type === 'hold' || operation.type === 'settle') &&
    !isReferenceId(closingReferenceOf(reference))
  ) {
    throw new CreditsError('invalid_reference');
  }
  if (!isReasonCode(operation.reason)) throw new CreditsError('invalid_reason');
  if (operation.type === 'renew') {
    const { period, included, carryMax } = operation;
    const starts = Date.parse(String(period?.startsAt));
    const ends = Date.parse(String(period?.endsAt));
    if (Number.isNaN(starts) || Number.isNaN(ends) || ends <= starts) {
      throw new CreditsError('invalid_period');
    }
    if (included !== 0 && !isCreditAmount(included)) throw new CreditsError('invalid_amount');
    if (carryMax !== 'all' && carryMax !== 0 && !isCreditAmount(carryMax)) {
      throw new CreditsError('invalid_amount');
    }
    // The amount depends on the wallet; it is decided in `applyOperation`.
    return 0;
  }
  if (operation.type === 'adjustment') {
    const { amount } = operation;
    if (typeof amount !== 'number' || !isCreditAmount(Math.abs(amount))) {
      throw new CreditsError('invalid_amount');
    }
    return amount;
  }
  if (operation.type === 'settle') {
    // Settling for nothing releases the hold.
    if (operation.amount !== 0 && !isCreditAmount(operation.amount)) {
      throw new CreditsError('invalid_amount');
    }
    return operation.amount === 0 ? 0 : -operation.amount;
  }
  if (!isCreditAmount(operation.amount)) throw new CreditsError('invalid_amount');
  if (operation.type === 'hold') {
    if (typeof operation.expiresAt !== 'string' || Number.isNaN(Date.parse(operation.expiresAt))) {
      throw new CreditsError('invalid_hold_expiry');
    }
    return 0;
  }
  if (operation.type === 'grant' && operation.bucket !== undefined) {
    if (operation.bucket !== 'included' && operation.bucket !== 'purchased') {
      throw new CreditsError('invalid_bucket');
    }
  }
  if (!Object.hasOwn(SIGN, operation.type)) throw new Error('unknown credit operation');
  return SIGN[operation.type as keyof typeof SIGN] * operation.amount;
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
  options: LedgerOptions = {},
): Posting {
  const order = options.consumptionOrder ?? DEFAULT_CONSUMPTION_ORDER;
  if (!isConsumptionOrder(order)) throw new Error('invalid consumption order');
  let amount = signedAmount(operation);
  const referenceId =
    operation.type === 'settle' ? closingReferenceOf(operation.holdOf) : operation.referenceId;
  const id = entryIdOf(organizationId, referenceId);
  const refundOf =
    operation.type === 'refund' ? entryIdOf(organizationId, operation.refundOf) : undefined;
  if (operation.type === 'refund' && !isReferenceId(operation.refundOf)) {
    throw new CreditsError('credits_refund_invalid');
  }
  const holdOf =
    operation.type === 'settle' ? entryIdOf(organizationId, operation.holdOf) : undefined;
  // A settle for nothing is recorded as a release.
  const type =
    operation.type === 'settle'
      ? amount === 0
        ? 'release'
        : 'consume'
      : operation.type === 'renew'
        ? 'renewal'
        : operation.type;
  const bucket = operation.type === 'grant' ? (operation.bucket ?? 'purchased') : undefined;

  const { existing, wallet } = state;
  // A period is renewed once: asking again, even with other plan values, replays the first.
  if (existing !== undefined && operation.type === 'renew') {
    if (
      existing.id !== id ||
      existing.organizationId !== organizationId ||
      existing.type !== 'renewal' ||
      existing.renewal?.periodStartsAt !== operation.period.startsAt
    ) {
      throw new CreditsError('credits_reference_conflict');
    }
    return { kind: 'replayed', entry: existing };
  }
  if (existing !== undefined) {
    // A hold is closed once: a different close of the same hold is refused, never applied.
    if (holdOf !== undefined && existing.holdOf === holdOf && existing.type !== type) {
      throw new CreditsError('credits_hold_closed');
    }
    const same =
      existing.id === id &&
      existing.organizationId === organizationId &&
      existing.type === type &&
      existing.amount === amount &&
      existing.reason === operation.reason &&
      existing.refundOf === refundOf &&
      existing.holdOf === holdOf &&
      (bucket === undefined || (existing.bucket ?? 'purchased') === bucket) &&
      (operation.type !== 'hold' || existing.held === operation.amount);
    if (!same) {
      throw new CreditsError(
        holdOf !== undefined ? 'credits_hold_closed' : 'credits_reference_conflict',
      );
    }
    return { kind: 'replayed', entry: existing };
  }

  if (wallet?.organizationId !== organizationId) throw new CreditsError('credits_wallet_missing');

  // Expired holds are dropped on every write: they hold nothing any more.
  const open = liveHolds(wallet, at);
  const buckets = bucketsOf(wallet);
  let nextBuckets = buckets;
  let nextHolds = open;
  let split: CreditBuckets | undefined;
  let held: number | undefined;
  let expiresAt: IsoTimestamp | undefined;
  let renewal: CreditRenewal | undefined;
  let period: CreditPeriod | undefined = wallet.period;
  const available = availableOf(wallet, at);
  const reserved = wallet.balance - available;

  switch (operation.type) {
    case 'grant': {
      nextBuckets = plus(buckets, {
        included: bucket === 'included' ? amount : 0,
        purchased: bucket === 'purchased' ? amount : 0,
      });
      break;
    }
    case 'consume': {
      if (-amount > available) throw new CreditsError('credits_insufficient');
      split = take(buckets, -amount, order);
      nextBuckets = minus(buckets, split);
      break;
    }
    case 'refund': {
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
      const already = state.alreadyRefunded ?? 0;
      const refundable = -original.amount - already;
      if (amount > refundable) throw new CreditsError('credits_refund_invalid');
      // Back where it came from, bought credits first (refunds always go in this order, so what
      // was already refunded is known from its total).
      const from = original.split ?? { included: 0, purchased: -original.amount };
      const purchased = Math.min(amount, Math.max(0, from.purchased - already));
      split = { included: amount - purchased, purchased };
      nextBuckets = plus(buckets, split);
      break;
    }
    case 'adjustment': {
      // An adjustment moves bought credits only: it has no plan period to belong to.
      if (buckets.purchased + amount < 0) throw new CreditsError('credits_insufficient');
      nextBuckets = { ...buckets, purchased: buckets.purchased + amount };
      break;
    }
    case 'hold': {
      if (open.length >= MAX_OPEN_HOLDS) throw new CreditsError('credits_holds_limit');
      if (operation.expiresAt <= at) throw new CreditsError('invalid_hold_expiry');
      if (operation.amount > available) throw new CreditsError('credits_insufficient');
      held = operation.amount;
      expiresAt = operation.expiresAt;
      nextHolds = [...open, { entryId: id, amount: operation.amount, expiresAt }];
      break;
    }
    case 'settle': {
      const { hold } = state;
      if (
        hold === undefined ||
        hold.id !== holdOf ||
        hold.organizationId !== organizationId ||
        hold.walletId !== wallet.id ||
        hold.type !== 'hold'
      ) {
        throw new CreditsError('credits_hold_invalid');
      }
      // A live hold frees its credits for its own settlement; an expired one held nothing.
      const mine = open.find((h) => h.entryId === holdOf);
      held = mine?.amount ?? 0;
      nextHolds = open.filter((h) => h.entryId !== holdOf);
      if (-amount > available + held) throw new CreditsError('credits_insufficient');
      if (amount !== 0) {
        split = take(buckets, -amount, order);
        nextBuckets = minus(buckets, split);
      }
      break;
    }
    case 'renew': {
      const { startsAt, endsAt } = operation.period;
      // Periods only move forward: an older period is never renewed over a newer one.
      if (wallet.period !== undefined && startsAt <= wallet.period.startsAt) {
        throw new CreditsError('credits_renewal_out_of_order');
      }
      // A period is renewed once it has started, never ahead of time.
      if (startsAt > at) throw new CreditsError('invalid_period');
      const last = buckets.included;
      // Only a period's own included credits can end with it: a wallet's first renewal keeps
      // whatever it already had, since no plan period gave it.
      const wanted =
        wallet.period === undefined || operation.carryMax === 'all'
          ? last
          : Math.min(last, operation.carryMax);
      // Credits held by running operations are never taken away: they are spent first (included
      // first by default), so what is reserved stays until those operations close.
      const expired = Math.min(last - wanted, Math.max(0, last - reserved));
      const carried = last - expired;
      amount = operation.included - expired;
      nextBuckets = { ...buckets, included: carried + operation.included };
      renewal = {
        periodStartsAt: startsAt,
        periodEndsAt: endsAt,
        granted: operation.included,
        carried,
        expired,
      };
      period = { startsAt, endsAt, included: carried + operation.included, consumed: 0 };
      break;
    }
  }

  // What the period spent: consumes add, refunds give back (never below 0).
  if (period !== undefined && operation.type !== 'renew') {
    if (type === 'consume') period = { ...period, consumed: period.consumed - amount };
    if (type === 'refund') period = { ...period, consumed: Math.max(0, period.consumed - amount) };
  }

  const balance = wallet.balance + amount;
  if (balance < 0) throw new CreditsError('credits_insufficient');
  if (balance > MAX_CREDIT_BALANCE) throw new CreditsError('credits_balance_limit');

  const entry: CreditLedgerEntry = Object.freeze({
    id,
    organizationId,
    walletId: wallet.id,
    type,
    amount,
    balanceAfter: balance,
    referenceId,
    reason: operation.reason,
    ...(refundOf === undefined ? {} : { refundOf }),
    ...(bucket === undefined ? {} : { bucket }),
    ...(split === undefined ? {} : { split: Object.freeze(split) }),
    ...(held === undefined ? {} : { held }),
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(holdOf === undefined ? {} : { holdOf }),
    ...(renewal === undefined ? {} : { renewal: Object.freeze(renewal) }),
    createdAt: at,
  });
  return {
    kind: 'posted',
    wallet: Object.freeze({
      ...wallet,
      balance,
      buckets: Object.freeze(nextBuckets),
      holds: Object.freeze(nextHolds),
      ...(period === undefined ? {} : { period: Object.freeze(period) }),
      updatedAt: at,
    }),
    entry,
  };
}

export type LedgerProblem =
  | 'balance_mismatch'
  | 'negative_balance'
  | 'foreign_entry'
  | 'running_balance_mismatch'
  | 'refund_exceeds_consume'
  | 'buckets_mismatch';

/**
 * Checks a wallet against its whole ledger, oldest entry first: the entries belong to it, the
 * running balance matches every `balanceAfter`, never dips below 0, adds up to the balance, no
 * consume is refunded beyond what it spent, and the buckets add up entry by entry (ADR-0123). Returns the problems found, none when consistent.
 */
export function verifyLedger(
  wallet: CreditWallet,
  entries: readonly CreditLedgerEntry[],
): readonly LedgerProblem[] {
  const problems = new Set<LedgerProblem>();
  const refunded = new Map<string, number>();
  const consumed = new Map<string, number>();
  let running = 0;
  // Entries written before D-12 carry no bucket or split: they moved bought credits.
  let buckets: CreditBuckets = { included: 0, purchased: 0 };
  for (const entry of entries) {
    if (entry.type === 'grant') {
      buckets = plus(buckets, {
        included: entry.bucket === 'included' ? entry.amount : 0,
        purchased: entry.bucket === 'included' ? 0 : entry.amount,
      });
    } else if (entry.type === 'consume') {
      buckets = minus(buckets, entry.split ?? { included: 0, purchased: -entry.amount });
    } else if (entry.type === 'refund') {
      buckets = plus(buckets, entry.split ?? { included: 0, purchased: entry.amount });
    } else if (entry.type === 'adjustment') {
      buckets = { ...buckets, purchased: buckets.purchased + entry.amount };
    } else if (entry.type === 'renewal') {
      const r = entry.renewal;
      if (r === undefined || r.granted - r.expired !== entry.amount) {
        problems.add('buckets_mismatch');
      }
      buckets = { ...buckets, included: buckets.included + entry.amount };
    }
    if (buckets.included < 0 || buckets.purchased < 0) problems.add('negative_balance');
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
  const stored = bucketsOf(wallet);
  if (stored.included < 0 || stored.purchased < 0) problems.add('negative_balance');
  if (
    stored.included + stored.purchased !== wallet.balance ||
    stored.included !== buckets.included ||
    stored.purchased !== buckets.purchased
  ) {
    problems.add('buckets_mismatch');
  }
  if (wallet.balance < 0) problems.add('negative_balance');
  return [...problems];
}
