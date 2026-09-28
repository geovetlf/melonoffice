import type { ForecastLimits, ForecastMetric } from './catalogue.js';
import {
  addPeriods,
  isPeriodDate,
  isPeriodStart,
  periodsBetween,
  type ForecastFrequency,
} from './periods.js';

/** One raw point from a source: the period it belongs to and its value (null: unknown). */
export interface SeriesPoint {
  readonly timestamp: string;
  readonly value: number | null;
}

/** A series ready for the model: consecutive periods, one finite value each. */
export interface PreparedSeries {
  readonly frequency: ForecastFrequency;
  /** The first and last period sent to the model. */
  readonly start: string;
  readonly end: string;
  readonly values: readonly number[];
}

/**
 * What was found in the data and what was done to it, so every forecast says what it rests on.
 * Nothing here is ever hidden from the result.
 */
export interface DataQuality {
  /** Points the source gave. */
  readonly received: number;
  /** Periods sent to the model. */
  readonly points: number;
  readonly nonZero: number;
  /** Periods with no record, and what the metric says they mean. */
  readonly absentPeriods: number;
  readonly nullValues: number;
  /**
   * Unusual values (robust z-score over 5, from the median and MAD). Flagged, never removed: a
   * sales peak can be real.
   */
  readonly outliers: readonly { readonly period: string; readonly value: number }[];
  /**
   * Each change made to the data, as a code: `absent_periods_as_zero`,
   * `null_values_interpolated`, `truncated_to_context`.
   */
  readonly transformations: readonly string[];
  readonly inputFrequency: ForecastFrequency;
  readonly normalizedFrequency: ForecastFrequency;
}

/** Why a series cannot be forecast. None of these runs the model or costs credits. */
export type SeriesProblem =
  | 'invalid_series'
  | 'invalid_timestamp'
  | 'duplicate_timestamp'
  | 'irregular_frequency'
  | 'invalid_value'
  | 'missing_values'
  | 'insufficient_data';

export type SeriesResult =
  | { readonly ok: true; readonly series: PreparedSeries; readonly quality: DataQuality }
  | {
      readonly ok: false;
      readonly problem: SeriesProblem;
      /** For `insufficient_data`: how many periods there are and how many are needed. */
      readonly have?: number;
      readonly need?: number;
      readonly quality?: DataQuality;
    };

const MAX_OUTLIERS = 10;
const OUTLIER_Z = 5;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

function median(values: readonly number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function outliersOf(
  periods: readonly string[],
  values: readonly number[],
): DataQuality['outliers'] {
  const m = median(values);
  const mad = median(values.map((v) => Math.abs(v - m)));
  if (mad === 0) return [];
  const found: { period: string; value: number }[] = [];
  values.forEach((value, i) => {
    // 0.6745 makes the MAD comparable to a standard deviation for normal data.
    if ((0.6745 * Math.abs(value - m)) / mad > OUTLIER_Z) {
      found.push({ period: periods[i] as string, value });
    }
  });
  return Object.freeze(found.slice(0, MAX_OUTLIERS).map((o) => Object.freeze(o)));
}

const MAX_NULL_SHARE = 0.1;
const MAX_NULL_RUN = 3;

/**
 * Fills unknown values (NaN) linearly between their known neighbours, in place. Refuses (false)
 * when there are too many, a run is too long, or one is at an edge with no neighbour.
 */
function interpolate(values: number[], nulls: number): boolean {
  if (nulls / values.length > MAX_NULL_SHARE) return false;
  let i = 0;
  while (i < values.length) {
    if (!Number.isNaN(values[i])) {
      i += 1;
      continue;
    }
    let j = i;
    while (j < values.length && Number.isNaN(values[j])) j += 1;
    if (i === 0 || j === values.length || j - i > MAX_NULL_RUN) return false;
    const before = values[i - 1] as number;
    const after = values[j] as number;
    for (let k = i; k < j; k++) {
      values[k] = before + ((after - before) * (k - i + 1)) / (j - i + 1);
    }
    i = j;
  }
  return true;
}

/**
 * Checks and prepares a series (ADR-0059). In order:
 *
 * 1. shape: an array of `{ timestamp, value }` (`invalid_series`);
 * 2. every timestamp a real date (`invalid_timestamp`) at the start of a period of the requested
 *    frequency (`irregular_frequency`): a series of another frequency is refused, never
 *    converted without an explicit strategy;
 * 3. no period twice (`duplicate_timestamp`) and every value finite, and not negative for a
 *    non-negative metric (`invalid_value`);
 * 4. absent periods, from the first point to `end`, follow the metric's declared meaning
 *    (`absentPeriod: zero`: the metric sums events, so a period without any had zero). A null
 *    value is different: it is unknown. A few (at most 10% of the periods, at most 3 in a row) are
 *    interpolated linearly between their neighbours; more is `missing_values`. Both changes are
 *    recorded, and nothing else is filled in;
 * 5. only the last `maxContext` periods are kept (recorded);
 * 6. at least `minHistory` periods and `minNonZero` non-zero values, or `insufficient_data`;
 * 7. unusual values are flagged and kept.
 */
export function prepareSeries(
  raw: unknown,
  options: {
    readonly metric: Pick<ForecastMetric, 'absentPeriod' | 'nonNegative'>;
    readonly frequency: ForecastFrequency;
    /** The last period of the series (the last complete one); the first point when absent. */
    readonly end?: string;
    readonly limits: Pick<ForecastLimits, 'maxContext' | 'minHistory' | 'minNonZero'>;
  },
): SeriesResult {
  const { metric, frequency, limits } = options;
  if (!Array.isArray(raw)) return { ok: false, problem: 'invalid_series' };
  const byPeriod = new Map<string, number | null>();
  for (const point of raw as unknown[]) {
    if (!isRecord(point) || !('timestamp' in point) || !('value' in point)) {
      return { ok: false, problem: 'invalid_series' };
    }
    const { timestamp, value } = point;
    if (!isPeriodDate(timestamp)) return { ok: false, problem: 'invalid_timestamp' };
    if (!isPeriodStart(timestamp, frequency)) return { ok: false, problem: 'irregular_frequency' };
    if (byPeriod.has(timestamp)) return { ok: false, problem: 'duplicate_timestamp' };
    if (value !== null) {
      if (typeof value !== 'number' || !Number.isFinite(value)) {
        return { ok: false, problem: 'invalid_value' };
      }
      if (metric.nonNegative && value < 0) return { ok: false, problem: 'invalid_value' };
    }
    byPeriod.set(timestamp, value as number | null);
  }
  const received = byPeriod.size;
  const sorted = [...byPeriod.keys()].sort();
  if (options.end !== undefined && !isPeriodStart(options.end, frequency)) {
    return { ok: false, problem: 'irregular_frequency' };
  }
  const first = sorted[0];
  const end = options.end ?? sorted.at(-1);
  if (first === undefined || end === undefined || first > end) {
    return { ok: false, problem: 'insufficient_data', have: 0, need: limits.minHistory[frequency] };
  }

  const length = periodsBetween(first, end, frequency) + 1;
  const periods: string[] = [];
  const values: number[] = [];
  let absent = 0;
  let nulls = 0;
  for (let i = 0; i < length; i++) {
    const period = addPeriods(first, i, frequency);
    periods.push(period);
    const value = byPeriod.get(period);
    if (value === undefined) {
      // The metric's declared meaning of a period with no record (step 4).
      absent += 1;
      values.push(0);
    } else if (value === null) {
      nulls += 1;
      values.push(Number.NaN);
    } else {
      values.push(value);
    }
  }
  const transformations: string[] = [];
  if (absent > 0) transformations.push('absent_periods_as_zero');
  if (nulls > 0) {
    if (!interpolate(values, nulls)) return { ok: false, problem: 'missing_values' };
    transformations.push('null_values_interpolated');
  }
  let kept = periods;
  let keptValues = values;
  if (periods.length > limits.maxContext) {
    kept = periods.slice(-limits.maxContext);
    keptValues = values.slice(-limits.maxContext);
    transformations.push('truncated_to_context');
  }
  const nonZero = keptValues.filter((v) => v !== 0).length;
  const quality: DataQuality = Object.freeze({
    received,
    points: keptValues.length,
    nonZero,
    absentPeriods: absent,
    nullValues: nulls,
    outliers: outliersOf(kept, keptValues),
    transformations: Object.freeze(transformations),
    inputFrequency: frequency,
    normalizedFrequency: frequency,
  });
  const need = limits.minHistory[frequency];
  if (keptValues.length < need) {
    return { ok: false, problem: 'insufficient_data', have: keptValues.length, need, quality };
  }
  if (nonZero < limits.minNonZero) {
    return {
      ok: false,
      problem: 'insufficient_data',
      have: nonZero,
      need: limits.minNonZero,
      quality,
    };
  }
  return {
    ok: true,
    series: Object.freeze({
      frequency,
      start: kept[0] as string,
      end: kept.at(-1) as string,
      values: Object.freeze(keptValues),
    }),
    quality,
  };
}
