import type { HandlerContext, HandlerResult } from '../context.js';
import type { Intent } from '../../ai/intent-schema.js';
import { resolveDateSpec } from '../../ai/intent-engine.js';
import { formatDisambiguation, formatTaskCreated, formatTaskList } from '../../whatsapp/formatter.js';
import { addMinutes, describeDateHe, describeInstantHe, todayInZone, wallClockToInstant } from '../../utils/time.js';
import { describeRecurrenceHe } from '../../tasks/recurrence.js';
import type { Recurrence, Task } from '../../domain/types.js';

/** Turns the intent's recurrence block into the stored rule shape. */
function toRecurrence(input: NonNullable<Intent['task']>['recurrence']): Recurrence | null {
  if (!input) return null;
  return {
    freq: input.freq,
    interval: input.interval,
    byweekday: input.byweekday.length ? input.byweekday : undefined,
    bymonthday: input.bymonthday ?? undefined,
    occurrences: 0,
  };
}

export async function handleCreateTask(ctx: HandlerContext, intent: Intent): Promise<HandlerResult> {
  const spec = intent.task;
  if (!spec?.title?.trim()) {
    return { reply: 'לא הבנתי מה המשימה. אפשר לנסח שוב?' };
  }

  const due = resolveDateSpec(spec.due, ctx);
  const reminder = resolveDateSpec(spec.reminder, ctx);

  const created = await ctx.tasks.create(
    {
      user: ctx.user,
      title: spec.title.trim(),
      description: spec.description,
      priority: spec.priority,
      project: spec.project,
      client: spec.client,
      tags: spec.tags,
      due: due.date ? { date: due.date, time: due.time } : null,
      reminder: reminder.date ? { date: reminder.date, time: reminder.time } : null,
      recurrence: toRecurrence(spec.recurrence),
      source: ctx.source === 'whatsapp_voice' ? 'whatsapp_voice' : 'whatsapp',
      aiGenerated: true,
      confidence: intent.confidence,
    },
    ctx.settings,
  );

  let reply = formatTaskCreated(created.task, created.reminderAt, ctx.user.timezone, ctx.now);
  if (created.task.recurrence) reply += `\n🔁 ${describeRecurrenceHe(created.task.recurrence)}`;
  if (created.reminderDeferredFrom) reply += '\n(הזזתי את התזכורת מחוץ לשעות השקט)';
  return { reply, focusTaskId: created.task.id };
}

/** Shared resolution step: find the task the user meant, or ask. */
async function resolveTarget(
  ctx: HandlerContext,
  reference: string | null,
  actionKind: string,
  payload: Record<string, unknown>,
): Promise<{ task: Task } | { ask: HandlerResult }> {
  if (!reference?.trim()) {
    const state = await ctx.repos.conversation.get(ctx.user.id);
    if (state?.last_task_id) {
      const task = await ctx.repos.tasks.findById(ctx.user.id, state.last_task_id);
      if (task && task.status !== 'completed') return { task };
    }
    return { ask: { reply: 'על איזו משימה מדובר?' } };
  }

  const match = await ctx.tasks.resolveReference(ctx.user, reference);
  if (match.best) return { task: match.best };

  if (match.isAmbiguous && match.candidates.length) {
    return {
      ask: {
        reply: formatDisambiguation(reference, match.candidates, ctx.user.timezone, ctx.now),
        pendingConfirmation: {
          kind: 'disambiguation',
          prompt: `בחירת משימה עבור: ${reference}`,
          payload: { action: actionKind, candidates: match.candidates.map((t) => t.id), ...payload },
        },
      },
    };
  }
  return { ask: { reply: `לא מצאתי משימה שמתאימה ל"${reference}".` } };
}

export async function handleCompleteTask(ctx: HandlerContext, intent: Intent): Promise<HandlerResult> {
  const resolved = await resolveTarget(ctx, intent.task_reference ?? intent.task?.title ?? null, 'complete', {});
  if ('ask' in resolved) return resolved.ask;

  const { task, nextTask } = await ctx.tasks.complete(ctx.user, resolved.task, ctx.settings);
  let reply = `✅ סימנתי כבוצע: ${task.title}`;
  if (nextTask?.due_date) {
    reply += `\n🔁 המופע הבא: ${describeDateHe(nextTask.due_date, ctx.user.timezone, ctx.now)}`;
  }
  return { reply, focusTaskId: null };
}

export function computeSnoozeUntil(ctx: HandlerContext, intent: Intent): Date | null {
  if (intent.snooze?.minutes) return addMinutes(ctx.now, intent.snooze.minutes);
  const spec = resolveDateSpec(intent.snooze?.until ?? null, ctx);
  if (spec.date) {
    return wallClockToInstant({ date: spec.date, time: spec.time ?? '09:00', timezone: ctx.user.timezone });
  }
  return null;
}

export async function handleSnoozeTask(ctx: HandlerContext, intent: Intent): Promise<HandlerResult> {
  const resolved = await resolveTarget(ctx, intent.task_reference ?? null, 'snooze', {
    minutes: intent.snooze?.minutes ?? null,
    until: intent.snooze?.until ?? null,
  });
  if ('ask' in resolved) return resolved.ask;

  const until = computeSnoozeUntil(ctx, intent);
  if (!until) return { reply: 'לכמה זמן לדחות? אפשר "שעה", "מחר", או "יום ראשון".' };

  await ctx.tasks.snooze(ctx.user, resolved.task, until, ctx.settings);
  return {
    reply: `⏰ דחיתי: ${resolved.task.title}\nאזכיר ${describeInstantHe(until, ctx.user.timezone, ctx.now)}`,
    focusTaskId: resolved.task.id,
  };
}

export async function handleUpdateTask(ctx: HandlerContext, intent: Intent): Promise<HandlerResult> {
  const reference = intent.task_reference ?? intent.task?.title ?? null;
  const resolved = await resolveTarget(ctx, reference, 'update', {});
  if ('ask' in resolved) return resolved.ask;

  const spec = intent.task;
  const due = resolveDateSpec(spec?.due ?? null, ctx);
  const reminder = resolveDateSpec(spec?.reminder ?? null, ctx);

  if (due.date || reminder.date) {
    const updated = await ctx.tasks.reschedule(
      ctx.user,
      resolved.task,
      {
        ...(due.date ? { due: { date: due.date, time: due.time } } : {}),
        ...(reminder.date ? { reminder: { date: reminder.date, time: reminder.time } } : {}),
      },
      ctx.settings,
    );
    const when = updated.reminder_at
      ? describeInstantHe(updated.reminder_at, ctx.user.timezone, ctx.now)
      : updated.due_date
        ? describeDateHe(updated.due_date, ctx.user.timezone, ctx.now)
        : '';
    return { reply: `📅 עדכנתי: ${updated.title}${when ? `\n${when}` : ''}`, focusTaskId: updated.id };
  }

  const patch: Partial<Task> = {};
  if (spec?.priority) patch.priority = spec.priority;
  if (spec?.status) patch.status = spec.status;
  if (spec?.project) patch.project = spec.project;
  if (spec?.client) patch.client = spec.client;
  if (spec?.title && intent.task_reference && spec.title !== resolved.task.title) patch.title = spec.title;
  if (!Object.keys(patch).length) return { reply: 'מה לעדכן במשימה?' };

  const updated = await ctx.tasks.update(ctx.user, resolved.task, patch);
  return { reply: `✏️ עדכנתי: ${updated.title}`, focusTaskId: updated.id };
}

export async function handleDeleteTask(ctx: HandlerContext, intent: Intent): Promise<HandlerResult> {
  // Bulk deletion is never executed straight from a natural-language sentence.
  if (intent.is_bulk) {
    const open = await ctx.repos.tasks.list(ctx.user.id, { limit: 500 });
    return {
      reply: `⚠️ זה ימחק ${open.length} משימות פתוחות ואי אפשר לשחזר.\nלמחוק? (כן / לא)`,
      pendingConfirmation: {
        kind: 'dangerous_action',
        prompt: 'מחיקה של כל המשימות',
        payload: { action: 'bulk_delete', taskIds: open.map((t) => t.id) },
        ttlMinutes: 10,
      },
    };
  }

  const resolved = await resolveTarget(ctx, intent.task_reference ?? intent.task?.title ?? null, 'delete', {});
  if ('ask' in resolved) return resolved.ask;

  return {
    reply: `למחוק את "${resolved.task.title}"? (כן / לא)`,
    pendingConfirmation: {
      kind: 'dangerous_action',
      prompt: `מחיקת המשימה: ${resolved.task.title}`,
      payload: { action: 'delete_task', taskId: resolved.task.id },
      ttlMinutes: 10,
    },
    focusTaskId: resolved.task.id,
  };
}

export async function handleListTasks(ctx: HandlerContext, intent: Intent): Promise<HandlerResult> {
  const q = intent.query;
  const requested = q?.range ?? 'all';
  const range = requested === 'specific_date' || requested === 'date_range' ? 'all' : requested;

  const extra: { priority?: 'low' | 'normal' | 'high' | 'urgent'; project?: string; client?: string; search?: string } = {};
  if (q?.priority) extra.priority = q.priority;
  if (q?.project) extra.project = q.project;
  if (q?.client) extra.client = q.client;
  if (q?.search_text) extra.search = q.search_text;

  let tasks = await ctx.tasks.listForRange(ctx.user, range, ctx.now, extra);

  // "מה דחוף היום" shouldn't come back empty just because nothing is tagged
  // urgent — fall back to everything in the range.
  if (!tasks.length && extra.priority) {
    delete extra.priority;
    tasks = await ctx.tasks.listForRange(ctx.user, range, ctx.now, extra);
  }

  const heading =
    range === 'overdue' ? '🔴 משימות באיחור'
    : range === 'today' ? '📋 המשימות שלך להיום'
    : range === 'tomorrow' ? '📋 המשימות שלך למחר'
    : range === 'this_week' ? '📋 המשימות שלך השבוע'
    : '📋 המשימות שלך';

  return { reply: formatTaskList(tasks, ctx.user.timezone, ctx.now, heading) };
}

export async function handleSearchTasks(ctx: HandlerContext, intent: Intent): Promise<HandlerResult> {
  const q = intent.query;
  const needle = q?.search_text ?? q?.contact ?? q?.client ?? q?.project ?? intent.task_reference;
  if (!needle) return handleListTasks(ctx, intent);

  const tasks = await ctx.repos.tasks.list(ctx.user.id, {
    search: needle,
    limit: 25,
    ...(q?.status ? { statuses: [q.status] } : {}),
  });
  return { reply: formatTaskList(tasks, ctx.user.timezone, ctx.now, `🔎 תוצאות עבור "${needle}"`) };
}

/**
 * Prioritisation with a deterministic scoring core.
 *
 * The ordering comes from real signals (overdue, deadline proximity, declared
 * priority, age, in-progress). No model is asked to rank, so urgency can never
 * be invented — the explanation is generated from the same signals that
 * produced the score.
 */
export function scoreUrgency(task: Task, now: Date, today: string): { score: number; reason: string } {
  const reasons: string[] = [];
  let score = 0;

  const priorityWeight: Record<string, number> = { urgent: 40, high: 25, normal: 8, low: 0 };
  score += priorityWeight[task.priority] ?? 0;
  if (task.priority === 'urgent') reasons.push('מסומנת כדחופה');
  else if (task.priority === 'high') reasons.push('עדיפות גבוהה');

  if (task.due_at) {
    const hoursLeft = (task.due_at.getTime() - now.getTime()) / 3_600_000;
    if (hoursLeft < 0) {
      const daysLate = Math.max(1, Math.floor(-hoursLeft / 24));
      score += 50 + Math.min(daysLate * 5, 30);
      reasons.push(daysLate === 1 ? 'באיחור מאתמול' : `באיחור ${daysLate} ימים`);
    } else if (task.due_date === today) {
      score += 35;
      reasons.push('היעד היום');
    } else if (hoursLeft < 48) {
      score += 20;
      reasons.push('היעד מחר');
    } else if (hoursLeft < 168) {
      score += 10;
      reasons.push('היעד השבוע');
    }
  }

  const ageDays = (now.getTime() - task.created_at.getTime()) / 86_400_000;
  if (ageDays > 14) {
    score += 8;
    reasons.push(`פתוחה כבר ${Math.floor(ageDays)} ימים`);
  }
  if (task.status === 'in_progress') {
    score += 12;
    reasons.push('כבר התחלת אותה');
  }

  return { score, reason: reasons.length ? reasons.join(', ') : 'ללא מועד יעד — כדאי לקבוע לה זמן' };
}

export async function handlePrioritize(ctx: HandlerContext): Promise<HandlerResult> {
  const tasks = await ctx.repos.tasks.list(ctx.user.id, { limit: 100 });
  if (!tasks.length) return { reply: 'אין משימות פתוחות 🎉' };

  const today = todayInZone(ctx.user.timezone, ctx.now);
  const scored = tasks
    .map((task) => ({ task, ...scoreUrgency(task, ctx.now, today) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);

  const lines = scored.map((s, i) => `${i + 1}. ${s.task.title}\n   ${s.reason}`);
  return {
    reply: `🎯 מה שהכי כדאי לעשות עכשיו:\n\n${lines.join('\n\n')}`,
    focusTaskId: scored[0]?.task.id ?? null,
  };
}
