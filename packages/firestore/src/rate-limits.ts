import type { Firestore } from '@google-cloud/firestore';
import {
  decideWindow,
  type ConnectionRateLimiter,
  type DeliveryPolicy,
  type RateLimitDecision,
  type RateLimitKey,
} from '@melonoffice/integrations';

/**
 * `connectionRateWindows/{organizationId}_{connectionId}`: one connection's current send window
 * (ADR-0045). Only a start time and a count: no message, no recipient, no secret. The id holds
 * the organization, so two organizations never share a window; the fields are checked too.
 */
export const CONNECTION_RATE_WINDOWS = 'connectionRateWindows';

/**
 * The send limit every API and worker instance shares: each provider call takes a slot in one
 * transaction, so concurrent senders, however many, never pass the limit together.
 */
export class FirestoreConnectionRateLimiter implements ConnectionRateLimiter {
  constructor(private readonly db: Firestore) {}

  async acquire(
    key: RateLimitKey,
    limit: DeliveryPolicy['rateLimit'],
    now: Date,
  ): Promise<RateLimitDecision> {
    const ref = this.db
      .collection(CONNECTION_RATE_WINDOWS)
      .doc(`${key.organizationId}_${key.connectionId}`);
    return this.db.runTransaction(async (tx) => {
      const snapshot = await tx.get(ref);
      const data = snapshot.data();
      const stored =
        data !== undefined &&
        data.organizationId === key.organizationId &&
        data.connectionId === key.connectionId &&
        typeof data.startedAt === 'number' &&
        typeof data.count === 'number'
          ? { startedAt: data.startedAt, count: data.count }
          : undefined;
      const { decision, next } = decideWindow(stored, limit, now.getTime());
      if (next !== undefined) {
        tx.set(ref, {
          organizationId: key.organizationId,
          connectionId: key.connectionId,
          startedAt: next.startedAt,
          count: next.count,
        });
      }
      return decision;
    });
  }
}
