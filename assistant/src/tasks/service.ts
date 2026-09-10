import type { Repositories } from '../db/repositories.js';
import type { Recurrence, Settings, Task, TaskPriority, TaskSource, TaskStatus, User } from '../domain/types.js';
import { OPEN_STATUSES } from '../domain/types.js';
import {
  addMinutes,
  instantToWallClock,
  isWithinQuietHours,
  localDayRange,
  localWeekRange,
  nextTimeOutsideQuietHours,
  todayInZone,
  wallClockToInstant,
  type LocalDate,
} from '../utils/time.js';
import { bumpOccurrence, nextOccurrence } from './recurrence.js';
import { matchTask, type MatchResult } from './matcher.js';

export interface CreateTaskRequest {
  user: User;
  title: string;
  description?: string | null;
  priority?: TaskPriority | null;
  status?: TaskStatus;
  project?: string | null;
  client?: string | null;
  tags?: string[];
  due?: { date: LocalDate | null; time: string | null } | null;
  reminder?: { date: LocalDate | null; time: string | null } | null;
  recurrence?: Recurrence | null;
  source: TaskSource;
  sourceId?: string | null;
  sourceUrl?: string | null;
  sourceMetadata?: Record<string, unknown>;
  aiGenerated?: boolean;
  confidence?: number | null;
}

export interface CreateTaskResult {
  task: Task;
  reminderAt: Date | null;
  /** Set when the reminder was moved out of quiet hours. */
  reminderDeferredFrom: Date | null;
}

/**
 * The single writer for tasks and their reminders.
 *
 * Everything that mutates a task goes through here so that the audit log, the
 * per-task event history and the reminder schedule stay consistent — an
 * orchestrator handler can never update a due date and forget the reminder.
 */
export class TaskService {
  constructor(private readonly repos: Repositories) {}

  async create(req: CreateTaskRequest, settings: Settings): Promise<CreateTaskResult> {
    const tz = req.user.timezone;
    const dueDate = req.due?.date ?? null;
    const dueTime = req.due?.time ?? null;
    const dueAt = dueDate ? wallClockToInstant({ date: dueDate, time: dueTime, timezone: tz }) : null;

    // A reminder defaults to the due moment when a time was given, so
    // "עד יום ראשון ב-18:00" still pings without the user asking twice.
    let reminderDate = req.reminder?.date ?? null;
    let reminderTime = req.reminder?.time ?? null;
    if (!reminderDate && dueDate && dueTime) {
      reminderDate = dueDate;
      reminderTime = dueTime;
    }

    let reminderAt = reminderDate
      ? wallClockToInstant({ date: reminderDate, time: reminderTime ?? '09:00', timezone: tz })
      : null;
    if (reminderAt && settings.default_reminder_lead_minutes > 0 && req.reminder?.date == null) {
      reminderAt = addMinutes(reminderAt, -settings.default_reminder_lead_minutes);
    }

    let deferredFrom: Date | null = null;
    if (reminderAt && isWithinQuietHours(reminderAt, tz, settings.quiet_hours_start, settings.quiet_hours_end)) {
      deferredFrom = reminderAt;
      reminderAt = nextTimeOutsideQuietHours(reminderAt, tz, settings.quiet_hours_start, settings.quiet_hours_end);
    }

    const task = await this.repos.tasks.create({
      user_id: req.user.id,
      title: req.title.trim(),
      description: req.description ?? null,
      status: req.status ?? 'open',
      priority: req.priority ?? 'normal',
      due_date: dueDate,
      due_time: dueTime,
      due_at: dueAt,
      timezone: tz,
      reminder_at: reminderAt,
      source: req.source,
      source_id: req.sourceId ?? null,
      source_url: req.sourceUrl ?? null,
      source_metadata: req.sourceMetadata ?? {},
      project: req.project ?? null,
      client: req.client ?? null,
      tags: req.tags ?? [],
      recurrence: req.recurrence ?? null,
      confidence_score: req.confidence ?? null,
      ai_generated: req.aiGenerated ?? false,
    });

    if (reminderAt) {
      await this.repos.reminders.create({ task_id: task.id, user_id: req.user.id, remind_at: reminderAt });
    }
    await this.repos.tasks.addEvent(req.user.id, task.id, 'created', { source: req.source });
    await this.repos.audit.log({
      user_id: req.user.id,
      action: 'CREATE_TASK',
      entity_type: 'task',
      entity_id: task.id,
      source: req.source,
      input: { title: task.title, due_date: dueDate, reminder_at: reminderAt },
      result: { id: task.id },
    });

    return { task, reminderAt, reminderDeferredFrom: deferredFrom };
  }

  /** Reschedules a task's due date and/or reminder, keeping both in sync. */
  async reschedule(
    user: User,
    task: Task,
    changes: { due?: { date: LocalDate | null; time: string | null } | null; reminder?: { date: LocalDate | null; time: string | null } | null },
    settings: Settings,
  ): Promise<Task> {
    const tz = task.timezone || user.timezone;
    const patch: Partial<Task> = {};

    if (changes.due !== undefined) {
      const d = changes.due?.date ?? null;
      const t = changes.due?.time ?? null;
      patch.due_date = d;
      patch.due_time = t;
      patch.due_at = d ? wallClockToInstant({ date: d, time: t, timezone: tz }) : null;
    }

    if (changes.reminder !== undefined) {
      await this.repos.reminders.cancelPendingForTask(task.id);
      const d = changes.reminder?.date ?? null;
      if (d) {
        let at = wallClockToInstant({ date: d, time: changes.reminder?.time ?? '09:00', timezone: tz });
        if (isWithinQuietHours(at, tz, settings.quiet_hours_start, settings.quiet_hours_end)) {
          at = nextTimeOutsideQuietHours(at, tz, settings.quiet_hours_start, settings.quiet_hours_end);
        }
        patch.reminder_at = at;
        await this.repos.reminders.create({ task_id: task.id, user_id: user.id, remind_at: at });
      } else {
        patch.reminder_at = null;
      }
    } else if (changes.due !== undefined && patch.due_at && task.reminder_at) {
      // Moving the due date carries an existing reminder with it.
      await this.repos.reminders.cancelPendingForTask(task.id);
      let at = patch.due_at;
      if (isWithinQuietHours(at, tz, settings.quiet_hours_start, settings.quiet_hours_end)) {
        at = nextTimeOutsideQuietHours(at, tz, settings.quiet_hours_start, settings.quiet_hours_end);
      }
      patch.reminder_at = at;
      await this.repos.reminders.create({ task_id: task.id, user_id: user.id, remind_at: at });
    }

    const updated = (await this.repos.tasks.update(user.id, task.id, patch)) ?? task;
    await this.repos.tasks.addEvent(user.id, task.id, 'rescheduled', {
      due_date: updated.due_date,
      reminder_at: updated.reminder_at,
    });
    await this.repos.audit.log({
      user_id: user.id,
      action: 'UPDATE_TASK',
      entity_type: 'task',
      entity_id: task.id,
      input: changes as Record<string, unknown>,
      result: { due_date: updated.due_date, reminder_at: updated.reminder_at },
    });
    return updated;
  }

  async update(user: User, task: Task, patch: Partial<Task>): Promise<Task> {
    const updated = (await this.repos.tasks.update(user.id, task.id, patch)) ?? task;
    await this.repos.tasks.addEvent(user.id, task.id, 'updated', patch as Record<string, unknown>);
    await this.repos.audit.log({
      user_id: user.id, action: 'UPDATE_TASK', entity_type: 'task', entity_id: task.id,
      input: patch as Record<string, unknown>, result: { id: task.id },
    });
    return updated;
  }

  /**
   * Completes a task. A recurring task spawns its next occurrence rather than
   * disappearing.
   */
  async complete(user: User, task: Task, settings: Settings): Promise<{ task: Task; nextTask: Task | null }> {
    await this.repos.reminders.cancelPendingForTask(task.id);
    const updated =
      (await this.repos.tasks.update(user.id, task.id, { status: 'completed', completed_at: new Date() })) ?? task;
    await this.repos.tasks.addEvent(user.id, task.id, 'completed', {});
    await this.repos.audit.log({
      user_id: user.id, action: 'COMPLETE_TASK', entity_type: 'task', entity_id: task.id,
      result: { title: task.title },
    });

    let nextTask: Task | null = null;
    if (task.recurrence) {
      const anchor = task.due_date ?? todayInZone(task.timezone);
      const nextDate = nextOccurrence(task.recurrence, anchor, task.timezone);
      if (nextDate) {
        const created = await this.create(
          {
            user,
            title: task.title,
            description: task.description,
            priority: task.priority,
            project: task.project,
            client: task.client,
            tags: task.tags,
            due: { date: nextDate, time: task.due_time },
            reminder: task.reminder_at
              ? { date: nextDate, time: instantToWallClock(task.reminder_at, task.timezone).time }
              : null,
            recurrence: bumpOccurrence(task.recurrence),
            source: task.source,
            sourceMetadata: { recurring_parent: task.id },
          },
          settings,
        );
        nextTask = created.task;
        await this.repos.tasks.update(user.id, created.task.id, { parent_task_id: task.id });
      }
    }
    return { task: updated, nextTask };
  }

  async snooze(user: User, task: Task, until: Date, settings: Settings): Promise<Task> {
    let at = until;
    if (isWithinQuietHours(at, task.timezone, settings.quiet_hours_start, settings.quiet_hours_end)) {
      at = nextTimeOutsideQuietHours(at, task.timezone, settings.quiet_hours_start, settings.quiet_hours_end);
    }
    await this.repos.reminders.cancelPendingForTask(task.id);
    await this.repos.reminders.create({ task_id: task.id, user_id: user.id, remind_at: at });
    const updated =
      (await this.repos.tasks.update(user.id, task.id, { snoozed_until: at, reminder_at: at })) ?? task;
    await this.repos.tasks.addEvent(user.id, task.id, 'snoozed', { until: at.toISOString() });
    await this.repos.audit.log({
      user_id: user.id, action: 'SNOOZE_TASK', entity_type: 'task', entity_id: task.id,
      result: { until: at.toISOString() },
    });
    return updated;
  }

  async cancel(user: User, task: Task): Promise<Task> {
    await this.repos.reminders.cancelPendingForTask(task.id);
    const updated = (await this.repos.tasks.update(user.id, task.id, { status: 'cancelled' })) ?? task;
    await this.repos.tasks.addEvent(user.id, task.id, 'cancelled', {});
    await this.repos.audit.log({
      user_id: user.id, action: 'CANCEL_TASK', entity_type: 'task', entity_id: task.id,
    });
    return updated;
  }

  async remove(user: User, task: Task): Promise<boolean> {
    const ok = await this.repos.tasks.delete(user.id, task.id);
    await this.repos.audit.log({
      user_id: user.id, action: 'DELETE_TASK', entity_type: 'task', entity_id: task.id,
      result: { deleted: ok, title: task.title }, status: ok ? 'success' : 'failure',
    });
    return ok;
  }

  /** Resolves a free-text reference against the user's open tasks. */
  async resolveReference(user: User, reference: string, opts: { includeCompleted?: boolean } = {}): Promise<MatchResult> {
    const tasks = await this.repos.tasks.list(user.id, {
      statuses: opts.includeCompleted ? [...OPEN_STATUSES, 'completed'] : OPEN_STATUSES,
      limit: 200,
      includeSnoozed: true,
    });
    return matchTask(reference, tasks);
  }

  async listForRange(
    user: User,
    range: 'today' | 'tomorrow' | 'this_week' | 'next_week' | 'overdue' | 'all',
    now: Date,
    extra: { priority?: TaskPriority; project?: string; client?: string; search?: string } = {},
  ): Promise<Task[]> {
    const tz = user.timezone;
    const today = todayInZone(tz, now);
    const base = { limit: 100, ...extra } as Parameters<Repositories['tasks']['list']>[1];

    switch (range) {
      case 'today': {
        const { end } = localDayRange(today, tz);
        return this.repos.tasks.list(user.id, { ...base, dueBefore: end });
      }
      case 'tomorrow': {
        const { start, end } = localDayRange(
          instantToWallClock(addMinutes(wallClockToInstant({ date: today, time: '12:00', timezone: tz }), 1440), tz).date,
          tz,
        );
        return this.repos.tasks.list(user.id, { ...base, dueAfter: start, dueBefore: end });
      }
      case 'this_week': {
        const { start, end } = localWeekRange(today, tz);
        return this.repos.tasks.list(user.id, { ...base, dueAfter: start, dueBefore: end });
      }
      case 'next_week': {
        const { end } = localWeekRange(today, tz);
        const nextEnd = new Date(end.getTime() + 7 * 86_400_000);
        return this.repos.tasks.list(user.id, { ...base, dueAfter: end, dueBefore: nextEnd });
      }
      case 'overdue':
        return this.repos.tasks.list(user.id, { ...base, overdueAsOf: now });
      case 'all':
      default:
        return this.repos.tasks.list(user.id, base);
    }
  }
}
