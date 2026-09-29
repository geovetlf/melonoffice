import type { ReplyRequest } from '../conversations/sendReply.js';

/**
 * AI usage and cost through the API (ADR-0074, ADR-0081): what the organization's AI use cost
 * MelonOffice (internal cost, from the provider's price) and what it charged in credits, kept
 * apart. Every figure is the ledger's; the screen adds nothing up beyond what the API returns.
 */

export interface UsageBucket {
  readonly operations: number;
  /** Internal cost, in millionths of a US dollar. */
  readonly costMicroUsd: number;
  /** Operations whose provider price was unknown: counted, never given a cost. */
  readonly unpricedOperations: number;
  /** Customer credits charged. */
  readonly credits: number;
}

export const USAGE_DIMENSIONS = [
  'capability',
  'provider',
  'model',
  'department',
  'agent',
  'workflow',
  'task_type',
] as const;
export type UsageDimension = (typeof USAGE_DIMENSIONS)[number];

export interface UsageSummary {
  readonly from: string;
  readonly to: string;
  readonly totals: UsageBucket;
  readonly by: Partial<Record<string, Readonly<Record<string, UsageBucket>>>>;
}

export interface UsageEvent {
  readonly id: string;
  readonly occurredAt: string;
  readonly capability: string;
  readonly provider: string;
  readonly model: string;
  readonly operation: string;
  readonly outcome: 'completed' | 'failed';
  readonly credits: number;
  readonly fallbackFrom?: string;
  readonly cost: { readonly actualMicroUsd: number | null };
  readonly attribution: {
    readonly actor: string;
    readonly specialistId?: string;
    readonly departmentId?: string;
    readonly workflowId?: string;
    readonly taskType?: string;
  };
}

export class UsageRequestError extends Error {
  override readonly name = 'UsageRequestError';
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`ai usage request failed: ${status}${code === undefined ? '' : ` ${code}`}`);
  }
}

export interface AIUsageClient {
  summary(from: string, to: string): Promise<UsageSummary>;
  events(cursor?: string): Promise<{ events: readonly UsageEvent[]; nextCursor: string | null }>;
}

export function createAIUsageClient(request: ReplyRequest, organizationId: string): AIUsageClient {
  const base = `/v1/organizations/${encodeURIComponent(organizationId)}/ai-usage`;
  const read = async <T>(path: string): Promise<T> => {
    const response = await request(path, {});
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new UsageRequestError(
        response.status,
        typeof body.error === 'string' ? body.error : undefined,
      );
    }
    return body as T;
  };
  return {
    summary: (from, to) =>
      read<UsageSummary>(`${base}?${new URLSearchParams({ from, to }).toString()}`),
    async events(cursor) {
      const query = new URLSearchParams({ limit: '50' });
      if (cursor !== undefined) query.set('cursor', cursor);
      const body = await read<{ events?: UsageEvent[]; nextCursor?: string | null }>(
        `${base}/events?${query.toString()}`,
      );
      return { events: body.events ?? [], nextCursor: body.nextCursor ?? null };
    },
  };
}

export type UsagePeriod = 'today' | 'week' | 'month';

/** A period's first and last UTC day: the ledger keeps whole UTC days (ADR-0074). */
export function periodDays(period: UsagePeriod, now: Date): { from: string; to: string } {
  const to = now.toISOString().slice(0, 10);
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
  if (period === 'week') start.setUTCDate(start.getUTCDate() - 6);
  if (period === 'month') start.setUTCDate(1);
  return { from: start.toISOString().slice(0, 10), to };
}

/** Which of an event's attributes a breakdown row stands for, to filter the operations by it. */
export function eventKey(event: UsageEvent, dimension: UsageDimension): string | undefined {
  const a = event.attribution;
  switch (dimension) {
    case 'capability':
      return event.capability;
    case 'provider':
      return event.provider;
    case 'model':
      return `${event.provider}/${event.model}`;
    case 'department':
      return a.departmentId;
    case 'agent':
      return a.specialistId;
    case 'workflow':
      return a.workflowId;
    case 'task_type':
      return a.taskType;
  }
}
