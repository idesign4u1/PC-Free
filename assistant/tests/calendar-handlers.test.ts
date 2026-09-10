import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/pglite.js';
import { FakeSender, testEnv } from './helpers/fakes.js';
import { buildApp, type App } from '../src/app.js';
import type { Db } from '../src/db/types.js';
import type { Settings, UnifiedEvent, User } from '../src/domain/types.js';
import type { HandlerContext } from '../src/orchestrator/context.js';
import {
  handleCalendarQuery,
  handleCreateEvent,
  handleFreeTimeQuery,
  handleUpdateEvent,
} from '../src/orchestrator/handlers/calendar.js';
import { handlePendingConfirmation } from '../src/orchestrator/handlers/confirmations.js';
import { emptyIntent, type Intent } from '../src/ai/intent-schema.js';
import type { CalendarService } from '../src/calendar/service.js';
import { mergeCalendars } from '../src/calendar/merge.js';
import { computeFreeSlots, findConflicts } from '../src/calendar/freebusy.js';

const TZ = 'Asia/Jerusalem';
// Wednesday 2026-09-09, 09:00 local (IDT, UTC+3).
const NOW = new Date('2026-09-09T06:00:00.000Z');

let db: Db;
let app: App;
let user: User;
let settings: Settings;

/**
 * A calendar backed by an in-memory event list, driving the real merge,
 * free/busy and conflict code. Records what would have been written.
 */
class StubCalendar {
  events: UnifiedEvent[] = [];
  created: { title: string; start: Date; end: Date }[] = [];
  deleted: string[] = [];
  connected = true;
  degraded: string[] = [];

  async accounts(): Promise<unknown[]> {
    return this.connected
      ? [{ id: 'cal-1', provider: 'google', is_primary: true, is_writable: true }]
      : [];
  }

  async fetchRange(_u: User, range: { start: Date; end: Date }) {
    const inRange = this.events.filter((e) => e.start < range.end && e.end > range.start);
    return {
      events: mergeCalendars([inRange]),
      degraded: this.degraded,
      healthy: ['google'],
      needsReauth: [],
    };
  }

  async fetchDay(u: User, date: string) {
    const start = new Date(`${date}T00:00:00+03:00`);
    return this.fetchRange(u, { start, end: new Date(start.getTime() + 86_400_000) });
  }

  async freeSlots(
    _u: User,
    date: string,
    opts: { minMinutes: number; dayStart: string; dayEnd: string; notBefore?: Date },
  ) {
    const { events } = await this.fetchDay(_u, date);
    return {
      slots: computeFreeSlots(events, {
        date,
        timezone: TZ,
        dayStart: opts.dayStart,
        dayEnd: opts.dayEnd,
        minMinutes: opts.minMinutes,
        ...(opts.notBefore ? { notBefore: opts.notBefore } : {}),
      }),
      degraded: this.degraded,
    };
  }

  async conflictsFor(_u: User, slot: { start: Date; end: Date }) {
    return { conflicts: findConflicts(this.events, slot), degraded: this.degraded };
  }

  async createEvent(_u: User, input: { title: string; start: Date; end: Date; location?: string }) {
    this.created.push(input);
    const event = makeEvent(input.title, input.start, input.end);
    this.events.push(event);
    return event;
  }

  async deleteEvent(_u: User, event: UnifiedEvent) {
    this.deleted.push(event.providerEventId);
    this.events = this.events.filter((e) => e.providerEventId !== event.providerEventId);
  }
}

let calendar: StubCalendar;

function makeEvent(title: string, start: Date, end: Date, attendees: string[] = []): UnifiedEvent {
  return {
    provider: 'google',
    calendarId: 'primary',
    calendarName: 'Primary',
    providerEventId: `${title}-${start.toISOString()}`,
    icalUid: null,
    title,
    start,
    end,
    allDay: false,
    location: null,
    organizer: null,
    attendees,
    status: 'confirmed',
    isCancelled: false,
    showAsBusy: true,
    htmlLink: null,
  };
}

function ctx(): HandlerContext {
  return {
    repos: app.repos,
    tasks: app.tasks,
    calendar: calendar as unknown as CalendarService,
    messenger: app.messenger,
    ai: null,
    user,
    settings,
    now: NOW,
    timezone: TZ,
    source: 'whatsapp',
  };
}

function eventIntent(title: string, date: string, time: string, duration?: number): Intent {
  return {
    ...emptyIntent('CREATE_EVENT', 0.9),
    event: {
      title,
      start: { date, time, relative_expression: null },
      duration_minutes: duration ?? null,
      location: null,
      attendees: [],
    },
  };
}

beforeAll(async () => {
  db = await createTestDb();
  app = buildApp(testEnv(), db, { sender: new FakeSender(), ai: null });
  user = await app.repos.users.create({
    display_name: 'Shay',
    whatsapp_phone: '972500000005',
    timezone: TZ,
  });
  settings = await app.repos.settings.get(user.id);
});
afterAll(async () => {
  await db.close();
});
beforeEach(() => {
  calendar = new StubCalendar();
});

describe('calendar query', () => {
  it('says so honestly when no calendar is connected', async () => {
    calendar.connected = false;
    const result = await handleCalendarQuery(ctx(), {
      ...emptyIntent('CALENDAR_QUERY', 0.9),
      query: { ...emptyQuery(), range: 'today' },
    });
    expect(result.reply).toContain('לא חיברת יומן');
  });

  it('lists today merged and ordered', async () => {
    calendar.events = [
      makeEvent('שיחת Zoom', new Date('2026-09-09T11:00:00Z'), new Date('2026-09-09T11:30:00Z')),
      makeEvent('פגישה עם דני', new Date('2026-09-09T06:00:00Z'), new Date('2026-09-09T07:00:00Z')),
    ];
    const result = await handleCalendarQuery(ctx(), {
      ...emptyIntent('CALENDAR_QUERY', 0.9),
      query: { ...emptyQuery(), range: 'today' },
    });
    expect(result.reply.indexOf('פגישה עם דני')).toBeLessThan(result.reply.indexOf('שיחת Zoom'));
    expect(result.reply).toContain('09:00');
    expect(result.reply).toContain('14:00');
  });

  it('flags partial data instead of pretending the day is empty', async () => {
    calendar.degraded = ['Google Calendar לא זמין כרגע, אז המידע חלקי.'];
    const result = await handleCalendarQuery(ctx(), {
      ...emptyIntent('CALENDAR_QUERY', 0.9),
      query: { ...emptyQuery(), range: 'today' },
    });
    expect(result.reply).toContain('⚠️');
    expect(result.reply).toContain('לא זמין');
  });
});

describe('free time', () => {
  it('lists the gaps in the working day', async () => {
    calendar.events = [
      makeEvent('פגישה', new Date('2026-09-10T07:00:00Z'), new Date('2026-09-10T08:00:00Z')),
      makeEvent('סדנה', new Date('2026-09-10T10:00:00Z'), new Date('2026-09-10T12:00:00Z')),
    ];
    const result = await handleFreeTimeQuery(ctx(), {
      ...emptyIntent('FREE_TIME_QUERY', 0.9),
      query: { ...emptyQuery(), range: 'tomorrow', slot_minutes: 60 },
    });
    expect(result.reply).toContain('מחר אתה פנוי');
    expect(result.reply).toContain('11:00–13:00'); // local, between the two blocks
  });

  it('says plainly when there is no window', async () => {
    calendar.events = [
      makeEvent('כל היום', new Date('2026-09-10T06:00:00Z'), new Date('2026-09-10T15:00:00Z')),
    ];
    const result = await handleFreeTimeQuery(ctx(), {
      ...emptyIntent('FREE_TIME_QUERY', 0.9),
      query: { ...emptyQuery(), range: 'tomorrow', slot_minutes: 60 },
    });
    expect(result.reply).toContain('לא מצאתי חלון פנוי');
  });
});

describe('creating an event', () => {
  it('creates when the slot is free', async () => {
    const result = await handleCreateEvent(
      ctx(),
      eventIntent('לעבוד על המצגת לאורקל', '2026-09-13', '13:00', 60),
    );
    expect(result.reply).toContain('📅 קבעתי');
    expect(calendar.created).toHaveLength(1);
    expect(calendar.created[0]!.start.toISOString()).toBe('2026-09-13T10:00:00.000Z'); // 13:00 IDT
  });

  it('never books over an existing commitment — it offers alternatives', async () => {
    calendar.events = [
      makeEvent('פגישה קיימת', new Date('2026-09-13T10:00:00Z'), new Date('2026-09-13T11:00:00Z')),
    ];
    const result = await handleCreateEvent(
      ctx(),
      eventIntent('לעבוד על המצגת', '2026-09-13', '13:00', 60),
    );

    expect(calendar.created).toHaveLength(0);
    expect(result.reply).toContain('כבר יש לך');
    expect(result.reply).toContain('פגישה קיימת');
    expect(result.reply).toContain('אתה פנוי ב');
    expect(result.pendingConfirmation?.kind).toBe('conflict_choice');
  });

  it('creates at the alternative the user picks', async () => {
    calendar.events = [
      makeEvent('פגישה קיימת', new Date('2026-09-13T10:00:00Z'), new Date('2026-09-13T11:00:00Z')),
    ];
    const proposal = await handleCreateEvent(
      ctx(),
      eventIntent('לעבוד על המצגת', '2026-09-13', '13:00', 60),
    );
    const pending = await app.repos.confirmations.create({
      user_id: user.id,
      kind: proposal.pendingConfirmation!.kind,
      payload: proposal.pendingConfirmation!.payload,
      prompt: proposal.pendingConfirmation!.prompt,
    });

    const outcome = await handlePendingConfirmation(ctx(), pending, '1');
    expect(outcome.handled).toBe(true);
    expect(outcome.result!.reply).toContain('📅 קבעתי');
    expect(calendar.created).toHaveLength(1);
  });

  it('asks for a time rather than guessing one', async () => {
    const result = await handleCreateEvent(ctx(), {
      ...emptyIntent('CREATE_EVENT', 0.9),
      event: {
        title: 'לעבוד על המצגת',
        start: { date: '2026-09-13', time: null, relative_expression: null },
        duration_minutes: null,
        location: null,
        attendees: [],
      },
    });
    expect(result.reply).toContain('מתי לקבוע');
    expect(calendar.created).toHaveLength(0);
  });
});

describe('moving an event', () => {
  it('moves a solo event and removes the original', async () => {
    calendar.events = [
      makeEvent(
        'זמן עבודה על המצגת',
        new Date('2026-09-13T10:00:00Z'),
        new Date('2026-09-13T11:00:00Z'),
      ),
    ];
    const result = await handleUpdateEvent(ctx(), {
      ...emptyIntent('UPDATE_EVENT', 0.9),
      event: {
        title: 'זמן עבודה על המצגת',
        start: { date: '2026-09-13', time: '16:00', relative_expression: null },
        duration_minutes: null,
        location: null,
        attendees: [],
      },
    });
    expect(result.reply).toContain('📅 הזזתי');
    expect(calendar.created).toHaveLength(1);
    expect(calendar.deleted).toHaveLength(1);
    expect(calendar.created[0]!.start.toISOString()).toBe('2026-09-13T13:00:00.000Z');
  });

  it('refuses to move a meeting with guests rather than dropping their invitations', async () => {
    calendar.events = [
      makeEvent(
        'פגישה עם דני',
        new Date('2026-09-13T10:00:00Z'),
        new Date('2026-09-13T11:00:00Z'),
        ['dani@example.com'],
      ),
    ];
    const result = await handleUpdateEvent(ctx(), {
      ...emptyIntent('UPDATE_EVENT', 0.9),
      event: {
        title: 'פגישה עם דני',
        start: { date: '2026-09-13', time: '16:00', relative_expression: null },
        duration_minutes: null,
        location: null,
        attendees: [],
      },
    });
    expect(result.reply).toContain('משתתפים');
    expect(calendar.created).toHaveLength(0);
    expect(calendar.deleted).toHaveLength(0);
  });

  it('does not move an event into a conflict', async () => {
    calendar.events = [
      makeEvent('זמן עבודה', new Date('2026-09-13T10:00:00Z'), new Date('2026-09-13T11:00:00Z')),
      makeEvent('פגישה אחרת', new Date('2026-09-13T13:00:00Z'), new Date('2026-09-13T14:00:00Z')),
    ];
    const result = await handleUpdateEvent(ctx(), {
      ...emptyIntent('UPDATE_EVENT', 0.9),
      event: {
        title: 'זמן עבודה',
        start: { date: '2026-09-13', time: '16:00', relative_expression: null },
        duration_minutes: 60,
        location: null,
        attendees: [],
      },
    });
    expect(result.reply).toContain('כבר יש לך');
    expect(calendar.created).toHaveLength(0);
    expect(calendar.deleted).toHaveLength(0);
  });
});

function emptyQuery(): NonNullable<Intent['query']> {
  return {
    range: null,
    date: null,
    end_date: null,
    status: null,
    priority: null,
    search_text: null,
    project: null,
    client: null,
    contact: null,
    slot_minutes: null,
  };
}
