import type { Hono } from 'hono';
import type { AuthEnv } from './auth.js';

/**
 * Limits on how often one person may make sensitive requests (ADR-0092): platform changes and
 * manual credit grants, invitation links, and partner and owner commercial changes. Each kind has
 * its own fixed window per person, shared by every API instance (Firestore in deployed services),
 * so neither a mistake nor a stolen session can repeat them without end. Reads are not limited.
 *
 * A refused request answers 429 `rate_limited` with `Retry-After`, before its route runs: nothing
 * is read, changed or audited. It counts in the log only.
 */

export type RequestScope =
  | 'platform_write'
  | 'credit_grant'
  | 'invitation_token'
  | 'commercial_write'
  | 'relationship_write';

export interface RequestLimit {
  readonly maxSends: number;
  readonly windowMs: number;
}

export type RequestRateDecision =
  { readonly allowed: true } | { readonly allowed: false; readonly retryAfterMs: number };

/** Takes one slot of `key` (`{scope}:{userId}`) in its window, or says when there is room. */
export interface RequestRateLimiter {
  acquire(key: string, limit: RequestLimit, now: Date): Promise<RequestRateDecision>;
}

const MINUTE = 60_000;

/** Generous for a person working by hand; tight for a script repeating a request. */
export const DEFAULT_REQUEST_LIMITS: Readonly<Record<RequestScope, RequestLimit>> = {
  platform_write: { maxSends: 30, windowMs: MINUTE },
  credit_grant: { maxSends: 20, windowMs: 60 * MINUTE },
  invitation_token: { maxSends: 20, windowMs: 10 * MINUTE },
  commercial_write: { maxSends: 60, windowMs: MINUTE },
  relationship_write: { maxSends: 30, windowMs: MINUTE },
};

const CREDIT_GRANT = /^\/v1\/platform\/organizations\/[^/]+\/credit-grants$/;
const INVITATION_TOKEN = /^\/v1\/(member-)?invitations\/(lookup|accept|reject)$/;
const RELATIONSHIPS = /^\/v1\/organizations\/[^/]+\/commercial-relationships(\/|$)/;

/**
 * The scopes a request counts against, most specific first. Reads count against none; the
 * invitation lookup is a POST (it carries the token) and counts like accepting.
 */
export function scopesOf(method: string, path: string): readonly RequestScope[] {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return [];
  if (CREDIT_GRANT.test(path)) return ['credit_grant', 'platform_write'];
  if (path.startsWith('/v1/platform/')) return ['platform_write'];
  if (INVITATION_TOKEN.test(path)) return ['invitation_token'];
  if (path.startsWith('/v1/commercial/')) return ['commercial_write'];
  if (RELATIONSHIPS.test(path)) return ['relationship_write'];
  return [];
}

/** In one process only: for tests and local runs. Deployed services use the Firestore one. */
export class InMemoryRequestRateLimiter implements RequestRateLimiter {
  private readonly windows = new Map<string, { startedAt: number; count: number }>();

  async acquire(key: string, limit: RequestLimit, now: Date): Promise<RequestRateDecision> {
    const at = now.getTime();
    const window = this.windows.get(key);
    if (window === undefined || at >= window.startedAt + limit.windowMs) {
      this.windows.set(key, { startedAt: at, count: 1 });
      return { allowed: true };
    }
    if (window.count < limit.maxSends) {
      window.count += 1;
      return { allowed: true };
    }
    return { allowed: false, retryAfterMs: window.startedAt + limit.windowMs - at };
  }
}

/**
 * After authentication, before any route. Counted by the person's user id, whether they act
 * directly or GIA acts for them: both draw on the same window.
 */
export function registerRequestLimits(
  app: Hono<AuthEnv>,
  limiter: RequestRateLimiter,
  limits: Partial<Record<RequestScope, RequestLimit>> = {},
  now: () => Date = () => new Date(),
): void {
  app.use('/v1/*', async (c, next) => {
    const scopes = scopesOf(c.req.method, c.req.path);
    const auth = c.get('auth');
    if (scopes.length === 0 || auth === undefined) return next();
    for (const scope of scopes) {
      const decision = await limiter.acquire(
        `${scope}:${auth.userId}`,
        limits[scope] ?? DEFAULT_REQUEST_LIMITS[scope],
        now(),
      );
      if (!decision.allowed) {
        const retryAfter = Math.max(1, Math.ceil(decision.retryAfterMs / 1000));
        c.get('logger').warn('request rate limited', { scope });
        c.header('Retry-After', String(retryAfter));
        return c.json({ error: 'rate_limited', retryAfterSeconds: retryAfter }, 429);
      }
    }
    return next();
  });
}
