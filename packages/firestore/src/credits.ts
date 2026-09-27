import type {
  Firestore,
  Timestamp as FirestoreTimestamp,
  Transaction,
} from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import type { AuditEvent } from '@melonoffice/audit';
import type { CreditStore, CreditTransaction } from '@melonoffice/credits';
import type {
  CreditEntryId,
  CreditEntryType,
  CreditLedgerEntry,
  CreditWallet,
  CreditWalletId,
  IsoTimestamp,
  OrganizationId,
} from '@melonoffice/domain';
import { isOrganizationId } from '@melonoffice/tenancy';
import { AUDIT_LOGS, toAuditDocument } from './audit.js';

/**
 * Collections (ADR-0023). Read and written only by the API, never by clients.
 *
 * - `creditWallets/{organizationId}`: the id makes one wallet per organization.
 * - `creditLedger/{entryId}`: top level, with the entry id derived from the organization and the
 *   operation's reference, so a repeated operation finds its entry by id inside the transaction.
 */
export const CREDIT_WALLETS = 'creditWallets';
export const CREDIT_LEDGER = 'creditLedger';

interface WalletDocument {
  readonly walletId: string;
  readonly balance: number;
  readonly createdAt: FirestoreTimestamp;
  readonly updatedAt: FirestoreTimestamp;
}

interface EntryDocument {
  readonly organizationId: string;
  readonly walletId: string;
  readonly type: CreditEntryType;
  readonly amount: number;
  readonly balanceAfter: number;
  readonly referenceId: string;
  readonly reason: string;
  readonly refundOf: string | null;
  readonly createdAt: FirestoreTimestamp;
}

const TYPES: readonly string[] = ['grant', 'consume', 'refund', 'adjustment'];
const at = (value: IsoTimestamp): FirestoreTimestamp => Timestamp.fromDate(new Date(value));
const iso = (timestamp: FirestoreTimestamp): IsoTimestamp =>
  timestamp.toDate().toISOString() as IsoTimestamp;
const whole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);

export const toWalletDocument = (wallet: CreditWallet): WalletDocument => ({
  walletId: wallet.id,
  balance: wallet.balance,
  createdAt: at(wallet.createdAt),
  updatedAt: at(wallet.updatedAt),
});

const toEntryDocument = (entry: CreditLedgerEntry): EntryDocument => ({
  organizationId: entry.organizationId,
  walletId: entry.walletId,
  type: entry.type,
  amount: entry.amount,
  balanceAfter: entry.balanceAfter,
  referenceId: entry.referenceId,
  reason: entry.reason,
  refundOf: entry.refundOf ?? null,
  createdAt: at(entry.createdAt),
});

// Stored values are checked, not trusted: a negative or fractional balance is an error.
function toWallet(organizationId: OrganizationId, data: WalletDocument): CreditWallet {
  if (!whole(data.balance) || data.balance < 0 || typeof data.walletId !== 'string') {
    throw new Error('invalid credit wallet record');
  }
  return Object.freeze({
    id: data.walletId as CreditWalletId,
    organizationId,
    balance: data.balance,
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
  });
}

function toEntry(id: string, data: EntryDocument): CreditLedgerEntry {
  if (!TYPES.includes(data.type) || !whole(data.amount) || !whole(data.balanceAfter)) {
    throw new Error('invalid credit ledger record');
  }
  return Object.freeze({
    id: id as CreditEntryId,
    organizationId: data.organizationId as OrganizationId,
    walletId: data.walletId as CreditWalletId,
    type: data.type,
    amount: data.amount,
    balanceAfter: data.balanceAfter,
    referenceId: data.referenceId,
    reason: data.reason,
    ...(data.refundOf === null ? {} : { refundOf: data.refundOf as CreditEntryId }),
    createdAt: iso(data.createdAt),
  });
}

/**
 * Wallets and the ledger in Firestore. Each operation is one transaction that reads the wallet
 * and writes it back, so operations on one wallet are serialized by Firestore: two consumes can
 * never both spend the same balance. The entry is written with `create`, never updated.
 */
export class FirestoreCreditStore implements CreditStore {
  constructor(private readonly db: Firestore) {}

  async findWallet(organizationId: OrganizationId): Promise<CreditWallet | undefined> {
    if (!isOrganizationId(organizationId)) return undefined;
    const snapshot = await this.db.collection(CREDIT_WALLETS).doc(organizationId).get();
    return snapshot.exists
      ? toWallet(organizationId, snapshot.data() as WalletDocument)
      : undefined;
  }

  // Equality only, then sorted here, so no composite index is needed.
  async ledger(organizationId: OrganizationId): Promise<readonly CreditLedgerEntry[]> {
    const snapshot = await this.db
      .collection(CREDIT_LEDGER)
      .where('organizationId', '==', organizationId)
      .get();
    return snapshot.docs
      .map((doc) => toEntry(doc.id, doc.data() as EntryDocument))
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  async transact<T>(
    organizationId: OrganizationId,
    work: (tx: CreditTransaction) => Promise<T>,
  ): Promise<T> {
    if (!isOrganizationId(organizationId)) throw new Error('invalid organization id');
    const walletRef = this.db.collection(CREDIT_WALLETS).doc(organizationId);
    const ledger = this.db.collection(CREDIT_LEDGER);
    return this.db.runTransaction(async (t: Transaction) => {
      let committed = false;
      const tx: CreditTransaction = {
        wallet: async () => {
          const snapshot = await t.get(walletRef);
          return snapshot.exists
            ? toWallet(organizationId, snapshot.data() as WalletDocument)
            : undefined;
        },
        entry: async (id) => {
          const snapshot = await t.get(ledger.doc(id));
          return snapshot.exists
            ? toEntry(snapshot.id, snapshot.data() as EntryDocument)
            : undefined;
        },
        refundedFor: async (consume) => {
          const snapshot = await t.get(ledger.where('refundOf', '==', consume));
          return snapshot.docs
            .map((doc) => toEntry(doc.id, doc.data() as EntryDocument))
            .filter((e) => e.type === 'refund' && e.organizationId === organizationId)
            .reduce((sum, e) => sum + e.amount, 0);
        },
        commit: (wallet: CreditWallet, entry: CreditLedgerEntry, events: readonly AuditEvent[]) => {
          if (committed) throw new Error('one commit per transaction');
          committed = true;
          t.update(walletRef, {
            balance: wallet.balance,
            updatedAt: at(wallet.updatedAt),
          });
          t.create(ledger.doc(entry.id), toEntryDocument(entry));
          for (const event of events) {
            t.create(this.db.collection(AUDIT_LOGS).doc(event.id), toAuditDocument(event));
          }
        },
      };
      return work(tx);
    });
  }
}
