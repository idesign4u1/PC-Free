-- 0002_messaging_ai.sql — WhatsApp traffic, AI debug trail, email pipeline,
-- idempotency, confirmations, conversation state, scheduler and observability.

CREATE TABLE whatsapp_messages (
  id            UUID PRIMARY KEY,
  user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
  direction     TEXT NOT NULL CHECK (direction IN ('inbound','outbound')),
  wa_message_id TEXT UNIQUE,
  wa_from       TEXT,
  wa_to         TEXT,
  message_type  TEXT NOT NULL DEFAULT 'text',
  body          TEXT,                       -- redacted/truncated for storage
  payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
  status        TEXT NOT NULL DEFAULT 'received',
  error         TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX whatsapp_messages_user_idx ON whatsapp_messages (user_id, created_at DESC);

CREATE TABLE ai_interactions (
  id                UUID PRIMARY KEY,
  user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
  kind              TEXT NOT NULL,          -- intent | email_extraction | prioritization | transcription
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  intent            TEXT,
  structured_output JSONB,
  tool_requested    TEXT,
  tool_result       JSONB,
  latency_ms        INTEGER,
  input_tokens      INTEGER,
  output_tokens     INTEGER,
  error             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ai_interactions_user_idx ON ai_interactions (user_id, created_at DESC);

CREATE TABLE email_messages (
  id                  UUID PRIMARY KEY,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_account_id    UUID NOT NULL REFERENCES email_accounts(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL CHECK (provider IN ('google','microsoft')),
  provider_message_id TEXT NOT NULL,
  thread_id           TEXT NOT NULL,
  from_address        TEXT,
  from_name           TEXT,
  subject             TEXT,
  received_at         TIMESTAMPTZ,
  web_url             TEXT,
  processed_at        TIMESTAMPTZ,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (email_account_id, provider_message_id)
);
CREATE INDEX email_messages_thread_idx ON email_messages (user_id, thread_id);

CREATE TABLE email_task_candidates (
  id                  UUID PRIMARY KEY,
  user_id             UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email_message_id    UUID NOT NULL REFERENCES email_messages(id) ON DELETE CASCADE,
  thread_id           TEXT NOT NULL,
  title               TEXT NOT NULL,
  description         TEXT,
  due_date            DATE,
  due_time            TEXT,
  contact_name        TEXT,
  contact_email       TEXT,
  confidence          NUMERIC(3,2) NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending','approved','ignored','snoozed','expired','auto_added')),
  dedupe_key          TEXT NOT NULL,
  task_id             UUID REFERENCES tasks(id) ON DELETE SET NULL,
  proposed_at         TIMESTAMPTZ,
  responded_at        TIMESTAMPTZ,
  snoozed_until       TIMESTAMPTZ,
  wa_message_id       TEXT,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, dedupe_key)
);
CREATE INDEX email_task_candidates_status_idx ON email_task_candidates (user_id, status, created_at DESC);

CREATE TABLE idempotency_keys (
  scope      TEXT NOT NULL,
  key        TEXT NOT NULL,
  result     JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (scope, key)
);
CREATE INDEX idempotency_keys_created_idx ON idempotency_keys (created_at);

CREATE TABLE pending_confirmations (
  id         UUID PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,       -- dangerous_action | disambiguation | conflict_choice | email_candidate
  payload    JSONB NOT NULL,
  prompt     TEXT NOT NULL,
  status     TEXT NOT NULL DEFAULT 'pending'
             CHECK (status IN ('pending','confirmed','rejected','expired','superseded')),
  expires_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX pending_confirmations_user_idx ON pending_confirmations (user_id, status, created_at DESC);

CREATE TABLE conversation_state (
  user_id                UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_inbound_at        TIMESTAMPTZ,
  last_outbound_at       TIMESTAMPTZ,
  last_task_id           UUID REFERENCES tasks(id) ON DELETE SET NULL,
  recent_turns           JSONB NOT NULL DEFAULT '[]'::jsonb,
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE scheduler_jobs (
  id          UUID PRIMARY KEY,
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,
  job_type    TEXT NOT NULL,      -- daily_briefing | eod_summary | email_scan | token_refresh | candidate_expiry
  run_at      TIMESTAMPTZ NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending'
              CHECK (status IN ('pending','running','done','failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  locked_at   TIMESTAMPTZ,
  payload     JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key  TEXT UNIQUE,
  last_error  TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX scheduler_jobs_due_idx ON scheduler_jobs (status, run_at);

CREATE TABLE integration_logs (
  id          UUID PRIMARY KEY,
  user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
  integration TEXT NOT NULL,      -- whatsapp | google_calendar | outlook_calendar | gmail | outlook_mail | ai | stt
  operation   TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('success','failure')),
  latency_ms  INTEGER,
  error       TEXT,
  meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX integration_logs_idx ON integration_logs (integration, created_at DESC);

CREATE TABLE integration_status (
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  integration     TEXT NOT NULL,
  status          TEXT NOT NULL DEFAULT 'unknown'
                  CHECK (status IN ('unknown','ok','degraded','down','not_connected')),
  last_success_at TIMESTAMPTZ,
  last_failure_at TIMESTAMPTZ,
  last_error      TEXT,
  meta            JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, integration)
);
