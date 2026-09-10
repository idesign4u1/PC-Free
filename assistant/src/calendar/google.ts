import { DateTime } from 'luxon';
import type { CalendarAccount, UnifiedEvent } from '../domain/types.js';
import { IntegrationError } from '../utils/errors.js';
import type { TokenStore } from '../oauth/token-store.js';

/**
 * Google Calendar via the REST API (v3). We call the API directly rather than
 * pulling in the full googleapis client: the surface we need is three
 * endpoints, and this keeps the dependency and the auth path explicit.
 */

const BASE = 'https://www.googleapis.com/calendar/v3';

interface GoogleDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

interface GoogleEvent {
  id: string;
  iCalUID?: string;
  summary?: string;
  description?: string;
  location?: string;
  status?: string;
  transparency?: string;
  htmlLink?: string;
  start?: GoogleDateTime;
  end?: GoogleDateTime;
  organizer?: { email?: string; displayName?: string };
  attendees?: { email?: string; responseStatus?: string }[];
}

export interface GoogleCalendarListEntry {
  id: string;
  summary: string;
  primary?: boolean;
  accessRole: string;
  selected?: boolean;
}

function toDate(value: GoogleDateTime | undefined, timezone: string, endOfDay = false): Date {
  if (value?.dateTime) return new Date(value.dateTime);
  if (value?.date) {
    const dt = DateTime.fromISO(value.date, { zone: value.timeZone ?? timezone });
    return (endOfDay ? dt.plus({ days: 1 }) : dt).toJSDate();
  }
  return new Date(NaN);
}

export class GoogleCalendarClient {
  constructor(
    private readonly tokens: TokenStore,
    private readonly timeoutMs = 20_000,
  ) {}

  private async get<T>(connectionId: string, path: string, params: Record<string, string>): Promise<T> {
    const token = await this.tokens.accessTokenFor(connectionId);
    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new IntegrationError(
        'google_calendar',
        `Google Calendar ${path} failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
        res.status,
        res.status >= 500 || res.status === 429,
      );
    }
    return (await res.json()) as T;
  }

  async listCalendars(connectionId: string): Promise<GoogleCalendarListEntry[]> {
    const data = await this.get<{ items?: GoogleCalendarListEntry[] }>(connectionId, '/users/me/calendarList', {
      maxResults: '100',
      minAccessRole: 'reader',
    });
    return data.items ?? [];
  }

  async listEvents(
    account: CalendarAccount,
    range: { start: Date; end: Date },
    timezone: string,
  ): Promise<UnifiedEvent[]> {
    const data = await this.get<{ items?: GoogleEvent[] }>(
      account.oauth_connection_id,
      `/calendars/${encodeURIComponent(account.calendar_id)}/events`,
      {
        timeMin: range.start.toISOString(),
        timeMax: range.end.toISOString(),
        singleEvents: 'true', // expand recurring series into instances
        orderBy: 'startTime',
        maxResults: '250',
        timeZone: timezone,
      },
    );

    return (data.items ?? [])
      .map((e): UnifiedEvent => {
        const allDay = Boolean(e.start?.date && !e.start?.dateTime);
        return {
          provider: 'google',
          calendarId: account.calendar_id,
          calendarName: account.display_name,
          providerEventId: e.id,
          icalUid: e.iCalUID ?? null,
          title: e.summary?.trim() || '(ללא כותרת)',
          start: toDate(e.start, timezone),
          end: toDate(e.end, timezone, allDay),
          allDay,
          location: e.location ?? null,
          organizer: e.organizer?.email ?? null,
          attendees: (e.attendees ?? []).map((a) => a.email ?? '').filter(Boolean),
          status: e.status ?? null,
          isCancelled: e.status === 'cancelled',
          showAsBusy: e.transparency !== 'transparent',
          htmlLink: e.htmlLink ?? null,
        };
      })
      .filter((e) => Number.isFinite(e.start.getTime()) && Number.isFinite(e.end.getTime()));
  }

  async createEvent(
    account: CalendarAccount,
    input: { title: string; start: Date; end: Date; timezone: string; description?: string; location?: string },
  ): Promise<UnifiedEvent> {
    const token = await this.tokens.accessTokenFor(account.oauth_connection_id);
    const res = await fetch(`${BASE}/calendars/${encodeURIComponent(account.calendar_id)}/events`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        summary: input.title,
        description: input.description,
        location: input.location,
        start: { dateTime: input.start.toISOString(), timeZone: input.timezone },
        end: { dateTime: input.end.toISOString(), timeZone: input.timezone },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new IntegrationError(
        'google_calendar',
        `Creating the Google event failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
        res.status,
      );
    }
    const e = (await res.json()) as GoogleEvent;
    return {
      provider: 'google',
      calendarId: account.calendar_id,
      calendarName: account.display_name,
      providerEventId: e.id,
      icalUid: e.iCalUID ?? null,
      title: e.summary ?? input.title,
      start: toDate(e.start, input.timezone),
      end: toDate(e.end, input.timezone),
      allDay: false,
      location: e.location ?? null,
      organizer: e.organizer?.email ?? null,
      attendees: [],
      status: e.status ?? null,
      isCancelled: false,
      showAsBusy: true,
      htmlLink: e.htmlLink ?? null,
    };
  }

  async deleteEvent(account: CalendarAccount, eventId: string): Promise<void> {
    const token = await this.tokens.accessTokenFor(account.oauth_connection_id);
    const res = await fetch(
      `${BASE}/calendars/${encodeURIComponent(account.calendar_id)}/events/${encodeURIComponent(eventId)}`,
      { method: 'DELETE', headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(this.timeoutMs) },
    );
    if (!res.ok && res.status !== 404 && res.status !== 410) {
      throw new IntegrationError('google_calendar', `Deleting the Google event failed (${res.status})`, res.status);
    }
  }
}
