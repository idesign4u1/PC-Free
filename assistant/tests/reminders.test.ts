import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/pglite.js';
import { FakeSender, testEnv } from './helpers/fakes.js';
import { buildApp, type App } from '../src/app.js';
import type { Db } from '../src/db/types.js';
import type { Settings, User } from '../src/domain/types.js';
import { instantToWallClock, wallClockToInstant } from '../src/utils/time.js';
import { nextOccurrence, describeRecurrenceHe } from '../src/tasks/recurrence.js';

const TZ = 'Asia/Jerusalem';
let db: Db;
let app: App;
let sender: FakeSender;
let user: User;
let settings: Settings;

beforeAll(async () => {
  db = await createTestDb();
  sender = new FakeSender();
  app = buildApp(testEnv(), db, { sender, ai: null });
  user = await app.repos.users.create({
    display_name: 'Shay',
    whatsapp_phone: '972500000002',
    email: 'shay@example.com',
    timezone: TZ,
  });
  settings = await app.repos.settings.get(user.id);
  // Open the 24-hour customer service window.
  await app.repos.whatsapp.recordInbound({
    user_id: user.id,
    wa_message_id: 'wamid.bootstrap',
    wa_from: user.whatsapp_phone,
    message_type: 'text',
    body: 'hi',
    payload: {},
  });
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  sender.clear();
});

describe('reminder scheduling', () => {
  it('schedules a reminder at the requested local wall clock', async () => {
    const created = await app.tasks.create(
      {
        user,
        title: 'להתקשר לדני',
        source: 'api',
        reminder: { date: '2026-09-10', time: '10:00' },
      },
      settings,
    );
    expect(instantToWallClock(created.reminderAt!, TZ)).toMatchObject({
      date: '2026-09-10',
      time: '10:00',
    });
  });

  it('defers a reminder that lands inside quiet hours', async () => {
    const created = await app.tasks.create(
      { user, title: 'משימת לילה', source: 'api', reminder: { date: '2026-09-10', time: '02:00' } },
      settings,
    );
    expect(created.reminderDeferredFrom).not.toBeNull();
    expect(instantToWallClock(created.reminderAt!, TZ).time).toBe('07:00');
  });

  it('defaults the reminder to the due moment when a deadline has a time', async () => {
    const created = await app.tasks.create(
      { user, title: 'להגיש דוח', source: 'api', due: { date: '2026-09-11', time: '18:00' } },
      settings,
    );
    expect(instantToWallClock(created.reminderAt!, TZ).time).toBe('18:00');
  });

  it('does not invent a reminder for a date-only deadline', async () => {
    const created = await app.tasks.create(
      { user, title: 'עד יום ראשון', source: 'api', due: { date: '2026-09-13', time: null } },
      settings,
    );
    expect(created.reminderAt).toBeNull();
  });
});

describe('reminder delivery', () => {
  // Earlier tests leave pending reminders dated in the past; clear them so each
  // dispatch assertion measures only its own reminder.
  beforeEach(async () => {
    await db.query(`UPDATE task_reminders SET status = 'cancelled' WHERE status = 'pending'`);
  });

  it('sends exactly one message per due reminder', async () => {
    const created = await app.tasks.create(
      {
        user,
        title: 'לשלוח חשבונית',
        source: 'api',
        reminder: { date: '2026-09-12', time: '09:00' },
      },
      settings,
    );
    const at = created.reminderAt!;

    const first = await app.reminders.dispatchDue(new Date(at.getTime() + 1000), 10);
    expect(first.sent).toBe(1);

    // A second pass must not resend — the reminder is no longer pending.
    const second = await app.reminders.dispatchDue(new Date(at.getTime() + 60_000), 10);
    expect(second.sent).toBe(0);
    expect(sender.sent.filter((s) => s.body.includes('לשלוח חשבונית'))).toHaveLength(1);
  });

  it('defers rather than delivers during quiet hours', async () => {
    const task = await app.repos.tasks.create({
      user_id: user.id,
      title: 'תזכורת בלילה',
      timezone: TZ,
      source: 'api',
    });
    const at = wallClockToInstant({ date: '2026-09-14', time: '02:30', timezone: TZ });
    await app.repos.reminders.create({ task_id: task.id, user_id: user.id, remind_at: at });

    const summary = await app.reminders.dispatchDue(new Date(at.getTime() + 1000), 10);
    expect(summary.deferred).toBe(1);
    expect(sender.sent).toHaveLength(0);

    const [reminder] = await app.repos.reminders.listForTask(task.id);
    expect(reminder!.status).toBe('pending');
    expect(instantToWallClock(reminder!.remind_at, TZ).time).toBe('07:00');
  });

  it('cancels the reminder when the task was already completed', async () => {
    const created = await app.tasks.create(
      { user, title: 'כבר בוצע', source: 'api', reminder: { date: '2026-09-15', time: '10:00' } },
      settings,
    );
    await app.tasks.complete(user, created.task, settings);

    const summary = await app.reminders.dispatchDue(
      new Date(created.reminderAt!.getTime() + 1000),
      10,
    );
    expect(summary.sent).toBe(0);
    expect(sender.sent.filter((s) => s.body.includes('כבר בוצע'))).toHaveLength(0);
  });

  it('schedules a bounded follow-up after a delivered reminder', async () => {
    const created = await app.tasks.create(
      {
        user,
        title: 'משימה עם מעקב',
        source: 'api',
        reminder: { date: '2026-09-16', time: '10:00' },
      },
      settings,
    );
    await app.reminders.dispatchDue(new Date(created.reminderAt!.getTime() + 1000), 10);

    const reminders = await app.repos.reminders.listForTask(created.task.id);
    const followups = reminders.filter((r) => r.kind === 'followup');
    expect(followups).toHaveLength(1);
    expect(followups[0]!.followup_index).toBe(1);
  });

  it('stops following up once max_followups is reached', async () => {
    await app.repos.settings.update(user.id, { max_followups: 1 } as never);
    const fresh = await app.repos.settings.get(user.id);

    const created = await app.tasks.create(
      { user, title: 'מעקב מוגבל', source: 'api', reminder: { date: '2026-09-17', time: '10:00' } },
      fresh,
    );
    let cursor = created.reminderAt!.getTime() + 1000;
    for (let i = 0; i < 4; i += 1) {
      await app.reminders.dispatchDue(new Date(cursor), 10);
      cursor += 6 * 60 * 60 * 1000;
    }
    const reminders = await app.repos.reminders.listForTask(created.task.id);
    expect(reminders.filter((r) => r.kind === 'followup')).toHaveLength(1);

    await app.repos.settings.update(user.id, { max_followups: 2 } as never);
  });
});

describe('transient delivery failures', () => {
  beforeEach(async () => {
    await db.query(`UPDATE task_reminders SET status = 'cancelled' WHERE status = 'pending'`);
    sender.shouldFail = false;
  });

  it('retries with backoff instead of dropping the reminder', async () => {
    const created = await app.tasks.create(
      {
        user,
        title: 'תזכורת שנכשלת',
        source: 'api',
        reminder: { date: '2026-09-20', time: '10:00' },
      },
      settings,
    );
    const at = created.reminderAt!;

    sender.shouldFail = true;
    const failed = await app.reminders.dispatchDue(new Date(at.getTime() + 1000), 10);
    expect(failed.deferred).toBe(1);
    expect(failed.failed).toBe(0);

    const [pending] = await app.repos.reminders.listForTask(created.task.id);
    expect(pending!.status).toBe('pending');
    // First backoff step is two minutes.
    expect(pending!.remind_at.getTime()).toBeGreaterThan(at.getTime());

    // Once WhatsApp recovers, the retry delivers.
    sender.shouldFail = false;
    const recovered = await app.reminders.dispatchDue(
      new Date(pending!.remind_at.getTime() + 1000),
      10,
    );
    expect(recovered.sent).toBe(1);
    expect(sender.sent.some((m) => m.body.includes('תזכורת שנכשלת'))).toBe(true);
  });

  it('gives up after the backoff ladder is exhausted, and records why', async () => {
    const created = await app.tasks.create(
      {
        user,
        title: 'תזכורת אבודה',
        source: 'api',
        reminder: { date: '2026-09-21', time: '10:00' },
      },
      settings,
    );
    sender.shouldFail = true;

    let cursor = created.reminderAt!.getTime() + 1000;
    let outcome = { sent: 0, deferred: 0, failed: 0, cancelled: 0, claimed: 0 };
    for (let i = 0; i < 6; i += 1) {
      outcome = await app.reminders.dispatchDue(new Date(cursor), 10);
      const [r] = await app.repos.reminders.listForTask(created.task.id);
      if (r!.status !== 'pending') break;
      cursor = r!.remind_at.getTime() + 1000;
    }
    expect(outcome.failed).toBe(1);

    const [reminder] = await app.repos.reminders.listForTask(created.task.id);
    expect(reminder!.status).toBe('failed');

    const log = await app.repos.audit.recent(20, user.id);
    expect(log.some((row) => row.action === 'SEND_REMINDER' && row.status === 'failure')).toBe(
      true,
    );
    sender.shouldFail = false;
  });
});

describe('snooze', () => {
  it('reschedules and records the new time', async () => {
    const created = await app.tasks.create(
      { user, title: 'לדחות אותי', source: 'api', reminder: { date: '2026-09-18', time: '10:00' } },
      settings,
    );
    const until = wallClockToInstant({ date: '2026-09-19', time: '09:00', timezone: TZ });
    await app.tasks.snooze(user, created.task, until, settings);

    const task = await app.repos.tasks.findById(user.id, created.task.id);
    expect(instantToWallClock(task!.reminder_at!, TZ)).toMatchObject({
      date: '2026-09-19',
      time: '09:00',
    });

    const pending = (await app.repos.reminders.listForTask(created.task.id)).filter(
      (r) => r.status === 'pending',
    );
    expect(pending).toHaveLength(1);
  });
});

describe('recurring tasks', () => {
  it('computes the next weekly occurrence on the named day', () => {
    // 2026-09-09 is a Wednesday; the rule says Sundays.
    expect(nextOccurrence({ freq: 'weekly', interval: 1, byweekday: [0] }, '2026-09-09', TZ)).toBe(
      '2026-09-13',
    );
  });

  it('rolls a monthly rule to the same day next month', () => {
    expect(nextOccurrence({ freq: 'monthly', interval: 1, bymonthday: 1 }, '2026-09-01', TZ)).toBe(
      '2026-10-01',
    );
  });

  it('clamps a monthly day that does not exist in the target month', () => {
    expect(nextOccurrence({ freq: 'monthly', interval: 1, bymonthday: 31 }, '2026-01-31', TZ)).toBe(
      '2026-02-28',
    );
  });

  it('ends the series after `count` occurrences', () => {
    expect(
      nextOccurrence({ freq: 'daily', interval: 1, count: 3, occurrences: 2 }, '2026-09-09', TZ),
    ).toBeNull();
  });

  it('ends the series past `until`', () => {
    expect(
      nextOccurrence({ freq: 'daily', interval: 1, until: '2026-09-09' }, '2026-09-09', TZ),
    ).toBeNull();
  });

  it('spawns the next occurrence on completion', async () => {
    const created = await app.tasks.create(
      {
        user,
        title: 'לבדוק חשבוניות',
        source: 'api',
        due: { date: '2026-09-13', time: '09:00' },
        recurrence: { freq: 'weekly', interval: 1, byweekday: [0], occurrences: 0 },
      },
      settings,
    );
    const { nextTask } = await app.tasks.complete(user, created.task, settings);
    expect(nextTask).not.toBeNull();
    expect(nextTask!.due_date).toBe('2026-09-20');
    expect(nextTask!.recurrence?.occurrences).toBe(1);
    expect(nextTask!.parent_task_id).toBe(created.task.id);
  });

  it('describes a rule in Hebrew', () => {
    expect(describeRecurrenceHe({ freq: 'weekly', interval: 1, byweekday: [0] })).toBe(
      'כל יום ראשון',
    );
    expect(describeRecurrenceHe({ freq: 'monthly', interval: 1, bymonthday: 1 })).toBe(
      'ב-1 לכל חודש',
    );
    expect(describeRecurrenceHe({ freq: 'daily', interval: 1 })).toBe('כל יום');
  });
});

describe('the 24-hour customer service window', () => {
  it('reports the window open right after an inbound message', async () => {
    expect(await app.messenger.isWindowOpen(user, new Date())).toBe(true);
  });

  it('skips a proactive send with no template once the window has closed', async () => {
    const other = await app.repos.users.create({
      display_name: 'Silent',
      whatsapp_phone: '972500000099',
      timezone: TZ,
    });
    const result = await app.messenger.send(other, 'תזכורת יזומה');
    expect(result.sent).toBe(false);
    expect(result.skippedReason).toBe('window_closed_no_template');
    expect(sender.sent).toHaveLength(0);
  });

  it('falls back to a template when one is configured', async () => {
    const templated = buildApp(testEnv({ WHATSAPP_TEMPLATE_REMINDER_NAME: 'task_reminder' }), db, {
      sender,
      ai: null,
    });
    const other = await app.repos.users.findByPhone('972500000099');
    const result = await templated.messenger.send(other!, 'תזכורת', {
      template: { name: 'task_reminder', locale: 'he', bodyParams: ['משימה'] },
    });
    expect(result.sent).toBe(true);
    expect(result.usedTemplate).toBe(true);
  });
});
