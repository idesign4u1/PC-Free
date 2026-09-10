import { describe, expect, it } from 'vitest';
import { mergeCalendars } from '../src/calendar/merge.js';
import { computeFreeSlots, findConflicts, mergeBusy } from '../src/calendar/freebusy.js';
import type { UnifiedEvent } from '../src/domain/types.js';

const TZ = 'Asia/Jerusalem';

type EvInput = Omit<Partial<UnifiedEvent>, 'start' | 'end'> & {
  title: string;
  start: string;
  end: string;
};

function ev(overrides: EvInput): UnifiedEvent {
  return {
    provider: 'google',
    calendarId: 'primary',
    calendarName: 'Primary',
    providerEventId: `${overrides.title}-${overrides.start}`,
    icalUid: null,
    location: null,
    organizer: null,
    attendees: [],
    status: 'confirmed',
    isCancelled: false,
    showAsBusy: true,
    allDay: false,
    htmlLink: null,
    ...overrides,
    start: new Date(overrides.start),
    end: new Date(overrides.end),
  };
}

describe('calendar merge', () => {
  it('orders events from both providers by time', () => {
    const google = [
      ev({ title: 'פגישה עם דני', start: '2026-09-10T06:00:00Z', end: '2026-09-10T07:00:00Z' }),
      ev({ title: 'שיחת Zoom', start: '2026-09-10T11:00:00Z', end: '2026-09-10T11:30:00Z' }),
    ];
    const outlook = [
      ev({
        provider: 'microsoft',
        calendarName: 'Work',
        title: 'הרצאה',
        start: '2026-09-10T08:30:00Z',
        end: '2026-09-10T09:30:00Z',
      }),
      ev({
        provider: 'microsoft',
        calendarName: 'Work',
        title: 'רופא',
        start: '2026-09-10T14:00:00Z',
        end: '2026-09-10T14:45:00Z',
      }),
    ];
    const merged = mergeCalendars([google, outlook]);
    expect(merged.map((e) => e.title)).toEqual(['פגישה עם דני', 'הרצאה', 'שיחת Zoom', 'רופא']);
  });

  it('deduplicates by iCalUID across providers', () => {
    const shared = 'abc-123@example.com';
    const merged = mergeCalendars([
      [
        ev({
          title: 'Standup',
          icalUid: shared,
          start: '2026-09-10T06:00:00Z',
          end: '2026-09-10T06:15:00Z',
        }),
      ],
      [
        ev({
          provider: 'microsoft',
          calendarName: 'Work',
          title: 'Standup',
          icalUid: shared,
          start: '2026-09-10T06:00:00Z',
          end: '2026-09-10T06:15:00Z',
        }),
      ],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.sources.map((s) => s.provider)).toEqual(['google', 'microsoft']);
  });

  it('deduplicates identical events even without a shared UID', () => {
    const merged = mergeCalendars([
      [ev({ title: 'פגישת צוות', start: '2026-09-10T07:00:00Z', end: '2026-09-10T08:00:00Z' })],
      [
        ev({
          provider: 'microsoft',
          calendarName: 'Work',
          title: 'פגישת צוות',
          start: '2026-09-10T07:00:00Z',
          end: '2026-09-10T08:00:00Z',
        }),
      ],
    ]);
    expect(merged).toHaveLength(1);
    expect(merged[0]!.sources).toHaveLength(2);
  });

  it('keeps genuinely different events with the same title', () => {
    const merged = mergeCalendars([
      [
        ev({ title: 'סטטוס', start: '2026-09-10T07:00:00Z', end: '2026-09-10T07:30:00Z' }),
        ev({ title: 'סטטוס', start: '2026-09-10T12:00:00Z', end: '2026-09-10T12:30:00Z' }),
      ],
    ]);
    expect(merged).toHaveLength(2);
  });

  it('drops cancelled events', () => {
    const merged = mergeCalendars([
      [
        ev({
          title: 'בוטל',
          isCancelled: true,
          start: '2026-09-10T07:00:00Z',
          end: '2026-09-10T08:00:00Z',
        }),
      ],
    ]);
    expect(merged).toHaveLength(0);
  });
});

describe('busy periods', () => {
  it('collapses overlapping blocks', () => {
    const busy = mergeBusy([
      ev({ title: 'a', start: '2026-09-10T07:00:00Z', end: '2026-09-10T08:00:00Z' }),
      ev({ title: 'b', start: '2026-09-10T07:30:00Z', end: '2026-09-10T09:00:00Z' }),
      ev({ title: 'c', start: '2026-09-10T10:00:00Z', end: '2026-09-10T10:30:00Z' }),
    ]);
    expect(busy).toHaveLength(2);
    expect(busy[0]!.end.toISOString()).toBe('2026-09-10T09:00:00.000Z');
  });

  it('ignores events marked free', () => {
    expect(
      mergeBusy([
        ev({
          title: 'free',
          showAsBusy: false,
          start: '2026-09-10T07:00:00Z',
          end: '2026-09-10T08:00:00Z',
        }),
      ]),
    ).toHaveLength(0);
  });

  it('ignores all-day markers', () => {
    expect(
      mergeBusy([
        ev({
          title: 'חופש',
          allDay: true,
          start: '2026-09-10T00:00:00Z',
          end: '2026-09-11T00:00:00Z',
        }),
      ]),
    ).toHaveLength(0);
  });
});

describe('free slots', () => {
  // Local IDT (UTC+3): events at 09:00-10:00, 12:00-14:00, 16:00-17:00
  const events = [
    ev({ title: 'פגישה', start: '2026-09-10T06:00:00Z', end: '2026-09-10T07:00:00Z' }),
    ev({
      provider: 'microsoft',
      calendarName: 'W',
      title: 'סדנה',
      start: '2026-09-10T09:00:00Z',
      end: '2026-09-10T11:00:00Z',
    }),
    ev({ title: 'שיחה', start: '2026-09-10T13:00:00Z', end: '2026-09-10T14:00:00Z' }),
  ];

  it('finds the gaps inside the working day', () => {
    const slots = computeFreeSlots(events, {
      date: '2026-09-10',
      timezone: TZ,
      dayStart: '09:00',
      dayEnd: '18:00',
      minMinutes: 60,
    });
    const asLocal = slots.map((s) => [
      s.start.toISOString().slice(11, 16),
      s.end.toISOString().slice(11, 16),
    ]);
    // UTC: 07:00-09:00, 11:00-13:00, 14:00-15:00 (= local 10:00-12:00, 14:00-16:00, 17:00-18:00)
    expect(asLocal).toEqual([
      ['07:00', '09:00'],
      ['11:00', '13:00'],
      ['14:00', '15:00'],
    ]);
  });

  it('honours the minimum slot length', () => {
    const slots = computeFreeSlots(events, {
      date: '2026-09-10',
      timezone: TZ,
      dayStart: '09:00',
      dayEnd: '18:00',
      minMinutes: 120,
    });
    expect(slots).toHaveLength(2);
  });

  it('never suggests a slot in the past', () => {
    const slots = computeFreeSlots(events, {
      date: '2026-09-10',
      timezone: TZ,
      dayStart: '09:00',
      dayEnd: '18:00',
      minMinutes: 60,
      notBefore: new Date('2026-09-10T11:05:00Z'),
    });
    expect(slots[0]!.start.toISOString()).toBe('2026-09-10T11:15:00.000Z');
  });

  it('returns nothing when the day is fully booked', () => {
    const full = [
      ev({ title: 'כל היום', start: '2026-09-10T06:00:00Z', end: '2026-09-10T15:00:00Z' }),
    ];
    expect(
      computeFreeSlots(full, {
        date: '2026-09-10',
        timezone: TZ,
        dayStart: '09:00',
        dayEnd: '18:00',
        minMinutes: 30,
      }),
    ).toHaveLength(0);
  });
});

describe('conflict detection', () => {
  const events = [
    ev({ title: 'פגישה קיימת', start: '2026-09-13T10:00:00Z', end: '2026-09-13T11:00:00Z' }),
  ];

  it('detects an overlapping proposal', () => {
    const conflicts = findConflicts(events, {
      start: new Date('2026-09-13T10:30:00Z'),
      end: new Date('2026-09-13T11:30:00Z'),
    });
    expect(conflicts).toHaveLength(1);
  });

  it('allows a back-to-back slot', () => {
    const conflicts = findConflicts(events, {
      start: new Date('2026-09-13T11:00:00Z'),
      end: new Date('2026-09-13T12:00:00Z'),
    });
    expect(conflicts).toHaveLength(0);
  });
});
