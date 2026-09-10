import type { HandlerContext, HandlerResult } from '../context.js';
import type { PendingConfirmation } from '../../db/repositories.js';
import { describeDateHe, describeInstantHe, formatTimeOnly, addMinutes } from '../../utils/time.js';
import { errorText } from '../../utils/errors.js';

/**
 * Resolves an answer to a question the assistant asked.
 *
 * Four question kinds:
 *  - disambiguation:   "which of these tasks?"  → answered with a number
 *  - dangerous_action: "delete X?"              → answered yes/no
 *  - conflict_choice:  "13:00 is taken, 14:30?" → answered with a number
 *  - email_candidate:  "add this to your tasks?" → answered yes/no/later
 *
 * A destructive action is only ever executed from a *confirmed* pending record
 * that this code created — never straight from a model output.
 */

function parseChoice(text: string, max: number): number | null {
  const trimmed = text.trim();
  const direct = /^([1-9]\d?)[.)]?$/.exec(trimmed);
  if (direct) {
    const n = Number(direct[1]);
    return n >= 1 && n <= max ? n : null;
  }
  const embedded = /(?:^|\s)(?:מספר\s*)?([1-9])(?:$|\s|\.)/.exec(trimmed);
  if (embedded) {
    const n = Number(embedded[1]);
    return n >= 1 && n <= max ? n : null;
  }
  const words: Record<string, number> = { הראשונה: 1, ראשונה: 1, השנייה: 2, שנייה: 2, השלישית: 3, שלישית: 3, הרביעית: 4, רביעית: 4 };
  for (const [word, n] of Object.entries(words)) {
    if (trimmed.includes(word) && n <= max) return n;
  }
  return null;
}

const YES = /^(כן|אישור|בטח|אוקיי|אוקי|ok|yes|תמחק|מחק|קדימה|אשר|✅)$/iu;
const NO = /^(לא|בטל|ביטול|עזוב|no|cancel|התעלם|❌)$/iu;

export interface ConfirmationOutcome {
  handled: boolean;
  result?: HandlerResult;
}

export async function handlePendingConfirmation(
  ctx: HandlerContext,
  pending: PendingConfirmation,
  rawText: string,
): Promise<ConfirmationOutcome> {
  const text = rawText.trim();
  const payload = pending.payload as Record<string, unknown>;

  switch (pending.kind) {
    case 'disambiguation': {
      const ids = (payload.candidates as string[]) ?? [];
      const choice = parseChoice(text, ids.length);
      if (choice === null) return { handled: false };

      await ctx.repos.confirmations.resolve(pending.id, 'confirmed');
      const task = await ctx.repos.tasks.findById(ctx.user.id, ids[choice - 1]!);
      if (!task) return { handled: true, result: { reply: 'המשימה כבר לא קיימת.' } };

      const action = String(payload.action ?? 'complete');
      if (action === 'complete') {
        const { task: done, nextTask } = await ctx.tasks.complete(ctx.user, task, ctx.settings);
        let reply = `✅ סימנתי כבוצע: ${done.title}`;
        if (nextTask?.due_date) reply += `\n🔁 המופע הבא: ${describeDateHe(nextTask.due_date, ctx.timezone, ctx.now)}`;
        return { handled: true, result: { reply, focusTaskId: null } };
      }
      if (action === 'snooze') {
        const minutes = typeof payload.minutes === 'number' ? payload.minutes : 60;
        const until = addMinutes(ctx.now, minutes);
        await ctx.tasks.snooze(ctx.user, task, until, ctx.settings);
        return {
          handled: true,
          result: { reply: `⏰ דחיתי: ${task.title}\nאזכיר ${describeInstantHe(until, ctx.timezone, ctx.now)}`, focusTaskId: task.id },
        };
      }
      if (action === 'delete') {
        return {
          handled: true,
          result: {
            reply: `למחוק את "${task.title}"? (כן / לא)`,
            pendingConfirmation: {
              kind: 'dangerous_action',
              prompt: `מחיקת המשימה: ${task.title}`,
              payload: { action: 'delete_task', taskId: task.id },
              ttlMinutes: 10,
            },
          },
        };
      }
      return { handled: true, result: { reply: `בחרת: ${task.title}`, focusTaskId: task.id } };
    }

    case 'dangerous_action': {
      if (NO.test(text)) {
        await ctx.repos.confirmations.resolve(pending.id, 'rejected');
        await ctx.repos.audit.log({
          user_id: ctx.user.id, action: 'DANGEROUS_ACTION_REJECTED', status: 'skipped',
          input: payload, entity_type: 'confirmation', entity_id: pending.id,
        });
        return { handled: true, result: { reply: 'בסדר, לא נגעתי בכלום.' } };
      }
      if (!YES.test(text)) return { handled: false };

      await ctx.repos.confirmations.resolve(pending.id, 'confirmed');
      const action = String(payload.action ?? '');

      if (action === 'delete_task') {
        const task = await ctx.repos.tasks.findById(ctx.user.id, String(payload.taskId));
        if (!task) return { handled: true, result: { reply: 'המשימה כבר לא קיימת.' } };
        await ctx.tasks.remove(ctx.user, task);
        return { handled: true, result: { reply: `🗑️ מחקתי: ${task.title}`, focusTaskId: null } };
      }

      if (action === 'bulk_delete') {
        const ids = (payload.taskIds as string[]) ?? [];
        let deleted = 0;
        for (const id of ids) {
          const task = await ctx.repos.tasks.findById(ctx.user.id, id);
          if (task && (await ctx.tasks.remove(ctx.user, task))) deleted += 1;
        }
        await ctx.repos.audit.log({
          user_id: ctx.user.id, action: 'BULK_DELETE_TASKS', status: 'success',
          result: { requested: ids.length, deleted },
        });
        return { handled: true, result: { reply: `🗑️ מחקתי ${deleted} משימות.`, focusTaskId: null } };
      }

      if (action === 'delete_event') {
        try {
          await ctx.calendar.deleteEvent(ctx.user, {
            provider: payload.provider as 'google' | 'microsoft',
            calendarId: String(payload.calendarId),
            providerEventId: String(payload.eventId),
            calendarName: '',
            icalUid: null,
            title: String(payload.title ?? ''),
            start: ctx.now,
            end: ctx.now,
            allDay: false,
            location: null,
            organizer: null,
            attendees: [],
            status: null,
            isCancelled: false,
            showAsBusy: true,
            htmlLink: null,
          });
          return { handled: true, result: { reply: `🗑️ מחקתי מהיומן: ${payload.title}` } };
        } catch (err) {
          return { handled: true, result: { reply: `לא הצלחתי למחוק את האירוע (${errorText(err)}).` } };
        }
      }
      return { handled: true, result: { reply: 'לא ברור מה לאשר.' } };
    }

    case 'conflict_choice': {
      const options = (payload.options as string[]) ?? [];
      const choice = parseChoice(text, options.length);
      if (choice === null) {
        if (NO.test(text)) {
          await ctx.repos.confirmations.resolve(pending.id, 'rejected');
          return { handled: true, result: { reply: 'בסדר, לא קבעתי כלום.' } };
        }
        return { handled: false };
      }

      await ctx.repos.confirmations.resolve(pending.id, 'confirmed');
      const start = new Date(options[choice - 1]!);
      const duration = Number(payload.durationMinutes ?? 60);
      try {
        const event = await ctx.calendar.createEvent(ctx.user, {
          title: String(payload.title),
          start,
          end: addMinutes(start, duration),
          ...(payload.location ? { location: String(payload.location) } : {}),
        });
        return {
          handled: true,
          result: {
            reply: `📅 קבעתי: ${event.title}\n${formatTimeOnly(event.start, ctx.timezone)}–${formatTimeOnly(event.end, ctx.timezone)}`,
          },
        };
      } catch (err) {
        return { handled: true, result: { reply: `לא הצלחתי לקבוע את האירוע (${errorText(err)}).` } };
      }
    }

    case 'email_candidate': {
      const candidateId = String(payload.candidateId ?? '');
      const candidate = await ctx.repos.email.findCandidate(ctx.user.id, candidateId);
      if (!candidate) return { handled: true, result: { reply: 'ההצעה כבר לא רלוונטית.' } };

      if (/^(מאוחר יותר|אחר כך|later|⏰)$/iu.test(text)) {
        await ctx.repos.confirmations.resolve(pending.id, 'confirmed');
        await ctx.repos.email.setCandidateStatus(candidate.id, 'snoozed', null, addMinutes(ctx.now, 240));
        return { handled: true, result: { reply: 'אזכיר לך על זה מאוחר יותר.' } };
      }
      if (NO.test(text)) {
        await ctx.repos.confirmations.resolve(pending.id, 'rejected');
        await ctx.repos.email.setCandidateStatus(candidate.id, 'ignored');
        await ctx.repos.audit.log({
          user_id: ctx.user.id, action: 'EMAIL_TASK_IGNORED', entity_type: 'email_task_candidate',
          entity_id: candidate.id, status: 'skipped',
        });
        return { handled: true, result: { reply: 'התעלמתי.' } };
      }
      if (!YES.test(text)) return { handled: false };

      await ctx.repos.confirmations.resolve(pending.id, 'confirmed');
      const created = await ctx.tasks.create(
        {
          user: ctx.user,
          title: candidate.title,
          description: candidate.description,
          due: candidate.due_date ? { date: candidate.due_date, time: candidate.due_time } : null,
          reminder: null,
          source: 'gmail',
          sourceId: candidate.email_message_id,
          sourceMetadata: { candidate_id: candidate.id, thread_id: candidate.thread_id },
          aiGenerated: true,
          confidence: candidate.confidence,
        },
        ctx.settings,
      );
      await ctx.repos.email.setCandidateStatus(candidate.id, 'approved', created.task.id);
      await ctx.repos.audit.log({
        user_id: ctx.user.id, action: 'EMAIL_TASK_APPROVED', entity_type: 'task',
        entity_id: created.task.id, result: { candidate_id: candidate.id },
      });
      return {
        handled: true,
        result: {
          reply: `✅ הוספתי: ${created.task.title}${candidate.due_date ? `\n📌 עד ${describeDateHe(candidate.due_date, ctx.timezone, ctx.now)}` : ''}`,
          focusTaskId: created.task.id,
        },
      };
    }

    default:
      return { handled: false };
  }
}
