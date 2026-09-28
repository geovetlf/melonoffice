import type { OrganizationId } from '@melonoffice/domain';
import { createHash } from 'node:crypto';
import type { ForecastCovariate, ForecastId, ForecastModelRef } from './model.js';
import type { PreparedSeries } from './series.js';

/** A digest of the exact series: its frequency, first and last period and every value. */
export function seriesDigestOf(series: PreparedSeries): string {
  return createHash('sha256')
    .update(JSON.stringify([series.frequency, series.start, series.end, series.values]))
    .digest('hex');
}

/**
 * The cache key of a forecast (ADR-0059): organization, metric, entity, frequency, horizon, the
 * exact input (its range and values), the covariates and the model's id and version. Any change
 * in the data (a new sale, a new day) changes the digest, so a stale result is never reused; a
 * new model version never answers with the old one's forecasts.
 */
export function forecastIdOf(parts: {
  readonly organizationId: OrganizationId;
  readonly metric: string;
  readonly entity: string;
  readonly horizon: number;
  readonly series: PreparedSeries;
  readonly covariates: readonly ForecastCovariate[];
  readonly model: ForecastModelRef;
}): ForecastId {
  const key = createHash('sha256')
    .update(
      JSON.stringify([
        'forecast',
        parts.organizationId,
        parts.metric,
        parts.entity,
        parts.series.frequency,
        parts.horizon,
        seriesDigestOf(parts.series),
        parts.covariates,
        parts.model.provider,
        parts.model.id,
        parts.model.version,
      ]),
    )
    .digest('hex');
  return `fc_${key.slice(0, 40)}` as ForecastId;
}

/** The credits reference of a forecast's one charge: retries and repeats are charged once. */
export const forecastCreditReferenceOf = (id: ForecastId): string => `forecast:${id}`;
