import type { ChannelConnectionId, OrganizationId } from '@melonoffice/domain';
import { isIntegrationError } from './errors.js';

/**
 * How the Integration Engine delivers an outbound message (CV-6D, ADR-0045): one place for every
 * value, so nothing about limits or retries is scattered through the code.
 *
 * - `rateLimit`: at most `maxSends` provider calls per connection in each `windowMs`, whoever
 *   asks (a person, one agent, several, or several worker processes), retries included. Each
 *   organization's connection has its own count; nothing is shared between organizations.
 * - `retry`: at most `maxAttempts` provider calls for one message, only while the provider surely
 *   did not take it, spaced by an exponential backoff with full jitter (or the provider's own
 *   `Retry-After`), all within `totalBudgetMs` of the first one.
 */
export interface DeliveryPolicy {
  readonly rateLimit: {
    readonly windowMs: number;
    readonly maxSends: number;
  };
  readonly retry: {
    readonly maxAttempts: number;
    readonly baseDelayMs: number;
    readonly maxDelayMs: number;
    /** Everything (waits and provider calls) within this long of the first try. */
    readonly totalBudgetMs: number;
    /** A retry starts only if at least this long remains for its call. */
    readonly minAttemptMs: number;
  };
}

/**
 * The defaults. They are MelonOffice's own protection, well under Meta's published throughput
 * (80 messages per second per number): adjustable by configuration, not a product decision.
 * The budget stays under the `message_send` tool's 15 s timeout, so a retry never outlives the
 * tool call that asked for it.
 */
export const DEFAULT_DELIVERY_POLICY: DeliveryPolicy = Object.freeze({
  rateLimit: Object.freeze({ windowMs: 60_000, maxSends: 60 }),
  retry: Object.freeze({
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 4_000,
    totalBudgetMs: 12_000,
    minAttemptMs: 3_000,
  }),
});

const LIMITS = {
  windowMs: [1_000, 3_600_000],
  maxSends: [1, 100_000],
  maxAttempts: [1, 5],
  baseDelayMs: [0, 60_000],
  maxDelayMs: [0, 60_000],
  totalBudgetMs: [1_000, 60_000],
  minAttemptMs: [100, 60_000],
} as const;

const inRange = (name: keyof typeof LIMITS, value: number): boolean =>
  Number.isSafeInteger(value) && value >= LIMITS[name][0] && value <= LIMITS[name][1];

/** A checked policy; throws on a value out of range, so a bad configuration fails at start. */
export function checkDeliveryPolicy(policy: DeliveryPolicy): DeliveryPolicy {
  const values = { ...policy.rateLimit, ...policy.retry };
  for (const name of Object.keys(LIMITS) as (keyof typeof LIMITS)[]) {
    if (!inRange(name, values[name])) throw new Error(`invalid delivery policy: ${name}`);
  }
  if (policy.retry.maxDelayMs < policy.retry.baseDelayMs) {
    throw new Error('invalid delivery policy: maxDelayMs');
  }
  return Object.freeze({
    rateLimit: Object.freeze({ ...policy.rateLimit }),
    retry: Object.freeze({ ...policy.retry }),
  });
}

/** The environment variables that may change the defaults, one per value. */
export const DELIVERY_POLICY_ENV = Object.freeze({
  windowMs: 'CHANNEL_RATE_WINDOW_MS',
  maxSends: 'CHANNEL_RATE_MAX_SENDS',
  maxAttempts: 'CHANNEL_RETRY_MAX_ATTEMPTS',
  baseDelayMs: 'CHANNEL_RETRY_BASE_DELAY_MS',
  maxDelayMs: 'CHANNEL_RETRY_MAX_DELAY_MS',
  totalBudgetMs: 'CHANNEL_RETRY_BUDGET_MS',
  minAttemptMs: 'CHANNEL_RETRY_MIN_ATTEMPT_MS',
} as const);

/** The defaults with any value the environment sets; throws on a malformed one. */
export function deliveryPolicyFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): DeliveryPolicy {
  const read = (name: keyof typeof DELIVERY_POLICY_ENV, fallback: number): number => {
    const raw = env[DELIVERY_POLICY_ENV[name]];
    if (raw === undefined || raw === '') return fallback;
    if (!/^[0-9]{1,9}$/.test(raw)) throw new Error(`invalid delivery policy: ${name}`);
    return Number(raw);
  };
  const { rateLimit, retry } = DEFAULT_DELIVERY_POLICY;
  return checkDeliveryPolicy({
    rateLimit: {
      windowMs: read('windowMs', rateLimit.windowMs),
      maxSends: read('maxSends', rateLimit.maxSends),
    },
    retry: {
      maxAttempts: read('maxAttempts', retry.maxAttempts),
      baseDelayMs: read('baseDelayMs', retry.baseDelayMs),
      maxDelayMs: read('maxDelayMs', retry.maxDelayMs),
      totalBudgetMs: read('totalBudgetMs', retry.totalBudgetMs),
      minAttemptMs: read('minAttemptMs', retry.minAttemptMs),
    },
  });
}

/**
 * The provider errors after which the message surely was not taken, so calling again cannot
 * send it twice: the provider's rate limit, a connection that never opened, and the errors the
 * provider itself calls temporary. Everything else is final, and an unknown outcome (no answer,
 * a timeout once the request left, a bare server error, an unreadable answer) is never retried:
 * the message may have gone out.
 */
export const RETRYABLE_DETAILS: readonly string[] = Object.freeze([
  'rate_limited',
  'not_connected',
  'temporary_provider_error',
]);

export function isRetryable(error: unknown): boolean {
  return (
    isIntegrationError(error) &&
    error.code === 'provider_unavailable' &&
    error.detail !== undefined &&
    RETRYABLE_DETAILS.includes(error.detail)
  );
}

/** The provider's own wait, when it said one (`Retry-After`), in milliseconds. */
export function retryAfterOf(error: unknown): number | undefined {
  const value = (error as { retryAfterMs?: unknown } | null)?.retryAfterMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

/**
 * The wait before the next call: exponential from `baseDelayMs` (`attempt` is the call that just
 * failed, from 1), capped at `maxDelayMs`, with full jitter; never less than the provider's own
 * `Retry-After`.
 */
export function backoffDelay(
  retry: DeliveryPolicy['retry'],
  attempt: number,
  random: () => number,
  retryAfterMs?: number,
): number {
  const ceiling = Math.min(retry.maxDelayMs, retry.baseDelayMs * 2 ** (attempt - 1));
  const jittered = Math.floor(ceiling * Math.min(Math.max(random(), 0), 1));
  return Math.max(jittered, retryAfterMs ?? 0);
}

/** One connection's send limit, as a place a slot is taken from. */
export interface RateLimitKey {
  readonly organizationId: OrganizationId;
  readonly connectionId: ChannelConnectionId;
}

/** Whether a provider call may start now; when not, how long until the window has room. */
export type RateLimitDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs: number };

/**
 * The one decision before every provider call (ADR-0045): shared by every caller of a
 * connection, keyed by organization and connection, and never by agent. A slot is taken when
 * allowed, even if the call then fails: the provider was still called.
 */
export interface ConnectionRateLimiter {
  acquire(
    key: RateLimitKey,
    limit: DeliveryPolicy['rateLimit'],
    now: Date,
  ): Promise<RateLimitDecision>;
}

/** The fixed-window rule both limiters apply, on a window as stored. */
export function decideWindow(
  window: { readonly startedAt: number; readonly count: number } | undefined,
  limit: DeliveryPolicy['rateLimit'],
  now: number,
): { readonly decision: RateLimitDecision; readonly next?: { startedAt: number; count: number } } {
  // Another instance's clock may be a little ahead: its window still counts. One started more
  // than a whole window "ahead" (a clock moved back) is treated as over, never as a lock-out.
  if (
    window === undefined ||
    now >= window.startedAt + limit.windowMs ||
    now < window.startedAt - limit.windowMs
  ) {
    return { decision: { allowed: true }, next: { startedAt: now, count: 1 } };
  }
  if (window.count < limit.maxSends) {
    return {
      decision: { allowed: true },
      next: { startedAt: window.startedAt, count: window.count + 1 },
    };
  }
  return {
    decision: {
      allowed: false,
      retryAfterMs: Math.min(window.startedAt + limit.windowMs - now, limit.windowMs),
    },
  };
}

/** In one process only: for tests and local runs. Deployed services use the Firestore one. */
export class InMemoryConnectionRateLimiter implements ConnectionRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  async acquire(
    key: RateLimitKey,
    limit: DeliveryPolicy['rateLimit'],
    now: Date,
  ): Promise<RateLimitDecision> {
    const id = `${key.organizationId}_${key.connectionId}`;
    const { decision, next } = decideWindow(this.windows.get(id), limit, now.getTime());
    if (next !== undefined) this.windows.set(id, next);
    return decision;
  }
}
