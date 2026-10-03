import {
  actorOf,
  buildAuditEvent,
  type AuditAction,
  type AuditEventInput,
} from '@melonoffice/audit';
import type {
  CreditBucket,
  CreditEntryType,
  CreditLedgerEntry,
  IsoTimestamp,
  OrganizationId,
  UserId,
} from '@melonoffice/domain';
import {
  isResolvedPlatformAdmin,
  isResolvedTenant,
  type PlatformAdminContext,
  type TenancyStore,
  type TenantContext,
} from '@melonoffice/tenancy';
import { CreditsError } from './errors.js';
import {
  applyOperation,
  availableOf,
  bucketsOf,
  closingReferenceOf,
  entryIdOf,
  type CreditOperation,
} from './ledger.js';
import type { CreditStore } from './store.js';

export type CreditBalance =
  | {
      readonly status: 'present';
      readonly organizationId: OrganizationId;
      /** Every credit in the wallet: `included` + `purchased`. */
      readonly balance: number;
      readonly included: number;
      readonly purchased: number;
      /** Held for operations still running (ADR-0123). */
      readonly reserved: number;
      /** What can be spent or held now: `balance` − `reserved`. */
      readonly available: number;
      readonly updatedAt: IsoTimestamp;
    }
  | {
      readonly status: 'unavailable';
      readonly reason: 'unresolved_tenant' | 'organization_inactive' | 'credits_wallet_missing';
    };

/** The outcome of an operation. `replayed` means the same operation had already been posted. */
export interface CreditResult {
  readonly entry: CreditLedgerEntry;
  readonly balance: number;
  readonly replayed: boolean;
}

export interface CreditRequest {
  /** Whole credits, positive. */
  readonly amount: number;
  /** The caller's idempotency key: the same key is the same operation. */
  readonly referenceId: string;
  /** A stable code saying why, for example `task_execution`. */
  readonly reason: string;
}

/** A grant names its bucket (ADR-0123). Absent: `purchased`. */
export interface CreditGrantRequest extends CreditRequest {
  readonly bucket?: CreditBucket;
}

export interface CreditHoldRequest extends CreditRequest {
  /** How long the hold lasts if it is never settled or released. Positive, at most 7 days. */
  readonly ttlMs: number;
}

export interface CreditSettleRequest {
  /** The `referenceId` of the hold. */
  readonly holdOf: string;
  /** Whole credits actually spent, 0 or more. It may exceed the hold if the balance covers it. */
  readonly amount: number;
  readonly reason: string;
}

/** The longest a hold may last. */
export const MAX_HOLD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * An organization's credits (ADR-0023). Every method works on the organization of a resolved
 * `TenantContext`, never on an id the caller passes, and records the tenant's user as the actor.
 * It knows nothing about HTTP, plans, capabilities, payments or usage: whether an action is
 * allowed is RBAC's and entitlements' call, made before credits is asked.
 *
 * There is no adjustment here: it needs an internal authority that does not exist yet.
 */
export interface CreditService {
  balanceOf(tenant: TenantContext): Promise<CreditBalance>;
  /** Adds credits. For internal, server-side flows only; no client route reaches it. */
  grant(tenant: TenantContext, request: CreditGrantRequest): Promise<CreditResult>;
  /**
   * Spends credits, or refuses with `credits_insufficient`. The balance never goes below 0, and
   * credits held for other operations are never spent.
   */
  consume(tenant: TenantContext, request: CreditRequest): Promise<CreditResult>;
  /**
   * Sets credits aside before an operation runs (ADR-0123), or refuses with
   * `credits_insufficient`. The balance does not move. The same `referenceId` is the same hold.
   */
  hold(tenant: TenantContext, request: CreditHoldRequest): Promise<CreditResult>;
  /**
   * Closes a hold with what the operation really cost: it spends `amount` and frees the rest.
   * A hold is closed once: asking again replays the first close, a different close is
   * `credits_hold_closed`. An expired hold can still be settled if the balance covers it.
   */
  settle(tenant: TenantContext, request: CreditSettleRequest): Promise<CreditResult>;
  /** Closes a hold without spending anything. Same once-only rule as `settle`. */
  release(
    tenant: TenantContext,
    request: Omit<CreditSettleRequest, 'amount'>,
  ): Promise<CreditResult>;
  /** Gives back credits for an earlier `consume` (by its `referenceId`), never more than it spent. */
  refund(
    tenant: TenantContext,
    request: CreditRequest & { readonly refundOf: string },
  ): Promise<CreditResult>;
  /**
   * Adds credits by hand, for the MelonOffice platform administrator (ADR-0091). It is the same
   * `grant` on the same wallet and ledger, only authorized by a resolved `PlatformAdminContext`
   * instead of a membership, and audited as `credits.platform_grant` with the administrator as the
   * actor. The same `referenceId` in the same organization replays the first grant: nothing moves
   * twice.
   */
  grantAsPlatform(
    admin: PlatformAdminContext,
    organizationId: OrganizationId,
    request: CreditRequest,
  ): Promise<CreditResult>;
  /**
   * Adds the credits of a paid purchase (ADR-0126) to the `purchased` bucket, once per purchase
   * (`purchase:<id>`). Only the purchase service calls it, after the payment provider confirmed
   * the payment; no client route reaches it. Audited as `credits.purchase`, with the buyer as the
   * one who started it.
   */
  grantPurchase(purchase: {
    readonly organizationId: OrganizationId;
    readonly purchaseId: string;
    readonly credits: number;
    readonly buyer: UserId;
  }): Promise<CreditResult>;
}

/** The ledger reference of a purchase's credits: a purchase is credited once. */
export const purchaseReferenceOf = (purchaseId: string): string => `purchase:${purchaseId}`;

export interface CreditServiceOptions {
  readonly store: CreditStore;
  /** Only `findOrganization` is used, to refuse inactive organizations. */
  readonly organizations: Pick<TenancyStore, 'findOrganization'>;
  readonly now?: () => Date;
}

const ACTION: Record<Exclude<CreditEntryType, 'adjustment'>, AuditAction> = {
  grant: 'credits.grant',
  consume: 'credits.consume',
  refund: 'credits.refund',
  hold: 'credits.hold',
  release: 'credits.release',
};

type ServiceOperation = Exclude<CreditOperation, { type: 'adjustment' }>;

/** The entry type an operation is recorded as: a settle is a consume, or a release for 0. */
const entryTypeOf = (operation: ServiceOperation): Exclude<CreditEntryType, 'adjustment'> =>
  operation.type === 'settle' ? (operation.amount === 0 ? 'release' : 'consume') : operation.type;

const referenceOf = (operation: ServiceOperation): string =>
  operation.type === 'settle'
    ? closingReferenceOf(String(operation.holdOf))
    : String(operation.referenceId);

export function createCreditService({
  store,
  organizations,
  now = () => new Date(),
}: CreditServiceOptions): CreditService {
  async function organizationOf(tenant: TenantContext): Promise<OrganizationId> {
    if (!isResolvedTenant(tenant)) throw new CreditsError('unresolved_tenant');
    const organization = await organizations.findOrganization(tenant.organizationId);
    if (organization?.id !== tenant.organizationId || organization.status !== 'active') {
      throw new CreditsError('organization_inactive');
    }
    return organization.id;
  }

  async function post(tenant: TenantContext, operation: ServiceOperation): Promise<CreditResult> {
    const organizationId = await organizationOf(tenant);
    return write(organizationId, operation, {
      action: ACTION[entryTypeOf(operation)],
      actor: actorOf(tenant),
    });
  }

  async function write(
    organizationId: OrganizationId,
    operation: ServiceOperation,
    by: Pick<AuditEventInput, 'action' | 'actor' | 'actorRole'>,
  ): Promise<CreditResult> {
    return store.transact(organizationId, async (tx) => {
      const id = entryIdOf(organizationId, referenceOf(operation));
      const wallet = await tx.wallet();
      const existing = await tx.entry(id);
      let original: CreditLedgerEntry | undefined;
      let alreadyRefunded = 0;
      let hold: CreditLedgerEntry | undefined;
      if (operation.type === 'refund' && existing === undefined) {
        const originalId = entryIdOf(organizationId, String(operation.refundOf));
        original = await tx.entry(originalId);
        alreadyRefunded = await tx.refundedFor(originalId);
      }
      if (operation.type === 'settle' && existing === undefined) {
        hold = await tx.entry(entryIdOf(organizationId, String(operation.holdOf)));
      }
      // Strictly after the wallet's last movement, so the ledger has one order even within a
      // millisecond.
      const last = wallet === undefined ? 0 : Date.parse(wallet.updatedAt) + 1;
      const at = new Date(Math.max(now().getTime(), last));
      const posting = applyOperation(
        organizationId,
        operation,
        { wallet, existing, original, alreadyRefunded, hold },
        at.toISOString() as IsoTimestamp,
      );
      if (posting.kind === 'replayed') {
        return { entry: posting.entry, balance: posting.entry.balanceAfter, replayed: true };
      }
      const { entry } = posting;
      // The fact goes to the audit log in the same write; the amounts stay in the ledger.
      const event = buildAuditEvent(
        {
          ...by,
          result: 'success',
          organizationId,
          target: { type: 'credit_entry', id: entry.id },
          // A hold's close is audited under the operation's own reference, so the operation's
          // events and its charge share one reference; the ledger keeps `<hold>:close`.
          reference: operation.type === 'settle' ? operation.holdOf : entry.referenceId,
          reason: entry.reason,
          source: 'api',
        },
        at,
      );
      tx.commit(posting.wallet, entry, [event]);
      return { entry, balance: entry.balanceAfter, replayed: false };
    });
  }

  return {
    async balanceOf(tenant) {
      let organizationId: OrganizationId;
      try {
        organizationId = await organizationOf(tenant);
      } catch (error) {
        if (error instanceof CreditsError && error.code === 'unresolved_tenant') {
          return { status: 'unavailable', reason: 'unresolved_tenant' };
        }
        if (error instanceof CreditsError) {
          return { status: 'unavailable', reason: 'organization_inactive' };
        }
        throw error;
      }
      const wallet = await store.findWallet(organizationId);
      if (wallet?.organizationId !== organizationId) {
        return { status: 'unavailable', reason: 'credits_wallet_missing' };
      }
      const buckets = bucketsOf(wallet);
      const available = availableOf(wallet, now().toISOString() as IsoTimestamp);
      return Object.freeze({
        status: 'present',
        organizationId,
        balance: wallet.balance,
        included: buckets.included,
        purchased: buckets.purchased,
        reserved: wallet.balance - available,
        available,
        updatedAt: wallet.updatedAt,
      });
    },
    grant: (tenant, request) =>
      post(tenant, {
        type: 'grant',
        ...pick(request),
        ...(request.bucket === undefined ? {} : { bucket: request.bucket }),
      }),
    consume: (tenant, request) => post(tenant, { type: 'consume', ...pick(request) }),
    hold: (tenant, request) => {
      const { ttlMs } = request;
      if (
        typeof ttlMs !== 'number' ||
        !Number.isSafeInteger(ttlMs) ||
        ttlMs < 1 ||
        ttlMs > MAX_HOLD_TTL_MS
      ) {
        return Promise.reject(new CreditsError('invalid_hold_expiry'));
      }
      const expiresAt = new Date(now().getTime() + ttlMs).toISOString() as IsoTimestamp;
      return post(tenant, { type: 'hold', ...pick(request), expiresAt });
    },
    settle: (tenant, { holdOf, amount, reason }) =>
      post(tenant, { type: 'settle', holdOf, amount, reason }),
    release: (tenant, { holdOf, reason }) =>
      post(tenant, { type: 'settle', holdOf, amount: 0, reason }),
    refund: (tenant, request) =>
      post(tenant, { type: 'refund', ...pick(request), refundOf: request.refundOf }),
    async grantAsPlatform(admin, organizationId, request) {
      if (!isResolvedPlatformAdmin(admin)) throw new CreditsError('unresolved_platform_admin');
      const organization = await organizations.findOrganization(organizationId);
      if (organization?.id !== organizationId || organization.status !== 'active') {
        throw new CreditsError('organization_inactive');
      }
      return write(
        organization.id,
        { type: 'grant', ...pick(request) },
        {
          action: 'credits.platform_grant',
          actor: { type: 'user', userId: admin.userId, via: 'direct' },
          actorRole: 'platform_admin',
        },
      );
    },
    async grantPurchase({ organizationId, purchaseId, credits, buyer }) {
      const organization = await organizations.findOrganization(organizationId);
      if (organization?.id !== organizationId || organization.status !== 'active') {
        throw new CreditsError('organization_inactive');
      }
      return write(
        organization.id,
        {
          type: 'grant',
          amount: credits,
          referenceId: purchaseReferenceOf(purchaseId),
          reason: 'credit_purchase',
          bucket: 'purchased',
        },
        {
          action: 'credits.purchase',
          actor: { type: 'system', id: 'runtime', initiatedBy: buyer, via: 'runtime' },
        },
      );
    },
  };
}

// Only the known fields are taken, so nothing else in a request can reach the ledger.
const pick = ({ amount, referenceId, reason }: CreditRequest): CreditRequest => ({
  amount,
  referenceId,
  reason,
});
