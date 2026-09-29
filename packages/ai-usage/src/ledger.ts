import type {
  AIUsageBucket,
  AIUsageEvent,
  AIUsageSummary,
  OrganizationId,
} from '@melonoffice/domain';
import { isCapabilityId, isUnit, isUsageCode } from './capabilities.js';
import { AIUsageError } from './errors.js';
import type { AIUsageSink } from './sink.js';
import { addUsageEvent, dayOf, emptyUsageDay, summarize, type AIUsageDay } from './totals.js';

/**
 * The AI Usage Ledger (ADR-0074): every AI operation's usage event, append-only and idempotent by
 * id, with its organization's daily totals updated in the same write. It is where every engine's
 * `AIUsageSink` writes, and what the Financial Backend reads. It charges nothing: the credits
 * ledger stays the only charge.
 */
export interface AIUsageStore {
  /** Keeps the event and adds it to its day, at once; a repeat of an id changes nothing. */
  record(event: AIUsageEvent): Promise<'recorded' | 'replayed'>;
  /** The organization's days between two UTC days, both included; days with no usage are absent. */
  days(organizationId: OrganizationId, from: string, to: string): Promise<readonly AIUsageDay[]>;
  /** Every organization's days between two UTC days (the platform view). */
  allDays(from: string, to: string): Promise<readonly AIUsageDay[]>;
  /** The organization's latest events, newest first, before an event's time and id when given. */
  events(
    organizationId: OrganizationId,
    request: {
      readonly limit: number;
      readonly before?: { readonly at: string; readonly id: string };
    },
  ): Promise<{ readonly items: readonly AIUsageEvent[]; readonly hasMore: boolean }>;
}

type EventsRequest = Parameters<AIUsageStore['events']>[1];

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const EVENT_ID = /^[A-Za-z0-9_-]{1,128}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
/** A summary covers at most this many days, so it reads a bounded number of documents. */
export const MAX_SUMMARY_DAYS = 92;
export const MAX_EVENTS_PAGE = 100;

/** Whether an event is well-formed enough to keep. It must hold codes and numbers only. */
export function checkUsageEvent(event: AIUsageEvent): void {
  const fail = (detail: string) => {
    throw new AIUsageError('invalid_event', detail);
  };
  if (!EVENT_ID.test(event.id)) fail('id');
  if (!ISO.test(event.occurredAt) || Number.isNaN(Date.parse(event.occurredAt))) fail('occurredAt');
  if (!isCapabilityId(event.capability) || event.cost.capability !== event.capability) {
    fail('capability');
  }
  for (const code of [
    event.provider,
    event.model,
    event.modelVersion,
    event.operation,
    event.source,
    event.requestId,
  ]) {
    if (!isUsageCode(code)) fail('code');
  }
  if (event.cost.provider !== event.provider || event.cost.model !== event.model) fail('cost');
  if (event.outcome !== 'completed' && event.outcome !== 'failed') fail('outcome');
  if (!Number.isSafeInteger(event.credits) || event.credits < 0) fail('credits');
  if (
    event.creditPolicy !== undefined &&
    (!isUsageCode(event.creditPolicy.id) || !isUsageCode(event.creditPolicy.version))
  ) {
    fail('creditPolicy');
  }
  if (event.fallbackFrom !== undefined && !isUsageCode(event.fallbackFrom)) fail('fallbackFrom');
  const actual = event.cost.actualMicroUsd;
  if (actual !== null && (!Number.isSafeInteger(actual) || actual < 0)) fail('cost');
  for (const q of event.cost.usage.quantities) {
    if (!isUnit(q.unit) || !Number.isFinite(q.quantity) || q.quantity < 0) fail('usage');
  }
  const a = event.attribution;
  if (!['user', 'gia', 'runtime', 'system'].includes(a.actor)) fail('actor');
  for (const code of [
    a.userId,
    a.specialistId,
    a.departmentId,
    a.workflowId,
    a.executionId,
    a.taskType,
  ]) {
    if (code !== undefined && !isUsageCode(code)) fail('attribution');
  }
}

/** Every UTC day from one to another, both included. */
export function daysBetween(from: string, to: string): readonly string[] {
  if (!DAY.test(from) || !DAY.test(to)) throw new AIUsageError('invalid_usage', 'day');
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(start) || Number.isNaN(end) || end < start) {
    throw new AIUsageError('invalid_usage', 'range');
  }
  const count = (end - start) / 86_400_000 + 1;
  if (count > MAX_SUMMARY_DAYS) throw new AIUsageError('invalid_usage', 'range');
  return Array.from({ length: count }, (_, i) =>
    new Date(start + i * 86_400_000).toISOString().slice(0, 10),
  );
}

export interface AIUsageLedger extends AIUsageSink {
  /** One organization's usage between two UTC days, both included. */
  summary(organizationId: OrganizationId, from: string, to: string): Promise<AIUsageSummary>;
  /** All of MelonOffice's AI usage between two UTC days (operators only, never a tenant route). */
  platformSummary(from: string, to: string): Promise<AIUsageSummary>;
  /** Each organization's totals between two UTC days (operators and the platform admin only). */
  organizationTotals(
    from: string,
    to: string,
  ): Promise<Readonly<Record<OrganizationId, AIUsageBucket>>>;
  events: AIUsageStore['events'];
}

/**
 * The ledger over a store. Tenancy and permissions are checked by the caller (the API route
 * resolves the tenant and requires `ai_usage.read`), as with credits.
 */
export function createAIUsageLedger(store: AIUsageStore): AIUsageLedger {
  return Object.freeze({
    async record(event: AIUsageEvent): Promise<void> {
      checkUsageEvent(event);
      await store.record(event);
    },
    async summary(organizationId: OrganizationId, from: string, to: string) {
      daysBetween(from, to);
      return summarize(organizationId, from, to, await store.days(organizationId, from, to));
    },
    async platformSummary(from: string, to: string) {
      daysBetween(from, to);
      return summarize('platform', from, to, await store.allDays(from, to));
    },
    async organizationTotals(from: string, to: string) {
      daysBetween(from, to);
      const totals: Record<OrganizationId, AIUsageBucket> = {};
      for (const day of await store.allDays(from, to)) {
        const own = totals[day.organizationId];
        totals[day.organizationId] =
          own === undefined
            ? { ...day.totals }
            : {
                operations: own.operations + day.totals.operations,
                costMicroUsd: own.costMicroUsd + day.totals.costMicroUsd,
                unpricedOperations: own.unpricedOperations + day.totals.unpricedOperations,
                credits: own.credits + day.totals.credits,
              };
      }
      return totals;
    },
    async events(organizationId: OrganizationId, request: EventsRequest) {
      if (
        !Number.isSafeInteger(request.limit) ||
        request.limit < 1 ||
        request.limit > MAX_EVENTS_PAGE
      ) {
        throw new AIUsageError('invalid_usage', 'limit');
      }
      return store.events(organizationId, request);
    },
  });
}

/** For tests and local runs. */
export class InMemoryAIUsageStore implements AIUsageStore {
  readonly #events = new Map<string, AIUsageEvent>();
  readonly #days = new Map<string, AIUsageDay>();

  async record(event: AIUsageEvent): Promise<'recorded' | 'replayed'> {
    if (this.#events.has(event.id)) return 'replayed';
    this.#events.set(event.id, event);
    const organizationId = event.attribution.organizationId;
    const day = dayOf(event.occurredAt);
    const key = `${organizationId}_${day}`;
    this.#days.set(
      key,
      addUsageEvent(this.#days.get(key) ?? emptyUsageDay(organizationId, day), event),
    );
    return 'recorded';
  }

  async days(organizationId: OrganizationId, from: string, to: string) {
    return daysBetween(from, to).flatMap((day) => {
      const found = this.#days.get(`${organizationId}_${day}`);
      return found === undefined ? [] : [found];
    });
  }

  async allDays(from: string, to: string) {
    return [...this.#days.values()].filter((d) => d.day >= from && d.day <= to);
  }

  async events(
    organizationId: OrganizationId,
    request: {
      readonly limit: number;
      readonly before?: { readonly at: string; readonly id: string };
    },
  ) {
    const newestFirst = [...this.#events.values()]
      .filter((e) => e.attribution.organizationId === organizationId)
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
