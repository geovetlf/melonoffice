import type { AuditEvent } from '@melonoffice/audit';
import type { InMemoryAuditStore } from '@melonoffice/audit';
import type {
  CreditEntryId,
  CreditLedgerEntry,
  CreditWallet,
  OrganizationId,
} from '@melonoffice/domain';

/**
 * One transaction on one organization's credits. Every read happens before `commit`, and nothing
 * is written unless the transaction completes: the new wallet, its ledger entry and their audit
 * events are stored together, or not at all.
 */
export interface CreditTransaction {
  wallet(): Promise<CreditWallet | undefined>;
  entry(id: CreditEntryId): Promise<CreditLedgerEntry | undefined>;
  /** How many credits refunds already returned for this `consume` entry. */
  refundedFor(consume: CreditEntryId): Promise<number>;
  /** Stages the writes. The entry is created, never overwritten. */
  commit(wallet: CreditWallet, entry: CreditLedgerEntry, events: readonly AuditEvent[]): void;
}

/**
 * Where wallets and the ledger live: Firestore in the API (ADR-0023), memory in tests. There is
 * no update or delete of an entry, and no way to set a balance directly.
 */
export interface CreditStore {
  findWallet(organizationId: OrganizationId): Promise<CreditWallet | undefined>;
  /** Every entry of the organization, oldest first. For integrity checks, not for clients. */
  ledger(organizationId: OrganizationId): Promise<readonly CreditLedgerEntry[]>;
  /**
   * Runs `work` as one transaction on the organization's wallet. Transactions on the same wallet
   * never interleave, so two operations cannot both spend the same balance.
   */
  transact<T>(
    organizationId: OrganizationId,
    work: (tx: CreditTransaction) => Promise<T>,
  ): Promise<T>;
}

/** For tests and local runs only. */
export class InMemoryCreditStore implements CreditStore {
  readonly #wallets = new Map<string, CreditWallet>();
  readonly #entries = new Map<string, CreditLedgerEntry>();
  readonly #order: CreditEntryId[] = [];
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(private readonly audit?: InMemoryAuditStore) {}

  /** Called by the memory tenancy store when it creates an organization. */
  openWalletNow(wallet: CreditWallet): void {
    if (this.#wallets.has(wallet.organizationId)) throw new Error('wallet already exists');
    this.#wallets.set(wallet.organizationId, wallet);
  }

  async findWallet(organizationId: OrganizationId): Promise<CreditWallet | undefined> {
    return this.#wallets.get(organizationId);
  }

  async ledger(organizationId: OrganizationId): Promise<readonly CreditLedgerEntry[]> {
    return this.#order
      .map((id) => this.#entries.get(id))
      .filter((entry): entry is CreditLedgerEntry => entry?.organizationId === organizationId);
  }

  async transact<T>(
    organizationId: OrganizationId,
    work: (tx: CreditTransaction) => Promise<T>,
  ): Promise<T> {
    // One transaction at a time per wallet, like Firestore's lock on the wallet document.
    const previous = this.#locks.get(organizationId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.#run(organizationId, work));
    this.#locks.set(organizationId, run);
    return run;
  }

  async #run<T>(
    organizationId: OrganizationId,
    work: (tx: CreditTransaction) => Promise<T>,
  ): Promise<T> {
    let staged:
      { wallet: CreditWallet; entry: CreditLedgerEntry; events: readonly AuditEvent[] } | undefined;
    const tx: CreditTransaction = {
      wallet: async () => this.#wallets.get(organizationId),
      entry: async (id) => this.#entries.get(id),
      refundedFor: async (consume) =>
        [...this.#entries.values()]
          .filter((e) => e.type === 'refund' && e.refundOf === consume)
          .reduce((sum, e) => sum + e.amount, 0),
      commit: (wallet, entry, events) => {
        if (staged !== undefined) throw new Error('one commit per transaction');
        staged = { wallet, entry, events };
      },
    };
    const result = await work(tx);
    if (staged !== undefined) {
      const { wallet, entry, events } = staged;
      if (this.#entries.has(entry.id)) throw new Error('ledger entry already exists');
      if (events.length > 0) {
        if (this.audit === undefined) throw new Error('no audit store for credit events');
        this.audit.appendNow(events);
      }
      this.#entries.set(entry.id, entry);
      this.#order.push(entry.id);
      this.#wallets.set(organizationId, wallet);
    }
    return result;
  }

  /** Test hook: removes an organization's wallet, as for one created before credits existed. */
  removeWallet(organizationId: OrganizationId): void {
    this.#wallets.delete(organizationId);
  }
}
