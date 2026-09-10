import { describe, expect, it } from 'vitest';
import { parseHebrewDateTime, stripDateExpression, stripLeadPhrases } from '../src/nlp/hebrew-datetime.js';
import { wallClockToInstant, instantToWallClock, isWithinQuietHours, nextTimeOutsideQuietHours, localWeekRange } from '../src/utils/time.js';

const TZ = 'Asia/Jerusalem';
// Wednesday 2026-09-09 14:00 local (IDT, UTC+3) => 11:00Z
const NOW = new Date('2026-09-09T11:00:00.000Z');
const ctx = { now: NOW, timezone: TZ };

describe('Hebrew relative days', () => {
  it('resolves היום', () => {
    const r = parseHebrewDateTime('היום להתקשר לדני', ctx);
    expect(r.date).toBe('2026-09-09');
  });

  it('resolves מחר with an explicit hour', () => {
    const r = parseHebrewDateTime('תזכיר לי מחר ב־10 להתקשר לדני', ctx);
    expect(r.date).toBe('2026-09-10');
    expect(r.time).toBe('10:00');
    expect(r.explicitTime).toBe(true);
  });

  it('resolves מחרתיים', () => {
    expect(parseHebrewDateTime('מחרתיים בבוקר', ctx).date).toBe('2026-09-11');
  });

  it('applies the morning daypart when no hour is given', () => {
    const r = parseHebrewDateTime('מחר בבוקר לשלוח הצעה', ctx);
    expect(r.date).toBe('2026-09-10');
    expect(r.time).toBe('09:00');
  });

  it('resolves הערב to 20:00 today', () => {
    const r = parseHebrewDateTime('הערב לבדוק מיילים', ctx);
    expect(r.date).toBe('2026-09-09');
    expect(r.time).toBe('20:00');
  });
});

describe('Hebrew weekdays', () => {
  it('resolves ביום ראשון to the coming Sunday', () => {
    // Wednesday 09/09 -> Sunday 13/09
    expect(parseHebrewDateTime('ביום ראשון לדבר עם רואה החשבון', ctx).date).toBe('2026-09-13');
  });

  it('resolves ביום חמישי to tomorrow-but-one', () => {
    expect(parseHebrewDateTime('ביום חמישי תזכיר לי', ctx).date).toBe('2026-09-10');
  });

  it('rolls to next week when the weekday is today', () => {
    // Wednesday asking for "ביום רביעי"
    expect(parseHebrewDateTime('ביום רביעי פגישה', ctx).date).toBe('2026-09-16');
  });
});

describe('relative offsets', () => {
  it('resolves עוד שעה', () => {
    const r = parseHebrewDateTime('עוד שעה להתקשר ליוסי', ctx);
    expect(r.date).toBe('2026-09-09');
    expect(r.time).toBe('15:00');
  });

  it('resolves עוד שעתיים', () => {
    expect(parseHebrewDateTime('עוד שעתיים להזכיר לי להתקשר ליוסי', ctx).time).toBe('16:00');
  });

  it('resolves בעוד שבועיים', () => {
    expect(parseHebrewDateTime('בעוד שבועיים לחדש את הביטוח', ctx).date).toBe('2026-09-23');
  });

  it('resolves בעוד 3 ימים', () => {
    expect(parseHebrewDateTime('בעוד 3 ימים', ctx).date).toBe('2026-09-12');
  });

  it('resolves עוד 45 דקות', () => {
    expect(parseHebrewDateTime('עוד 45 דקות', ctx).time).toBe('14:45');
  });
});

describe('period phrases', () => {
  it('resolves סוף החודש', () => {
    expect(parseHebrewDateTime('בסוף החודש להוציא חשבוניות', ctx).date).toBe('2026-09-30');
  });

  it('resolves סוף השבוע to Thursday', () => {
    expect(parseHebrewDateTime('עד סוף השבוע', ctx).date).toBe('2026-09-10');
  });

  it('flags עד as a deadline', () => {
    expect(parseHebrewDateTime('צריך לשלוח הצעה לאביב עד יום ראשון', ctx).isDeadline).toBe(true);
  });
});

describe('clock times', () => {
  it('reads a 24h time literally', () => {
    expect(parseHebrewDateTime('פגישה מחר ב־14:30', ctx).time).toBe('14:30');
  });

  it('treats a bare small hour as afternoon', () => {
    expect(parseHebrewDateTime('מחר ב־3 לבדוק', ctx).time).toBe('15:00');
  });

  it('treats a bare 9 as morning', () => {
    expect(parseHebrewDateTime('מחר ב־9 לשלוח הצעה לדני', ctx).time).toBe('09:00');
  });

  it('honours בערב', () => {
    expect(parseHebrewDateTime('מחר ב־8 בערב', ctx).time).toBe('20:00');
  });

  it('rolls a bare past time to tomorrow', () => {
    // now is 14:00; "ב־10" without a date -> tomorrow 10:00
    const r = parseHebrewDateTime('ב־10 להתקשר', ctx);
    expect(r.date).toBe('2026-09-10');
    expect(r.time).toBe('10:00');
  });

  it('reads Hebrew number words', () => {
    expect(parseHebrewDateTime('מחר בשמונה וחצי בבוקר', ctx).time).toBe('08:30');
  });
});

describe('explicit dates', () => {
  it('parses dd/MM', () => {
    expect(parseHebrewDateTime('פגישה ב־12/10', ctx).date).toBe('2026-10-12');
  });

  it('rolls a past dd/MM into next year', () => {
    expect(parseHebrewDateTime('12/01 לחדש רישיון', ctx).date).toBe('2027-01-12');
  });

  it('parses dd.MM.yyyy', () => {
    expect(parseHebrewDateTime('01.12.2026 דוח שנתי', ctx).date).toBe('2026-12-01');
  });
});

describe('no date present', () => {
  it('returns zero confidence', () => {
    const r = parseHebrewDateTime('לבדוק את הקמפיין של דני', ctx);
    expect(r.confidence).toBe(0);
    expect(r.date).toBeNull();
  });
});

describe('title extraction', () => {
  it('strips the date expression and lead phrase', () => {
    const raw = 'תזכיר לי מחר ב־10 להתקשר לדני לגבי ההצעה';
    const parsed = parseHebrewDateTime(raw, ctx);
    const title = stripLeadPhrases(stripDateExpression(raw, parsed));
    expect(title).toBe('להתקשר לדני לגבי ההצעה');
  });
});

describe('timezone and DST', () => {
  it('round-trips a wall clock through UTC', () => {
    const instant = wallClockToInstant({ date: '2026-09-10', time: '10:00', timezone: TZ });
    expect(instant.toISOString()).toBe('2026-09-10T07:00:00.000Z'); // IDT = UTC+3
    expect(instantToWallClock(instant, TZ)).toEqual({ date: '2026-09-10', time: '10:00', timezone: TZ });
  });

  it('uses winter offset after the autumn DST change', () => {
    // Israel returns to IST (UTC+2) at the end of October.
    const instant = wallClockToInstant({ date: '2026-11-10', time: '10:00', timezone: TZ });
    expect(instant.toISOString()).toBe('2026-11-10T08:00:00.000Z');
  });

  it('a reminder set in summer for a winter date keeps its wall-clock hour', () => {
    const summer = wallClockToInstant({ date: '2026-09-10', time: '09:00', timezone: TZ });
    const winter = wallClockToInstant({ date: '2026-12-10', time: '09:00', timezone: TZ });
    expect(instantToWallClock(summer, TZ).time).toBe('09:00');
    expect(instantToWallClock(winter, TZ).time).toBe('09:00');
    // ...even though the UTC offsets differ.
    expect(summer.toISOString().slice(11, 16)).toBe('06:00');
    expect(winter.toISOString().slice(11, 16)).toBe('07:00');
  });

  it('pushes a wall clock inside the spring-forward gap to a real instant', () => {
    // 2027-03-26 02:30 does not exist in Israel (clocks jump 02:00 -> 03:00).
    const instant = wallClockToInstant({ date: '2027-03-26', time: '02:30', timezone: TZ });
    const back = instantToWallClock(instant, TZ);
    expect(back.date).toBe('2027-03-26');
    expect(Number(back.time.slice(0, 2))).toBeGreaterThanOrEqual(3);
  });
});

describe('quiet hours', () => {
  it('detects a wrapping window', () => {
    const at2am = new Date('2026-09-10T23:30:00.000Z'); // 02:30 local
    expect(isWithinQuietHours(at2am, TZ, '23:00', '07:00')).toBe(true);
  });

  it('lets daytime through', () => {
    const at2pm = new Date('2026-09-10T11:00:00.000Z');
    expect(isWithinQuietHours(at2pm, TZ, '23:00', '07:00')).toBe(false);
  });

  it('defers to the end of the window', () => {
    const at2am = new Date('2026-09-10T23:30:00.000Z');
    const out = nextTimeOutsideQuietHours(at2am, TZ, '23:00', '07:00');
    expect(instantToWallClock(out, TZ).time).toBe('07:00');
    expect(instantToWallClock(out, TZ).date).toBe('2026-09-11');
  });
});

describe('Israeli week', () => {
  it('runs Sunday to Saturday', () => {
    const range = localWeekRange('2026-09-09', TZ); // Wednesday
    expect(range.startDate).toBe('2026-09-06'); // Sunday
    expect(range.endDate).toBe('2026-09-12');   // Saturday
  });
});
