import { DateTime } from 'luxon';
import type { Recurrence } from '../domain/types.js';
import type { LocalDate } from '../utils/time.js';

/**
 * Computes the next occurrence of a recurring task, in local wall-clock terms.
 * Returns null when the series has ended (`until` passed or `count` exhausted).
 *
 * Working in wall-clock dates rather than instants is deliberate: "every Sunday
 * at 09:00" must stay 09:00 across a DST change.
 */
export function nextOccurrence(
  rule: Recurrence,
  from: LocalDate,
  timezone: string,
): LocalDate | null {
  const occurrences = rule.occurrences ?? 0;
  if (rule.count != null && occurrences + 1 >= rule.count) return null;

  const base = DateTime.fromISO(from, { zone: timezone }).startOf('day');
  if (!base.isValid) return null;
  const interval = Math.max(1, rule.interval);
  let next: DateTime;

  switch (rule.freq) {
    case 'daily':
      next = base.plus({ days: interval });
      break;
    case 'weekly': {
      const days = (rule.byweekday ?? []).slice().sort((a, b) => a - b);
      if (!days.length) {
        next = base.plus({ weeks: interval });
        break;
      }
      const current = base.weekday % 7; // 0 = Sunday
      const upcoming = days.find((d) => d > current);
      next =
        upcoming !== undefined
          ? base.plus({ days: upcoming - current })
          : base.plus({ days: 7 * interval - current + days[0]! });
      break;
    }
    case 'monthly': {
      const target = base.plus({ months: interval });
      const day = rule.bymonthday ?? base.day;
      next = target.set({ day: Math.min(day, target.daysInMonth ?? 28) });
      break;
    }
    case 'yearly':
      next = base.plus({ years: interval });
      break;
    default:
      return null;
  }

  if (rule.until) {
    const until = DateTime.fromISO(rule.until, { zone: timezone }).endOf('day');
    if (until.isValid && next > until) return null;
  }
  return next.toFormat('yyyy-MM-dd');
}

export function bumpOccurrence(rule: Recurrence): Recurrence {
  return { ...rule, occurrences: (rule.occurrences ?? 0) + 1 };
}

/** Renders a recurrence rule in Hebrew for confirmations. */
export function describeRecurrenceHe(rule: Recurrence): string {
  const names = ['ראשון', 'שני', 'שלישי', 'רביעי', 'חמישי', 'שישי', 'שבת'];
  switch (rule.freq) {
    case 'daily':
      return rule.interval === 1 ? 'כל יום' : `כל ${rule.interval} ימים`;
    case 'weekly': {
      const days = (rule.byweekday ?? []).map((d) => names[d]).filter(Boolean);
      if (days.length) return `כל יום ${days.join(' ו')}`;
      return rule.interval === 1 ? 'כל שבוע' : `כל ${rule.interval} שבועות`;
    }
    case 'monthly':
      return rule.bymonthday ? `ב-${rule.bymonthday} לכל חודש` : 'כל חודש';
    case 'yearly':
      return 'כל שנה';
    default:
      return '';
  }
}
