export type TaskStatus = 'inbox' | 'open' | 'in_progress' | 'waiting' | 'completed' | 'cancelled';
export type TaskPriority = 'low' | 'normal' | 'high' | 'urgent';
export type TaskSource =
  'whatsapp' | 'whatsapp_voice' | 'gmail' | 'outlook' | 'api' | 'system' | 'manual';
export type Provider = 'google' | 'microsoft';

export const OPEN_STATUSES: TaskStatus[] = ['inbox', 'open', 'in_progress', 'waiting'];

export interface Recurrence {
  freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
  interval: number;
  /** 0 = Sunday … 6 = Saturday, matching the Hebrew week. */
  byweekday?: number[];
  bymonthday?: number;
  until?: string | null;
  count?: number | null;
  occurrences?: number;
}

export interface Task {
  id: string;
  user_id: string;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: TaskPriority;
  due_date: string | null;
  due_time: string | null;
  due_at: Date | null;
  timezone: string;
  reminder_at: Date | null;
  source: TaskSource;
  source_id: string | null;
  source_url: string | null;
  source_metadata: Record<string, unknown>;
  project: string | null;
  client: string | null;
  tags: string[];
  completed_at: Date | null;
  snoozed_until: Date | null;
  parent_task_id: string | null;
  recurrence: Recurrence | null;
  confidence_score: number | null;
  ai_generated: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface User {
  id: string;
  display_name: string;
  whatsapp_phone: string;
  email: string | null;
  timezone: string;
  locale: string;
  is_active: boolean;
}

export interface Settings {
  user_id: string;
  daily_briefing_enabled: boolean;
  daily_briefing_time: string;
  eod_summary_enabled: boolean;
  eod_summary_time: string;
  quiet_hours_start: string;
  quiet_hours_end: string;
  follow_up_enabled: boolean;
  follow_up_interval_minutes: number;
  max_followups: number;
  email_scan_enabled: boolean;
  email_scan_interval_minutes: number;
  email_min_confidence: number;
  email_auto_add_confidence: number;
  default_reminder_lead_minutes: number;
  workday_start: string;
  workday_end: string;
  extra: Record<string, unknown>;
}

export interface TaskReminder {
  id: string;
  task_id: string;
  user_id: string;
  remind_at: Date;
  kind: 'primary' | 'followup';
  status: 'pending' | 'sent' | 'cancelled' | 'failed' | 'deferred';
  channel: string;
  followup_index: number;
  sent_at: Date | null;
  attempt_count: number;
  last_error: string | null;
}

export interface OAuthConnection {
  id: string;
  user_id: string;
  provider: Provider;
  account_email: string;
  scopes: string[];
  access_token_enc: string | null;
  refresh_token_enc: string | null;
  expires_at: Date | null;
  status: 'connected' | 'needs_reauth' | 'revoked' | 'error';
  last_error: string | null;
}

export interface CalendarAccount {
  id: string;
  user_id: string;
  oauth_connection_id: string;
  provider: Provider;
  calendar_id: string;
  display_name: string;
  is_primary: boolean;
  is_writable: boolean;
  enabled: boolean;
}

export interface EmailAccount {
  id: string;
  user_id: string;
  oauth_connection_id: string;
  provider: Provider;
  address: string;
  enabled: boolean;
  sync_cursor: string | null;
  last_scanned_at: Date | null;
}

/** A calendar event normalised across Google and Microsoft. */
export interface UnifiedEvent {
  provider: Provider;
  calendarId: string;
  calendarName: string;
  providerEventId: string;
  /** Cross-provider identity hint (iCalUID) used for deduplication. */
  icalUid: string | null;
  title: string;
  start: Date;
  end: Date;
  allDay: boolean;
  location: string | null;
  organizer: string | null;
  attendees: string[];
  status: string | null;
  isCancelled: boolean;
  showAsBusy: boolean;
  htmlLink: string | null;
}

export interface EmailTaskCandidate {
  id: string;
  user_id: string;
  email_message_id: string;
  thread_id: string;
  title: string;
  description: string | null;
  due_date: string | null;
  due_time: string | null;
  contact_name: string | null;
  contact_email: string | null;
  confidence: number;
  status: 'pending' | 'approved' | 'ignored' | 'snoozed' | 'expired' | 'auto_added';
  dedupe_key: string;
  task_id: string | null;
  snoozed_until: Date | null;
}
