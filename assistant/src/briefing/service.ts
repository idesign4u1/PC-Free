import type { Repositories } from '../db/repositories.js';
import type { Settings, User } from '../domain/types.js';
import type { CalendarService } from '../calendar/service.js';
import type { TaskService } from '../tasks/service.js';
import { formatTimeOnly, localDayRange, todayInZone, addDaysLocal } from '../utils/time.js';
import { scoreUrgency } from '../orchestrator/handlers/tasks.js';

/**
 * Morning briefing and end-of-day summary.
 *
 * Both are assembled from real data only. If a calendar is unreachable the
 * briefing says so instead of quietly reporting "0 meetings".
 */
export class BriefingService {
  constructor(
    private readonly repos: Repositories,
    private readonly tasks: TaskService,
    private readonly calendar: CalendarService,
  ) {}

  async buildDailyBriefing(user: User, _settings: Settings, now: Date): Promise<string> {
    const tz = user.timezone;
    const today = todayInZone(tz, now);

    const [openTasks, overdue, calendarResult] = await Promise.all([
      this.tasks.listForRange(user, 'today', now, {}),
      this.tasks.listForRange(user, 'overdue', now, {}),
      this.calendar
        .fetchDay(user, today)
        .catch(() => ({
          events: [],
          degraded: ['לא הצלחתי לקרוא את היומן.'],
          healthy: [],
          needsReauth: [],
        })),
    ]);
    const allOpen = await this.repos.tasks.list(user.id, { limit: 200 });

    const timed = calendarResult.events.filter((e) => !e.allDay);
    const lines: string[] = [`☀️ בוקר טוב ${user.display_name}`, '', 'היום שלך:', ''];

    if (calendarResult.degraded.length) {
      lines.push(`📅 ${timed.length} פגישות (מידע חלקי)`);
    } else {
      lines.push(`📅 ${timed.length} ${timed.length === 1 ? 'פגישה' : 'פגישות'}`);
    }
    lines.push(`✅ ${allOpen.length} ${allOpen.length === 1 ? 'משימה פתוחה' : 'משימות פתוחות'}`);
    if (overdue.length)
      lines.push(`🔴 ${overdue.length} ${overdue.length === 1 ? 'משימה באיחור' : 'משימות באיחור'}`);

    const focus = [...overdue, ...openTasks]
      .filter((t, i, arr) => arr.findIndex((o) => o.id === t.id) === i)
      .map((task) => ({ task, ...scoreUrgency(task, now, today) }))
      .sort((a, b) => b.score - a.score)
      .slice(0, 3);

    if (focus.length) {
      lines.push('', 'הדברים החשובים ביותר:', '');
      focus.forEach((f, i) => lines.push(`${i + 1}. ${f.task.title}`));
    }

    const firstMeeting = timed.find((e) => e.end > now) ?? timed[0];
    if (firstMeeting) {
      lines.push(
        '',
        'פגישה ראשונה:',
        '',
        `${formatTimeOnly(firstMeeting.start, tz)} – ${firstMeeting.title}`,
      );
    }
    if (calendarResult.degraded.length) lines.push('', `⚠️ ${calendarResult.degraded.join(' ')}`);

    return lines.join('\n');
  }

  async buildEndOfDay(user: User, now: Date): Promise<string> {
    const tz = user.timezone;
    const today = todayInZone(tz, now);
    const { start, end } = localDayRange(today, tz);

    const [completed, remaining, overdue] = await Promise.all([
      this.repos.tasks.completedBetween(user.id, start, end),
      this.tasks.listForRange(user, 'today', now, {}),
      this.tasks.listForRange(user, 'overdue', now, {}),
    ]);

    const tomorrow = addDaysLocal(today, 1, tz);
    const tomorrowCal = await this.calendar
      .fetchDay(user, tomorrow)
      .catch(() => ({
        events: [],
        degraded: ['לא הצלחתי לקרוא את היומן למחר.'],
        healthy: [],
        needsReauth: [],
      }));
    const tomorrowMeetings = tomorrowCal.events.filter((e) => !e.allDay).length;

    const lines = ['🌙 סיכום היום', '', `בוצעו: ${completed.length}`, `נשארו: ${remaining.length}`];
    if (overdue.length) lines.push(`באיחור: ${overdue.length}`);
    lines.push(
      '',
      tomorrowMeetings
        ? `מחר יש לך ${tomorrowMeetings} ${tomorrowMeetings === 1 ? 'פגישה' : 'פגישות'}.`
        : 'מחר היומן פנוי.',
    );
    if (tomorrowCal.degraded.length) lines.push('', `⚠️ ${tomorrowCal.degraded.join(' ')}`);

    return lines.join('\n');
  }
}
