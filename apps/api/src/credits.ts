import type { BillingService } from '@melonoffice/billing';
import type {
  CreditBalance,
  CreditRenewal,
  CreditService,
  RenewalSubject,
} from '@melonoffice/credits';
import type { EntitlementService } from '@melonoffice/entitlements';
import type { TenantContext } from '@melonoffice/tenancy';
import type { Hono } from 'hono';
import type { AuthEnv } from './auth.js';
import { withPermission, type AuthorizationDependencies } from './authorization.js';

/**
 * Credit routes (ADR-0023). Only the balance can be read: there is no route that grants,
 * consumes, refunds or adjusts credits, and none that lists the ledger. Tenancy picks the
 * organization from the caller's membership, RBAC checks `credits.read`, and only then is the
 * wallet read, from the resolved tenant. Query parameters, headers and bodies are never read.
 */
export function registerCreditRoutes(
  app: Hono<AuthEnv>,
  dependencies: AuthorizationDependencies & {
    readonly credits: CreditService;
    /** Renews the wallet when a new plan period started (ADR-0127). Absent: never renewed. */
    readonly renewal?: CreditRenewal;
  },
): void {
  const { credits, renewal } = dependencies;
  app.get(
    '/v1/organizations/:organizationId/credits',
    withPermission('credits.read', dependencies, async (c, tenant) => {
      // A renewal that fails never hides the balance: it is retried on the next read.
      await renewal?.ensureCurrent(tenant).catch((error: unknown) => {
        c.get('logger').warn('credits renewal failed', { error });
      });
      const balance = await credits.balanceOf(tenant);
      if (balance.status !== 'present') {
        c.get('logger').warn('credits unavailable', { reason: balance.reason });
      }
      return c.json(toView(tenant.organizationId, balance));
    }),
  );
}

/**
 * The public view: the balance in whole credits, where it came from (included with the plan or
 * purchased), how much is held for running operations, what is available, and when it last moved.
 * No ledger entries.
 */
function toView(organizationId: string, balance: CreditBalance) {
  if (balance.status !== 'present') {
    return { organizationId, status: balance.status, reason: balance.reason };
  }
  return {
    organizationId,
    status: balance.status,
    balance: balance.balance,
    included: balance.included,
    purchased: balance.purchased,
    reserved: balance.reserved,
    available: balance.available,
    // The plan period (ADR-0127): when it started, when it renews, what it included and spent.
    period:
      balance.period === undefined
        ? null
        : {
            startsAt: balance.period.startsAt,
            renewsAt: balance.period.endsAt,
            included: balance.period.included,
            consumed: balance.period.consumed,
          },
    updatedAt: balance.updatedAt,
  };
}

/**
 * What renewal needs, read from billing and entitlements (ADR-0127): the subscription's start,
 * from which monthly periods are counted, and the plan's credit terms. Nothing when no plan is in
 * force, so nothing renews.
 */
export function renewalSubjectOf(
  billing: Pick<BillingService, 'billingOf'>,
  entitlements: Pick<EntitlementService, 'entitlementsOf'>,
): (tenant: TenantContext) => Promise<RenewalSubject | undefined> {
  return async (tenant) => {
    const account = await billing.billingOf(tenant);
    if (account.status !== 'present' || !account.planInForce) return undefined;
    const plan = await entitlements.entitlementsOf(tenant);
    if (plan.status !== 'active') return undefined;
    return {
      anchor: account.subscription.createdAt,
      terms: {
        monthlyIncluded: plan.values['credits.monthlyIncluded'],
        rollover: plan.values['credits.rollover'],
        rolloverMax: plan.values['credits.rolloverMax'],
      },
    };
  };
}

/**
 * The credit service, renewing the wallet first when a new plan period started (ADR-0127), so
 * every spend and hold sees the period's included credits. A failed renewal never blocks it.
 */
export function withRenewal<T extends Pick<CreditService, 'balanceOf' | 'hold' | 'consume'>>(
  credits: T,
  renewal: CreditRenewal,
  onError: (error: unknown) => void,
): T {
  const renew = (tenant: TenantContext) => renewal.ensureCurrent(tenant).catch(onError);
  return {
    ...credits,
    balanceOf: async (tenant: TenantContext) => {
      await renew(tenant);
      return credits.balanceOf(tenant);
    },
    hold: async (tenant: TenantContext, request: Parameters<T['hold']>[1]) => {
      await renew(tenant);
      return credits.hold(tenant, request);
    },
    consume: async (tenant: TenantContext, request: Parameters<T['consume']>[1]) => {
      await renew(tenant);
      return credits.consume(tenant, request);
    },
  };
}
