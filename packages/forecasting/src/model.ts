import type { IsoTimestamp, OrganizationId, UserId } from '@melonoffice/domain';
import type { ForecastFrequency } from './periods.js';
import type { DataQuality } from './series.js';

/** A forecast's id: `fc_` and 40 hex characters of its cache key, so the same request is one. */
export type ForecastId = string & { readonly __brand: 'ForecastId' };

const FORECAST_ID = /^fc_[0-9a-f]{40}$/;
export const isForecastId = (value: unknown): value is ForecastId =>
  typeof value === 'string' && FORECAST_ID.test(value);

/**
 * `queued` → `running` → `completed` or `failed`. A failed one is queued again by the next
 * identical request. There is no stored `insufficient_data`: such a request never runs.
 */
export type ForecastStatus = 'queued' | 'running' | 'completed' | 'failed';

/**
 * The model that produced a result. `kind: 'fallback'` is the deterministic statistical method
 * MelonOffice uses only when the model failed on its last attempt; it is always shown as such.
 */
export interface ForecastModelRef {
  readonly provider: string;
  readonly id: string;
  readonly version: string;
  readonly kind: 'model' | 'fallback';
}

/**
 * One predicted period. `value` is the model's median (its 0.5 quantile). `low` and `high` are
 * its 0.1 and 0.9 quantiles: the model's own uncertainty band, not a probability that the
 * forecast is right. There is no confidence figure because the model does not give one.
 */
export interface ForecastPrediction {
  readonly period: string;
  readonly value: number;
  readonly low: number;
  readonly high: number;
}

export interface ForecastResult {
  readonly model: ForecastModelRef;
  readonly predictions: readonly ForecastPrediction[];
  /** The 0.1…0.9 quantiles per predicted period, as the model gave them. */
  readonly quantiles: readonly (readonly number[])[];
  readonly generatedAt: IsoTimestamp;
  /** What the run cost and took. No business data. */
  readonly usage: {
    readonly inferenceMs?: number;
    readonly durationMs: number;
    readonly memoryMb?: number;
  };
}

/**
 * A covariate: an extra series the model may use (price, promotions, holidays). The contract
 * exists so callers and the cache key are ready; the runtime supports none yet (ADR-0059).
 */
export interface ForecastCovariate {
  readonly name: string;
  readonly kind: 'numeric' | 'categorical';
  readonly values: readonly (number | string)[];
}

export interface Forecast {
  readonly id: ForecastId;
  readonly organizationId: OrganizationId;
  readonly metric: string;
  /** What the series is narrowed to (a currency, a source kind, a channel) or `all`. */
  readonly entity: string;
  readonly frequency: ForecastFrequency;
  readonly horizon: number;
  readonly unit: 'currency' | 'count';
  /** The business's time zone the periods were read in. */
  readonly timeZone: string;
  /** Who asked and for which department (a catalogue type), for audit and observability. */
  readonly requestedBy: UserId;
  readonly department?: string;
  /** The exact series the model received: periods `start`…`end`, one value each. */
  readonly input: {
    readonly start: string;
    readonly end: string;
    readonly values: readonly number[];
    readonly digest: string;
  };
  readonly covariates: readonly ForecastCovariate[];
  readonly dataQuality: DataQuality;
  readonly warnings: readonly string[];
  readonly status: ForecastStatus;
  /**
   * Which queuing this is: it grows each time the forecast is queued again, and the task carries
   * it, so a task of an earlier queuing does nothing.
   */
  readonly run: number;
  /** Deliveries of the current run that reached the model. */
  readonly attempts: number;
  readonly result?: ForecastResult;
  readonly failure?: string;
  /** The credits reference of the one charge of this forecast, once charged. */
  readonly creditReference?: string;
  readonly creditsCharged: number;
  readonly revision: number;
  readonly createdAt: IsoTimestamp;
  readonly updatedAt: IsoTimestamp;
  readonly queuedAt: IsoTimestamp;
  readonly completedAt?: IsoTimestamp;
  /** After this a finished forecast no longer answers a request; one is made again. */
  readonly expiresAt: IsoTimestamp;
}

/** The task the queue delivers to the worker: codes only. */
export interface ForecastTask {
  readonly organizationId: OrganizationId;
  readonly forecastId: ForecastId;
  readonly run: number;
}
