import type { Repositories } from '../db/repositories.js';
import type { Settings, Task, TaskReminder, User } from '../domain/types.js';
import type { Messenger } from '../whatsapp/messenger.js';
import { formatReminder, reminderButtons } from '../whatsapp/formatter.js';
import {
  addMinutes,
  isWithinQuietHours,
  nextTimeOutsideQuietHours,
} from '../utils/time.js';
import { logger } from '../utils/logger.js';
import { errorText } from '../utils/errors.js';

export interface ReminderDispatchSummary {
  claimed: number;
  sent: number;
  deferred: number;
  cancelled: number;
  failed: number;
}

export interface ReminderTemplateConfig {
  /** Name of an approved Utility template for out-of-window reminders. */
  name: string;
  locale: string;
}

/**
 * Delivers due reminders.
 *
 * Ordering of checks, all of which can cancel a send:
 *   1. Task still exists and is still open.
 *   2. Not inside quiet hours (otherwise deferred, not dropped).
 *   3. WhatsApp 24-hour window open, or a template is configured.
 *
 * Claiming uses FOR UPDATE SKIP LOCKED, so running two app instances cannot
 * double-send.
 */
export class ReminderEngine {
  constructor(
    private readonly repos: Repositories,
    private readonly messenger: Messenger,
    private readonly template: ReminderTemplateConfig | null,
  ) {}

  async dispatchDue(now: Date, batchSize: number): Promise<ReminderDispatchSummary> {
    const summary: ReminderDispatchSummary = { claimed: 0, sent: 0, deferred: 0, cancelled: 0, failed: 0 };
    const due = await this.repos.reminders.claimDue(now, batchSize);
    summary.claimed = due.length;

    for (const reminder of due) {
      try {
        const outcome = await this.deliver(reminder, now);
        summary[outcome] += 1;
      } catch (err) {
        summary.failed += 1;
        await this.repos.reminders.markFailed(reminder.id, errorText(err));
        logger().error({ reminder: reminder.id, err: errorText(err) }, 'reminder delivery threw');
      }
    }
    return summary;
  }

  private async deliver(reminder: TaskReminder, now: Date): Promise<'sent' | 'deferred' | 'cancelled' | 'failed'> {
    const user = await this.repos.users.findById(reminder.user_id);
    const task = await this.repos.tasks.findById(reminder.user_id, reminder.task_id);

    if (!user || !task || !user.is_active) {
      await this.repos.reminders.markSent(reminder.id);
      return 'cancelled';
    }
    if (task.status === 'completed' || task.status === 'cancelled') {
      await this.repos.reminders.cancelPendingForTask(task.id);
      return 'cancelled';
    }

    const settings = await this.repos.settings.get(user.id);

    if (isWithinQuietHours(now, user.timezone, settings.quiet_hours_start, settings.quiet_hours_end)) {
      const until = nextTimeOutsideQuietHours(now, user.timezone, settings.quiet_hours_start, settings.quiet_hours_end);
      await this.repos.reminders.defer(reminder.id, until, 'quiet hours');
      return 'deferred';
    }

    const body = formatReminder(task);
    const result = await this.messenger.send(user, body, {
      buttons: reminderButtons(task.id),
      template: this.template
        ? { name: this.template.name, locale: this.template.locale, bodyParams: [task.title] }
        : null,
    });

    if (!result.sent) {
      if (result.skippedReason === 'window_closed_no_template') {
        // Retry after the window would reopen rather than failing permanently —
        // the user messaging us at any point re-opens it.
        await this.repos.reminders.defer(reminder.id, addMinutes(now, 60), 'waiting for an open messaging window');
        return 'deferred';
      }
      await this.repos.reminders.markFailed(reminder.id, result.error ?? 'send failed');
      return 'failed';
    }

    await this.repos.reminders.markSent(reminder.id);
    await this.repos.conversation.setLastTask(user.id, task.id);
    await this.repos.tasks.addEvent(user.id, task.id, 'reminder_sent', { reminder_id: reminder.id });
    await this.repos.audit.log({
      user_id: user.id,
      action: 'SEND_REMINDER',
      entity_type: 'task',
      entity_id: task.id,
      source: 'scheduler',
      result: { reminder_id: reminder.id, used_template: result.usedTemplate },
    });

    await this.scheduleFollowUp(user, settings, task, reminder, now);
    return 'sent';
  }

  /**
   * A gentle nudge if the task is still open later. Bounded by
   * `max_followups`, and never applied to a follow-up of a follow-up beyond
   * that count — the spec is explicit that this must not become nagging.
   */
  private async scheduleFollowUp(
    user: User,
    settings: Settings,
    task: Task,
    reminder: TaskReminder,
    now: Date,
  ): Promise<void> {
    if (!settings.follow_up_enabled) return;
    const nextIndex = reminder.followup_index + 1;
    if (nextIndex > settings.max_followups) return;

    let at = addMinutes(now, settings.follow_up_interval_minutes);
    if (isWithinQuietHours(at, user.timezone, settings.quiet_hours_start, settings.quiet_hours_end)) {
      at = nextTimeOutsideQuietHours(at, user.timezone, settings.quiet_hours_start, settings.quiet_hours_end);
    }
    await this.repos.reminders.create({
      task_id: task.id,
      user_id: user.id,
      remind_at: at,
      kind: 'followup',
      followup_index: nextIndex,
    });
  }
}
