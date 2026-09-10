import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { App } from '../app.js';
import { capabilities, missingCredentials } from '../config/env.js';
import { errorText } from '../utils/errors.js';

/**
 * Observability surface.
 *
 * /health      — liveness + database reachability, safe to expose to a probe.
 * /health/full — integration status, last sync, last webhook, last reminder.
 *                Requires ADMIN_TOKEN because it names connected accounts.
 */
export function registerHealthRoutes(server: FastifyInstance, app: App): void {
  server.get('/health', async (_req, reply: FastifyReply) => {
    let database = 'ok';
    try {
      await app.db.query('SELECT 1');
    } catch (err) {
      database = `error: ${errorText(err)}`;
    }
    const status = database === 'ok' ? 200 : 503;
    return reply.code(status).send({
      status: status === 200 ? 'ok' : 'degraded',
      database,
      uptimeSeconds: Math.round(process.uptime()),
      capabilities: capabilities(app.env),
      scheduler: app.scheduler.status(),
    });
  });

  server.get('/health/full', async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isAuthorised(req, app)) return reply.code(401).send({ error: 'unauthorized' });

    const users = await app.repos.users.listActive();
    const perUser = [];
    for (const user of users) {
      const [integrations, connections, calendars, emails, lastInbound] = await Promise.all([
        app.repos.integrationLogs.status(user.id),
        app.repos.oauth.listForUser(user.id),
        app.repos.calendarAccounts.listEnabled(user.id),
        app.repos.emailAccounts.listEnabled(user.id),
        app.repos.whatsapp.lastInboundAt(user.id),
      ]);
      perUser.push({
        userId: user.id,
        name: user.display_name,
        timezone: user.timezone,
        integrations,
        connections: connections.map((c) => ({
          provider: c.provider,
          account: c.account_email,
          status: c.status,
          expiresAt: c.expires_at,
          lastError: c.last_error,
        })),
        calendars: calendars.map((c) => ({ provider: c.provider, name: c.display_name, primary: c.is_primary })),
        mailboxes: emails.map((e) => ({ provider: e.provider, address: e.address, lastScannedAt: e.last_scanned_at })),
        lastInboundAt: lastInbound,
      });
    }

    return reply.send({
      status: 'ok',
      missingCredentials: missingCredentials(app.env),
      scheduler: app.scheduler.status(),
      lastWebhookReceivedAt: await app.repos.whatsapp.lastWebhookAt(),
      lastReminderSentAt: await app.repos.reminders.lastSentAt(),
      recentIntegrationFailures: await app.repos.integrationLogs.recentFailures(10),
      users: perUser,
    });
  });
}

export function isAuthorised(req: FastifyRequest, app: App): boolean {
  if (!app.env.ADMIN_TOKEN) return app.env.NODE_ENV !== 'production';
  const header = req.headers.authorization;
  const query = (req.query as { token?: string }).token;
  const provided = header?.startsWith('Bearer ') ? header.slice(7) : query;
  return provided === app.env.ADMIN_TOKEN;
}
