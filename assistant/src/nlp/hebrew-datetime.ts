import { DateTime } from 'luxon';
import type { LocalDate, LocalTime } from '../utils/time.js';
import { normalizeTime } from '../utils/time.js';

/**
 * Deterministic Hebrew date/time parser.
 *
 * Two jobs:
 *  1. A fast path that resolves the common phrasings without an LLM round-trip.
 *  2. A normaliser for whatever the LLM returns — the intent engine is allowed to
 *     hand back a *relative expression* ("מחר בבוקר") instead of an absolute date,
 *     and this module is the single place that turns any relative expression into
 *     a concrete local date/time. Date arithmetic never happens inside a prompt.
 *
 * Everything is computed in the user's timezone; the caller converts to an
 * instant with `wallClockToInstant`.
 */

export interface ParseContext {
  now: Date;
  timezone: string;
  /** Default hour used when a date is given without a time. */
  defaultHour?: number;
  defaultMinute?: number;
}

export interface ParsedDateTime {
  date: LocalDate | null;
  time: LocalTime | null;
  /** True when the user actually said a time (vs. a default being applied). */
  explicitTime: boolean;
  /** True when the user actually pinned a date (vs. "today" being assumed). */
  explicitDate: boolean;
  /** The substring that produced the match — used to strip it from the title. */
  matchedText: string | null;
  /** 0..1 — how sure we are this is a real date expression. */
  confidence: number;
  /** True when the phrase named a deadline ("עד יום ראשון") rather than a moment. */
  isDeadline: boolean;
}

const EMPTY: ParsedDateTime = {
  date: null,
  time: null,
  explicitTime: false,
  explicitDate: false,
  matchedText: null,
  confidence: 0,
  isDeadline: false,
};

/** 0 = Sunday, matching the Israeli week. */
const WEEKDAYS: Record<string, number> = {
  ראשון: 0,
  שני: 1,
  שלישי: 2,
  רביעי: 3,
  חמישי: 4,
  שישי: 5,
  שבת: 6,
  א: 0,
  ב: 1,
  ג: 2,
  ד: 3,
  ה: 4,
  ו: 5,
  ש: 6,
};

const HEBREW_NUMBERS: Record<string, number> = {
  אחת: 1,
  אחד: 1,
  שתיים: 2,
  שניים: 2,
  שתי: 2,
  שני: 2,
  שלוש: 3,
  שלושה: 3,
  ארבע: 4,
  ארבעה: 4,
  חמש: 5,
  חמישה: 5,
  שש: 6,
  שישה: 6,
  שבע: 7,
  שבעה: 7,
  שמונה: 8,
  תשע: 9,
  תשעה: 9,
  עשר: 10,
  עשרה: 10,
  עשרים: 20,
};

/** Words that already mean "two of X". */
const DUALS: Record<string, { unit: Unit; count: number }> = {
  שעתיים: { unit: 'hours', count: 2 },
  יומיים: { unit: 'days', count: 2 },
  שבועיים: { unit: 'weeks', count: 2 },
  חודשיים: { unit: 'months', count: 2 },
  דקותיים: { unit: 'minutes', count: 2 },
};

type Unit = 'minutes' | 'hours' | 'days' | 'weeks' | 'months';

const UNIT_WORDS: Record<string, Unit> = {
  דקה: 'minutes',
  דקות: 'minutes',
  שעה: 'hours',
  שעות: 'hours',
  יום: 'days',
  ימים: 'days',
  שבוע: 'weeks',
  שבועות: 'weeks',
  חודש: 'months',
  חודשים: 'months',
};

/** Named parts of the day and the hour they resolve to. */
const DAYPARTS: Record<string, { hour: number; minute: number }> = {
  בבוקר: { hour: 9, minute: 0 },
  בוקר: { hour: 9, minute: 0 },
  'לפנות בוקר': { hour: 6, minute: 0 },
  בצהריים: { hour: 12, minute: 0 },
  צהריים: { hour: 12, minute: 0 },
  'אחר הצהריים': { hour: 16, minute: 0 },
  'אחרי הצהריים': { hour: 16, minute: 0 },
  אחהצ: { hour: 16, minute: 0 },
  בערב: { hour: 20, minute: 0 },
  ערב: { hour: 20, minute: 0 },
  בלילה: { hour: 22, minute: 0 },
  לילה: { hour: 22, minute: 0 },
};

function normalise(input: string): string {
  return (
    input
      // Maqaf (U+05BE) sits inside the niqqud block, so normalise dashes first —
      // stripping niqqud beforehand would swallow the hyphen in "ב־10".
      .replace(/[־–—]/g, '-')
      .replace(/[ְ-ׇֽֿׁׂ]/g, '') // niqqud
      .replace(/["״'׳]/g, '')
      .replace(/\s+/g, ' ')
      .trim()
  );
}

function localNow(ctx: ParseContext): DateTime {
  return DateTime.fromJSDate(ctx.now, { zone: ctx.timezone });
}

function fmt(dt: DateTime): LocalDate {
  return dt.toFormat('yyyy-MM-dd');
}

/**
 * A bare hour has no AM/PM in Hebrew. Israeli usage: 1–6 said on its own means
 * the afternoon ("ב-3" = 15:00), 7–12 means the morning ("ב-9" = 09:00).
 * A minute-qualified 24h time ("14:00") is taken literally.
 */
function disambiguateHour(
  hour: number,
  hadExplicitMinutes: boolean,
  daypart: string | null,
): number {
  if (daypart) {
    const isPm = [
      'בערב',
      'ערב',
      'בלילה',
      'לילה',
      'בצהריים',
      'צהריים',
      'אחר הצהריים',
      'אחרי הצהריים',
      'אחהצ',
    ].includes(daypart);
    if (isPm && hour < 12) return hour + 12;
    if (!isPm && hour === 12) return 0;
    return hour;
  }
  if (hour >= 13) return hour;
  if (hadExplicitMinutes) return hour; // "9:30" is 09:30
  if (hour >= 1 && hour <= 6) return hour + 12;
  return hour;
}

interface TimeMatch {
  hour: number;
  minute: number;
  matched: string;
}

/** Finds an explicit clock time: "10:30", "ב-10", "בשעה 8 בערב", "בשמונה בערב". */
function findTime(text: string): TimeMatch | null {
  const daypartRe = Object.keys(DAYPARTS)
    .sort((a, b) => b.length - a.length)
    .join('|');

  // 10:30 / 14:00, optionally with a daypart word after it
  const hhmm = new RegExp(
    `(?:^|[\\s(])(?:ב-?|בשעה\\s*|ל-?)?(\\d{1,2}):(\\d{2})(?:\\s*(${daypartRe}))?`,
    'u',
  ).exec(text);
  if (hhmm) {
    const h = Number(hhmm[1]);
    const m = Number(hhmm[2]);
    if (h <= 23 && m <= 59) {
      return {
        hour: disambiguateHour(h, true, hhmm[3] ?? null),
        minute: m,
        matched: hhmm[0].trim(),
      };
    }
  }

  // "ב-10 בבוקר" / "בשעה 8 בערב" / "ב 14"
  const bare = new RegExp(
    `(?:^|\\s)(?:בשעה\\s*|ב-\\s*|ב\\s+|ל-\\s*)(\\d{1,2})(?:\\s*(${daypartRe}))?(?![./]\\d)(?=$|[\\s,.!?])`,
    'u',
  ).exec(text);
  if (bare) {
    const h = Number(bare[1]);
    if (h >= 0 && h <= 23) {
      return {
        hour: disambiguateHour(h, false, bare[2] ?? null),
        minute: 0,
        matched: bare[0].trim(),
      };
    }
  }

  // "בעשר בבוקר" / "בשמונה וחצי"
  const words = Object.keys(HEBREW_NUMBERS)
    .sort((a, b) => b.length - a.length)
    .join('|');
  const wordTime = new RegExp(
    `(?:^|\\s)(?:בשעה\\s*)?ב(${words})(?:\\s*ו(חצי|רבע))?(?:\\s*(${daypartRe}))?(?=$|[\\s,.!?])`,
    'u',
  ).exec(text);
  if (wordTime) {
    const h = HEBREW_NUMBERS[wordTime[1]!]!;
    if (h >= 1 && h <= 12) {
      const minute = wordTime[2] === 'חצי' ? 30 : wordTime[2] === 'רבע' ? 15 : 0;
      return {
        hour: disambiguateHour(h, false, wordTime[3] ?? null),
        minute,
        matched: wordTime[0].trim(),
      };
    }
  }

  // A daypart on its own: "מחר בבוקר"
  const dp = new RegExp(`(?:^|\\s)(${daypartRe})(?=$|[\\s,.!?])`, 'u').exec(text);
  if (dp) {
    const conf = DAYPARTS[dp[1]!]!;
    return { hour: conf.hour, minute: conf.minute, matched: dp[1]! };
  }
  return null;
}

interface RelativeMatch {
  dt: DateTime;
  matched: string;
  /** A relative offset in hours/minutes carries its own time-of-day. */
  carriesTime: boolean;
}

/** "עוד שעתיים", "בעוד 3 ימים", "בעוד שבוע". */
function findRelativeOffset(text: string, base: DateTime): RelativeMatch | null {
  const dualWords = Object.keys(DUALS).join('|');
  const dual = new RegExp(`(?:עוד|בעוד|תוך)\\s+(${dualWords})`, 'u').exec(text);
  if (dual) {
    const spec = DUALS[dual[1]!]!;
    return {
      dt: base.plus({ [spec.unit]: spec.count }),
      matched: dual[0],
      carriesTime: spec.unit === 'hours' || spec.unit === 'minutes',
    };
  }

  const unitWords = Object.keys(UNIT_WORDS)
    .sort((a, b) => b.length - a.length)
    .join('|');
  const numWords = Object.keys(HEBREW_NUMBERS)
    .sort((a, b) => b.length - a.length)
    .join('|');
  const numeric = new RegExp(
    `(?:עוד|בעוד|תוך)\\s+(?:(\\d{1,3})|(${numWords}))?\\s*(${unitWords})`,
    'u',
  ).exec(text);
  if (numeric) {
    const count = numeric[1] ? Number(numeric[1]) : numeric[2] ? HEBREW_NUMBERS[numeric[2]]! : 1;
    const unit = UNIT_WORDS[numeric[3]!]!;
    return {
      dt: base.plus({ [unit]: count }),
      matched: numeric[0],
      carriesTime: unit === 'hours' || unit === 'minutes',
    };
  }
  return null;
}

/** "ביום ראשון", "יום ה'", "בשבת". */
function findWeekday(text: string, base: DateTime): RelativeMatch | null {
  const names = Object.keys(WEEKDAYS)
    .filter((k) => k.length > 1)
    .sort((a, b) => b.length - a.length)
    .join('|');
  const full = new RegExp(`(?:ב?יום\\s+)?ה?(${names})(?:\\s+(הבא|הקרוב))?`, 'u').exec(text);
  const short = new RegExp(`ביום\\s+([אבגדהוש])(?:\\s|$|['׳])`, 'u').exec(text);
  const m = full ?? short;
  if (!m) return null;
  const key = m[1]!;
  const target = WEEKDAYS[key];
  if (target === undefined) return null;

  // Luxon: 1=Monday … 7=Sunday. Convert to 0=Sunday.
  const current = base.weekday % 7;
  let diff = (target - current + 7) % 7;
  // "ביום ראשון" said on a Sunday means the coming Sunday, not today.
  if (diff === 0) diff = 7;
  if (m[2] === 'הבא' && diff < 7) diff += 0; // "הבא" = the coming one, already correct
  return { dt: base.plus({ days: diff }), matched: m[0], carriesTime: false };
}

/** "12/10", "12.10.2026", "ה-12 לחודש". */
function findExplicitDate(text: string, base: DateTime): RelativeMatch | null {
  const dmy = /(?:^|\s)(?:[בלמה]-?)?(\d{1,2})[./](\d{1,2})(?:[./](\d{2,4}))?(?=$|[\s,.!?])/u.exec(
    text,
  );
  if (dmy) {
    const day = Number(dmy[1]);
    const month = Number(dmy[2]);
    if (day >= 1 && day <= 31 && month >= 1 && month <= 12) {
      let year = dmy[3] ? Number(dmy[3]) : base.year;
      if (year < 100) year += 2000;
      let dt = DateTime.fromObject({ year, month, day }, { zone: base.zone });
      if (!dt.isValid) return null;
      // A bare day/month in the past means next year.
      if (!dmy[3] && dt < base.startOf('day')) dt = dt.plus({ years: 1 });
      return { dt, matched: dmy[0].trim(), carriesTime: false };
    }
  }
  const inMonth = /ה-?(\d{1,2})\s+ל(?:חודש|כל חודש)/u.exec(text);
  if (inMonth) {
    const day = Number(inMonth[1]);
    let dt = base.set({ day }).startOf('day');
    if (dt < base.startOf('day')) dt = dt.plus({ months: 1 });
    return { dt, matched: inMonth[0], carriesTime: false };
  }
  return null;
}

/**
 * Resolves any Hebrew date/time expression inside `input`.
 * Returns `confidence: 0` and null fields when nothing date-like is present.
 */
export function parseHebrewDateTime(input: string, ctx: ParseContext): ParsedDateTime {
  const text = normalise(input);
  if (!text) return { ...EMPTY };

  const base = localNow(ctx);
  const isDeadline = /(?:^|\s)(עד|לא יאוחר מ|דדליין|deadline)(?:\s|$)/u.test(text);

  const timeMatch = findTime(text);
  let date: LocalDate | null = null;
  let matchedText: string | null = null;
  let explicitDate = false;
  let confidence = 0;
  let carriedTime: { hour: number; minute: number } | null = null;

  // 1. Absolute relative offsets win — "עוד שעתיים" is unambiguous.
  const offset = findRelativeOffset(text, base);
  if (offset) {
    date = fmt(offset.dt);
    matchedText = offset.matched;
    explicitDate = true;
    confidence = 0.95;
    if (offset.carriesTime) carriedTime = { hour: offset.dt.hour, minute: offset.dt.minute };
  }

  // 2. Explicit calendar dates.
  if (!date) {
    const explicit = findExplicitDate(text, base);
    if (explicit) {
      date = fmt(explicit.dt);
      matchedText = explicit.matched;
      explicitDate = true;
      confidence = 0.9;
    }
  }

  // 3. Named relative days.
  if (!date) {
    const dayWords: Array<[RegExp, number, string]> = [
      [/(?:^|\s)מחרתיים(?=$|[\s,.!?])/u, 2, 'מחרתיים'],
      [/(?:^|\s)מחר(?=$|[\s,.!?])/u, 1, 'מחר'],
      [/(?:^|\s)היום(?=$|[\s,.!?])/u, 0, 'היום'],
      [/(?:^|\s)הערב(?=$|[\s,.!?])/u, 0, 'הערב'],
      [/(?:^|\s)הלילה(?=$|[\s,.!?])/u, 0, 'הלילה'],
      [/(?:^|\s)אתמול(?=$|[\s,.!?])/u, -1, 'אתמול'],
    ];
    for (const [re, offsetDays, label] of dayWords) {
      if (re.test(text)) {
        date = fmt(base.plus({ days: offsetDays }));
        matchedText = label;
        explicitDate = true;
        confidence = 0.95;
        if (label === 'הערב' && !timeMatch) carriedTime = { hour: 20, minute: 0 };
        if (label === 'הלילה' && !timeMatch) carriedTime = { hour: 22, minute: 0 };
        break;
      }
    }
  }

  // 4. Weekday names.
  if (!date) {
    const weekday = findWeekday(text, base);
    if (weekday) {
      date = fmt(weekday.dt);
      matchedText = weekday.matched;
      explicitDate = true;
      confidence = 0.85;
    }
  }

  // 5. Coarse period phrases.
  if (!date) {
    if (/סוף\s+(?:ה)?חודש/u.test(text)) {
      date = fmt(base.endOf('month'));
      matchedText = 'סוף החודש';
      explicitDate = true;
      confidence = 0.8;
    } else if (/סוף\s+(?:ה)?שבוע/u.test(text)) {
      // The Israeli work week ends on Thursday; "סוף השבוע" as a deadline means Thursday.
      const current = base.weekday % 7;
      const diff = (4 - current + 7) % 7 || 7;
      date = fmt(base.plus({ days: diff }));
      matchedText = 'סוף השבוע';
      explicitDate = true;
      confidence = 0.7;
    } else if (/(?:ה)?שבוע\s+הבא/u.test(text)) {
      const current = base.weekday % 7;
      const diff = (0 - current + 7) % 7 || 7;
      date = fmt(base.plus({ days: diff }));
      matchedText = 'שבוע הבא';
      explicitDate = true;
      confidence = 0.7;
    } else if (/(?:ה)?חודש\s+הבא/u.test(text)) {
      date = fmt(base.plus({ months: 1 }).startOf('month'));
      matchedText = 'חודש הבא';
      explicitDate = true;
      confidence = 0.7;
    }
  }

  // A time with no date means the next occurrence of that time.
  let time: LocalTime | null = null;
  let explicitTime = false;
  if (timeMatch) {
    time = normalizeTime(`${timeMatch.hour}:${timeMatch.minute}`);
    explicitTime = true;
    confidence = Math.max(confidence, 0.8);
    matchedText = matchedText ? `${matchedText} ${timeMatch.matched}` : timeMatch.matched;
    if (!date) {
      const candidate = base.set({
        hour: timeMatch.hour,
        minute: timeMatch.minute,
        second: 0,
        millisecond: 0,
      });
      date = fmt(candidate <= base ? candidate.plus({ days: 1 }) : candidate);
      explicitDate = false;
    }
  } else if (carriedTime) {
    time = normalizeTime(`${carriedTime.hour}:${carriedTime.minute}`);
    explicitTime = true;
  } else if (date && ctx.defaultHour !== undefined) {
    time = normalizeTime(`${ctx.defaultHour}:${ctx.defaultMinute ?? 0}`);
  }

  if (!date && !time) return { ...EMPTY };
  return { date, time, explicitTime, explicitDate, matchedText, confidence, isDeadline };
}

/**
 * Removes the date expression from a sentence so the task title reads naturally:
 * "תזכיר לי מחר ב־10 להתקשר לדני" → "להתקשר לדני".
 */
export function stripDateExpression(input: string, parsed: ParsedDateTime): string {
  let out = normalise(input);
  if (parsed.matchedText) {
    for (const piece of parsed.matchedText.split(' ').filter(Boolean)) {
      out = out.replace(new RegExp(`\\s*${escapeRegExp(piece)}\\s*`, 'u'), ' ');
    }
  }
  // Removing "יום ראשון" from "…לאביב עד יום ראשון" leaves a dangling "עד".
  if (parsed.isDeadline) {
    out = out.replace(/\s*(?:עד|לא יאוחר מ|דדליין|deadline)\s*$/u, ' ');
    out = out.replace(/(?:^|\s)(?:עד|לא יאוחר מ)(?=\s|$)/u, ' ');
  }
  return out.replace(/\s+/g, ' ').trim();
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Leading assistant-address phrases that are never part of the task title. */
const LEAD_PHRASES = [
  'תזכיר לי בבקשה',
  'תזכיר לי',
  'תזכירי לי',
  'הזכר לי',
  'להזכיר לי',
  'תוסיף משימה',
  'הוסף משימה',
  'תוסיף לי משימה',
  'תרשום לי',
  'תרשום',
  'רשום לי',
  'צריך',
  'אני צריך',
  'אני חייב',
  'תדאג ש',
  'שים לב ש',
];

export function stripLeadPhrases(input: string): string {
  let out = normalise(input);
  for (const phrase of LEAD_PHRASES.sort((a, b) => b.length - a.length)) {
    const re = new RegExp(`^${escapeRegExp(phrase)}\\s+`, 'u');
    if (re.test(out)) {
      out = out.replace(re, '');
      break;
    }
  }
  return out.trim();
}
