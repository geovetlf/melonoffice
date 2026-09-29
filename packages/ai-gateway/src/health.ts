import type { ProviderErrorKind, ProviderHealth } from './adapter.js';
import { isTransient } from './adapter.js';

/**
 * What the gateway has seen of each provider lately (ADR-0072), kept in memory by each server
 * instance: no store, no probe, no extra call before a request. A provider whose calls failed for
 * transient reasons (timeouts, rate limits, outages) `failureThreshold` times within `windowMs` is
 * skipped for `cooldownMs`, so calls go straight to a compatible fallback instead of waiting on
 * it. After the cooldown it is tried again, as `degraded` until a call succeeds. A refused
 * request (invalid, content policy) says nothing about the provider's health and is not counted.
 */
export interface ProviderHealthTracker {
  /** Providers to leave out of routing right now. */
  unavailable(): ReadonlySet<string>;
  status(providerId: string): ProviderHealth;
  /**
   * `retryAfterMs`: on `rate_limited`, how long the provider asked to wait. It is left out of
   * routing for that long at once (ADR-0080), whatever the failure count.
   */
  record(providerId: string, outcome: 'success' | ProviderErrorKind, retryAfterMs?: number): void;
}

export interface ProviderHealthOptions {
  readonly failureThreshold?: number;
  readonly windowMs?: number;
  readonly cooldownMs?: number;
  readonly now?: () => number;
}

export function createProviderHealthTracker(
  options: ProviderHealthOptions = {},
): ProviderHealthTracker {
  const { failureThreshold = 3, windowMs = 60_000, cooldownMs = 30_000 } = options;
  const now = options.now ?? (() => Date.now());
  const state = new Map<string, { failures: number[]; openUntil: number; degraded: boolean }>();
  const of = (id: string) => {
    let s = state.get(id);
    if (s === undefined) {
      s = { failures: [], openUntil: 0, degraded: false };
      state.set(id, s);
    }
    return s;
  };
  return Object.freeze({
    unavailable() {
      const at = now();
      return new Set([...state].filter(([, s]) => s.openUntil > at).map(([id]) => id));
    },
    status(providerId: string): ProviderHealth {
      const s = state.get(providerId);
      if (s === undefined) return 'available';
      if (s.openUntil > now()) return 'unavailable';
      return s.degraded ? 'degraded' : 'available';
    },
    record(providerId: string, outcome: 'success' | ProviderErrorKind, retryAfterMs?: number) {
      const s = of(providerId);
      if (outcome === 'success') {
        s.failures = [];
        s.openUntil = 0;
        s.degraded = false;
        return;
      }
      if (!isTransient(outcome)) return;
      const at = now();
      s.degraded = true;
      s.failures = [...s.failures.filter((t) => at - t < windowMs), at];
      if (s.failures.length >= failureThreshold) {
        s.openUntil = Math.max(s.openUntil, at + cooldownMs);
        s.failures = [];
      }
      // The provider said when it takes calls again: it is not asked before then.
      if (outcome === 'rate_limited' && retryAfterMs !== undefined && retryAfterMs > 0) {
        s.openUntil = Math.max(s.openUntil, at + retryAfterMs);
      }
    },
  });
}
