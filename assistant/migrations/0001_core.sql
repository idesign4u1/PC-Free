-- 0001_core.sql — users, settings, oauth, tasks, reminders, audit.
-- All timestamps are stored as TIMESTAMPTZ (UTC on the wire). Wall-clock intent
-- that must survive a DST shift is stored separately in due_date/due_time + timezone.

CREATE TABLE users (
  id              UUID PRIMARY KEY,
  display_name    TEXT        NOT NULL,
  whatsapp_phone  TEXT        NOT NULL UNIQUE,   -- E.164 digits, no '+'
  email           TEXT,
  timezone        TEXT        NOT NULL DEFAULT 'Asia/Jerusalem',
  locale          TEXT        NOT NULL DEFAULT 'he',
  is_active       BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE settings (
  user_id                    UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  daily_briefing_enabled     BOOLEAN NOT NULL DEFAULT TRUE,
  daily_briefing_time        TEXT    NOT NULL DEFAULT '07:30',
  eod_summary_enabled        BOOLEAN NOT NULL DEFAULT TRUE,
  eod_summary_time           TEXT    NOT NULL DEFAULT '20:30',
  quiet_hours_start          TEXT    NOT NULL DEFAULT '23:00',
  quiet_hours_end            TEXT    NOT NULL DEFAULT '07:00',
  follow_up_enabled          BOOLEAN NOT NULL DEFAULT TRUE,
  follow_up_interval_minutes INTEGER NOT NULL DEFAULT 120,
  max_followups              INTEGER NOT NULL DEFAULT 2,
  email_scan_enabled         BOOLEAN NOT NULL DEFAULT TRUE,
  email_scan_interval_minutes INTEGER NOT NULL DEFAULT 15,
  email_min_confidence       NUMERIC(3,2) NOT NULL DEFAULT 0.60,
  email_auto_add_confidence  NUMERIC(3,2) NOT NULL DEFAULT 1.01, -- >1 disables auto-add
  default_reminder_lead_minutes INTEGER NOT NULL DEFAULT 0,
  workday_start              TEXT    NOT NULL DEFAULT '09:00',
  workday_end                TEXT    NOT NULL DEFAULT '18:00',
  extra                      JSONB   NOT NULL DEFAULT '{}'::jsonb,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE oauth_connections (
  id                 UUID PRIMARY KEY,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  provider           TEXT NOT NULL CHECK (provider IN ('google','microsoft')),
  account_email      TEXT NOT NULL,
  scopes             TEXT[] NOT NULL DEFAULT '{}',
  access_token_enc   TEXT,
  refresh_token_enc  TEXT,
  expires_at         TIMESTAMPTZ,
  status             TEXT NOT NULL DEFAULT 'connected'
                     CHECK (status IN ('connected','needs_reauth','revoked','error')),
  last_error         TEXT,
  last_refreshed_at  TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, account_email)
);

CREATE TABLE calendar_accounts (
  id                   UUID PRIMARY KEY,
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  oauth_connection_id  UUID NOT NULL REFERENCES oauth_connections(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL CHECK (provider IN ('google','microsoft')),
  calendar_id          TEXT NOT NULL,
  display_name         TEXT NOT NULL,
  is_primary           BOOLEAN NOT NULL DEFAULT FALSE,
  is_writable          BOOLEAN NOT NULL DEFAULT TRUE,
  enabled              BOOLEAN NOT NULL DEFAULT TRUE,
  last_sync_at         TIMESTAMPTZ,
  last_sync_status     TEXT,
  last_error           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (oauth_connection_id, calendar_id)
);

CREATE TABLE email_accounts (
  id                   UUID PRIMARY KEY,
  user_id              UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  oauth_connection_id  UUID NOT NULL REFERENCES oauth_connections(id) ON DELETE CASCADE,
  provider             TEXT NOT NULL CHECK (provider IN ('google','microsoft')),
  address              TEXT NOT NULL,
  enabled              BOOLEAN NOT NULL DEFAULT TRUE,
  sync_cursor          TEXT,              -- Gmail historyId / Graph delta link
  last_scanned_at      TIMESTAMPTZ,
  last_sync_status     TEXT,
  last_error           TEXT,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, provider, address)
);

CREATE TABLE projects (
  id         UUID PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL,
  aliases    TEXT[] NOT NULL DEFAULT '{}',
  client     TEXT,
  status     TEXT NOT NULL DEFAULT 'active',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);

CREATE TABLE contacts (
  id           UUID PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  display_name TEXT NOT NULL,
  aliases      TEXT[] NOT NULL DEFAULT '{}',
  emails       TEXT[] NOT NULL DEFAULT '{}',
  phones       TEXT[] NOT NULL DEFAULT '{}',
  organization TEXT,
  notes        TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, display_name)
);

CREATE TABLE tasks (
  id               UUID PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title            TEXT NOT NULL,
  description      TEXT,
  status           TEXT NOT NULL DEFAULT 'inbox'
                   CHECK (status IN ('inbox','open','in_progress','waiting','completed','cancelled')),
  priority         TEXT NOT NULL DEFAULT 'normal'
                   CHECK (priority IN ('low','normal','high','urgent')),
  due_date         DATE,                 -- local wall-clock date in `timezone`
  due_time         TEXT,                 -- 'HH:mm' local wall-clock, NULL = all-day
  due_at           TIMESTAMPTZ,          -- derived absolute instant, kept in sync
  timezone         TEXT NOT NULL DEFAULT 'Asia/Jerusalem',
  reminder_at      TIMESTAMPTZ,          -- absolute instant of the next primary reminder
  source           TEXT NOT NULL DEFAULT 'whatsapp'
                   CHECK (source IN ('whatsapp','whatsapp_voice','gmail','outlook','api','system','manual')),
  source_id        TEXT,
  source_url       TEXT,
  source_metadata  JSONB NOT NULL DEFAULT '{}'::jsonb,
  project          TEXT,
  client           TEXT,
  tags             TEXT[] NOT NULL DEFAULT '{}',
  completed_at     TIMESTAMPTZ,
  snoozed_until    TIMESTAMPTZ,
  parent_task_id   UUID REFERENCES tasks(id) ON DELETE SET NULL,
  recurrence       JSONB,                -- {freq,interval,byweekday[],bymonthday,until,count}
  confidence_score NUMERIC(3,2),
  ai_generated     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX tasks_user_status_idx   ON tasks (user_id, status);
CREATE INDEX tasks_user_due_idx      ON tasks (user_id, due_at);
CREATE INDEX tasks_user_created_idx  ON tasks (user_id, created_at DESC);
CREATE INDEX tasks_source_idx        ON tasks (user_id, source, source_id);

CREATE TABLE task_reminders (
  id             UUID PRIMARY KEY,
  task_id        UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  remind_at      TIMESTAMPTZ NOT NULL,
  kind           TEXT NOT NULL DEFAULT 'primary' CHECK (kind IN ('primary','followup')),
  status         TEXT NOT NULL DEFAULT 'pending'
                 CHECK (status IN ('pending','sent','cancelled','failed','deferred')),
  channel        TEXT NOT NULL DEFAULT 'whatsapp',
  followup_index INTEGER NOT NULL DEFAULT 0,
  sent_at        TIMESTAMPTZ,
  attempt_count  INTEGER NOT NULL DEFAULT 0,
  locked_at      TIMESTAMPTZ,
  last_error     TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX task_reminders_due_idx  ON task_reminders (status, remind_at);
CREATE INDEX task_reminders_task_idx ON task_reminders (task_id, status);

CREATE TABLE task_events (
  id         UUID PRIMARY KEY,
  task_id    UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX task_events_task_idx ON task_events (task_id, created_at DESC);

CREATE TABLE audit_logs (
  id          UUID PRIMARY KEY,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  action      TEXT NOT NULL,
  entity_type TEXT,
  entity_id   TEXT,
  source      TEXT NOT NULL DEFAULT 'system',
  input       JSONB,
  result      JSONB,
  status      TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success','failure','skipped')),
  error       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX audit_logs_user_idx   ON audit_logs (user_id, created_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC);
