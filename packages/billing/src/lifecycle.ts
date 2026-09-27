import type { IsoTimestamp, PlanRef, Subscription, SubscriptionStatus } from '@melonoffice/domain';
import { BillingError } from './errors.js';

/**
 * Every subscription status and where it may go next (ADR-0022). Anything not listed is refused.
 * `canceled` is final: a canceled organization gets a new subscription, never a revived one.
 * A status is added here, with its transitions, when something needs it.
 */
export const SUBSCRIPTION_TRANSITIONS = {
  trialing: ['active', 'canceled'],
  active: ['past_due', 'canceled'],
  past_due: ['active', 'canceled'],
  canceled: [],
} as const satisfies Record<SubscriptionStatus, readonly SubscriptionStatus[]>;

export const SUBSCRIPTION_STATUSES = Object.freeze(
  Object.keys(SUBSCRIPTION_TRANSITIONS),
) as readonly SubscriptionStatus[];

export const isSubscriptionStatus = (value: unknown): value is SubscriptionStatus =>
  typeof value === 'string' && Object.hasOwn(SUBSCRIPTION_TRANSITIONS, value);

export function canTransition(from: SubscriptionStatus, to: SubscriptionStatus): boolean {
  if (!isSubscriptionStatus(from) || !isSubscriptionStatus(to)) return false;
  const next: readonly SubscriptionStatus[] = SUBSCRIPTION_TRANSITIONS[from];
  return next.includes(to);
}

/**
 * The statuses in which a subscription's plan is in force, so entitlements apply. `past_due` and
 * `canceled` grant nothing until a decision says otherwise (for example a grace period).
 */
export const PLAN_IN_FORCE: readonly SubscriptionStatus[] = Object.freeze(['trialing', 'active']);

export const isPlanInForce = (status: SubscriptionStatus): boolean =>
  PLAN_IN_FORCE.includes(status);

const PLAN_ID = /^[a-z][a-z0-9_-]{0,63}$/;

/** Whether a value has the shape of a plan reference. Whether the plan exists is entitlements' call. */
export const isPlanRef = (value: unknown): value is PlanRef =>
  typeof value === 'object' &&
  value !== null &&
  typeof (value as PlanRef).id === 'string' &&
  PLAN_ID.test((value as PlanRef).id) &&
  Number.isInteger((value as PlanRef).version) &&
  (value as PlanRef).version >= 1;

/**
 * Moves a subscription to another status. Pure: it returns a new, frozen subscription and never
 * changes the one given, so a refused transition changes nothing.
 */
export function transition(
  subscription: Subscription,
  to: SubscriptionStatus,
  at: IsoTimestamp,
): Subscription {
  if (!canTransition(subscription.status, to)) throw new BillingError('invalid_transition');
  return Object.freeze({ ...subscription, status: to, updatedAt: at });
}

/**
 * Puts a subscription on another plan. Pure, like `transition`. A canceled subscription cannot
 * change plan. Billing only records the reference; what the plan grants is resolved by
 * entitlements, never copied here.
 */
export function changePlan(
  subscription: Subscription,
  plan: PlanRef,
  at: IsoTimestamp,
): Subscription {
  if (subscription.status === 'canceled') throw new BillingError('subscription_canceled');
  if (!isPlanRef(plan)) throw new BillingError('invalid_plan');
  return Object.freeze({
    ...subscription,
    plan: Object.freeze({ id: plan.id, version: plan.version }),
    updatedAt: at,
  });
}
