import type { OrganizationId } from '@melonoffice/domain';
import { verifyLedger, type LedgerProblem } from './ledger.js';
import type { CreditStore } from './store.js';

/** What a read-only check found in one organization's credits (ADR-0023, ADR-0123). */
export interface LedgerCheck {
  readonly organizationId: OrganizationId;
  readonly walletFound: boolean;
  readonly entries: number;
  readonly problems: readonly LedgerProblem[];
}

/**
 * Reads one organization's wallet and ledger and reports what does not add up. It writes nothing
 * and corrects nothing: what a problem means for the organization is a decision not taken yet.
 */
export async function checkCreditLedger(
  store: CreditStore,
  organizationId: OrganizationId,
): Promise<LedgerCheck> {
  const wallet = await store.findWallet(organizationId);
  const entries = await store.ledger(organizationId);
  if (wallet === undefined) {
    // Entries with no wallet belong to nothing: that is a problem, not an empty account.
    return {
      organizationId,
      walletFound: false,
      entries: entries.length,
      problems: entries.length === 0 ? [] : ['foreign_entry'],
    };
  }
  return {
    organizationId,
    walletFound: true,
    entries: entries.length,
    problems: verifyLedger(wallet, entries),
  };
}
