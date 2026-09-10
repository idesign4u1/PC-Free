import { DateTime } from 'luxon';
import type { Repositories } from '../db/repositories.js';
import type { Settings, User } from '../domain/types.js';
import type { ReminderEngine } from './engine.js';
import type { BriefingService } from '../briefing/service.js';
import type { Messenger } from '../whatsapp/messenger.js';
import type { EmailScanner } from '../email/scanner.js';
import { candidateButtons } from '../whatsapp/formatter.js';
import { describeDateHe, isWithinQuietHours } from '../utils/time.js';
import { logger } from '../utils/logger.js';
import { errorText } from '../utils/errors.js';

/**
 * The single background loop.
 *
 * Every tick it:
 *   1. delivers due reminders,
 *   2. runs due scheduled jobs (briefing, end-of-day, email scan),
 *   3. re-arms the next occurrence of each recurring job.
 *
 * Job scheduling is idempotent through `dedupe_key`, so a restart, a duplicate
 * tick, or a second app instance cannot produce two morning briefings.
 */
export class Scheduler {
  private timer: NodeJS.Timeout | null = null;
  private running = false;
  private lastTickAt: Date | null = null;
  private lastError: string | null = null;

  constructor(
    private readonly repos: Repositories,
    private readonly reminders: ReminderEngine,
    private readonly briefing: BriefingService,
    private readonly messenger: Messenger,
    private readonly emailScanner: EmailScanner | null,
    private readonly options: { tickMs: number; batchSize: number },
  ) {}

  start(): void {
    if (this.timer) return;
    // Kick once immediately so a restart doesn't sit idle for a full interval.
    void this.tick();
    this.timer = setInterval(() => void this.tick(), this.options.tickMs);
    this.timer.unref?.();
    logger().info({ tickMs: this.options.tickMs }, 'scheduler started');
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  status(): { running: boolean; lastTickAt: Date | null; lastError: string | null } {
    return { running: this.timer !== null, lastTickAt: this.lastTickAt, lastError: this.lastError };
  }

  async tick(now: Date = new Date()): Promise<void> {
    if (this.running) return; // never overlap ticks
    this.running = true;
    try {
      await this.reminders.dispatchDue(now, this.options.batchSize);
      await this.runDueJobs(now);
      await this.armRecurringJobs(now);
      this.lastTickAt = now;
      this.lastError = null;
    } catch (err) {
      this.lastError = errorText(err);
      logger().error({ err: this.lastError }, 'scheduler tick failed');
    } finally {
      this.running = false;
    }
  }

  /** Public so an operator (or a test) can force a job without waiting. */
  async runDueJobs(now: Date): Promise<number> {
    const jobs = await this.repos.jobs.claimDue(now, 20);
    for (const job of jobs) {
      try {
        await this.runJob(job.job_type, job.user_id, now);
        await this.repos.jobs.finish(job.id, 'done');
      } catch (err) {
        await this.repos.jobs.finish(job.id, 'failed', errorText(err));
        logger().error({ job: job.job_type, err: errorText(err) }, 'scheduled job failed');
      }
    }
    return jobs.length;
  }

  private async runJob(jobType: string, userId: string | null, now: Date): Promise<void> {
    if (!userId) return;
    const user = await this.repos.users.findById(userId);
    if (!user || !user.is_active) return;
    const settings = await this.repos.settings.get(user.id);

    switch (jobType) {
      case 'daily_briefing': {
        if (!settings.daily_briefing_enabled) return;
        const body = await this.briefing.buildDailyBriefing(user, settings, now);
        await this.messenger.send(user, body);
        await this.repos.audit.log({
          user_id: user.id,
          action: 'SEND_DAILY_BRIEFING',
          source: 'scheduler',
        });
        return;
      }
      case 'eod_summary': {
        if (!settings.eod_summary_enabled) return;
        const body = await this.briefing.buildEndOfDay(user, now);
        await this.messenger.send(user, body);
        await this.repos.audit.log({
          user_id: user.id,
          action: 'SEND_EOD_SUMMARY',
          source: 'scheduler',
        });
        return;
      }
      case 'email_scan': {
        if (!this.emailScanner || !settings.email_scan_enabled) return;
        const outcome = await this.emailScanner.scan(user, settings, { now });
        if (outcome.candidatesCreated) await this.proposeCandidates(user, settings, now);
        return;
      }
      case 'candidate_followup': {
        await this.proposeCandidates(user, settings, now);
        return;
      }
      default:
        logger().warn({ jobType }, 'unknown scheduled job type');
    }
  }

  /**
   * Sends one pending email candidate at a time, with approve/ignore/later
   * buttons. One at a time is deliberate — a batch of six proposals at 09:00 is
   * exactly the "don't nag me" failure the spec warns about.
   */
  private async proposeCandidates(user: User, settings: Settings, now: Date): Promise<void> {
    if (
      isWithinQuietHours(now, user.timezone, settings.quiet_hours_start, settings.quiet_hours_end)
    )
      return;

    const existing = await this.repos.confirmations.findPending(user.id);
    if (existing) return; // don't stack questions

    const candidate = await this.repos.email.latestPendingCandidate(user.id);
    if (!candidate) return;
    if (candidate.status === 'snoozed' && candidate.snoozed_until && candidate.snoozed_until > now)
      return;

    const dueLine = candidate.due_date
      ? `\n\nעד ${describeDateHe(candidate.due_date, user.timezone, now)}`
      : '';
    const body = `📧 זיהיתי משימה חדשה במייל:\n\n${candidate.title}${dueLine}\n\nלהוסיף למשימות?`;

    const result = await this.messenger.send(user, body, {
      buttons: candidateButtons(candidate.id),
    });
    if (!result.sent) return;

    await this.repos.confirmations.create({
      user_id: user.id,
      kind: 'email_candidate',
      prompt: body,
      payload: { candidateId: candidate.id },
      ttlMinutes: 24 * 60,
    });
  }

  /**
   * Creates tomorrow's (or today's, if still ahead) briefing/summary/scan jobs.
   * `dedupe_key` includes the local date, so repeated calls are no-ops.
   */
  async armRecurringJobs(now: Date): Promise<void> {
    const users = await this.repos.users.listActive();
    for (const user of users) {
      const settings = await this.repos.settings.get(user.id);
      const local = DateTime.fromJSDate(now, { zone: user.timezone });

      if (settings.daily_briefing_enabled) {
        await this.armDailyJob(user, 'daily_briefing', settings.daily_briefing_time, local);
      }
      if (settings.eod_summary_enabled) {
        await this.armDailyJob(user, 'eod_summary', settings.eod_summary_time, local);
      }
      if (settings.email_scan_enabled && this.emailScanner) {
        const slot = Math.floor(now.getTime() / (settings.email_scan_interval_minutes * 60_000));
        await this.repos.jobs.schedule({
          user_id: user.id,
          job_type: 'email_scan',
          run_at: new Date((slot + 1) * settings.email_scan_interval_minutes * 60_000),
          dedupe_key: `email_scan:${user.id}:${slot + 1}`,
        });
      }
    }
  }

  private async armDailyJob(
    user: User,
    jobType: string,
    timeOfDay: string,
    local: DateTime,
  ): Promise<void> {
    const [h, m] = timeOfDay.split(':').map(Number);
    let target = local.set({ hour: h ?? 7, minute: m ?? 30, second: 0, millisecond: 0 });
    if (target <= local) target = target.plus({ days: 1 });
    await this.repos.jobs.schedule({
      user_id: user.id,
      job_type: jobType,
      run_at: target.toJSDate(),
      dedupe_key: `${jobType}:${user.id}:${target.toFormat('yyyy-MM-dd')}`,
    });
  }
}
