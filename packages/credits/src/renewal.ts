import type { IsoTimestamp, OrganizationId } from '@melonoffice/domain';
import type { TenantContext } from '@melonoffice/tenancy';
import type { CreditRenewalTerms, CreditResult, CreditService } from './service.js';

/**
 * Plan periods and their renewal (D-12, ADR-0127). A subscription is monthly: each period starts
 * on the same day of the month as the subscription did (the last day of a shorter month). At the
 * start of each period the wallet is renewed once: the plan's included credits for the period are
 * added, and the last period's included credits beyond what the plan carries over are removed.
 * Bought credits never expire.
 *
 * Every amount comes from the plan's entitlements, never from here: how many credits a plan
 * includes and how many carry over are commercial decisions, unset until the owner makes them
 * (they resolve to 0, so a renewal adds nothing and carries nothing).
 */

const addMonths = (anchor: Date, months: number): Date => {
  const year = anchor.getUTCFullYear();
  const month = anchor.getUTCMonth() + months;
  const lastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(
    Date.UTC(
      year,
      month,
      Math.min(anchor.getUTCDate(), lastDay),
      anchor.getUTCHours(),
      anchor.getUTCMinutes(),
      anchor.getUTCSeconds(),
      anchor.getUTCMilliseconds(),
    ),
  );
};

/**
 * The monthly period that contains `at`, counted from `anchor` (the subscription's start). Before
 * the anchor there is no period.
 */
export function monthlyPeriodAt(
  anchor: IsoTimestamp,
  at: Date,
): { readonly startsAt: IsoTimestamp; readonly endsAt: IsoTimestamp } | undefined {
  const start = new Date(anchor);
  if (Number.isNaN(start.getTime()) || at.getTime() < start.getTime()) return undefined;
  let months =
    (at.getUTCFullYear() - start.getUTCFullYear()) * 12 + (at.getUTCMonth() - start.getUTCMonth());
  if (addMonths(start, months).getTime() > at.getTime()) months -= 1;
  return Object.freeze({
    startsAt: addMonths(start, months).toISOString() as IsoTimestamp,
    endsAt: addMonths(start, months + 1).toISOString() as IsoTimestamp,
  });
}

/** What a plan says about its included credits, as its entitlements resolve. */
export interface PlanCreditTerms {
  /** `credits.monthlyIncluded`. */
  readonly monthlyIncluded: number | 'unlimited';
  /** `credits.rollover`. */
  readonly rollover: boolean;
  /** `credits.rolloverMax`. */
  readonly rolloverMax: number | 'unlimited';
}

/**
 * The renewal a plan asks for. Included credits cannot be unlimited (a wallet holds a number), so
 * an `'unlimited'` value is refused rather than guessed. Without rollover nothing carries over.
 */
export function renewalOfPlan(
  terms: PlanCreditTerms,
): Pick<CreditRenewalTerms, 'included' | 'carryMax'> | undefined {
  if (terms.monthlyIncluded === 'unlimited') return undefined;
  const carryMax = !terms.rollover
    ? 0
    : terms.rolloverMax === 'unlimited'
      ? ('all' as const)
      : terms.rolloverMax;
  return { included: terms.monthlyIncluded, carryMax };
}

/** What renewal needs to know about an organization's subscription and plan. */
export interface RenewalSubject {
  /** When the subscription started: periods are counted from it. */
  readonly anchor: IsoTimestamp;
  readonly terms: PlanCreditTerms;
}

export interface CreditRenewalOptions {
  readonly credits: Pick<CreditService, 'balanceOf' | 'renew'>;
  /**
   * The organization's subscription and plan terms, or nothing when no plan is in force (no
   * billing, a subscription that is not active, a plan that cannot be resolved). Nothing renews
   * then.
   */
  readonly subjectOf: (tenant: TenantContext) => Promise<RenewalSubject | undefined>;
  readonly now?: () => Date;
}

export type RenewalOutcome =
  | { readonly status: 'renewed'; readonly result: CreditResult }
  | { readonly status: 'current' }
  | { readonly status: 'skipped'; readonly reason: 'no_plan' | 'no_wallet' | 'unsupported_terms' };

export interface CreditRenewal {
  /**
   * Renews the tenant's wallet if a new period has started since its last renewal. Safe to call
   * often and from many places at once: a period is renewed once (the ledger replays it), and a
   * wallet whose period is current is not written.
   */
  ensureCurrent(tenant: TenantContext): Promise<RenewalOutcome>;
}

export function createCreditRenewal({
  credits,
  subjectOf,
  now = () => new Date(),
}: CreditRenewalOptions): CreditRenewal {
  // When each organization's current period ends, as last seen, so most calls read nothing.
  const current = new Map<OrganizationId, number>();
  return {
    async ensureCurrent(tenant) {
      const at = now();
      const known = current.get(tenant.organizationId);
      if (known !== undefined && at.getTime() < known) return { status: 'current' };
      const subject = await subjectOf(tenant);
      if (subject === undefined) return { status: 'skipped', reason: 'no_plan' };
      const period = monthlyPeriodAt(subject.anchor, at);
      if (period === undefined) return { status: 'skipped', reason: 'no_plan' };
      const balance = await credits.balanceOf(tenant);
      if (balance.status !== 'present') return { status: 'skipped', reason: 'no_wallet' };
      if (balance.period !== undefined && balance.period.startsAt >= period.startsAt) {
        current.set(tenant.organizationId, Date.parse(balance.period.endsAt));
        return { status: 'current' };
      }
      const terms = renewalOfPlan(subject.terms);
      if (terms === undefined) return { status: 'skipped', reason: 'unsupported_terms' };
      const result = await credits.renew(tenant, { period, ...terms });
      current.set(tenant.organizationId, Date.parse(period.endsAt));
      return { status: 'renewed', result };
    },
  };
}

/** The part of billing renewal reads: the subscription's start and whether its plan is in force. */
export interface RenewalBillingPort {
  billingOf(tenant: TenantContext): Promise<
    | {
        readonly status: 'present';
        readonly subscription: { readonly createdAt: IsoTimestamp };
        readonly planInForce: boolean;
      }
    | { readonly status: 'unavailable' }
  >;
}

/** The part of entitlements renewal reads: the plan's credit values. */
export interface RenewalEntitlementsPort {
  entitlementsOf(tenant: TenantContext): Promise<
    | {
        readonly status: 'active';
        readonly values: {
          readonly 'credits.monthlyIncluded': number | 'unlimited';
          readonly 'credits.rollover': boolean;
          readonly 'credits.rolloverMax': number | 'unlimited';
        };
      }
    | { readonly status: 'unavailable' }
  >;
}

/**
 * What renewal needs, read from billing and entitlements: the subscription's start, from which
 * monthly periods are counted, and the plan's credit terms. Nothing when no plan is in force, so
 * nothing renews.
 */
export function renewalSubjectOf(
  billing: RenewalBillingPort,
  entitlements: RenewalEntitlementsPort,
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
 * The credit service, renewing the wallet first when a new plan period started, so every read,
 * spend and hold sees the period's included credits. A failed renewal never blocks it: it is
 * reported to `onError` and retried on the next call.
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
