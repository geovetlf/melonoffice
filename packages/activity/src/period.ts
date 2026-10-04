/**
 * The periods the activity view is read in, in the business's own time zone (ADR-0049): today,
 * this week (Monday first) and this month. The window starts at local midnight and ends now.
 */

export const ACTIVITY_PERIODS = ['today', 'week', 'month'] as const;
export type ActivityPeriod = (typeof ACTIVITY_PERIODS)[number];

export const isActivityPeriod = (value: unknown): value is ActivityPeriod =>
  typeof value === 'string' && (ACTIVITY_PERIODS as readonly string[]).includes(value);

/** An IANA time zone Intl accepts (`UTC` included). */
export function isTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 64) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

interface LocalDate {
  readonly year: number;
  readonly month: number;
  readonly day: number;
}

function partsIn(instant: number, timeZone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour'),
    minute: get('minute'),
    second: get('second'),
  };
}

/** How far the zone's wall clock is ahead of UTC at an instant, in milliseconds. */
function offsetAt(instant: number, timeZone: string): number {
  const p = partsIn(instant, timeZone);
  const wall = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return wall - Math.floor(instant / 1000) * 1000;
}

/** The instant a local calendar day starts in the zone. */
function startOfLocalDay(date: LocalDate, timeZone: string): Date {
  const wall = Date.UTC(date.year, date.month - 1, date.day);
  let instant = wall - offsetAt(wall, timeZone);
  // Once more, for a day that starts on the other side of an offset change.
  instant = wall - offsetAt(instant, timeZone);
  return new Date(instant);
}

export interface PeriodRange {
  readonly from: Date;
  readonly to: Date;
}

export function periodRange(period: ActivityPeriod, timeZone: string, now: Date): PeriodRange {
  const today = partsIn(now.getTime(), timeZone);
  let start: LocalDate = { year: today.year, month: today.month, day: today.day };
  if (period === 'week') {
    // 0 is Sunday; the week starts on Monday.
    const weekday = new Date(Date.UTC(today.year, today.month - 1, today.day)).getUTCDay();
    const back = (weekday + 6) % 7;
    const monday = new Date(Date.UTC(today.year, today.month - 1, today.day - back));
    start = {
      year: monday.getUTCFullYear(),
      month: monday.getUTCMonth() + 1,
      day: monday.getUTCDate(),
    };
  } else if (period === 'month') {
    start = { year: today.year, month: today.month, day: 1 };
  }
  return Object.freeze({ from: startOfLocalDay(start, timeZone), to: now });
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar day `YYYY-MM-DD` that exists, or undefined. */
function localDateOf(value: unknown): LocalDate | undefined {
  if (typeof value !== 'string') return undefined;
  const m = DAY.exec(value);
  if (m === null) return undefined;
  const [year, month, day] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const check = new Date(Date.UTC(year, month - 1, day));
  if (check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1) return undefined;
  if (check.getUTCDate() !== day) return undefined;
  return { year, month, day };
}

const shift = (date: LocalDate, days: number): LocalDate => {
  const d = new Date(Date.UTC(date.year, date.month - 1, date.day + days));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
};

const dayText = (date: LocalDate): string =>
  `${String(date.year).padStart(4, '0')}-${String(date.month).padStart(2, '0')}-${String(date.day).padStart(2, '0')}`;

/** The most days one range of the audit trail spans. */
export const MAX_RANGE_DAYS = 366;

/**
 * The days `from` to `to`, both included, in the business's time zone (the audit trail viewer):
 * from local midnight of `from` to local midnight after `to`, never past this instant. Absent days mean
 * the last 30 days. Undefined when a day is not one, `from` is after `to`, or the range is longer
 * than `MAX_RANGE_DAYS`.
 */
export function dayRange(
  input: { readonly from?: unknown; readonly to?: unknown },
  timeZone: string,
  now: Date,
): (PeriodRange & { readonly fromDay: string; readonly toDay: string }) | undefined {
  const today = partsIn(now.getTime(), timeZone);
  const todayDate: LocalDate = { year: today.year, month: today.month, day: today.day };
  const to = input.to === undefined ? todayDate : localDateOf(input.to);
  if (to === undefined) return undefined;
  const from = input.from === undefined ? shift(to, -29) : localDateOf(input.from);
  if (from === undefined) return undefined;
  const span =
    (Date.UTC(to.year, to.month - 1, to.day) - Date.UTC(from.year, from.month - 1, from.day)) /
    86_400_000;
  if (span < 0 || span >= MAX_RANGE_DAYS) return undefined;
  const end = startOfLocalDay(shift(to, 1), timeZone);
  return Object.freeze({
    from: startOfLocalDay(from, timeZone),
    // Exclusive: one millisecond past now, so what happened this very instant is in.
    to: end.getTime() > now.getTime() ? new Date(now.getTime() + 1) : end,
    fromDay: dayText(from),
    toDay: dayText(to),
  });
}
