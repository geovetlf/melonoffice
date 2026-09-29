import type {
  AIUsageBucket,
  AIUsageDimension,
  AIUsageEvent,
  AIUsageSummary,
  OrganizationId,
} from '@melonoffice/domain';

/**
 * Daily totals (ADR-0074): each organization's usage per UTC day, kept as it is recorded, so a
 * summary reads a few days, not every event. Pure functions: the stores keep the documents.
 */
export const AI_USAGE_DIMENSIONS = Object.freeze([
  'capability',
  'provider',
  'model',
  'operation',
  'actor',
  'user',
  'agent',
  'department',
  'workflow',
  'task_type',
] as const satisfies readonly AIUsageDimension[]);

/** One organization's usage on one UTC day. */
export interface AIUsageDay {
  readonly organizationId: OrganizationId;
  /** `YYYY-MM-DD`, UTC. */
  readonly day: string;
  readonly totals: AIUsageBucket;
  readonly by: Readonly<Record<AIUsageDimension, Readonly<Record<string, AIUsageBucket>>>>;
  readonly quantities: Readonly<Record<string, Readonly<Record<string, number>>>>;
}

const EMPTY_BUCKET: AIUsageBucket = Object.freeze({
  operations: 0,
  costMicroUsd: 0,
  unpricedOperations: 0,
  credits: 0,
});

const emptyBy = (): Record<AIUsageDimension, Record<string, AIUsageBucket>> =>
  Object.fromEntries(AI_USAGE_DIMENSIONS.map((d) => [d, {}])) as Record<
    AIUsageDimension,
    Record<string, AIUsageBucket>
  >;

export const dayOf = (iso: string): string => iso.slice(0, 10);

export function emptyUsageDay(organizationId: OrganizationId, day: string): AIUsageDay {
  return { organizationId, day, totals: EMPTY_BUCKET, by: emptyBy(), quantities: {} };
}

const addBuckets = (a: AIUsageBucket, b: AIUsageBucket): AIUsageBucket => ({
  operations: a.operations + b.operations,
  costMicroUsd: a.costMicroUsd + b.costMicroUsd,
  unpricedOperations: a.unpricedOperations + b.unpricedOperations,
  credits: a.credits + b.credits,
});

/** The keys an event counts under, one per dimension it has. Nothing inferred. */
export function keysOf(event: AIUsageEvent): Partial<Record<AIUsageDimension, string>> {
  const a = event.attribution;
  return {
    capability: event.capability,
    provider: event.provider,
    model: `${event.provider}/${event.model}`,
    operation: `${event.capability}:${event.operation}`,
    actor: a.actor,
    ...(a.userId === undefined ? {} : { user: a.userId }),
    ...(a.specialistId === undefined ? {} : { agent: a.specialistId }),
    ...(a.departmentId === undefined ? {} : { department: a.departmentId }),
    ...(a.workflowId === undefined ? {} : { workflow: a.workflowId }),
    ...(a.taskType === undefined ? {} : { task_type: a.taskType }),
  };
}

const bucketOf = (event: AIUsageEvent): AIUsageBucket => ({
  operations: 1,
  costMicroUsd: event.cost.actualMicroUsd ?? 0,
  unpricedOperations: event.cost.actualMicroUsd === null ? 1 : 0,
  credits: event.credits,
});

/** The day with one more event in it. */
export function addUsageEvent(day: AIUsageDay, event: AIUsageEvent): AIUsageDay {
  const bucket = bucketOf(event);
  const by = emptyBy();
  for (const dimension of AI_USAGE_DIMENSIONS) by[dimension] = { ...day.by[dimension] };
  for (const [dimension, key] of Object.entries(keysOf(event)) as [AIUsageDimension, string][]) {
    by[dimension][key] = addBuckets(by[dimension][key] ?? EMPTY_BUCKET, bucket);
  }
  const quantities: Record<string, Record<string, number>> = { ...day.quantities };
  const own = { ...(quantities[event.capability] ?? {}) };
  for (const { unit, quantity } of event.cost.usage.quantities) {
    own[unit] = (own[unit] ?? 0) + quantity;
  }
  quantities[event.capability] = own;
  return {
    organizationId: day.organizationId,
    day: day.day,
    totals: addBuckets(day.totals, bucket),
    by,
    quantities,
  };
}

/** Several days, of one organization or many, as one summary. */
export function summarize(
  scope: AIUsageSummary['scope'],
  from: string,
  to: string,
  days: readonly AIUsageDay[],
): AIUsageSummary {
  let totals = EMPTY_BUCKET;
  const by = emptyBy();
  const quantities: Record<string, Record<string, number>> = {};
  for (const day of days) {
    totals = addBuckets(totals, day.totals);
    for (const dimension of AI_USAGE_DIMENSIONS) {
      for (const [key, bucket] of Object.entries(day.by[dimension] ?? {})) {
        by[dimension][key] = addBuckets(by[dimension][key] ?? EMPTY_BUCKET, bucket);
      }
    }
    for (const [capability, units] of Object.entries(day.quantities)) {
      const own = (quantities[capability] ??= {});
      for (const [unit, quantity] of Object.entries(units)) own[unit] = (own[unit] ?? 0) + quantity;
    }
  }
  return { scope, from, to, currency: 'USD', totals, by, quantities };
}
