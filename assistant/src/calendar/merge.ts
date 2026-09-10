import type { UnifiedEvent } from '../domain/types.js';

/**
 * Merges events from every connected calendar into a single timeline.
 *
 * Deduplication matters because the same meeting is often present in both
 * Google and Outlook (an invitation accepted in one, mirrored into the other).
 * Two signals, in order of trust:
 *   1. iCalUID — the cross-system identity of an event. Both providers expose
 *      it, and a match is conclusive.
 *   2. Fuzzy: identical start and end (to the minute) plus a normalised title
 *      match. Catches copies made by sync tools that mint a fresh UID.
 *
 * When duplicates are found we keep one and record where else it appeared, so
 * the UI can say "Google + Outlook" rather than pretending one source is right.
 */

export interface MergedEvent extends UnifiedEvent {
  /** Every provider this event was seen on, in discovery order. */
  sources: { provider: string; calendarName: string }[];
}

function normaliseTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/^(fwd?|re|invitation|הזמנה)[:\s]+/i, '')
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim();
}

function fuzzyKey(e: UnifiedEvent): string {
  return [
    Math.floor(e.start.getTime() / 60_000),
    Math.floor(e.end.getTime() / 60_000),
    normaliseTitle(e.title),
  ].join('|');
}

export function mergeCalendars(groups: UnifiedEvent[][]): MergedEvent[] {
  const all = groups.flat().filter((e) => !e.isCancelled);
  const byUid = new Map<string, MergedEvent>();
  const byFuzzy = new Map<string, MergedEvent>();
  const out: MergedEvent[] = [];

  for (const event of all) {
    const uidKey = event.icalUid ? `uid:${event.icalUid.toLowerCase()}` : null;
    const fzKey = fuzzyKey(event);
    const existing = (uidKey ? byUid.get(uidKey) : undefined) ?? byFuzzy.get(fzKey);

    if (existing) {
      if (
        !existing.sources.some(
          (s) => s.provider === event.provider && s.calendarName === event.calendarName,
        )
      ) {
        existing.sources.push({ provider: event.provider, calendarName: event.calendarName });
      }
      // Prefer a title that is not empty, and a link if we did not have one.
      if (!existing.htmlLink && event.htmlLink) existing.htmlLink = event.htmlLink;
      if (!existing.location && event.location) existing.location = event.location;
      continue;
    }

    const merged: MergedEvent = {
      ...event,
      sources: [{ provider: event.provider, calendarName: event.calendarName }],
    };
    if (uidKey) byUid.set(uidKey, merged);
    byFuzzy.set(fzKey, merged);
    out.push(merged);
  }

  return out.sort(
    (a, b) => a.start.getTime() - b.start.getTime() || a.title.localeCompare(b.title),
  );
}
