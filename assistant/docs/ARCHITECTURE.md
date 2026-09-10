# Architecture

## The problem this solves

Action items arrive from WhatsApp, Gmail, Outlook, two calendars and from
conversations you half-remember. They end up in six places, which means they
end up nowhere.

This system gives them **one source of truth** — a Postgres database — and
**one interface** — WhatsApp, in natural Hebrew.

## Principles

1. **WhatsApp is an interface, not a database.** Messages are transport. The
   task list lives in Postgres and survives a lost phone, a cleared chat and a
   changed number.
2. **A task is not a calendar event.** "Prepare the Oracle deck" is a task.
   "Meeting with Yossi, Monday 14:00" is an event. The system never silently
   converts one into the other.
3. **The model decides *what you meant*, never *what happens*.** The LLM emits
   one validated JSON envelope. Every side effect runs in ordinary typed code
   behind a safety gate.
4. **Accuracy over creativity.** No invented events, tasks, emails or urgency.
   An unreachable integration is reported as unreachable, never as "nothing
   found".
5. **Ask only when the answer changes the action.** One matching task → act.
   Four → ask.

## Stack

| Layer | Choice | Why |
|---|---|---|
| Runtime | Node.js 22 + TypeScript strict | One language across the whole system; `strict` + `noUncheckedIndexedAccess` catch the class of bug that hurts most here (undefined dates) |
| HTTP | Fastify 5 | Fast, small, and lets us keep the raw request body — required for Meta's HMAC signature |
| Database | PostgreSQL 17 (Supabase-compatible) | Real constraints, `FOR UPDATE SKIP LOCKED`, JSONB, arrays |
| Validation | Zod 4 | One schema definition validates both the model output and the REST payloads |
| Dates | Luxon | The only part of this that has to be right every single time |
| Logging | pino | Structured JSON with redaction at the logger, not at the call site |
| Tests | Vitest + PGlite | Integration tests run real Postgres in-process, no server to provision |

**No ORM.** The schema is small, the queries are explicit, and the SQL is the
documentation. **No Make.com in the critical path** — see below.

## Request flow

```
WhatsApp (Meta Cloud API)
   │  POST /webhooks/whatsapp
   ▼
[1] Signature check ──── X-Hub-Signature-256 over the RAW body, constant-time
   │
[2] 200 OK returned immediately ──── Meta retries slow responses; a retry is a duplicate
   │
[3] Identify sender ──── unknown number → recorded and dropped
   │
[4] Idempotency claim ──── INSERT wa_message_id; a conflict means "already handled"
   │
[5] Voice? ──── download media → speech-to-text → continue as text
   │
[6] Pending question? ──── "2" or "כן" answers it; no model call
   │
[7] Intent detection
   │      ├── rules fast path (≈70% of daily traffic, 0 ms, no model)
   │      └── LLM → JSON Schema → Zod validation
   │
[8] Safety gate ──── confidence floor on mutations; injection flags cap confidence
   │
[9] Tool handler ──── typed, deterministic; the only code that touches data
   │
[10] External API ──── Google / Microsoft, each failure isolated
   │
[11] Hebrew reply ──── short; buttons where they help
   │
[12] Audit log ──── every action, always
```

### Why the model never computes a date

Ask an LLM for "next Sunday" and you get a date that is right most of the
time. Most of the time is not good enough for a reminder.

The intent schema lets the model return a **relative expression** verbatim
(`"מחר בבוקר"`, `"בעוד שבועיים"`, `"בסוף החודש"`). A deterministic parser
(`src/nlp/hebrew-datetime.ts`) resolves it against the user's clock and
timezone. The model classifies; arithmetic is code. Only an explicitly stated
absolute date (`12/10`, `14:30`) is passed through.

That parser also runs *first*, as a fast path: `"תזכיר לי מחר ב-10 להתקשר
לדני"` never reaches the model at all.

## Timezone and DST

Israel changes clocks twice a year. A reminder set in September for December
must still fire at 09:00 local.

Every task stores **both**:

| Column | Meaning |
|---|---|
| `due_date`, `due_time`, `timezone` | The wall clock the user actually said |
| `due_at`, `reminder_at` (TIMESTAMPTZ) | The absolute instant, derived from the above |

Storing only the instant loses the intent across a DST boundary. Storing only
the wall clock makes scheduling impossible. Whenever the wall clock changes,
the instant is recomputed from it — never the reverse.

Two edge cases are handled explicitly in `wallClockToInstant`:
non-existent local times inside the spring-forward gap (advanced to the first
real instant) and the repeated hour at fall-back (resolved to the earlier
offset, which is what a person means).

`node-postgres` is configured to return `DATE` as literal `'YYYY-MM-DD'` text
rather than a server-timezone-shifted `Date` — otherwise a due date can silently
move a day. The test database applies the identical parser config, so the tests
see exactly the JS types production sees.

## The AI layer

```
AiProvider (interface)
   ├── OpenAiProvider      Chat Completions + response_format: json_schema  (default)
   └── AnthropicProvider   Messages API + output_config.format
```

Nothing outside `src/ai/` knows which provider is in use. Adding one means
implementing a single method.

**Structured output, not prompt-and-hope.** The provider is handed a JSON
Schema and returns JSON that matches it; Zod validates it again before anything
is dispatched. A malformed or refused response becomes `UNKNOWN`, which asks
the user to rephrase.

**One canonical schema, two dialects.** `intent-schema.ts` is written for
expressiveness — numeric ranges, nullable unions, descriptions. Anthropic takes
it as-is. OpenAI's strict Structured Outputs is a deliberately small subset and
**rejects the entire request** on an unsupported keyword, so
`openai-schema.ts` rewrites it on the way out: unsupported validation keywords
are stripped and `type: ["string","null"]` becomes `anyOf`. The constraints are
not lost, they move — Zod enforces them on the way back, and numbers outside
their range are clamped rather than rejected, because a model that answers
`confidence: 1.2` still understood the sentence.

**Refusals and truncation are outcomes, not crashes.** Both providers can
decline: Anthropic with `stop_reason: "refusal"`, OpenAI with a `message.refusal`
field on an HTTP 200 whose `content` is null. Each is detected before the
response is parsed. Hitting the output cap is reported as truncation, so it
does not masquerade as invalid JSON.

**Verifying the credential.** Model ids change and keys get revoked, and the
failure is silent — the assistant just falls back to the rules path and seems
dim. `GET /api/ai-check` does a real round-trip and reports the configured
model, the model that answered, and the latency.

**Cost and latency.** Intent parsing runs at `effort: low` — it is a short
classification on a chat path, not a reasoning task. The rules fast path removes
the model from the common cases entirely.

### Prompt injection

Email bodies and forwarded messages are untrusted input.

- Content is wrapped in `<untrusted_data>` blocks; the system prompt states that
  such content is data, never instructions.
- Delimiter sequences, fake role tags, chat-template markers, zero-width and
  bidi control characters are stripped before the content is sent.
- Patterns are classified by severity. **Override** attempts ("ignore all
  previous instructions") cap confidence wherever they appear. **Destructive
  requests** ("delete all my tasks") only cap confidence inside untrusted
  content — from you directly it is a legitimate request, gated by the
  confirmation flow rather than suppressed.

The structural guarantee is the architecture, not the filters: the model has no
tool access. It emits JSON. Deleting anything requires a typed handler, a
confirmation record this system created, and an explicit "כן".

## Data model

Sixteen tables. The ones that carry the design:

- **`tasks`** — the source of truth. Both wall-clock and instant, `source` /
  `source_id` / `source_url` provenance, `confidence_score` and `ai_generated`
  so an AI-suggested task is always distinguishable from one you typed.
- **`task_reminders`** — separate from tasks because one task can have a primary
  reminder plus bounded follow-ups, each with its own state.
- **`email_task_candidates`** — proposals, not tasks. `dedupe_key` is
  `hash(thread_id + normalised title)`, which is what stops every reply in a
  thread re-proposing the same action item.
- **`pending_confirmations`** — an open question. Creating one supersedes the
  previous, so a stale "which task did you mean?" can never be answered by
  accident.
- **`idempotency_keys`**, unique `wa_message_id` — webhook replays are no-ops.
- **`audit_logs`**, **`integration_logs`**, **`ai_interactions`** — what
  happened, whether the integration worked, and what the model actually said.

Every table carries `user_id`. There is no hard-coded user anywhere in the
business logic: the system is multi-user ready without being multi-tenant
complicated.

## Concurrency

Reminders and scheduled jobs are claimed with `SELECT … FOR UPDATE SKIP LOCKED`
inside a transaction. Two app instances can run against one database without
sending a reminder twice. Scheduled jobs additionally carry a `dedupe_key`
containing the local date, so a restart cannot produce two morning briefings.

## Degradation

Partial failure is a first-class result, not an exception.

`CalendarService.fetchRange` calls every connected calendar with
`Promise.allSettled`. If Google fails and Outlook answers, you get the Outlook
events **and** a sentence saying Google was unavailable. A provider is only
reported as down when none of its calendars answered.

A revoked token raises `ReauthRequiredError`, which is never retried and
surfaces as "reconnect your account" instead of a silent empty result.

## Why not Make.com

Make is genuinely good for wiring integrations. It is a poor place for the logic
that decides whether to delete your tasks.

The rules here: no critical logic in Make, no source of truth in Make, nothing
that is not diffable and testable. The system is complete without it. Should you
want Make for a peripheral flow — pushing a completed task to a spreadsheet,
say — the REST API (`POST /api/tasks`, `POST /api/message`) is the integration
point, and the audit log records what Make did.

## Extending it

Already shaped for it, deliberately not built yet:

- **Monday.com** — `TaskService` is the single writer; a `MondayAdapter`
  subscribing to `task_events` syncs a board without touching the core.
- **More AI providers** — implement `AiProvider`.
- **More calendars/mailboxes** — implement the client interface and register it;
  `mergeCalendars` and `EmailScanner` are already provider-agnostic.
- **Contacts / entity resolution** — the `contacts` and `projects` tables exist
  with `aliases[]`, so "דני", "דני כהן" and "Daniel" can resolve to one person.
