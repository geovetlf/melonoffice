import type { ReplyRequest } from '../conversations/sendReply.js';

/**
 * Reports through the API (ADR-0060): what was recorded for each metric, per day, week or month.
 * The screen shows exactly what the API added up from the organization's records; it never
 * calculates a projection, and it never fills in a period the API did not return.
 */

export type ReportFrequency = 'day' | 'week' | 'month';

export interface MetricView {
  readonly id: string;
  readonly unit: 'currency' | 'count';
  readonly frequencies: readonly ReportFrequency[];
  /** The department types (catalogue ids) the metric serves. */
  readonly departments: readonly string[];
  readonly readable: boolean;
}

export interface MetricPoint {
  readonly period: string;
  readonly value: number;
}

export type MetricReadiness =
  | { readonly ready: true; readonly have: number; readonly need: number }
  | {
      readonly ready: false;
      readonly problem: string;
      readonly have: number | null;
      readonly need: number | null;
      readonly shortOf: 'periods' | 'active_periods' | null;
    };

export interface MetricHistoryView {
  readonly metric: string;
  readonly unit: 'currency' | 'count';
  readonly entity: string;
  readonly frequency: ReportFrequency;
  readonly timeZone: string;
  readonly from: string;
  readonly to: string;
  readonly points: readonly MetricPoint[];
  readonly total: number;
  readonly average: number;
  readonly previousTotal: number | null;
  readonly current: MetricPoint;
  readonly firstRecord: string | null;
  readonly readiness: MetricReadiness;
}

export class ReportRequestError extends Error {
  override readonly name = 'ReportRequestError';
  constructor(
    readonly status: number,
    readonly code?: string,
    readonly field?: string,
  ) {
    super(`report request failed: ${status}${code === undefined ? '' : ` ${code}`}`);
  }
}

export interface ReportsClient {
  metrics(): Promise<readonly MetricView[]>;
  history(
    metric: string,
    input: { readonly frequency: ReportFrequency; readonly periods?: number },
  ): Promise<MetricHistoryView>;
}

export function createReportsClient(request: ReplyRequest, organizationId: string): ReportsClient {
  const base = `/v1/organizations/${encodeURIComponent(organizationId)}/metrics`;
  const read = async (path: string): Promise<unknown> => {
    const response = await request(path, {});
    const body = (await response.json().catch(() => ({}))) as Record<string, unknown>;
    if (!response.ok) {
      throw new ReportRequestError(
        response.status,
        typeof body.error === 'string' ? body.error : undefined,
        typeof body.field === 'string' ? body.field : undefined,
      );
    }
    return body;
  };
  return {
    async metrics() {
      const body = (await read(base)) as { metrics?: readonly MetricView[] };
      return body.metrics ?? [];
    },
    async history(metric, { frequency, periods }) {
      const query = new URLSearchParams({ frequency });
      if (periods !== undefined) query.set('periods', String(periods));
      return (await read(
        `${base}/${encodeURIComponent(metric)}?${query.toString()}`,
      )) as MetricHistoryView;
    },
  };
}
