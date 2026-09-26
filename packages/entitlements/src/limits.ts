import type { EffectiveEntitlements } from './resolve.js';
import { limitForScope } from './resolve.js';
import type { Limit, LimitKey, LimitMapKey } from './registry.js';

export interface LimitCheck {
  readonly allowed: boolean;
  readonly limit: Limit;
  readonly used: number;
  /** How many more units fit; `'unlimited'` when there is no cap. */
  readonly remaining: number | 'unlimited';
}

function check(limit: Limit, used: number, requested: number): LimitCheck {
  if (!Number.isInteger(used) || used < 0 || !Number.isInteger(requested) || requested < 1) {
    throw new Error('usage must be a non-negative integer and the request a positive integer');
  }
  if (limit === 'unlimited') return { allowed: true, limit, used, remaining: 'unlimited' };
  const remaining = Math.max(0, limit - used);
  return { allowed: requested <= remaining, limit, used, remaining };
}

/**
 * Whether `requested` more units fit under a limit, given current usage.
 * The caller must read `used` and write the new usage in the same
 * transaction, or two requests could both pass (plan §11A.5).
 */
export function checkLimit(
  entitlements: EffectiveEntitlements,
  key: LimitKey,
  used: number,
  requested = 1,
): LimitCheck {
  return check(entitlements.values[key], used, requested);
}

/** Same as `checkLimit`, for a cap that depends on a scope such as a department type. */
export function checkScopedLimit(
  entitlements: EffectiveEntitlements,
  key: LimitMapKey,
  scope: string,
  used: number,
  requested = 1,
): LimitCheck {
  return check(limitForScope(entitlements, key, scope), used, requested);
}
