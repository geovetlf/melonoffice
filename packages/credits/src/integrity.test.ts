import type {
  CreditLedgerEntry,
  CreditWallet,
  CreditWalletId,
  IsoTimestamp,
  OrganizationId,
} from '@melonoffice/domain';
import { describe, expect, it } from 'vitest';
import { checkCreditLedger } from './integrity.js';
import { applyOperation, type CreditOperation, type LedgerState } from './ledger.js';
import type { CreditStore } from './store.js';

const ORG = '11111111-1111-4111-8111-111111111111' as OrganizationId;
const AT = '2026-09-27T12:00:00.000Z' as IsoTimestamp;

/** A consistent wallet and ledger, built by the same rules the service posts with. */
function ledgerOf(operations: CreditOperation[]): {
  wallet: CreditWallet;
  entries: CreditLedgerEntry[];
} {
  let state: LedgerState = {
    wallet: {
      id: `wallet-${ORG}` as CreditWalletId,
      organizationId: ORG,
      balance: 0,
      createdAt: AT,
      updatedAt: AT,
    },
    existing: undefined,
  };
  const entries: CreditLedgerEntry[] = [];
  for (const operation of operations) {
    const posting = applyOperation(ORG, operation, state, AT);
    if (posting.kind !== 'posted') throw new Error('expected a posting');
    state = { ...state, wallet: posting.wallet };
    entries.push(posting.entry);
  }
  if (state.wallet === undefined) throw new Error('missing wallet');
  return { wallet: state.wallet, entries };
}

/** A store that only reads: any write fails the test. */
function readOnlyStore(
  wallet: CreditWallet | undefined,
  entries: readonly CreditLedgerEntry[],
): CreditStore {
  return {
    findWallet: async () => wallet,
    ledger: async () => entries,
    transact: async () => {
      throw new Error('a read-only check must not write');
    },
  };
}

describe('checkCreditLedger', () => {
  it('finds nothing wrong in a consistent ledger', async () => {
    const { wallet, entries } = ledgerOf([
      { type: 'grant', amount: 100, referenceId: 'g', reason: 'test' },
      { type: 'consume', amount: 30, referenceId: 'c', reason: 'test' },
    ]);
    expect(await checkCreditLedger(readOnlyStore(wallet, entries), ORG)).toEqual({
      organizationId: ORG,
      walletFound: true,
      entries: 2,
      problems: [],
    });
  });

  it('reports what does not add up, and writes nothing', async () => {
    const { wallet, entries } = ledgerOf([
      { type: 'grant', amount: 100, referenceId: 'g', reason: 'test' },
      { type: 'consume', amount: 30, referenceId: 'c', reason: 'test' },
    ]);
    const first = entries[0];
    if (first === undefined) throw new Error('missing entry');
    // The first entry claims a balance it does not have. A write would fail the store above.
    const found = await checkCreditLedger(
      readOnlyStore(wallet, [{ ...first, balanceAfter: 99 }, ...entries.slice(1)]),
      ORG,
    );
    expect(found.problems).toEqual(['running_balance_mismatch']);
  });

  it('treats entries with no wallet as a problem, not as an empty account', async () => {
    const { entries } = ledgerOf([{ type: 'grant', amount: 10, referenceId: 'g', reason: 'test' }]);
    expect(await checkCreditLedger(readOnlyStore(undefined, entries), ORG)).toEqual({
      organizationId: ORG,
      walletFound: false,
      entries: 1,
      problems: ['foreign_entry'],
    });
  });

  it('finds nothing to check for an organization with no credits', async () => {
    expect(await checkCreditLedger(readOnlyStore(undefined, []), ORG)).toEqual({
      organizationId: ORG,
      walletFound: false,
      entries: 0,
      problems: [],
    });
  });
});
