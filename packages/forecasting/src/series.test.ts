import { describe, expect, it } from 'vitest';
import { FORECAST_LIMITS } from './catalogue.js';
import {
  addPeriods,
  isPeriodStart,
  lastCompletePeriod,
  localDateOf,
  periodOf,
  periodsBetween,
} from './periods.js';
import { prepareSeries, type SeriesPoint } from './series.js';

const METRIC = { absentPeriod: 'zero', nonNegative: true } as const;

/** `n` consecutive days from `start`, with the given values (cycled). */
function days(start: string, n: number, values: readonly (number | null)[] = [5, 7, 3]) {
  return Array.from({ length: n }, (_, i) => ({
    timestamp: addPeriods(start, i, 'day'),
    value: values[i % values.length] as number | null,
  }));
}

const prepare = (raw: unknown, frequency: 'day' | 'week' | 'month' = 'day', end?: string) =>
  prepareSeries(raw, {
    metric: METRIC,
    frequency,
    ...(end === undefined ? {} : { end }),
    limits: FORECAST_LIMITS,
  });

describe('3. a valid series', () => {
  it('is kept as consecutive periods with their values and a clean data quality', () => {
    const result = prepare(days('2026-08-01', 40));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.series.start).toBe('2026-08-01');
    expect(result.series.end).toBe('2026-09-09');
    expect(result.series.values).toHaveLength(40);
    expect(result.quality).toMatchObject({
      received: 40,
      points: 40,
      absentPeriods: 0,
      nullValues: 0,
      transformations: [],
      inputFrequency: 'day',
      normalizedFrequency: 'day',
    });
  });
});

describe('4. insufficient data', () => {
  it('says how many periods there are and how many are needed, and never pads', () => {
    const result = prepare(days('2026-09-01', 10));
    expect(result).toMatchObject({
      ok: false,
      problem: 'insufficient_data',
      have: 10,
      need: 28,
      shortOf: 'periods',
    });
  });

  it('refuses a series that is mostly empty (fewer than 5 non-zero periods)', () => {
    const raw = [...days('2026-08-01', 3), { timestamp: '2026-09-15', value: 0 }];
    const result = prepare(raw);
    expect(result).toMatchObject({
      ok: false,
      problem: 'insufficient_data',
      need: 5,
      shortOf: 'active_periods',
    });
  });

  it('refuses an empty series', () => {
    expect(prepare([])).toMatchObject({
      ok: false,
      problem: 'insufficient_data',
      have: 0,
      shortOf: 'periods',
    });
  });
});

describe('5. invalid timestamps', () => {
  it.each(['2026-02-30', '2026-9-01', '28/09/2026', '', 20260901, null])(
    'refuses %s',
    (timestamp) => {
      const raw = [...days('2026-08-01', 30), { timestamp, value: 1 }];
      expect(prepare(raw)).toMatchObject({ ok: false, problem: 'invalid_timestamp' });
    },
  );
});

describe('6. duplicate timestamps', () => {
  it('refuses a period given twice instead of adding or picking one', () => {
    const raw = [...days('2026-08-01', 30), { timestamp: '2026-08-05', value: 9 }];
    expect(prepare(raw)).toMatchObject({ ok: false, problem: 'duplicate_timestamp' });
  });
});

describe('7. missing values', () => {
  it('treats a period with no record as zero for an event metric, and records it', () => {
    const raw = days('2026-08-01', 40).filter((p) => p.timestamp !== '2026-08-10');
    const result = prepare(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.series.values[9]).toBe(0);
    expect(result.quality.absentPeriods).toBe(1);
    expect(result.quality.transformations).toContain('absent_periods_as_zero');
  });

  it('interpolates a few unknown (null) values between their neighbours, and records it', () => {
    const raw: SeriesPoint[] = days('2026-08-01', 40, [10]);
    raw[20] = { timestamp: raw[20]?.timestamp as string, value: null };
    raw[19] = { timestamp: raw[19]?.timestamp as string, value: 4 };
    raw[21] = { timestamp: raw[21]?.timestamp as string, value: 8 };
    const result = prepare(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.series.values[20]).toBe(6);
    expect(result.quality.nullValues).toBe(1);
    expect(result.quality.transformations).toContain('null_values_interpolated');
  });

  it('refuses too many unknown values, a long run of them, or one at an edge', () => {
    const many = days('2026-08-01', 40, [5, null, 5, 5, 5]);
    expect(prepare(many)).toMatchObject({ ok: false, problem: 'missing_values' });
    const run = days('2026-08-01', 60, [5]).map((p, i) =>
      i >= 20 && i < 24 ? { ...p, value: null } : p,
    );
    expect(prepare(run)).toMatchObject({ ok: false, problem: 'missing_values' });
    const edge = days('2026-08-01', 40, [5]).map((p, i) => (i === 0 ? { ...p, value: null } : p));
    expect(prepare(edge)).toMatchObject({ ok: false, problem: 'missing_values' });
  });
});

describe('8. irregular frequency', () => {
  it('refuses a weekly series with a point that is not a Monday: no silent conversion', () => {
    const weeks = Array.from({ length: 14 }, (_, i) => ({
      timestamp: addPeriods('2026-06-01', i, 'week'),
      value: 3,
    }));
    expect(prepare(weeks, 'week').ok).toBe(true);
    expect(prepare([...weeks, { timestamp: '2026-09-09', value: 1 }], 'week')).toMatchObject({
      ok: false,
      problem: 'irregular_frequency',
    });
  });

  it('refuses a daily series asked for as monthly', () => {
    expect(prepare(days('2026-08-01', 40), 'month')).toMatchObject({
      ok: false,
      problem: 'irregular_frequency',
    });
  });
});

describe('9. valid frequencies and periods', () => {
  it('names a week by its Monday and a month by its first day', () => {
    expect(periodOf('2026-09-27', 'week')).toBe('2026-09-21');
    expect(periodOf('2026-09-28', 'week')).toBe('2026-09-28');
    expect(periodOf('2026-09-28', 'month')).toBe('2026-09-01');
    expect(isPeriodStart('2026-09-28', 'week')).toBe(true);
    expect(isPeriodStart('2026-09-02', 'month')).toBe(false);
    expect(addPeriods('2026-01-31', 1, 'day')).toBe('2026-02-01');
    expect(addPeriods('2026-12-01', 1, 'month')).toBe('2027-01-01');
    expect(periodsBetween('2026-01-01', '2027-03-01', 'month')).toBe(14);
  });

  it('reads the local date in the business time zone and leaves the current period out', () => {
    // 03:30Z on the 28th is still the 27th in Lima.
    const at = new Date('2026-09-28T03:30:00Z');
    expect(localDateOf(at, 'America/Lima')).toBe('2026-09-27');
    expect(lastCompletePeriod(at, 'America/Lima', 'day')).toBe('2026-09-26');
    expect(lastCompletePeriod(at, 'UTC', 'day')).toBe('2026-09-27');
    expect(lastCompletePeriod(at, 'America/Lima', 'month')).toBe('2026-08-01');
  });

  it('prepares monthly series', () => {
    const months = Array.from({ length: 13 }, (_, i) => ({
      timestamp: addPeriods('2025-08-01', i, 'month'),
      value: 100 + i,
    }));
    const result = prepare(months, 'month');
    expect(result.ok && result.series.end).toBe('2026-08-01');
  });
});

describe('outliers and limits', () => {
  it('flags an unusual value and keeps it: a peak can be real', () => {
    const raw = days('2026-08-01', 40, [10, 11, 9, 10]);
    raw[30] = { timestamp: raw[30]?.timestamp as string, value: 500 };
    const result = prepare(raw);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.series.values[30]).toBe(500);
    expect(result.quality.outliers).toEqual([{ period: raw[30]?.timestamp, value: 500 }]);
  });

  it('keeps only the last maxContext periods, and records it', () => {
    const result = prepareSeries(days('2023-01-01', 1100), {
      metric: METRIC,
      frequency: 'day',
      limits: FORECAST_LIMITS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.series.values).toHaveLength(1024);
    expect(result.quality.transformations).toContain('truncated_to_context');
  });

  it('refuses negative, infinite and non-numeric values', () => {
    for (const value of [-1, Infinity, Number.NaN, '5']) {
      const raw = [...days('2026-08-01', 30), { timestamp: '2026-09-15', value }];
      expect(prepare(raw)).toMatchObject({ ok: false, problem: 'invalid_value' });
    }
  });
});

describe('27. malformed input', () => {
  it.each([undefined, 'series', { a: 1 }, [1, 2, 3], [{ timestamp: '2026-09-01' }]])(
    'refuses %j as a series',
    (raw) => {
      expect(prepare(raw)).toMatchObject({ ok: false, problem: 'invalid_series' });
    },
  );
});
