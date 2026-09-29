import { FieldPath, type DocumentData, type Firestore } from '@google-cloud/firestore';
import {
  addUsageEvent,
  dayOf,
  daysBetween,
  emptyUsageDay,
  type AIUsageDay,
  type AIUsageStore,
} from '@melonoffice/ai-usage';
import type { AIUsageEvent, OrganizationId } from '@melonoffice/domain';

/**
 * The AI Usage Ledger in Firestore (ADR-0074).
 *
 * - `aiUsageEvents/{eventId}`: one per AI operation, written once. Its id comes from the operation,
 *   so a repeat finds it and changes nothing.
 * - `aiUsageDays/{organizationId}_{YYYY-MM-DD}`: the organization's totals for that UTC day,
 *   updated in the same transaction as the event, so they never disagree.
 *
 * Written by the API and the worker only. Reads check the organization field. The day queries
 * need no composite index; the event list needs one (organizationId, occurredAt, id), and until it
 * exists the list is read without it and the gap logged.
 */
export const AI_USAGE_EVENTS = 'aiUsageEvents';
export const AI_USAGE_DAYS = 'aiUsageDays';
const FALLBACK_LIMIT = 500;

/** A query Firestore refuses until its composite index exists (gRPC FAILED_PRECONDITION). */
const isMissingIndex = (error: unknown): boolean =>
  typeof error === 'object' &&
  error !== null &&
  (error as { code?: unknown }).code === 9 &&
  /index/i.test(String((error as { message?: unknown }).message));

const organizationOf = (event: AIUsageEvent) => event.attribution.organizationId;

export class FirestoreAIUsageStore implements AIUsageStore {
  constructor(
    private readonly db: Firestore,
    private readonly options: { readonly onIndexMissing?: (query: string) => void } = {},
  ) {}

  async record(event: AIUsageEvent): Promise<'recorded' | 'replayed'> {
    const organizationId = organizationOf(event);
    const day = dayOf(event.occurredAt);
    const eventDoc = this.db.collection(AI_USAGE_EVENTS).doc(event.id);
    const dayDoc = this.db.collection(AI_USAGE_DAYS).doc(`${organizationId}_${day}`);
    // Firestore runs this again if either document changed before the commit.
    return this.db.runTransaction(async (t) => {
      const [stored, totals] = await Promise.all([t.get(eventDoc), t.get(dayDoc)]);
      if (stored.exists) {
        if (stored.data()?.organizationId !== organizationId) throw new Error('usage id taken');
        return 'replayed';
      }
      const current =
        totals.exists && totals.data()?.organizationId === organizationId
          ? (totals.data() as AIUsageDay)
          : emptyUsageDay(organizationId, day);
      t.create(eventDoc, { ...event, organizationId });
      t.set(dayDoc, addUsageEvent(current, event));
      return 'recorded';
    });
  }

  async days(organizationId: OrganizationId, from: string, to: string) {
    const refs = daysBetween(from, to).map((day) =>
      this.db.collection(AI_USAGE_DAYS).doc(`${organizationId}_${day}`),
    );
    const snapshots = await this.db.getAll(...refs);
    return snapshots.flatMap((s) => {
      const data = s.data();
      return data?.organizationId === organizationId ? [data as AIUsageDay] : [];
    });
  }

  async allDays(from: string, to: string) {
    daysBetween(from, to);
    // One field, a range: Firestore's automatic index.
    const snapshot = await this.db
      .collection(AI_USAGE_DAYS)
      .where('day', '>=', from)
      .where('day', '<=', to)
      .get();
    return snapshot.docs.map((doc) => doc.data() as AIUsageDay);
  }

  async events(
    organizationId: OrganizationId,
    request: {
      readonly limit: number;
      readonly before?: { readonly at: string; readonly id: string };
    },
  ) {
    const mine = this.db.collection(AI_USAGE_EVENTS).where('organizationId', '==', organizationId);
    let query = mine.orderBy('occurredAt', 'desc').orderBy(FieldPath.documentId(), 'desc');
    if (request.before !== undefined)
      query = query.startAfter(request.before.at, request.before.id);
    try {
      const snapshot = await query.limit(request.limit + 1).get();
      const items = snapshot.docs.map((doc) => toEvent(doc.data()));
      return { items: items.slice(0, request.limit), hasMore: items.length > request.limit };
    } catch (error) {
      if (!isMissingIndex(error)) throw error;
      this.options.onIndexMissing?.('ai_usage_events');
      // Equality only: Firestore's automatic indexes. Sorted here, at most FALLBACK_LIMIT read.
      const snapshot = await mine.limit(FALLBACK_LIMIT).get();
      const newestFirst = snapshot.docs
        .map((doc) => toEvent(doc.data()))
        .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id))
        .filter(
          (e) =>
            request.before === undefined ||
            e.occurredAt < request.before.at ||
            (e.occurredAt === request.before.at && e.id < request.before.id),
        );
      return {
        items: newestFirst.slice(0, request.limit),
        hasMore: newestFirst.length > request.limit,
      };
    }
  }
}

/** The stored event without the query field kept beside it (it is in the attribution). */
function toEvent(data: DocumentData): AIUsageEvent {
  const event: DocumentData = { ...data };
  delete event.organizationId;
  return event as AIUsageEvent;
}
