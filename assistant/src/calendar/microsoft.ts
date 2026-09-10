import { DateTime } from 'luxon';
import type { CalendarAccount, UnifiedEvent } from '../domain/types.js';
import { IntegrationError } from '../utils/errors.js';
import type { TokenStore } from '../oauth/token-store.js';

/**
 * Outlook Calendar via Microsoft Graph v1.0.
 *
 * Two Graph-specific details matter:
 *  - `/calendarView` (not `/events`) expands recurring series into instances,
 *    which is what a "what do I have today" question needs.
 *  - Graph returns naive local date-times plus a separate `timeZone` field. We
 *    ask for UTC with the `Prefer: outlook.timezone="UTC"` header and then parse
 *    explicitly as UTC, because parsing them as local would silently shift
 *    every event.
 */

const BASE = 'https://graph.microsoft.com/v1.0';

interface GraphDateTime {
  dateTime: string;
  timeZone: string;
}

interface GraphEvent {
  id: string;
  iCalUId?: string;
  subject?: string;
  bodyPreview?: string;
  location?: { displayName?: string };
  start?: GraphDateTime;
  end?: GraphDateTime;
  isAllDay?: boolean;
  isCancelled?: boolean;
  showAs?: string;
  webLink?: string;
  organizer?: { emailAddress?: { address?: string } };
  attendees?: { emailAddress?: { address?: string } }[];
}

export interface GraphCalendar {
  id: string;
  name: string;
  isDefaultCalendar?: boolean;
  canEdit?: boolean;
}

function parseGraphDate(value: GraphDateTime | undefined, fallbackZone: string): Date {
  if (!value?.dateTime) return new Date(NaN);
  const zone = value.timeZone && value.timeZone !== 'tzone://Microsoft/Custom' ? value.timeZone : fallbackZone;
  // Graph emits ISO without an offset; the offset lives in `timeZone`.
  const dt = DateTime.fromISO(value.dateTime, { zone: zone === 'UTC' ? 'utc' : zone });
  return dt.isValid ? dt.toJSDate() : new Date(value.dateTime);
}

export class MicrosoftCalendarClient {
  constructor(
    private readonly tokens: TokenStore,
    private readonly timeoutMs = 20_000,
  ) {}

  private async get<T>(connectionId: string, path: string, params: Record<string, string> = {}): Promise<T> {
    const token = await this.tokens.accessTokenFor(connectionId);
    const url = new URL(`${BASE}${path}`);
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, {
      headers: {
        authorization: `Bearer ${token}`,
        // Ask Graph to normalise every date-time to UTC.
        Prefer: 'outlook.timezone="UTC"',
      },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new IntegrationError(
        'outlook_calendar',
        `Microsoft Graph ${path} failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
        res.status,
        res.status >= 500 || res.status === 429,
      );
    }
    return (await res.json()) as T;
  }

  async listCalendars(connectionId: string): Promise<GraphCalendar[]> {
    const data = await this.get<{ value?: GraphCalendar[] }>(connectionId, '/me/calendars', { $top: '100' });
    return data.value ?? [];
  }

  async listEvents(account: CalendarAccount, range: { start: Date; end: Date }): Promise<UnifiedEvent[]> {
    const path = account.is_primary
      ? '/me/calendarView'
      : `/me/calendars/${encodeURIComponent(account.calendar_id)}/calendarView`;
    const data = await this.get<{ value?: GraphEvent[] }>(account.oauth_connection_id, path, {
      startDateTime: range.start.toISOString(),
      endDateTime: range.end.toISOString(),
      $orderby: 'start/dateTime',
      $top: '250',
      $select: 'id,iCalUId,subject,start,end,isAllDay,isCancelled,showAs,webLink,location,organizer,attendees',
    });

    return (data.value ?? [])
      .map((e): UnifiedEvent => ({
        provider: 'microsoft',
        calendarId: account.calendar_id,
        calendarName: account.display_name,
        providerEventId: e.id,
        icalUid: e.iCalUId ?? null,
        title: e.subject?.trim() || '(ללא כותרת)',
        start: parseGraphDate(e.start, 'utc'),
        end: parseGraphDate(e.end, 'utc'),
        allDay: Boolean(e.isAllDay),
        location: e.location?.displayName ?? null,
        organizer: e.organizer?.emailAddress?.address ?? null,
        attendees: (e.attendees ?? []).map((a) => a.emailAddress?.address ?? '').filter(Boolean),
        status: e.showAs ?? null,
        isCancelled: Boolean(e.isCancelled),
        showAsBusy: e.showAs !== 'free' && e.showAs !== 'workingElsewhere',
        htmlLink: e.webLink ?? null,
      }))
      .filter((e) => Number.isFinite(e.start.getTime()) && Number.isFinite(e.end.getTime()));
  }

  async createEvent(
    account: CalendarAccount,
    input: { title: string; start: Date; end: Date; timezone: string; description?: string; location?: string },
  ): Promise<UnifiedEvent> {
    const token = await this.tokens.accessTokenFor(account.oauth_connection_id);
    const path = account.is_primary
      ? '/me/events'
      : `/me/calendars/${encodeURIComponent(account.calendar_id)}/events`;
    const res = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        subject: input.title,
        body: input.description ? { contentType: 'text', content: input.description } : undefined,
        location: input.location ? { displayName: input.location } : undefined,
        start: { dateTime: DateTime.fromJSDate(input.start).toUTC().toISO({ includeOffset: false }), timeZone: 'UTC' },
        end: { dateTime: DateTime.fromJSDate(input.end).toUTC().toISO({ includeOffset: false }), timeZone: 'UTC' },
      }),
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok) {
      throw new IntegrationError(
        'outlook_calendar',
        `Creating the Outlook event failed (${res.status}): ${(await res.text()).slice(0, 200)}`,
        res.status,
      );
    }
    const e = (await res.json()) as GraphEvent;
    return {
      provider: 'microsoft',
      calendarId: account.calendar_id,
      calendarName: account.display_name,
      providerEventId: e.id,
      icalUid: e.iCalUId ?? null,
      title: e.subject ?? input.title,
      start: parseGraphDate(e.start, 'utc'),
      end: parseGraphDate(e.end, 'utc'),
      allDay: false,
      location: e.location?.displayName ?? null,
      organizer: e.organizer?.emailAddress?.address ?? null,
      attendees: [],
      status: e.showAs ?? null,
      isCancelled: false,
      showAsBusy: true,
      htmlLink: e.webLink ?? null,
    };
  }

  async deleteEvent(account: CalendarAccount, eventId: string): Promise<void> {
    const token = await this.tokens.accessTokenFor(account.oauth_connection_id);
    const res = await fetch(`${BASE}/me/events/${encodeURIComponent(eventId)}`, {
      method: 'DELETE',
      headers: { authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(this.timeoutMs),
    });
    if (!res.ok && res.status !== 404) {
      throw new IntegrationError('outlook_calendar', `Deleting the Outlook event failed (${res.status})`, res.status);
    }
  }
}
