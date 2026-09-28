/**
 * Dates and times of follow-ups (C5, ADR-0058), in the business's time zone. "Tomorrow at 10" in
 * Lima is 10:00 America/Lima, whatever the server's clock or the person's browser says. Relative
 * dates ("mañana", "el viernes", "en 3 días") are resolved by fixed rules here, never by a model;
 * a time is only ever read from what the person wrote, never assumed.
 */

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;

export const isLocalDate = (value: unknown): value is string => {
  if (typeof value !== 'string') return false;
  const m = DATE.exec(value);
  if (m === null) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
};

export const isLocalTime = (value: unknown): value is string =>
  typeof value === 'string' && TIME.test(value);

/** The local date and time of an instant in a time zone: `YYYY-MM-DD` and `HH:MM`. */
export function localDateTime(
  at: Date | string,
  timeZone: string,
): { readonly date: string; readonly time: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(typeof at === 'string' ? new Date(at) : at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return {
    date: `${get('year')}-${get('month')}-${get('day')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

/** Minutes the zone is ahead of UTC at an instant. */
function offsetMinutes(at: number, timeZone: string): number {
  const { date, time } = localDateTime(new Date(at), timeZone);
  const local = Date.parse(`${date}T${time}:00Z`);
  return Math.round((local - Math.floor(at / 60_000) * 60_000) / 60_000);
}

/**
 * The instant a local date and time is in a time zone. A time skipped by a daylight-saving jump
 * is taken with the offset before the jump (it moves forward with the clock); a repeated one is
 * its first occurrence.
 */
export function zonedInstant(date: string, time: string, timeZone: string): Date {
  if (!isLocalDate(date) || !isLocalTime(time)) throw new Error('invalid local date or time');
  const wall = Date.parse(`${date}T${time}:00Z`);
  const before = wall - offsetMinutes(wall - 12 * 3_600_000, timeZone) * 60_000;
  const after = wall - offsetMinutes(wall + 12 * 3_600_000, timeZone) * 60_000;
  for (const candidate of [Math.min(before, after), Math.max(before, after)]) {
    const local = localDateTime(new Date(candidate), timeZone);
    if (local.date === date && local.time === time) return new Date(candidate);
  }
  return new Date(before);
}

const dayNumber = (date: string) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 86_400_000);
export const plusDays = (date: string, days: number): string =>
  new Date((dayNumber(date) + days) * 86_400_000).toISOString().slice(0, 10);
export const daysBetween = (from: string, to: string): number => dayNumber(to) - dayNumber(from);

/** Monday is 1 … Sunday is 7. */
const weekdayOf = (date: string) => ((new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7) + 1;

const WEEKDAYS: Readonly<Record<string, number>> = {
  lunes: 1,
  martes: 2,
  miercoles: 3,
  jueves: 4,
  viernes: 5,
  sabado: 6,
  domingo: 7,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
  sunday: 7,
};

const NUMBERS: Readonly<Record<string, number>> = {
  un: 1,
  uno: 1,
  una: 1,
  dos: 2,
  tres: 3,
  cuatro: 4,
  cinco: 5,
  seis: 6,
  siete: 7,
  ocho: 8,
  nueve: 9,
  diez: 10,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

/** Lower case, without accents, one space between words. */
const plain = (text: string) =>
  text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}:]+/gu, ' ')
    .trim();

/**
 * The date a phrase names, from `today` in the business's time zone, or undefined when it names
 * none. Rules (Spanish and English):
 *
 * - hoy / today; mañana / tomorrow; pasado mañana / the day after tomorrow;
 * - en N días / in N days (N in digits or a word up to ten), en una semana / in a week;
 * - el viernes / on friday / el próximo viernes / next friday: the next such day after today
 *   (said on a Friday, "el viernes" is the one a week later);
 * - la próxima semana / la semana que viene / next week: next Monday.
 *
 * A calendar date written out (`2026-10-02`) is taken as it is.
 */
export function relativeDate(text: string, today: string): string | undefined {
  const s = ` ${plain(text)} `;
  const iso = /\b(\d{4}-\d{2}-\d{2})\b/.exec(text);
  if (iso?.[1] !== undefined && isLocalDate(iso[1])) return iso[1];
  if (/ pasado manana | day after tomorrow /.test(s)) return plusDays(today, 2);
  // "mañana" is also "morning" ("a las 10 de la mañana"): only "de la mañana" is excluded.
  if (/ (?<!de la )manana | tomorrow /.test(s.replace(/ de la manana /g, ' '))) {
    return plusDays(today, 1);
  }
  if (/ hoy | today | tonight | esta noche | esta tarde /.test(s)) return today;
  const inDays = / (?:en|in|dentro de) (\d{1,3}|[a-z]+) (?:dias|dia|days|day) /.exec(s);
  if (inDays?.[1] !== undefined) {
    const n = /^\d+$/.test(inDays[1]) ? Number(inDays[1]) : NUMBERS[inDays[1]];
    if (n !== undefined && n >= 0 && n <= 366) return plusDays(today, n);
  }
  if (/ (?:en|in) (?:una|a|one) (?:semana|week) /.test(s)) return plusDays(today, 7);
  if (/ (?:la )?proxima semana | la semana que viene | next week /.test(s)) {
    return plusDays(today, 8 - weekdayOf(today));
  }
  for (const [name, day] of Object.entries(WEEKDAYS)) {
    if (s.includes(` ${name} `)) {
      const ahead = (day - weekdayOf(today) + 7) % 7;
      return plusDays(today, ahead === 0 ? 7 : ahead);
    }
  }
  return undefined;
}

/**
 * The time a phrase names, as `HH:MM`, or undefined when it names none: "a las 10", "10:30",
 * "a las 3 de la tarde", "3 pm", "at 9am", "al mediodía" / "noon". A bare number is never a time.
 */
export function relativeTime(text: string): string | undefined {
  const s = ` ${plain(text)} `;
  if (/ (?:al )?mediodia | noon | midday /.test(s)) return '12:00';
  const pad = (h: number, m: number) =>
    h >= 0 && h <= 23 && m >= 0 && m <= 59
      ? `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
      : undefined;
  const PART = '(am|pm|de la manana|de la tarde|de la noche)';
  const found =
    new RegExp(` (?:a las|a la|at|las) (\\d{1,2})(?::(\\d{2}))?(?: ?${PART})?(?= )`).exec(s) ??
    new RegExp(` (\\d{1,2}):(\\d{2})(?: ?${PART})?(?= )`).exec(s) ??
    / (\d{1,2}) ?(am|pm) /.exec(s)?.map((v, i, all) => (i === 2 ? '' : i === 3 ? all[2] : v));
  if (found === null || found === undefined || found[1] === undefined) return undefined;
  let hour = Number(found[1]);
  const minute = found[2] === undefined || found[2] === '' ? 0 : Number(found[2]);
  const part = found[3];
  if ((part === 'pm' || part === 'de la tarde' || part === 'de la noche') && hour < 12) hour += 12;
  if ((part === 'am' || part === 'de la manana') && hour === 12) hour = 0;
  return pad(hour, minute);
}
