import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { App } from '../app.js';
import { isAuthorised } from '../api/health-routes.js';
import { describeDateHe } from '../utils/time.js';

/**
 * A small read-only operations dashboard: tasks, connection health, and the
 * automation/error logs. Deliberately server-rendered with no build step and no
 * client framework — it exists to answer "is anything broken?".
 */

function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const STYLE = `
:root{color-scheme:light dark;--bg:#fbfbfd;--fg:#1c1c1e;--muted:#6b6b70;--card:#fff;--line:#e5e5ea;--accent:#0a84ff}
@media(prefers-color-scheme:dark){:root{--bg:#0f0f11;--fg:#f2f2f7;--muted:#9a9aa0;--card:#1b1b1f;--line:#2c2c30}}
*{box-sizing:border-box}
body{margin:0;padding:24px;background:var(--bg);color:var(--fg);font:14px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
.wrap{max-width:1100px;margin:0 auto}
h1{font-size:1.35rem;margin:0 0 4px}
.sub{color:var(--muted);margin:0 0 24px}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin-bottom:24px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px}
.card .n{font-size:1.7rem;font-weight:650}
.card .l{color:var(--muted);font-size:.82rem}
section{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:16px;margin-bottom:20px}
h2{font-size:1rem;margin:0 0 12px}
table{width:100%;border-collapse:collapse;font-size:.85rem}
th{text-align:start;color:var(--muted);font-weight:600;padding:6px 8px;border-bottom:1px solid var(--line)}
td{padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
tr:last-child td{border-bottom:0}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:.75rem;border:1px solid var(--line)}
.ok{color:#0a7c3a;border-color:#0a7c3a55}.bad{color:#c1121f;border-color:#c1121f55}.warn{color:#b8730a;border-color:#b8730a55}
.scroll{overflow-x:auto}
code{font-size:.8rem}
`;

export function registerAdminDashboard(server: FastifyInstance, app: App): void {
  server.get('/admin', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isAuthorised(req, app)) {
      return reply
        .code(401)
        .type('text/html')
        .send('<h1>401</h1><p>Add ?token=&lt;ADMIN_TOKEN&gt;</p>');
    }

    const users = await app.repos.users.listActive();
    const user = users[0];
    if (!user)
      return reply.type('text/html').send(`<style>${STYLE}</style><h1>No user registered yet</h1>`);

    const now = new Date();
    const [
      tasks,
      counts,
      connections,
      calendars,
      mailboxes,
      integrations,
      failures,
      audit,
      candidates,
    ] = await Promise.all([
      app.repos.tasks.list(user.id, { limit: 40, includeSnoozed: true }),
      app.repos.tasks.countByStatus(user.id),
      app.repos.oauth.listForUser(user.id),
      app.repos.calendarAccounts.listEnabled(user.id),
      app.repos.emailAccounts.listEnabled(user.id),
      app.repos.integrationLogs.status(user.id),
      app.repos.integrationLogs.recentFailures(15),
      app.repos.audit.recent(25, user.id),
      app.repos.email.listCandidates(user.id, 'pending', 10),
    ]);

    const open = Object.entries(counts)
      .filter(([s]) => !['completed', 'cancelled'].includes(s))
      .reduce((sum, [, n]) => sum + n, 0);
    const overdue = tasks.filter(
      (t) => t.due_at && t.due_at < now && t.status !== 'completed',
    ).length;
    const sched = app.scheduler.status();

    const connectionRows = connections
      .map(
        (c) => `<tr><td>${esc(c.provider)}</td><td>${esc(c.account_email)}</td>
        <td><span class="pill ${c.status === 'connected' ? 'ok' : 'bad'}">${esc(c.status)}</span></td>
        <td>${c.expires_at ? esc(new Date(c.expires_at).toISOString().slice(0, 16).replace('T', ' ')) : '—'}</td>
        <td><code>${esc(c.last_error ?? '')}</code></td></tr>`,
      )
      .join('');

    const taskRows = tasks
      .map(
        (t) => `<tr><td>${esc(t.title)}</td>
        <td><span class="pill">${esc(t.status)}</span></td>
        <td>${esc(t.priority)}</td>
        <td>${t.due_date ? esc(`${describeDateHe(t.due_date, user.timezone, now)}${t.due_time ? ` ${t.due_time}` : ''}`) : '—'}</td>
        <td>${esc(t.source)}</td>
        <td>${t.ai_generated ? `AI ${t.confidence_score ?? ''}` : '—'}</td></tr>`,
      )
      .join('');

    const integrationRows = integrations
      .map((i) => {
        const record = i as Record<string, unknown>;
        const status = String(record.status);
        return `<tr><td>${esc(record.integration)}</td>
        <td><span class="pill ${status === 'ok' ? 'ok' : status === 'not_connected' ? 'warn' : 'bad'}">${esc(status)}</span></td>
        <td>${esc(record.last_success_at ?? '—')}</td>
        <td><code>${esc(record.last_error ?? '')}</code></td></tr>`;
      })
      .join('');

    const failureRows = failures
      .map((f) => {
        const r = f as Record<string, unknown>;
        return `<tr><td>${esc(r.created_at)}</td><td>${esc(r.integration)}</td><td>${esc(r.operation)}</td><td><code>${esc(r.error)}</code></td></tr>`;
      })
      .join('');

    const auditRows = audit
      .map((a) => {
        const r = a as Record<string, unknown>;
        return `<tr><td>${esc(r.created_at)}</td><td>${esc(r.action)}</td><td>${esc(r.entity_type ?? '')}</td>
        <td><span class="pill ${r.status === 'success' ? 'ok' : r.status === 'skipped' ? 'warn' : 'bad'}">${esc(r.status)}</span></td>
        <td>${esc(r.source)}</td></tr>`;
      })
      .join('');

    const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Assistant Admin</title><style>${STYLE}</style>
<div class="wrap">
<h1>Shay AI Assistant</h1>
<p class="sub">${esc(user.display_name)} · ${esc(user.timezone)} · ${esc(now.toISOString())}</p>

<div class="grid">
  <div class="card"><div class="n">${open}</div><div class="l">משימות פתוחות</div></div>
  <div class="card"><div class="n">${overdue}</div><div class="l">באיחור</div></div>
  <div class="card"><div class="n">${counts.completed ?? 0}</div><div class="l">הושלמו</div></div>
  <div class="card"><div class="n">${candidates.length}</div><div class="l">הצעות מייל ממתינות</div></div>
  <div class="card"><div class="n">${calendars.length}</div><div class="l">יומנים מחוברים</div></div>
  <div class="card"><div class="n">${mailboxes.length}</div><div class="l">תיבות מייל</div></div>
</div>

<section><h2>Scheduler</h2>
<p><span class="pill ${sched.running ? 'ok' : 'bad'}">${sched.running ? 'running' : 'stopped'}</span>
 last tick: ${esc(sched.lastTickAt?.toISOString() ?? 'never')} ${sched.lastError ? `<code>${esc(sched.lastError)}</code>` : ''}</p></section>

<section><h2>Connections</h2><div class="scroll"><table>
<tr><th>Provider</th><th>Account</th><th>Status</th><th>Token expires</th><th>Last error</th></tr>
${connectionRows || '<tr><td colspan="5">No connections yet.</td></tr>'}</table></div></section>

<section><h2>Integration status</h2><div class="scroll"><table>
<tr><th>Integration</th><th>Status</th><th>Last success</th><th>Last error</th></tr>
${integrationRows || '<tr><td colspan="4">No activity recorded.</td></tr>'}</table></div></section>

<section><h2>Tasks</h2><div class="scroll"><table>
<tr><th>Title</th><th>Status</th><th>Priority</th><th>Due</th><th>Source</th><th>AI</th></tr>
${taskRows || '<tr><td colspan="6">No tasks.</td></tr>'}</table></div></section>

<section><h2>Recent errors</h2><div class="scroll"><table>
<tr><th>When</th><th>Integration</th><th>Operation</th><th>Error</th></tr>
${failureRows || '<tr><td colspan="4">No failures 🎉</td></tr>'}</table></div></section>

<section><h2>Automation log</h2><div class="scroll"><table>
<tr><th>When</th><th>Action</th><th>Entity</th><th>Status</th><th>Source</th></tr>
${auditRows || '<tr><td colspan="5">Nothing yet.</td></tr>'}</table></div></section>
</div>`;

    return reply.type('text/html; charset=utf-8').send(html);
  });
}
