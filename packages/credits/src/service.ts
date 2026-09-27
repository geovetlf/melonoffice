import { actorOf, buildAuditEvent, type AuditAction } from '@melonoffice/audit';
import type {
  CreditEntryType,
  CreditLedgerEntry,
  IsoTimestamp,
  OrganizationId,
} from '@melonoffice/domain';
import { isResolvedTenant, type TenancyStore, type TenantContext } from '@melonoffice/tenancy';
import { CreditsError } from './errors.js';
import { applyOperation, entryIdOf, type CreditOperation } from './ledger.js';
import type { CreditStore } from './store.js';

export type CreditBalance =
  | {
      readonly status: 'present';
      readonly organizationId: OrganizationId;
      readonly balance: number;
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
  grant(tenant: TenantContext, request: CreditRequest): Promise<CreditResult>;
  /** Spends credits, or refuses with `credits_insufficient`. The balance never goes below 0. */
  consume(tenant: TenantContext, request: CreditRequest): Promise<CreditResult>;
  /** Gives back credits for an earlier `consume` (by its `referenceId`), never more than it spent. */
  refund(
    tenant: TenantContext,
    request: CreditRequest & { readonly refundOf: string },
  ): Promise<CreditResult>;
}

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
};

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

  async function post(
    tenant: TenantContext,
    operation: Exclude<CreditOperation, { type: 'adjustment' }>,
  ): Promise<CreditResult> {
    const organizationId = await organizationOf(tenant);
    return store.transact(organizationId, async (tx) => {
      const id = entryIdOf(organizationId, String(operation.referenceId));
      const wallet = await tx.wallet();
      const existing = await tx.entry(id);
      let original: CreditLedgerEntry | undefined;
      let alreadyRefunded = 0;
      if (operation.type === 'refund' && existing === undefined) {
        const originalId = entryIdOf(organizationId, String(operation.refundOf));
        original = await tx.entry(originalId);
        alreadyRefunded = await tx.refundedFor(originalId);
      }
      // Strictly after the wallet's last movement, so the ledger has one order even within a
      // millisecond.
      const last = wallet === undefined ? 0 : Date.parse(wallet.updatedAt) + 1;
      const at = new Date(Math.max(now().getTime(), last));
      const posting = applyOperation(
        organizationId,
        operation,
        { wallet, existing, original, alreadyRefunded },
        at.toISOString() as IsoTimestamp,
      );
      if (posting.kind === 'replayed') {
        return { entry: posting.entry, balance: posting.entry.balanceAfter, replayed: true };
      }
      const { entry } = posting;
      // The fact goes to the audit log in the same write; the amounts stay in the ledger.
      const event = buildAuditEvent(
        {
          action: ACTION[operation.type],
          result: 'success',
          actor: actorOf(tenant),
          organizationId,
          target: { type: 'credit_entry', id: entry.id },
          reference: entry.referenceId,
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
      return Object.freeze({
        status: 'present',
        organizationId,
        balance: wallet.balance,
        updatedAt: wallet.updatedAt,
      });
    },
    grant: (tenant, request) => post(tenant, { type: 'grant', ...pick(request) }),
    consume: (tenant, request) => post(tenant, { type: 'consume', ...pick(request) }),
    refund: (tenant, request) =>
      post(tenant, { type: 'refund', ...pick(request), refundOf: request.refundOf }),
  };
}

// Only the known fields are taken, so nothing else in a request can reach the ledger.
const pick = ({ amount, referenceId, reason }: CreditRequest): CreditRequest => ({
  amount,
  referenceId,
  reason,
});
