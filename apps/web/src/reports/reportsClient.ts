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

/** One projected period: the expected value and the range it likely falls in (10%…90%). */
export interface ProjectedPoint {
  readonly period: string;
  readonly value: number;
  readonly low: number;
  readonly high: number;
}

/**
 * A projection the Forecasting Engine made from the recorded history (ADR-0059), or why it made
 * none. The screen only shows it; the engine decides, charges and keeps it.
 */
export type ProjectionView =
  | {
      readonly status: 'completed';
      readonly points: readonly ProjectedPoint[];
      /** The forecasting model, or the engine's simple fallback when the model could not run. */
      readonly model: 'model' | 'fallback';
      readonly creditsCharged: number;
    }
  | { readonly status: 'pending' }
  | {
      readonly status: 'not_possible';
      readonly problem: string;
      readonly have: number | null;
      readonly need: number | null;
    };

export interface ReportsClient {
  metrics(): Promise<readonly MetricView[]>;
  history(
    metric: string,
    input: { readonly frequency: ReportFrequency; readonly periods?: number },
  ): Promise<MetricHistoryView>;
  /** "Project this" (ADR-0139): a forecast of the next `horizon` periods, through the engine. */
  project(
    metric: string,
    input: {
      readonly frequency: ReportFrequency;
      readonly entity: string;
      readonly horizon: number;
    },
  ): Promise<ProjectionView>;
}

const isNumber = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

/** The engine's answer as the screen reads it; anything else is not a projection. */
export function projectionOf(body: Record<string, unknown>): ProjectionView {
  if (body.status === 'queued' || body.status === 'running') return { status: 'pending' };
  if (body.status === 'completed' && Array.isArray(body.forecast)) {
    const points = (body.forecast as unknown[]).flatMap((raw) => {
      const p = raw as Record<string, unknown> | null;
      return p !== null &&
        typeof p.period === 'string' &&
        isNumber(p.value) &&
        isNumber(p.low) &&
        isNumber(p.high)
        ? [{ period: p.period, value: p.value, low: p.low, high: p.high }]
        : [];
    });
    if (points.length > 0) {
      return {
        status: 'completed',
        points,
        model: body.model === 'model' ? 'model' : 'fallback',
        creditsCharged: isNumber(body.creditsCharged) ? body.creditsCharged : 0,
      };
    }
  }
  return {
    status: 'not_possible',
    problem: typeof body.problem === 'string' ? body.problem : 'unavailable',
    have: isNumber(body.have) ? body.have : null,
    need: isNumber(body.need) ? body.need : null,
  };
}

export function createReportsClient(request: ReplyRequest, organizationId: string): ReportsClient {
  const base = `/v1/organizations/${encodeURIComponent(organizationId)}/metrics`;
  const read = async (path: string, init: RequestInit = {}): Promise<unknown> => {
    const response = await request(path, init);
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
    async project(metric, { frequency, entity, horizon }) {
      const path = `/v1/organizations/${encodeURIComponent(organizationId)}/forecasts`;
      const body = await read(path, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        // Waits a bounded time for the run; a run still going answers `pending`.
        body: JSON.stringify({ metric, frequency, entity, horizon, wait: true }),
      });
      return projectionOf(body as Record<string, unknown>);
    },
  };
}
