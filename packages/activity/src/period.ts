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
