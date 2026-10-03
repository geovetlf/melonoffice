import type {
  Firestore,
  Timestamp as FirestoreTimestamp,
  Transaction,
} from '@google-cloud/firestore';
import { Timestamp } from '@google-cloud/firestore';
import type { AuditEvent } from '@melonoffice/audit';
import type { CreditStore, CreditTransaction } from '@melonoffice/credits';
import type {
  CreditBucket,
  CreditBuckets,
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

interface HoldDocument {
  readonly entryId: string;
  readonly amount: number;
  readonly expiresAt: FirestoreTimestamp;
}

interface WalletDocument {
  readonly walletId: string;
  readonly balance: number;
  /** Absent on wallets written before D-12 (ADR-0123): all of the balance is `purchased`. */
  readonly buckets?: CreditBuckets;
  readonly holds?: readonly HoldDocument[];
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
  // D-12 fields (ADR-0123), only on the entries that have them.
  readonly bucket?: CreditBucket;
  readonly split?: CreditBuckets;
  readonly held?: number;
  readonly expiresAt?: FirestoreTimestamp;
  readonly holdOf?: string;
  readonly createdAt: FirestoreTimestamp;
}

const TYPES: readonly string[] = ['grant', 'consume', 'refund', 'adjustment', 'hold', 'release'];
const BUCKETS: readonly string[] = ['included', 'purchased'];
const at = (value: IsoTimestamp): FirestoreTimestamp => Timestamp.fromDate(new Date(value));
const iso = (timestamp: FirestoreTimestamp): IsoTimestamp =>
  timestamp.toDate().toISOString() as IsoTimestamp;
const whole = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value);
const isBuckets = (value: unknown): value is CreditBuckets => {
  const b = value as CreditBuckets | null | undefined;
  return (
    typeof b === 'object' &&
    b !== null &&
    whole(b.included) &&
    whole(b.purchased) &&
    b.included >= 0 &&
    b.purchased >= 0
  );
};

const holdsOf = (wallet: CreditWallet): HoldDocument[] =>
  (wallet.holds ?? []).map((h) => ({
    entryId: h.entryId,
    amount: h.amount,
    expiresAt: at(h.expiresAt),
  }));

export const toWalletDocument = (wallet: CreditWallet): WalletDocument => ({
  walletId: wallet.id,
  balance: wallet.balance,
  ...(wallet.buckets === undefined ? {} : { buckets: { ...wallet.buckets } }),
  ...(wallet.holds === undefined ? {} : { holds: holdsOf(wallet) }),
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
  ...(entry.bucket === undefined ? {} : { bucket: entry.bucket }),
  ...(entry.split === undefined ? {} : { split: { ...entry.split } }),
  ...(entry.held === undefined ? {} : { held: entry.held }),
  ...(entry.expiresAt === undefined ? {} : { expiresAt: at(entry.expiresAt) }),
  ...(entry.holdOf === undefined ? {} : { holdOf: entry.holdOf }),
  createdAt: at(entry.createdAt),
});

// Stored values are checked, not trusted: a negative or fractional balance is an error.
function toWallet(organizationId: OrganizationId, data: WalletDocument): CreditWallet {
  if (!whole(data.balance) || data.balance < 0 || typeof data.walletId !== 'string') {
    throw new Error('invalid credit wallet record');
  }
  if (
    data.buckets !== undefined &&
    (!isBuckets(data.buckets) || data.buckets.included + data.buckets.purchased !== data.balance)
  ) {
    throw new Error('invalid credit wallet record');
  }
  const holds = data.holds?.map((h) => {
    if (typeof h.entryId !== 'string' || !whole(h.amount) || h.amount < 1) {
      throw new Error('invalid credit wallet record');
    }
    return Object.freeze({
      entryId: h.entryId as CreditEntryId,
      amount: h.amount,
      expiresAt: iso(h.expiresAt),
    });
  });
  return Object.freeze({
    id: data.walletId as CreditWalletId,
    organizationId,
    balance: data.balance,
    ...(data.buckets === undefined
      ? {}
      : {
          buckets: Object.freeze({
            included: data.buckets.included,
            purchased: data.buckets.purchased,
          }),
        }),
    ...(holds === undefined ? {} : { holds: Object.freeze(holds) }),
    createdAt: iso(data.createdAt),
    updatedAt: iso(data.updatedAt),
  });
}

function toEntry(id: string, data: EntryDocument): CreditLedgerEntry {
  if (!TYPES.includes(data.type) || !whole(data.amount) || !whole(data.balanceAfter)) {
    throw new Error('invalid credit ledger record');
  }
  if (
    (data.bucket !== undefined && !BUCKETS.includes(data.bucket)) ||
    (data.split !== undefined && !isBuckets(data.split)) ||
    (data.held !== undefined && (!whole(data.held) || data.held < 0))
  ) {
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
    ...(data.bucket === undefined ? {} : { bucket: data.bucket }),
    ...(data.split === undefined
      ? {}
      : {
          split: Object.freeze({ included: data.split.included, purchased: data.split.purchased }),
        }),
    ...(data.held === undefined ? {} : { held: data.held }),
    ...(data.expiresAt === undefined ? {} : { expiresAt: iso(data.expiresAt) }),
    ...(data.holdOf === undefined ? {} : { holdOf: data.holdOf as CreditEntryId }),
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
            buckets: { ...(wallet.buckets ?? { included: 0, purchased: wallet.balance }) },
            holds: holdsOf(wallet),
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
