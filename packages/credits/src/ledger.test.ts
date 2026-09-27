import type {
  CreditLedgerEntry,
  CreditWallet,
  CreditWalletId,
  IsoTimestamp,
  OrganizationId,
} from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { CreditsError } from './errors.js';
import {
  applyOperation,
  entryIdOf,
  isCreditAmount,
  MAX_CREDIT_AMOUNT,
  MAX_CREDIT_BALANCE,
  openWallet,
  verifyLedger,
  type CreditOperation,
  type LedgerState,
} from './ledger.js';

/** The value, or a failed test when it is missing. */
function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing value');
  return value;
}

const ORG = '11111111-1111-4111-8111-111111111111' as OrganizationId;
const OTHER = '22222222-2222-4222-8222-222222222222' as OrganizationId;
const AT = '2026-09-27T12:00:00.000Z' as IsoTimestamp;
const wallet = (balance: number, organizationId = ORG): CreditWallet => ({
  id: `wallet-${organizationId}` as CreditWalletId,
  organizationId,
  balance,
  createdAt: AT,
  updatedAt: AT,
});

function codeOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    if (error instanceof CreditsError) return error.code;
    throw error;
  }
  return 'accepted';
}

const fresh = (w: CreditWallet | undefined): LedgerState => ({ wallet: w, existing: undefined });

describe('amounts', () => {
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['decimal', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
    ['a numeric string', '10'],
    ['over the maximum', MAX_CREDIT_AMOUNT + 1],
    ['an unsafe integer', 2 ** 53],
    ['null', null],
    ['an object', { valueOf: (): number => 10 }],
  ])('refuses %s', (_, amount) => {
    expect(isCreditAmount(amount)).toBe(false);
    const operation = { type: 'grant', amount, referenceId: 'r1', reason: 'test' } as never;
    expect(codeOf(() => applyOperation(ORG, operation, fresh(wallet(0)), AT))).toBe(
      'invalid_amount',
    );
  });

  it('accepts whole credits from 1 to the maximum', () => {
    expect(isCreditAmount(1)).toBe(true);
    expect(isCreditAmount(MAX_CREDIT_AMOUNT)).toBe(true);
  });

  it('refuses an adjustment of 0 or out of range, in either direction', () => {
    for (const amount of [0, -0, 0.5, -MAX_CREDIT_AMOUNT - 1, Number.NaN]) {
      const operation: CreditOperation = {
        type: 'adjustment',
        amount,
        referenceId: 'adj',
        reason: 'correction',
      };
      expect(codeOf(() => applyOperation(ORG, operation, fresh(wallet(10)), AT))).toBe(
        'invalid_amount',
      );
    }
  });
});

describe('references and reasons', () => {
  it.each(['', ' ', 'a b', 'x'.repeat(129), 'ñ', 'a/b', '../x'])(
    'refuses the reference %j',
    (referenceId) => {
      const operation: CreditOperation = { type: 'grant', amount: 1, referenceId, reason: 'test' };
      expect(codeOf(() => applyOperation(ORG, operation, fresh(wallet(0)), AT))).toBe(
        'invalid_reference',
      );
    },
  );

  it.each(['', 'Test', 'with space', 'task-run', '1abc', 'x'.repeat(65)])(
    'refuses the reason %j',
    (reason) => {
      const operation: CreditOperation = { type: 'grant', amount: 1, referenceId: 'r', reason };
      expect(codeOf(() => applyOperation(ORG, operation, fresh(wallet(0)), AT))).toBe(
        'invalid_reason',
      );
    },
  );

  it('gives the same reference the same entry id within an organization, never across', () => {
    expect(entryIdOf(ORG, 'r1')).toBe(entryIdOf(ORG, 'r1'));
    expect(entryIdOf(ORG, 'r1')).not.toBe(entryIdOf(ORG, 'r2'));
    expect(entryIdOf(ORG, 'r1')).not.toBe(entryIdOf(OTHER, 'r1'));
    expect(entryIdOf(ORG, 'r1')).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('applyOperation', () => {
  it('opens every wallet empty', () => {
    const opened = openWallet({
      id: ORG,
      name: 'A',
      status: 'active',
      createdBy: 'u' as never,
      createdAt: AT,
      updatedAt: AT,
    });
    expect(opened).toMatchObject({ organizationId: ORG, balance: 0, createdAt: AT });
    expect(Object.isFrozen(opened)).toBe(true);
  });

  it('signs amounts by type and changes nothing it was given', () => {
    const before = wallet(50);
    const grant = applyOperation(
      ORG,
      { type: 'grant', amount: 10, referenceId: 'g', reason: 'test' },
      fresh(before),
      AT,
    );
    const consume = applyOperation(
      ORG,
      { type: 'consume', amount: 10, referenceId: 'c', reason: 'test' },
      fresh(before),
      AT,
    );
    expect(grant).toMatchObject({ kind: 'posted', entry: { amount: 10, balanceAfter: 60 } });
    expect(consume).toMatchObject({ kind: 'posted', entry: { amount: -10, balanceAfter: 40 } });
    expect(before.balance).toBe(50);
    if (grant.kind === 'posted') {
      expect(Object.isFrozen(grant.entry)).toBe(true);
      expect(Object.isFrozen(grant.wallet)).toBe(true);
      expect(grant.wallet).toEqual({ ...before, balance: 60, updatedAt: AT });
    }
  });

  it('refuses to go below 0 or above the maximum balance', () => {
    expect(
      codeOf(() =>
        applyOperation(
          ORG,
          { type: 'consume', amount: 1, referenceId: 'c', reason: 'test' },
          fresh(wallet(0)),
          AT,
        ),
      ),
    ).toBe('credits_insufficient');
    expect(
      codeOf(() =>
        applyOperation(
          ORG,
          { type: 'grant', amount: 1, referenceId: 'g', reason: 'test' },
          fresh(wallet(MAX_CREDIT_BALANCE)),
          AT,
        ),
      ),
    ).toBe('credits_balance_limit');
    expect(
      codeOf(() =>
        applyOperation(
          ORG,
          { type: 'adjustment', amount: -11, referenceId: 'a', reason: 'correction' },
          fresh(wallet(10)),
          AT,
        ),
      ),
    ).toBe('credits_insufficient');
  });

  it("refuses a missing wallet or another organization's wallet", () => {
    const operation: CreditOperation = { type: 'grant', amount: 1, referenceId: 'g', reason: 'x' };
    expect(codeOf(() => applyOperation(ORG, operation, fresh(undefined), AT))).toBe(
      'credits_wallet_missing',
    );
    expect(codeOf(() => applyOperation(ORG, operation, fresh(wallet(0, OTHER)), AT))).toBe(
      'credits_wallet_missing',
    );
  });

  it('replays an identical operation and refuses a different one with the same reference', () => {
    const operation: CreditOperation = {
      type: 'grant',
      amount: 10,
      referenceId: 'g',
      reason: 'test',
    };
    const first = applyOperation(ORG, operation, fresh(wallet(0)), AT);
    if (first.kind !== 'posted') throw new Error('expected a posting');
    const state = { wallet: first.wallet, existing: first.entry };
    expect(applyOperation(ORG, operation, state, AT)).toEqual({
      kind: 'replayed',
      entry: first.entry,
    });
    for (const changed of [
      { ...operation, amount: 11 },
      { ...operation, reason: 'other' },
      { ...operation, type: 'consume' as const },
    ]) {
      expect(codeOf(() => applyOperation(ORG, changed, state, AT))).toBe(
        'credits_reference_conflict',
      );
    }
  });

  it('refunds only an earlier consume of the same wallet, and never more than it spent', () => {
    const consume = applyOperation(
      ORG,
      { type: 'consume', amount: 30, referenceId: 'c', reason: 'test' },
      fresh(wallet(100)),
      AT,
    );
    if (consume.kind !== 'posted') throw new Error('expected a posting');
    const refund = (amount: number, state: Partial<LedgerState>, refundOf = 'c') =>
      codeOf(() =>
        applyOperation(
          ORG,
          { type: 'refund', amount, referenceId: `r-${amount}`, reason: 'test', refundOf },
          { wallet: consume.wallet, existing: undefined, ...state },
          AT,
        ),
      );
    expect(refund(30, { original: consume.entry })).toBe('accepted');
    expect(refund(31, { original: consume.entry })).toBe('credits_refund_invalid');
    expect(refund(11, { original: consume.entry, alreadyRefunded: 20 })).toBe(
      'credits_refund_invalid',
    );
    expect(refund(10, { original: consume.entry, alreadyRefunded: 20 })).toBe('accepted');
    expect(refund(1, { original: undefined })).toBe('credits_refund_invalid');
    expect(refund(1, { original: consume.entry }, 'other')).toBe('credits_refund_invalid');
    expect(refund(1, { original: { ...consume.entry, type: 'grant', amount: 30 } })).toBe(
      'credits_refund_invalid',
    );
    expect(refund(1, { original: { ...consume.entry, walletId: 'w2' as CreditWalletId } })).toBe(
      'credits_refund_invalid',
    );
    expect(refund(1, { original: consume.entry }, '')).toBe('credits_refund_invalid');
  });

  it('prepares signed adjustments in the domain only', () => {
    const up = applyOperation(
      ORG,
      { type: 'adjustment', amount: 5, referenceId: 'a1', reason: 'correction' },
      fresh(wallet(10)),
      AT,
    );
    const down = applyOperation(
      ORG,
      { type: 'adjustment', amount: -5, referenceId: 'a2', reason: 'correction' },
      fresh(wallet(10)),
      AT,
    );
    expect(up).toMatchObject({ entry: { type: 'adjustment', amount: 5, balanceAfter: 15 } });
    expect(down).toMatchObject({ entry: { type: 'adjustment', amount: -5, balanceAfter: 5 } });
  });
});

describe('verifyLedger', () => {
  function run(operations: CreditOperation[]) {
    let w = wallet(0);
    const entries: CreditLedgerEntry[] = [];
    for (const operation of operations) {
      const original =
        operation.type === 'refund'
          ? entries.find((e) => e.id === entryIdOf(ORG, operation.refundOf))
          : undefined;
      const posting = applyOperation(
        ORG,
        operation,
        { wallet: w, existing: undefined, original },
        AT,
      );
      if (posting.kind !== 'posted') throw new Error('expected a posting');
      w = posting.wallet;
      entries.push(posting.entry);
    }
    return { wallet: w, entries };
  }

  it('finds nothing wrong in a consistent ledger', () => {
    const { wallet: w, entries } = run([
      { type: 'grant', amount: 100, referenceId: 'g', reason: 'test' },
      { type: 'consume', amount: 30, referenceId: 'c', reason: 'test' },
      { type: 'refund', amount: 30, referenceId: 'r', reason: 'test', refundOf: 'c' },
    ]);
    expect(verifyLedger(w, entries)).toEqual([]);
    expect(entries.reduce((sum, e) => sum + e.amount, 0)).toBe(w.balance);
  });

  it('reports a balance that does not match, foreign entries, and over-refunds', () => {
    const { wallet: w, entries } = run([
      { type: 'grant', amount: 100, referenceId: 'g', reason: 'test' },
      { type: 'consume', amount: 30, referenceId: 'c', reason: 'test' },
    ]);
    expect(verifyLedger({ ...w, balance: 71 }, entries)).toEqual(['balance_mismatch']);
    expect(verifyLedger(w, [...entries, { ...must(entries[0]), organizationId: OTHER }])).toEqual(
      expect.arrayContaining(['foreign_entry']),
    );
    expect(verifyLedger(w, [{ ...must(entries[0]), balanceAfter: 99 }, must(entries[1])])).toEqual(
      expect.arrayContaining(['running_balance_mismatch']),
    );
    const overRefund: CreditLedgerEntry = {
      ...must(entries[0]),
      id: entryIdOf(ORG, 'r'),
      type: 'refund',
      amount: 31,
      balanceAfter: 101,
      refundOf: must(entries[1]).id,
    };
    expect(verifyLedger({ ...w, balance: 101 }, [...entries, overRefund])).toEqual([
      'refund_exceeds_consume',
    ]);
    expect(
      verifyLedger({ ...w, balance: -1 }, [{ ...must(entries[1]), amount: -1, balanceAfter: -1 }]),
    ).toEqual(['negative_balance']);
  });
});
