import { describe, expect, it } from 'vitest';
import { resolveByRules } from '../src/ai/intent-engine.js';

/**
 * The rules path is what keeps the assistant fast, cheap and usable when the
 * AI provider is unreachable. These tests pin both what it must handle and —
 * just as important — what it must decline to guess at.
 */

const TZ = 'Asia/Jerusalem';
// Wednesday 2026-09-09, 14:00 local.
const ctx = { now: new Date('2026-09-09T11:00:00.000Z'), timezone: TZ, userName: 'Shay' };

describe('reminder phrasings resolve without a model', () => {
  it('handles the canonical form', () => {
    const intent = resolveByRules('תזכיר לי מחר ב־10 להתקשר לדני לגבי ההצעה', ctx);
    expect(intent?.intent).toBe('CREATE_TASK');
    expect(intent?.task?.title).toBe('להתקשר לדני לגבי ההצעה');
    expect(intent?.task?.reminder).toMatchObject({ date: '2026-09-10', time: '10:00' });
    expect(intent?.task?.due).toBeNull();
  });

  it('handles a date before the verb', () => {
    const intent = resolveByRules('ביום חמישי תזכיר לי לדבר עם רואה החשבון', ctx);
    expect(intent?.intent).toBe('CREATE_TASK');
    expect(intent?.task?.title).toBe('לדבר עם רואה החשבון');
    expect(intent?.task?.reminder?.date).toBe('2026-09-10');
  });

  it('handles a relative offset before the verb', () => {
    const intent = resolveByRules('עוד שעתיים להזכיר לי להתקשר ליוסי', ctx);
    expect(intent?.intent).toBe('CREATE_TASK');
    expect(intent?.task?.title).toBe('להתקשר ליוסי');
    expect(intent?.task?.reminder).toMatchObject({ date: '2026-09-09', time: '16:00' });
  });
});

describe('deadline phrasings set a due date, not a reminder', () => {
  it('handles "צריך … עד יום ראשון"', () => {
    const intent = resolveByRules('צריך לשלוח הצעה לאביב עד יום ראשון', ctx);
    expect(intent?.intent).toBe('CREATE_TASK');
    expect(intent?.task?.title).toBe('לשלוח הצעה לאביב');
    expect(intent?.task?.due?.date).toBe('2026-09-13');
    // No time was named, so nothing should be scheduled to ping.
    expect(intent?.task?.reminder).toBeNull();
  });

  it('keeps both when a reminder verb and a deadline appear together', () => {
    const intent = resolveByRules('תזכיר לי מחר ב־15 לשלוח את הדוח עד 18:00', ctx);
    expect(intent?.task?.reminder).not.toBeNull();
    expect(intent?.task?.due).not.toBeNull();
  });
});

describe('add-task phrasings', () => {
  it('creates a task with no date', () => {
    const intent = resolveByRules('הוסף משימה לבדוק את הקמפיין של דני', ctx);
    expect(intent?.intent).toBe('CREATE_TASK');
    expect(intent?.task?.title).toBe('לבדוק את הקמפיין של דני');
    expect(intent?.task?.due).toBeNull();
    expect(intent?.task?.reminder).toBeNull();
  });
});

describe('what the rules must NOT guess at', () => {
  it('defers an ambiguous rescheduling request to the model', () => {
    expect(resolveByRules('תעביר את המשימה של אביב ליום ראשון', ctx)).toBeNull();
  });

  it('defers a search to the model', () => {
    expect(resolveByRules('מה נשאר לי לעשות לאביב?', ctx)).toBeNull();
  });

  it('defers an event creation to the model', () => {
    expect(resolveByRules('קבע לי ביום ראשון ב־13:00 שעה לעבוד על המצגת לאורקל', ctx)).toBeNull();
  });

  it('defers a free-time question to the model', () => {
    expect(resolveByRules('מתי אני פנוי מחר לשעה?', ctx)).toBeNull();
  });

  it('defers anything it does not recognise', () => {
    expect(resolveByRules('מה שלומך היום חבר', ctx)).toBeNull();
  });

  it('does not treat a bare confirmation as one when nothing was asked', () => {
    expect(resolveByRules('כן', ctx)).toBeNull();
    expect(
      resolveByRules('כן', { ...ctx, pendingQuestion: { kind: 'x', prompt: 'y' } })?.intent,
    ).toBe('CONFIRM_YES');
  });
});

describe('direct commands', () => {
  it.each([
    ['בוצע', 'COMPLETE_TASK'],
    ['סיימתי', 'COMPLETE_TASK'],
    ['מה המשימות שלי?', 'LIST_TASKS'],
    ['מה לא הספקתי?', 'LIST_TASKS'],
    ['מה יש לי היום?', 'CALENDAR_QUERY'],
    ['מה יש לי מחר?', 'CALENDAR_QUERY'],
    ['מה הכי חשוב שאעשה עכשיו?', 'PRIORITIZE'],
    ['עזרה', 'HELP'],
  ])('%s → %s', (text, expected) => {
    expect(resolveByRules(text, ctx)?.intent).toBe(expected);
  });

  it('snoozes by an hour', () => {
    const intent = resolveByRules('דחה בשעה', ctx);
    expect(intent?.intent).toBe('SNOOZE_TASK');
    expect(intent?.snooze?.minutes).toBe(60);
  });

  it('snoozes to tomorrow', () => {
    const intent = resolveByRules('מחר', ctx);
    expect(intent?.intent).toBe('SNOOZE_TASK');
    expect(intent?.snooze?.until?.relative_expression).toBe('מחר');
  });
});
