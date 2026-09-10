# Deployment

Requirements: HTTPS with a stable public URL (Meta and both OAuth providers
redirect to it), PostgreSQL 15+, and a process that stays running — the
scheduler is in-process, so a platform that sleeps idle containers will not
deliver reminders.

---

## Option A — Docker Compose (own VPS)

Simplest thing that is fully in your control.

```bash
git clone <repo> && cd assistant
cp .env.example .env
```

Fill in `.env` (see the setup docs), then:

```env
NODE_ENV=production
APP_URL=https://assistant.yourdomain.com
# DATABASE_URL is overridden by compose to reach the db service
```

```bash
docker compose up -d --build
docker compose logs -f app
```

Migrations run automatically on boot. Verify:

```bash
curl -s https://assistant.yourdomain.com/health | jq
```

### TLS

Compose exposes plain HTTP on 3000; put a reverse proxy in front. Caddy is two
lines:

```caddyfile
assistant.yourdomain.com {
    reverse_proxy localhost:3000
}
```

Caddy obtains and renews the certificate itself. With nginx, use certbot and
make sure the proxy passes the request body through **unmodified** — rewriting
it breaks Meta's webhook signature.

### Backups

The task list is the asset. Nightly dump:

```bash
0 3 * * * docker compose -f /srv/assistant/docker-compose.yml exec -T db \
  pg_dump -U assistant assistant | gzip > /backups/assistant-$(date +\%F).sql.gz
```

Restore: `gunzip -c backup.sql.gz | docker compose exec -T db psql -U assistant assistant`.

---

## Option B — Managed platform + Supabase

Works on Railway, Render, Fly.io or any container host that does **not** sleep.

1. **Database.** Create a Supabase project. Take the **session pooler**
   connection string from *Project settings → Database → Connection string*
   (the transaction pooler does not support the session-level locking the
   scheduler uses). Set `DATABASE_URL` and `DATABASE_SSL=true`.
2. **App.** Point the platform at this repo. It builds from the `Dockerfile`;
   no start command needed.
3. **Environment.** Add every variable from `.env.example`. Set `PORT` to
   whatever the platform injects (most do this automatically).
4. **Disable sleep.** Railway: no sleep on a paid plan. Render: use a paid
   instance, not free. Fly.io: set `min_machines_running = 1`.
5. **APP_URL.** Set it to the platform's HTTPS URL, then update the Meta
   webhook callback and both OAuth redirect URIs to match.

> **Serverless is not suitable.** Vercel and Lambda cannot host the scheduler:
> reminders need a resident process. If you must run serverless, split the
> scheduler into an external cron hitting `POST /api/scheduler/tick` every
> minute with `ADMIN_TOKEN`.

---

## First-run checklist

```bash
curl -s https://<domain>/health | jq '.capabilities'
```

Every capability you configured should be `true`. Then:

1. **Webhook.** Meta app → WhatsApp → Configuration → point the callback at
   `https://<domain>/webhooks/whatsapp`, subscribe to `messages`.
2. **Google.** Visit `https://<domain>/oauth/google/start`.
3. **Microsoft.** Visit `https://<domain>/oauth/microsoft/start`.
4. **Smoke test.** WhatsApp: `תזכיר לי בעוד שתי דקות לבדוק שהמערכת עובדת`.
   The confirmation is immediate; the reminder arrives two minutes later.
5. **Dashboard.** `https://<domain>/admin?token=<ADMIN_TOKEN>`.

---

## Operations

### Monitoring

| Endpoint | Use |
|---|---|
| `GET /health` | Liveness probe. `503` when the database is unreachable |
| `GET /health/full?token=…` | Integration status, token expiry, last webhook, last reminder, recent failures |
| `GET /admin?token=…` | Human view of the same, plus tasks and the audit log |

Alert on: `/health` non-200; `lastReminderSentAt` older than expected;
any connection in `/health/full` with `status != connected`.

### Logs

Structured JSON on stdout. Useful filters:

```bash
docker compose logs app | jq 'select(.level >= 40)'                  # warnings and errors
docker compose logs app | jq 'select(.msg | test("reminder"))'
docker compose logs app | jq 'select(.integration == "google_calendar")'
```

Set `LOG_LEVEL=debug` temporarily to trace intent routing.

### Migrations

Applied automatically at boot, inside a transaction, recorded in
`schema_migrations`. To run them by hand:

```bash
docker compose exec app node -e "import('./dist/db/cli-migrate.js')"
# or, from a checkout: npm run migrate
```

Adding one: create `migrations/000N_description.sql`. Never edit an applied
file — the runner skips anything already recorded.

### Upgrades

```bash
git pull && docker compose up -d --build
```

Zero-downtime is unnecessary at this scale; the restart takes seconds and Meta
retries any webhook that lands during it.

### Scaling

One instance is right for one user. If you run more, nothing breaks: reminders
and jobs are claimed with `FOR UPDATE SKIP LOCKED` and scheduled jobs carry a
date-scoped `dedupe_key`, so no reminder or briefing is ever sent twice.

---

## Troubleshooting

| Symptom | Where to look |
|---|---|
| No reply to WhatsApp | `/health` first. Then logs for `invalid signature` or `unregistered number` |
| Reminders never arrive | `scheduler.running` in `/health`. Check `SCHEDULER_ENABLED`, and that the host is not sleeping |
| Reminders arrive an hour off | Container timezone. `TZ=Asia/Jerusalem` is set in compose; the Dockerfile installs `tzdata` |
| `column … does not exist` | Migrations did not run — check boot logs |
| Calendar empty but populated in the UI | `/health/full` → connection status. Usually an expired token needing reconnect |
| `needs_reauth` on a connection | Re-run the `/oauth/<provider>/start` flow |
| Everything worked, then stopped after a week | Google Testing-mode refresh-token expiry — see `docs/GOOGLE_SETUP.md` |
