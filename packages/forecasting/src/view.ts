import type { ForecastOutcome } from './engine.js';
import type { Forecast } from './model.js';
import { addPeriods } from './periods.js';

/**
 * A forecast as the screens and GIA receive it (ADR-0059). History and forecast are separate
 * lists, never one line: `history` is what happened, `forecast` what the model projects, with
 * its band. There is no confidence figure, because the model gives none (`confidence: null`).
 */
export function forecastViewOf(f: Forecast, cache: 'hit' | 'miss' | null = null) {
  const history = f.input.values.map((value, i) => ({
    period: addPeriods(f.input.start, i, f.frequency),
    value,
  }));
  return {
    id: f.id,
    status: f.status,
    metric: f.metric,
    entity: f.entity,
    frequency: f.frequency,
    horizon: f.horizon,
    unit: f.unit,
    currency: f.unit === 'currency' ? f.entity : null,
    timeZone: f.timeZone,
    department: f.department ?? null,
    history,
    inputPeriod: { start: f.input.start, end: f.input.end, points: f.input.values.length },
    forecast: f.result?.predictions ?? [],
    interval:
      f.result === undefined ? null : { low: 'quantile_0.1', high: 'quantile_0.9' as const },
    confidence: null,
    model: f.result?.model ?? null,
    generatedAt: f.result?.generatedAt ?? null,
    dataQuality: f.dataQuality,
    warnings: f.warnings,
    failure: f.failure ?? null,
    creditsCharged: f.creditsCharged,
    cache,
    createdAt: f.createdAt,
    updatedAt: f.updatedAt,
  };
}

export type ForecastView = ReturnType<typeof forecastViewOf>;

/** An outcome as the API answers it. */
export function forecastOutcomeView(outcome: ForecastOutcome) {
  if (!('forecast' in outcome)) {
    return {
      status: outcome.status,
      metric: outcome.metric,
      entity: outcome.entity,
      frequency: outcome.frequency,
      horizon: outcome.horizon,
      problem: outcome.problem,
      have: outcome.have ?? null,
      need: outcome.need ?? null,
      dataQuality: outcome.dataQuality ?? null,
      forecast: [],
      confidence: null,
    };
  }
  return forecastViewOf(outcome.forecast, outcome.cache);
}
