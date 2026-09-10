import { DateTime } from 'luxon';
import type { UnifiedEvent } from '../domain/types.js';
import type { LocalDate } from '../utils/time.js';

export interface Slot {
  start: Date;
  end: Date;
}

/** Collapses overlapping/adjacent busy blocks into a minimal set of intervals. */
export function mergeBusy(events: UnifiedEvent[]): Slot[] {
  const busy = events
    .filter((e) => e.showAsBusy && !e.isCancelled && !e.allDay)
    .map((e) => ({ start: e.start, end: e.end }))
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start.getTime() - b.start.getTime());

  const out: Slot[] = [];
  for (const block of busy) {
    const last = out[out.length - 1];
    if (last && block.start.getTime() <= last.end.getTime()) {
      if (block.end > last.end) last.end = block.end;
    } else {
      out.push({ start: new Date(block.start), end: new Date(block.end) });
    }
  }
  return out;
}

export interface FreeSlotOptions {
  date: LocalDate;
  timezone: string;
  /** Working window, local wall clock. */
  dayStart: string;
  dayEnd: string;
  /** Minimum usable slot length. */
  minMinutes: number;
  /** Never suggest a slot that starts before this instant (usually "now"). */
  notBefore?: Date;
}

/**
 * Computes free windows inside the working day. All-day events are ignored:
 * a full-day "vacation" marker shouldn't blank the day, and a full-day
 * "conference" is handled by the user, not by us.
 */
export function computeFreeSlots(events: UnifiedEvent[], opts: FreeSlotOptions): Slot[] {
  const dayStart = DateTime.fromISO(`${opts.date}T${opts.dayStart}`, { zone: opts.timezone });
  const dayEnd = DateTime.fromISO(`${opts.date}T${opts.dayEnd}`, { zone: opts.timezone });
  if (!dayStart.isValid || !dayEnd.isValid || dayEnd <= dayStart) return [];

  let cursor = dayStart.toJSDate();
  if (opts.notBefore && opts.notBefore > cursor) {
    // Round up to the next quarter hour so suggestions look deliberate.
    const rounded = DateTime.fromJSDate(opts.notBefore, { zone: opts.timezone });
    const bump = (15 - (rounded.minute % 15)) % 15;
    cursor = rounded.plus({ minutes: bump }).startOf('minute').toJSDate();
  }
  const limit = dayEnd.toJSDate();
  if (cursor >= limit) return [];

  const busy = mergeBusy(events);
  const free: Slot[] = [];

  for (const block of busy) {
    if (block.end <= cursor) continue;
    if (block.start > cursor) {
      const gap = Math.round((Math.min(block.start.getTime(), limit.getTime()) - cursor.getTime()) / 60_000);
      if (gap >= opts.minMinutes) {
        free.push({ start: new Date(cursor), end: new Date(Math.min(block.start.getTime(), limit.getTime())) });
      }
    }
    if (block.end > cursor) cursor = new Date(Math.max(cursor.getTime(), block.end.getTime()));
    if (cursor >= limit) break;
  }

  if (cursor < limit) {
    const gap = Math.round((limit.getTime() - cursor.getTime()) / 60_000);
    if (gap >= opts.minMinutes) free.push({ start: new Date(cursor), end: new Date(limit) });
  }

  return free;
}

/** Events that overlap the proposed window — used before creating an event. */
export function findConflicts(events: UnifiedEvent[], slot: Slot): UnifiedEvent[] {
  return events.filter(
    (e) => e.showAsBusy && !e.isCancelled && !e.allDay && e.start < slot.end && e.end > slot.start,
  );
}
