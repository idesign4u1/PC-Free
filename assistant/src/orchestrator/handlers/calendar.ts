import type { HandlerContext, HandlerResult } from '../context.js';
import type { Intent } from '../../ai/intent-schema.js';
import { resolveDateSpec } from '../../ai/intent-engine.js';
import { formatAgenda, formatFreeSlots } from '../../whatsapp/formatter.js';
import {
  addDaysLocal,
  addMinutes,
  describeDateHe,
  formatTimeOnly,
  localDayRange,
  localWeekRange,
  todayInZone,
  wallClockToInstant,
  type LocalDate,
} from '../../utils/time.js';
import { errorText, ReauthRequiredError } from '../../utils/errors.js';

/** Resolves the local date a calendar question is about. */
function targetDate(
  ctx: HandlerContext,
  intent: Intent,
): { date: LocalDate; label: string; isWeek: boolean } {
  const today = todayInZone(ctx.timezone, ctx.now);
  const q = intent.query;

  if (q?.range === 'this_week' || q?.range === 'next_week') {
    return { date: today, label: q.range === 'this_week' ? 'השבוע' : 'שבוע הבא', isWeek: true };
  }
  const spec = resolveDateSpec(q?.date ?? null, ctx);
  if (spec.date)
    return {
      date: spec.date,
      label: describeDateHe(spec.date, ctx.timezone, ctx.now),
      isWeek: false,
    };

  if (q?.range === 'tomorrow') {
    return { date: addDaysLocal(today, 1, ctx.timezone), label: 'מחר', isWeek: false };
  }
  return { date: today, label: 'היום', isWeek: false };
}

export async function handleCalendarQuery(
  ctx: HandlerContext,
  intent: Intent,
): Promise<HandlerResult> {
  const accounts = await ctx.calendar.accounts(ctx.user);
  if (!accounts.length) {
    return { reply: 'עדיין לא חיברת יומן. שלח /connect כדי לחבר Google או Outlook.' };
  }

  const target = targetDate(ctx, intent);

  if (target.isWeek) {
    const week = localWeekRange(target.date, ctx.timezone);
    const range =
      intent.query?.range === 'next_week'
        ? { start: week.end, end: new Date(week.end.getTime() + 7 * 86_400_000) }
        : { start: week.start, end: week.end };
    const { events, degraded } = await ctx.calendar.fetchRange(ctx.user, range);
    if (!events.length)
      return { reply: formatAgenda([], ctx.timezone, `📅 ${target.label}`, degraded) };

    // Group by local day so a week reads as a week, not a wall of times.
    const byDay = new Map<string, typeof events>();
    for (const event of events) {
      const key = new Date(event.start).toLocaleDateString('en-CA', { timeZone: ctx.timezone });
      const list = byDay.get(key) ?? [];
      list.push(event);
      byDay.set(key, list);
    }
    const sections = [...byDay.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([day, dayEvents]) => {
        const lines = dayEvents.map(
          (e) => `${e.allDay ? 'כל היום' : formatTimeOnly(e.start, ctx.timezone)}  ${e.title}`,
        );
        return `${describeDateHe(day, ctx.timezone, ctx.now)}\n${lines.join('\n')}`;
      });
    return {
      reply: `📅 ${target.label}\n\n${sections.join('\n\n')}${degraded.length ? `\n\n⚠️ ${degraded.join(' ')}` : ''}`,
      degraded,
    };
  }

  const { events, degraded } = await ctx.calendar.fetchDay(ctx.user, target.date);
  return { reply: formatAgenda(events, ctx.timezone, `📅 ${target.label}`, degraded), degraded };
}

export async function handleFreeTimeQuery(
  ctx: HandlerContext,
  intent: Intent,
): Promise<HandlerResult> {
  const accounts = await ctx.calendar.accounts(ctx.user);
  if (!accounts.length) return { reply: 'עדיין לא חיברת יומן, אז אני לא יודע מתי אתה פנוי.' };

  const target = targetDate(ctx, intent);
  const minMinutes = intent.query?.slot_minutes ?? 60;
  const today = todayInZone(ctx.timezone, ctx.now);

  const { slots, degraded } = await ctx.calendar.freeSlots(ctx.user, target.date, {
    minMinutes,
    dayStart: ctx.settings.workday_start,
    dayEnd: ctx.settings.workday_end,
    ...(target.date === today ? { notBefore: ctx.now } : {}),
  });

  const heading = `🕐 ${target.label} אתה פנוי${minMinutes !== 60 ? ` (${minMinutes} דקות)` : ''}:`;
  const body = formatFreeSlots(slots, ctx.timezone, heading);
  return { reply: degraded.length ? `${body}\n\n⚠️ ${degraded.join(' ')}` : body, degraded };
}

export async function handleCreateEvent(
  ctx: HandlerContext,
  intent: Intent,
): Promise<HandlerResult> {
  const spec = intent.event;
  if (!spec?.title?.trim()) return { reply: 'מה לקבוע ביומן?' };

  const when = resolveDateSpec(spec.start, ctx);
  if (!when.date || !when.time) {
    return { reply: `מתי לקבוע את "${spec.title}"? צריך תאריך ושעה.` };
  }

  const duration = spec.duration_minutes ?? 60;
  const start = wallClockToInstant({ date: when.date, time: when.time, timezone: ctx.timezone });
  const end = addMinutes(start, duration);

  let conflicts;
  let degraded: string[] = [];
  try {
    const result = await ctx.calendar.conflictsFor(ctx.user, { start, end });
    conflicts = result.conflicts;
    degraded = result.degraded;
  } catch (err) {
    return { reply: `לא הצלחתי לבדוק את היומן כרגע (${errorText(err)}). לא קבעתי כלום.` };
  }

  // Never create over an existing commitment — offer alternatives instead.
  if (conflicts.length) {
    const { slots } = await ctx.calendar.freeSlots(ctx.user, when.date, {
      minMinutes: duration,
      dayStart: ctx.settings.workday_start,
      dayEnd: ctx.settings.workday_end,
    });
    const options = slots.slice(0, 3).map((s) => formatTimeOnly(s.start, ctx.timezone));
    const conflictName = conflicts[0]!.title;
    const reply = options.length
      ? `ב־${when.time} כבר יש לך "${conflictName}".\n\nאתה פנוי ב:\n${options.join('\n')}\n\nרוצה שאקבע באחת מהשעות?`
      : `ב־${when.time} כבר יש לך "${conflictName}", ולא מצאתי חלון פנוי אחר באותו יום.`;
    return {
      reply,
      ...(options.length
        ? {
            pendingConfirmation: {
              kind: 'conflict_choice',
              prompt: `בחירת שעה חלופית עבור "${spec.title}"`,
              payload: {
                action: 'create_event',
                title: spec.title,
                date: when.date,
                durationMinutes: duration,
                options: slots.slice(0, 3).map((s) => s.start.toISOString()),
                location: spec.location ?? null,
              },
              ttlMinutes: 20,
            },
          }
        : {}),
      degraded,
    };
  }

  try {
    const event = await ctx.calendar.createEvent(ctx.user, {
      title: spec.title,
      start,
      end,
      ...(spec.location ? { location: spec.location } : {}),
    });
    const label = describeDateHe(when.date, ctx.timezone, ctx.now);
    return {
      reply: `📅 קבעתי: ${event.title}\n${label} ${when.time}–${formatTimeOnly(end, ctx.timezone)}`,
      degraded,
    };
  } catch (err) {
    if (err instanceof ReauthRequiredError) {
      return { reply: 'היומן מנותק — צריך לחבר אותו מחדש (/connect).' };
    }
    return { reply: 'לא הצלחתי לקבוע את האירוע ביומן כרגע. שמרתי את הפרטים בלוג.' };
  }
}

/**
 * Moving an existing event.
 *
 * Neither Google nor Microsoft is edited in place here: we delete and recreate,
 * which is correct for a personal time block but would silently drop the guest
 * list on a meeting. So an event with attendees is never moved automatically —
 * the assistant says who is on it and leaves the decision to the user.
 */
export async function handleUpdateEvent(
  ctx: HandlerContext,
  intent: Intent,
): Promise<HandlerResult> {
  const spec = intent.event;
  const reference = spec?.title ?? intent.task_reference;
  if (!reference) return { reply: 'איזה אירוע להזיז?' };

  const when = resolveDateSpec(spec?.start ?? null, ctx);
  if (!when.date || !when.time) {
    return { reply: `לאיזו שעה להזיז את "${reference}"? צריך תאריך ושעה.` };
  }

  // Look for the event across a window around both the old and the new date.
  const today = todayInZone(ctx.timezone, ctx.now);
  const searchStart = localDayRange(today, ctx.timezone).start;
  const searchEnd = new Date(localDayRange(when.date, ctx.timezone).end.getTime() + 7 * 86_400_000);
  const { events, degraded } = await ctx.calendar.fetchRange(ctx.user, {
    start: searchStart,
    end: searchEnd,
  });

  const matches = events.filter((e) => e.title.toLowerCase().includes(reference.toLowerCase()));
  if (!matches.length) return { reply: `לא מצאתי ביומן אירוע בשם "${reference}".`, degraded };
  if (matches.length > 1) {
    const list = matches
      .slice(0, 5)
      .map(
        (e, i) =>
          `${i + 1}. ${describeDateHe(
            new Date(e.start).toLocaleDateString('en-CA', { timeZone: ctx.timezone }),
            ctx.timezone,
            ctx.now,
          )} ${formatTimeOnly(e.start, ctx.timezone)} — ${e.title}`,
      )
      .join('\n');
    return { reply: `מצאתי כמה אירועים בשם הזה:\n\n${list}\n\nאיזה מהם להזיז?`, degraded };
  }

  const event = matches[0]!;
  if (event.attendees.length > 0) {
    return {
      reply:
        `ל"${event.title}" יש ${event.attendees.length} משתתפים, ואם אזיז אותו דרכי הם עלולים לאבד את ההזמנה.\n` +
        'עדיף להזיז אותו ישירות ביומן.',
      degraded,
    };
  }

  const duration =
    spec?.duration_minutes ??
    Math.max(15, Math.round((event.end.getTime() - event.start.getTime()) / 60_000));
  const newStart = wallClockToInstant({ date: when.date, time: when.time, timezone: ctx.timezone });
  const newEnd = addMinutes(newStart, duration);

  const { conflicts } = await ctx.calendar.conflictsFor(ctx.user, { start: newStart, end: newEnd });
  const realConflicts = conflicts.filter((c) => c.providerEventId !== event.providerEventId);
  if (realConflicts.length) {
    return {
      reply: `ב־${when.time} כבר יש לך "${realConflicts[0]!.title}". לא הזזתי כלום.`,
      degraded,
    };
  }

  try {
    await ctx.calendar.createEvent(ctx.user, {
      title: event.title,
      start: newStart,
      end: newEnd,
      ...(event.location ? { location: event.location } : {}),
    });
    await ctx.calendar.deleteEvent(ctx.user, event);
  } catch (err) {
    if (err instanceof ReauthRequiredError)
      return { reply: 'היומן מנותק — צריך לחבר אותו מחדש (/connect).' };
    return { reply: `לא הצלחתי להזיז את האירוע (${errorText(err)}).`, degraded };
  }

  return {
    reply: `📅 הזזתי: ${event.title}\n${describeDateHe(when.date, ctx.timezone, ctx.now)} ${when.time}–${formatTimeOnly(newEnd, ctx.timezone)}`,
    degraded,
  };
}

export async function handleDeleteEvent(
  ctx: HandlerContext,
  intent: Intent,
): Promise<HandlerResult> {
  const title = intent.event?.title ?? intent.task_reference;
  if (!title) return { reply: 'איזה אירוע למחוק?' };

  const when = resolveDateSpec(intent.event?.start ?? null, ctx);
  const date = when.date ?? todayInZone(ctx.timezone, ctx.now);
  const { events } = await ctx.calendar.fetchDay(ctx.user, date);
  const matches = events.filter((e) => e.title.toLowerCase().includes(title.toLowerCase()));

  if (!matches.length)
    return {
      reply: `לא מצאתי אירוע בשם "${title}" ב־${describeDateHe(date, ctx.timezone, ctx.now)}.`,
    };
  if (matches.length > 1) {
    const list = matches
      .map((e, i) => `${i + 1}. ${formatTimeOnly(e.start, ctx.timezone)} ${e.title}`)
      .join('\n');
    return { reply: `מצאתי כמה אירועים:\n\n${list}\n\nאיזה מהם למחוק? (מספר)` };
  }

  const event = matches[0]!;
  return {
    reply: `למחוק מהיומן את "${event.title}" (${formatTimeOnly(event.start, ctx.timezone)})? (כן / לא)`,
    pendingConfirmation: {
      kind: 'dangerous_action',
      prompt: `מחיקת אירוע: ${event.title}`,
      payload: {
        action: 'delete_event',
        provider: event.provider,
        calendarId: event.calendarId,
        eventId: event.providerEventId,
        title: event.title,
      },
      ttlMinutes: 10,
    },
  };
}
