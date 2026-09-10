import { DateTime, Duration, Interval } from 'luxon';

/**
 * Timezone policy for the whole system:
 *
 *  - Absolute instants (reminder_at, due_at, created_at) are TIMESTAMPTZ / UTC.
 *  - The user's *intent* ("Sunday at 13:00") is additionally stored as a local
 *    wall-clock pair (due_date + due_time) plus the timezone it was expressed in.
 *
 * Storing only the instant loses information across a DST boundary: a task
 * created in winter for a summer date would drift by an hour. Storing only the
 * wall clock makes scheduling impossible. We keep both and always re-derive the
 * instant from the wall clock when the wall clock changes.
 */

export const DEFAULT_TIMEZONE = 'Asia/Jerusalem';

export type LocalDate = string; // YYYY-MM-DD
export type LocalTime = string; // HH:mm

export interface WallClock {
  date: LocalDate;
  time?: LocalTime | null;
  timezone: string;
}

export function nowInZone(timezone: string, now: Date = new Date()): DateTime {
  return DateTime.fromJSDate(now, { zone: timezone });
}

export function isValidZone(timezone: string): boolean {
  return DateTime.local().setZone(timezone).isValid;
}

/**
 * Converts a local wall-clock date/time into an absolute instant.
 *
 * Israel's spring-forward skips 02:00→03:00; a wall clock inside the gap does
 * not exist. Luxon reports that as invalid, and we shift forward to the first
 * real instant rather than silently returning garbage. On fall-back the same
 * wall clock happens twice; Luxon resolves to the earlier (still-DST) offset,
 * which is what a person means by "02:30" on that morning.
 */
export function wallClockToInstant(wall: WallClock): Date {
  const time = wall.time ?? '00:00';
  const iso = `${wall.date}T${normalizeTime(time)}`;
  let dt = DateTime.fromISO(iso, { zone: wall.timezone });
  if (!dt.isValid) {
    // Non-existent local time (DST gap) — advance in 15-minute steps to the
    // first instant that does exist on that day.
    for (let minutes = 15; minutes <= 180 && !dt.isValid; minutes += 15) {
      dt = DateTime.fromISO(iso, { zone: wall.timezone }).plus({ minutes });
      if (!dt.isValid) {
        const [h, m] = normalizeTime(time).split(':').map(Number);
        const bumped = DateTime.fromObject(
          {
            year: Number(wall.date.slice(0, 4)),
            month: Number(wall.date.slice(5, 7)),
            day: Number(wall.date.slice(8, 10)),
            hour: h ?? 0,
            minute: m ?? 0,
          },
          { zone: wall.timezone },
        ).plus({ minutes });
        if (bumped.isValid) dt = bumped;
      }
    }
  }
  if (!dt.isValid)
    throw new Error(`Cannot resolve wall clock ${iso} in ${wall.timezone}: ${dt.invalidReason}`);
  return dt.toJSDate();
}

export function instantToWallClock(instant: Date, timezone: string): Required<WallClock> {
  const dt = DateTime.fromJSDate(instant, { zone: timezone });
  return { date: dt.toFormat('yyyy-MM-dd'), time: dt.toFormat('HH:mm'), timezone };
}

/** '9:5' → '09:05'. Accepts 'HH:mm' and 'HH:mm:ss'. */
export function normalizeTime(time: string): LocalTime {
  const m = /^(\d{1,2}):(\d{1,2})(?::\d{1,2})?$/.exec(time.trim());
  if (!m) throw new Error(`Invalid time: ${time}`);
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) throw new Error(`Invalid time: ${time}`);
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

export function isValidLocalDate(date: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(date) && DateTime.fromISO(date).isValid;
}

export function todayInZone(timezone: string, now: Date = new Date()): LocalDate {
  return nowInZone(timezone, now).toFormat('yyyy-MM-dd');
}

export function addDaysLocal(date: LocalDate, days: number, timezone: string): LocalDate {
  return DateTime.fromISO(date, { zone: timezone }).plus({ days }).toFormat('yyyy-MM-dd');
}

/** Start/end of a local day as absolute instants — the range for a calendar query. */
export function localDayRange(date: LocalDate, timezone: string): { start: Date; end: Date } {
  const start = DateTime.fromISO(date, { zone: timezone }).startOf('day');
  return { start: start.toJSDate(), end: start.plus({ days: 1 }).toJSDate() };
}

/** Israeli weeks run Sunday→Saturday. Luxon's weekday is 1=Mon…7=Sun. */
export function localWeekRange(
  date: LocalDate,
  timezone: string,
): { start: Date; end: Date; startDate: LocalDate; endDate: LocalDate } {
  const dt = DateTime.fromISO(date, { zone: timezone }).startOf('day');
  const daysSinceSunday = dt.weekday % 7; // Sunday(7)→0, Monday(1)→1 …
  const start = dt.minus({ days: daysSinceSunday });
  const end = start.plus({ days: 7 });
  return {
    start: start.toJSDate(),
    end: end.toJSDate(),
    startDate: start.toFormat('yyyy-MM-dd'),
    endDate: end.minus({ days: 1 }).toFormat('yyyy-MM-dd'),
  };
}

/** Minutes since local midnight — used for quiet-hours comparisons. */
export function minutesOfDay(time: LocalTime): number {
  const [h, m] = normalizeTime(time).split(':').map(Number);
  return (h ?? 0) * 60 + (m ?? 0);
}

/**
 * Quiet hours may wrap past midnight (23:00 → 07:00). Returns true when `instant`
 * falls inside the window in the user's own timezone.
 */
export function isWithinQuietHours(
  instant: Date,
  timezone: string,
  start: LocalTime,
  end: LocalTime,
): boolean {
  const local = DateTime.fromJSDate(instant, { zone: timezone });
  const cur = local.hour * 60 + local.minute;
  const s = minutesOfDay(start);
  const e = minutesOfDay(end);
  if (s === e) return false;
  return s < e ? cur >= s && cur < e : cur >= s || cur < e;
}

/** First instant at or after `instant` that is outside quiet hours. */
export function nextTimeOutsideQuietHours(
  instant: Date,
  timezone: string,
  start: LocalTime,
  end: LocalTime,
): Date {
  if (!isWithinQuietHours(instant, timezone, start, end)) return instant;
  const local = DateTime.fromJSDate(instant, { zone: timezone });
  const [eh, em] = normalizeTime(end).split(':').map(Number);
  let candidate = local.set({ hour: eh ?? 0, minute: em ?? 0, second: 0, millisecond: 0 });
  if (candidate <= local) candidate = candidate.plus({ days: 1 });
  return candidate.toJSDate();
}

export function formatHe(
  instant: Date,
  timezone: string,
  opts: { withDate?: boolean } = {},
): string {
  const dt = DateTime.fromJSDate(instant, { zone: timezone });
  return opts.withDate ? dt.toFormat('dd/MM HH:mm') : dt.toFormat('HH:mm');
}

export function formatTimeOnly(instant: Date, timezone: string): string {
  return DateTime.fromJSDate(instant, { zone: timezone }).toFormat('HH:mm');
}

const HEBREW_WEEKDAYS = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];

/** Hebrew weekday name for a local date ("יום ראשון"). */
export function hebrewWeekdayName(date: LocalDate, timezone: string): string {
  const dt = DateTime.fromISO(date, { zone: timezone });
  return HEBREW_WEEKDAYS[dt.weekday % 7] ?? '';
}

/**
 * Human phrasing used in every confirmation: "היום", "מחר", "מחרתיים",
 * "ביום ראשון" (within the next week) or "12/10" beyond that.
 */
export function describeDateHe(date: LocalDate, timezone: string, now: Date = new Date()): string {
  const today = todayInZone(timezone, now);
  const diff = Math.round(
    DateTime.fromISO(date, { zone: timezone })
      .startOf('day')
      .diff(DateTime.fromISO(today, { zone: timezone }).startOf('day'), 'days').days,
  );
  if (diff === 0) return 'היום';
  if (diff === 1) return 'מחר';
  if (diff === 2) return 'מחרתיים';
  if (diff === -1) return 'אתמול';
  if (diff > 2 && diff <= 7) return `ביום ${hebrewWeekdayName(date, timezone)}`;
  if (diff < 0) return `${DateTime.fromISO(date).toFormat('dd/MM')} (עבר)`;
  return DateTime.fromISO(date).toFormat('dd/MM');
}

export function describeInstantHe(instant: Date, timezone: string, now: Date = new Date()): string {
  const { date, time } = instantToWallClock(instant, timezone);
  return `${describeDateHe(date, timezone, now)} ב־${time}`;
}

export interface TimeRange {
  start: Date;
  end: Date;
}

export function toInterval(range: TimeRange): Interval {
  return Interval.fromDateTimes(DateTime.fromJSDate(range.start), DateTime.fromJSDate(range.end));
}

export function durationMinutes(range: TimeRange): number {
  return Math.round((range.end.getTime() - range.start.getTime()) / 60_000);
}

export function addMinutes(instant: Date, minutes: number): Date {
  return new Date(instant.getTime() + minutes * 60_000);
}

export { DateTime, Duration, Interval };
