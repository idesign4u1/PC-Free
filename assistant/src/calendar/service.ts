import type { Repositories } from '../db/repositories.js';
import type { CalendarAccount, UnifiedEvent, User } from '../domain/types.js';
import { GoogleCalendarClient } from './google.js';
import { MicrosoftCalendarClient } from './microsoft.js';
import { mergeCalendars, type MergedEvent } from './merge.js';
import { computeFreeSlots, findConflicts, type Slot } from './freebusy.js';
import { errorText, ReauthRequiredError } from '../utils/errors.js';
import { logger } from '../utils/logger.js';
import { localDayRange, type LocalDate } from '../utils/time.js';

/**
 * The unified calendar.
 *
 * Partial failure is a first-class outcome: if Google is down we still answer
 * from Outlook and say so. We never present a partial answer as complete.
 */

export interface CalendarFetchResult {
  events: MergedEvent[];
  /** Hebrew sentences describing what could not be read. */
  degraded: string[];
  /** Providers that answered successfully. */
  healthy: string[];
  /** Connections that need the user to reconnect. */
  needsReauth: string[];
}

const PROVIDER_LABEL: Record<string, string> = {
  google: 'Google Calendar',
  microsoft: 'Outlook Calendar',
};

export class CalendarService {
  constructor(
    private readonly repos: Repositories,
    private readonly google: GoogleCalendarClient | null,
    private readonly microsoft: MicrosoftCalendarClient | null,
  ) {}

  async accounts(user: User): Promise<CalendarAccount[]> {
    return this.repos.calendarAccounts.listEnabled(user.id);
  }

  async fetchRange(user: User, range: { start: Date; end: Date }): Promise<CalendarFetchResult> {
    const accounts = await this.accounts(user);
    const groups: UnifiedEvent[][] = [];
    const degraded: string[] = [];
    const healthy = new Set<string>();
    const needsReauth: string[] = [];
    const failedProviders = new Set<string>();

    const results = await Promise.allSettled(
      accounts.map(async (account) => {
        const started = Date.now();
        try {
          const client = account.provider === 'google' ? this.google : this.microsoft;
          if (!client) throw new Error(`${account.provider} client is not configured`);
          const events =
            account.provider === 'google'
              ? await (client as GoogleCalendarClient).listEvents(account, range, user.timezone)
              : await (client as MicrosoftCalendarClient).listEvents(account, range);
          await this.repos.calendarAccounts.markSync(account.id, 'ok');
          await this.repos.integrationLogs.log({
            user_id: user.id,
            integration: account.provider === 'google' ? 'google_calendar' : 'outlook_calendar',
            operation: 'list_events',
            status: 'success',
            latency_ms: Date.now() - started,
            meta: { calendar: account.display_name, count: events.length },
          });
          return { account, events };
        } catch (err) {
          const message = errorText(err);
          await this.repos.calendarAccounts.markSync(account.id, 'error', message);
          await this.repos.integrationLogs.log({
            user_id: user.id,
            integration: account.provider === 'google' ? 'google_calendar' : 'outlook_calendar',
            operation: 'list_events',
            status: 'failure',
            latency_ms: Date.now() - started,
            error: message,
          });
          if (err instanceof ReauthRequiredError) needsReauth.push(account.provider);
          throw Object.assign(err instanceof Error ? err : new Error(message), { provider: account.provider });
        }
      }),
    );

    for (const result of results) {
      if (result.status === 'fulfilled') {
        groups.push(result.value.events);
        healthy.add(result.value.account.provider);
      } else {
        const provider = (result.reason as { provider?: string }).provider ?? 'unknown';
        failedProviders.add(provider);
        logger().warn({ provider, err: errorText(result.reason) }, 'calendar fetch failed');
      }
    }

    for (const provider of failedProviders) {
      // Only report a provider as unavailable if none of its calendars answered.
      if (healthy.has(provider)) continue;
      const label = PROVIDER_LABEL[provider] ?? provider;
      degraded.push(
        needsReauth.includes(provider)
          ? `${label} מנותק — צריך לחבר מחדש.`
          : `${label} לא זמין כרגע, אז המידע חלקי.`,
      );
    }

    return { events: mergeCalendars(groups), degraded, healthy: [...healthy], needsReauth };
  }

  async fetchDay(user: User, date: LocalDate): Promise<CalendarFetchResult> {
    return this.fetchRange(user, localDayRange(date, user.timezone));
  }

  async freeSlots(
    user: User,
    date: LocalDate,
    opts: { minMinutes: number; dayStart: string; dayEnd: string; notBefore?: Date },
  ): Promise<{ slots: Slot[]; degraded: string[] }> {
    const { events, degraded } = await this.fetchDay(user, date);
    const slots = computeFreeSlots(events, {
      date,
      timezone: user.timezone,
      dayStart: opts.dayStart,
      dayEnd: opts.dayEnd,
      minMinutes: opts.minMinutes,
      ...(opts.notBefore ? { notBefore: opts.notBefore } : {}),
    });
    return { slots, degraded };
  }

  async conflictsFor(user: User, slot: Slot): Promise<{ conflicts: UnifiedEvent[]; degraded: string[] }> {
    const { events, degraded } = await this.fetchRange(user, {
      start: new Date(slot.start.getTime() - 60_000),
      end: new Date(slot.end.getTime() + 60_000),
    });
    return { conflicts: findConflicts(events, slot), degraded };
  }

  /** Writes to the user's primary writable calendar, preferring Google. */
  async createEvent(
    user: User,
    input: { title: string; start: Date; end: Date; description?: string; location?: string },
  ): Promise<UnifiedEvent> {
    const accounts = await this.accounts(user);
    const target =
      accounts.find((a) => a.provider === 'google' && a.is_primary && a.is_writable) ??
      accounts.find((a) => a.provider === 'microsoft' && a.is_primary && a.is_writable) ??
      accounts.find((a) => a.is_writable);
    if (!target) {
      throw new ReauthRequiredError('calendar', 'No writable calendar is connected');
    }

    const started = Date.now();
    try {
      const event =
        target.provider === 'google'
          ? await this.requireGoogle().createEvent(target, { ...input, timezone: user.timezone })
          : await this.requireMicrosoft().createEvent(target, { ...input, timezone: user.timezone });
      await this.repos.integrationLogs.log({
        user_id: user.id,
        integration: target.provider === 'google' ? 'google_calendar' : 'outlook_calendar',
        operation: 'create_event',
        status: 'success',
        latency_ms: Date.now() - started,
      });
      await this.repos.audit.log({
        user_id: user.id,
        action: 'CREATE_EVENT',
        entity_type: 'calendar_event',
        entity_id: event.providerEventId,
        result: { title: event.title, start: event.start.toISOString(), provider: event.provider },
      });
      return event;
    } catch (err) {
      await this.repos.integrationLogs.log({
        user_id: user.id,
        integration: target.provider === 'google' ? 'google_calendar' : 'outlook_calendar',
        operation: 'create_event',
        status: 'failure',
        latency_ms: Date.now() - started,
        error: errorText(err),
      });
      throw err;
    }
  }

  async deleteEvent(user: User, event: UnifiedEvent): Promise<void> {
    const accounts = await this.accounts(user);
    const account = accounts.find((a) => a.provider === event.provider && a.calendar_id === event.calendarId);
    if (!account) throw new ReauthRequiredError('calendar', 'That calendar is no longer connected');
    if (event.provider === 'google') await this.requireGoogle().deleteEvent(account, event.providerEventId);
    else await this.requireMicrosoft().deleteEvent(account, event.providerEventId);
    await this.repos.audit.log({
      user_id: user.id,
      action: 'DELETE_EVENT',
      entity_type: 'calendar_event',
      entity_id: event.providerEventId,
      result: { title: event.title },
    });
  }

  /** Discovers calendars for a freshly connected account and stores them. */
  async syncCalendarList(user: User, connectionId: string, provider: 'google' | 'microsoft'): Promise<number> {
    if (provider === 'google') {
      const list = await this.requireGoogle().listCalendars(connectionId);
      for (const cal of list) {
        await this.repos.calendarAccounts.upsert({
          user_id: user.id,
          oauth_connection_id: connectionId,
          provider: 'google',
          calendar_id: cal.id,
          display_name: cal.summary,
          is_primary: Boolean(cal.primary),
          is_writable: cal.accessRole === 'owner' || cal.accessRole === 'writer',
          enabled: cal.selected !== false,
        });
      }
      return list.length;
    }
    const list = await this.requireMicrosoft().listCalendars(connectionId);
    for (const cal of list) {
      await this.repos.calendarAccounts.upsert({
        user_id: user.id,
        oauth_connection_id: connectionId,
        provider: 'microsoft',
        calendar_id: cal.id,
        display_name: cal.name,
        is_primary: Boolean(cal.isDefaultCalendar),
        is_writable: cal.canEdit !== false,
        enabled: true,
      });
    }
    return list.length;
  }

  private requireGoogle(): GoogleCalendarClient {
    if (!this.google) throw new ReauthRequiredError('google_calendar', 'Google is not configured');
    return this.google;
  }

  private requireMicrosoft(): MicrosoftCalendarClient {
    if (!this.microsoft) throw new ReauthRequiredError('outlook_calendar', 'Microsoft is not configured');
    return this.microsoft;
  }
}
