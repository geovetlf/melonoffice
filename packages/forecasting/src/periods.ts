/**
 * Periods of a time series (ADR-0059). A period is named by the local date it starts on, in the
 * business's time zone: a day by its date, a week by its Monday, a month by its first day. Every
 * series point uses that name as its timestamp, so two sources, the model and the screens agree
 * on which period a value belongs to. Hourly series are not supported: the business records that
 * exist today are too sparse for them.
 */
export const FORECAST_FREQUENCIES = ['day', 'week', 'month'] as const;
export type ForecastFrequency = (typeof FORECAST_FREQUENCIES)[number];

export const isForecastFrequency = (value: unknown): value is ForecastFrequency =>
  typeof value === 'string' && (FORECAST_FREQUENCIES as readonly string[]).includes(value);

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whether a value is a real calendar date written `YYYY-MM-DD`. */
export function isPeriodDate(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const match = DATE.exec(value);
  if (match === null) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

const toDate = (period: string) => new Date(`${period}T00:00:00Z`);
const toKey = (date: Date) => date.toISOString().slice(0, 10);

/** Whether a date is the start of a period of this frequency (a Monday, a first of month). */
export function isPeriodStart(period: string, frequency: ForecastFrequency): boolean {
  if (!isPeriodDate(period)) return false;
  if (frequency === 'day') return true;
  const date = toDate(period);
  return frequency === 'week' ? date.getUTCDay() === 1 : date.getUTCDate() === 1;
}

/** The period a local date falls in. */
export function periodOf(localDate: string, frequency: ForecastFrequency): string {
  const date = toDate(localDate);
  if (frequency === 'week') {
    const back = (date.getUTCDay() + 6) % 7;
    date.setUTCDate(date.getUTCDate() - back);
  } else if (frequency === 'month') {
    date.setUTCDate(1);
  }
  return toKey(date);
}

/** The period `n` periods after (or, negative, before) a period start. */
export function addPeriods(period: string, n: number, frequency: ForecastFrequency): string {
  const date = toDate(period);
  if (frequency === 'day') date.setUTCDate(date.getUTCDate() + n);
  else if (frequency === 'week') date.setUTCDate(date.getUTCDate() + 7 * n);
  else date.setUTCMonth(date.getUTCMonth() + n);
  return toKey(date);
}

/** How many periods from `from` to `to` (both period starts); negative when `to` is earlier. */
export function periodsBetween(from: string, to: string, frequency: ForecastFrequency): number {
  const a = toDate(from);
  const b = toDate(to);
  if (frequency === 'month') {
    return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
  }
  const days = Math.round((b.getTime() - a.getTime()) / 86_400_000);
  return frequency === 'day' ? days : Math.floor(days / 7);
}

/** The local date of an instant in a time zone (`YYYY-MM-DD`). */
export function localDateOf(instant: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(instant);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

/** Whether a time zone is one the runtime knows (IANA name). */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value === '') return false;
  try {
    new Intl.DateTimeFormat('en', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

/**
 * The last period that is over at `now` in the business's time zone. The current period is still
 * filling, so it is never part of a series: a half day of sales is not a low day of sales.
 */
export function lastCompletePeriod(
  now: Date,
  timeZone: string,
  frequency: ForecastFrequency,
): string {
  return addPeriods(periodOf(localDateOf(now, timeZone), frequency), -1, frequency);
}
