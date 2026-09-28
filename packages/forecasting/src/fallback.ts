import type { ForecastModelRef } from './model.js';
import type { ForecastModelInput, ForecastModelOutput, ForecastModelProvider } from './provider.js';

/**
 * The fallback (ADR-0059): a simple, deterministic statistical method, used only when the model
 * failed on its last attempt. It is not a second AI: a seasonal mean, with the spread of its own
 * past errors as the band. Every result it produces says `kind: 'fallback'`.
 */
export const FALLBACK_MODEL: ForecastModelRef = Object.freeze({
  provider: 'melonoffice',
  id: 'fallback',
  version: 'seasonal_mean_v1',
  kind: 'fallback',
});

const SEASONS = 4;
const FLAT_WINDOW = 8;
const BACKTEST = 60;
const LEVELS = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9] as const;

/** The season length a frequency has, when the history covers two of them. */
function seasonOf(input: ForecastModelInput): number | undefined {
  const season = input.frequency === 'day' ? 7 : input.frequency === 'month' ? 12 : undefined;
  return season !== undefined && input.values.length >= 2 * season ? season : undefined;
}

/** The value predicted for the period at `index` from the values before `until`. */
function predictAt(values: readonly number[], until: number, index: number, season?: number) {
  if (season !== undefined) {
    const same: number[] = [];
    for (let i = index - season; i >= 0 && same.length < SEASONS; i -= season) {
      if (i < until) same.push(values[i] as number);
    }
    if (same.length > 0) return same.reduce((a, b) => a + b, 0) / same.length;
  }
  const window = values.slice(Math.max(0, until - FLAT_WINDOW), until);
  return window.reduce((a, b) => a + b, 0) / Math.max(1, window.length);
}

function quantile(sorted: readonly number[], q: number): number {
  if (sorted.length === 0) return 0;
  const at = (sorted.length - 1) * q;
  const lo = Math.floor(at);
  const hi = Math.ceil(at);
  return (sorted[lo] as number) + ((sorted[hi] as number) - (sorted[lo] as number)) * (at - lo);
}

export function createFallbackProvider(options: { readonly nonNegative?: boolean } = {}) {
  const provider: ForecastModelProvider = Object.freeze({
    model: FALLBACK_MODEL,
    forecast(input: ForecastModelInput): Promise<ForecastModelOutput> {
      const { values, horizon } = input;
      const season = seasonOf(input);
      // Its own one-step errors over the recent past: the band says how wrong it has been.
      const errors: number[] = [];
      const from = Math.max(season ?? 1, values.length - BACKTEST);
      for (let t = from; t < values.length; t++) {
        errors.push((values[t] as number) - predictAt(values, t, t, season));
      }
      errors.sort((a, b) => a - b);
      const floor = options.nonNegative === false ? -Infinity : 0;
      const point: number[] = [];
      const quantiles: number[][] = [];
      for (let h = 0; h < horizon; h++) {
        const index = values.length + h;
        const value = predictAt(values, values.length, index, season);
        point.push(Math.max(floor, value));
        quantiles.push(LEVELS.map((q) => Math.max(floor, value + quantile(errors, q))));
      }
      return Promise.resolve({ point, quantiles });
    },
  });
  return provider;
}
