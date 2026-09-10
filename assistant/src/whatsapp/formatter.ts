import type { Task, UnifiedEvent } from '../domain/types.js';
import { describeDateHe, formatTimeOnly, instantToWallClock } from '../utils/time.js';

/**
 * Hebrew message formatting.
 *
 * House style: short, no corporate phrasing, emoji as structure not decoration.
 * "✅ הוספתי: לשלוח הצעה לדני / מחר ב־09:00" — never "הפעולה בוצעה בהצלחה".
 */

const PRIORITY_MARK: Record<string, string> = { urgent: '🔴', high: '🟠', normal: '', low: '' };

export function taskLine(task: Task, timezone: string, now: Date, opts: { index?: number; showDate?: boolean } = {}): string {
  const prefix = opts.index !== undefined ? `${opts.index}. ` : '• ';
  const mark = PRIORITY_MARK[task.priority] ?? '';
  const when =
    opts.showDate !== false && task.due_date
      ? ` — ${describeDateHe(task.due_date, timezone, now)}${task.due_time ? ` ${task.due_time}` : ''}`
      : '';
  const overdue = task.due_at && task.due_at < now && task.status !== 'completed' ? ' ⏰' : '';
  return `${prefix}${mark ? `${mark} ` : ''}${task.title}${when}${overdue}`;
}

export function formatTaskCreated(task: Task, reminderAt: Date | null, timezone: string, now: Date): string {
  const lines = [`✅ הוספתי: ${task.title}`];
  if (reminderAt) {
    const { date, time } = instantToWallClock(reminderAt, timezone);
    lines.push(`🔔 ${describeDateHe(date, timezone, now)} ב־${time}`);
  } else if (task.due_date) {
    lines.push(`📌 עד ${describeDateHe(task.due_date, timezone, now)}${task.due_time ? ` ב־${task.due_time}` : ''}`);
  }
  return lines.join('\n');
}

export function formatTaskList(tasks: Task[], timezone: string, now: Date, heading: string): string {
  if (!tasks.length) return `${heading}\n\nאין משימות פתוחות 🎉`;
  const lines = tasks.map((t, i) => taskLine(t, timezone, now, { index: i + 1 }));
  return `${heading}\n\n${lines.join('\n')}`;
}

export function formatDisambiguation(reference: string, tasks: Task[], timezone: string, now: Date): string {
  const lines = tasks.map((t, i) => taskLine(t, timezone, now, { index: i + 1, showDate: Boolean(t.due_date) }));
  return `מצאתי כמה משימות שמתאימות ל"${reference}":\n\n${lines.join('\n')}\n\nאיזו מהן? (מספר)`;
}

export function formatEventLine(event: UnifiedEvent, timezone: string): string {
  const source = event.provider === 'google' ? 'Google' : 'Outlook';
  if (event.allDay) return `כל היום  ${event.title}\n   ${source}`;
  return `${formatTimeOnly(event.start, timezone)}  ${event.title}\n   ${source}`;
}

export function formatAgenda(
  events: UnifiedEvent[],
  timezone: string,
  heading: string,
  degraded: string[] = [],
): string {
  const parts: string[] = [heading];
  if (!events.length) {
    parts.push('\nאין אירועים ביומן.');
  } else {
    parts.push('');
    parts.push(events.map((e) => formatEventLine(e, timezone)).join('\n\n'));
  }
  if (degraded.length) parts.push(`\n⚠️ ${degraded.join(' ')}`);
  return parts.join('\n');
}

export function formatFreeSlots(slots: { start: Date; end: Date }[], timezone: string, heading: string): string {
  if (!slots.length) return `${heading}\n\nלא מצאתי חלון פנוי מתאים.`;
  const lines = slots.map((s) => `${formatTimeOnly(s.start, timezone)}–${formatTimeOnly(s.end, timezone)}`);
  return `${heading}\n\n${lines.join('\n')}`;
}

export function formatReminder(task: Task): string {
  return `🔔 תזכורת\n\n${task.title}`;
}

/** Reply buttons for a reminder; ids are parsed back by the orchestrator. */
export function reminderButtons(taskId: string): { id: string; title: string }[] {
  const short = taskId.slice(0, 8);
  return [
    { id: `done:${short}`, title: '✅ בוצע' },
    { id: `snooze60:${short}`, title: '⏰ שעה' },
    { id: `tomorrow:${short}`, title: '🌅 מחר' },
  ];
}

export function candidateButtons(candidateId: string): { id: string; title: string }[] {
  const short = candidateId.slice(0, 8);
  return [
    { id: `cand_add:${short}`, title: '✅ הוסף' },
    { id: `cand_skip:${short}`, title: '❌ התעלם' },
    { id: `cand_later:${short}`, title: '⏰ מאוחר יותר' },
  ];
}

export const HELP_TEXT = `אני העוזר האישי שלך. אפשר פשוט לכתוב לי בעברית, למשל:

📝 משימות
"תזכיר לי מחר ב־10 להתקשר לדני"
"צריך לשלוח הצעה לאביב עד יום ראשון"
"סיימתי להתקשר לדני"
"דחה את זה למחר"
"מה המשימות שלי?"
"מה לא הספקתי?"

📅 יומן
"מה יש לי היום?"
"מה יש לי ביום רביעי?"
"מתי אני פנוי מחר לשעה?"
"קבע לי ביום ראשון ב־13:00 שעה לעבוד על המצגת"

🎯 תעדוף
"מה הכי חשוב שאעשה עכשיו?"

אפשר גם לשלוח לי הודעה קולית.`;
