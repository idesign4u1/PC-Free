import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { App } from '../app.js';
import type { Provider } from '../domain/types.js';
import { randomToken } from '../utils/crypto.js';
import { logger } from '../utils/logger.js';
import { errorText } from '../utils/errors.js';

/**
 * OAuth connect/callback for Google and Microsoft.
 *
 * `state` is a single-use random token bound to a user id, held in memory with
 * a short TTL. It is the CSRF defence required by the OAuth spec: a callback
 * carrying an unknown state is rejected outright.
 */
const stateStore = new Map<string, { userId: string; provider: Provider; expiresAt: number }>();
const STATE_TTL_MS = 10 * 60 * 1000;

function issueState(userId: string, provider: Provider): string {
  const token = randomToken(24);
  stateStore.set(token, { userId, provider, expiresAt: Date.now() + STATE_TTL_MS });
  for (const [key, value] of stateStore) if (value.expiresAt < Date.now()) stateStore.delete(key);
  return token;
}

function consumeState(token: string): { userId: string; provider: Provider } | null {
  const entry = stateStore.get(token);
  if (!entry) return null;
  stateStore.delete(token);
  if (entry.expiresAt < Date.now()) return null;
  return { userId: entry.userId, provider: entry.provider };
}

/** Reads the account's own address so we can tell "from me" apart from inbound. */
async function fetchAccountEmail(provider: Provider, accessToken: string): Promise<string> {
  if (provider === 'google') {
    const res = await fetch('https://openidconnect.googleapis.com/v1/userinfo', {
      headers: { authorization: `Bearer ${accessToken}` },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`Google userinfo failed (${res.status})`);
    const data = (await res.json()) as { email?: string };
    if (!data.email) throw new Error('Google userinfo returned no email');
    return data.email.toLowerCase();
  }
  const res = await fetch('https://graph.microsoft.com/v1.0/me', {
    headers: { authorization: `Bearer ${accessToken}` },
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`Microsoft /me failed (${res.status})`);
  const data = (await res.json()) as { mail?: string; userPrincipalName?: string };
  const email = data.mail ?? data.userPrincipalName;
  if (!email) throw new Error('Microsoft /me returned no address');
  return email.toLowerCase();
}

function page(title: string, body: string): string {
  return `<!doctype html><meta charset="utf-8"><title>${title}</title>
<style>body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:34rem;margin:4rem auto;padding:0 1.5rem;line-height:1.6;color:#1c1c1e}
h1{font-size:1.4rem}code{background:#f2f2f7;padding:.15rem .35rem;border-radius:4px}</style>
<h1>${title}</h1>${body}`;
}

export function registerOAuthRoutes(server: FastifyInstance, app: App): void {
  for (const provider of ['google', 'microsoft'] as const) {
    server.get(`/oauth/${provider}/start`, async (req: FastifyRequest, reply: FastifyReply) => {
      if (!app.tokens)
        return reply
          .code(501)
          .type('text/html')
          .send(page('לא מוגדר', '<p>ENCRYPTION_KEY חסר.</p>'));

      const query = req.query as { user_id?: string; phone?: string };
      const user = query.user_id
        ? await app.repos.users.findById(query.user_id)
        : query.phone
          ? await app.repos.users.findByPhone(query.phone)
          : (await app.repos.users.listActive())[0];
      if (!user)
        return reply
          .code(404)
          .type('text/html')
          .send(page('לא נמצא משתמש', '<p>אין משתמש רשום במערכת.</p>'));

      try {
        const url = app.tokens.buildAuthUrl(provider, issueState(user.id, provider));
        return reply.redirect(url);
      } catch (err) {
        return reply
          .code(501)
          .type('text/html')
          .send(page('לא מוגדר', `<p>${errorText(err)}</p>`));
      }
    });

    server.get(`/oauth/${provider}/callback`, async (req: FastifyRequest, reply: FastifyReply) => {
      const query = req.query as {
        code?: string;
        state?: string;
        error?: string;
        error_description?: string;
      };
      if (query.error) {
        return reply
          .code(400)
          .type('text/html')
          .send(page('החיבור בוטל', `<p>${query.error_description ?? query.error}</p>`));
      }
      if (!query.code || !query.state) {
        return reply
          .code(400)
          .type('text/html')
          .send(page('בקשה לא תקינה', '<p>חסר code או state.</p>'));
      }

      const state = consumeState(query.state);
      if (!state || state.provider !== provider) {
        logger().warn({ provider }, 'oauth callback with an unknown state');
        return reply
          .code(400)
          .type('text/html')
          .send(page('בקשה לא תקינה', '<p>ה־state לא מוכר או פג תוקף. נסה לחבר שוב.</p>'));
      }
      if (!app.tokens) return reply.code(501).send('not configured');

      try {
        const tokens = await app.tokens.exchangeCode(provider, query.code);
        const accountEmail = await fetchAccountEmail(provider, tokens.access_token);
        const connection = await app.tokens.saveConnection({
          userId: state.userId,
          provider,
          accountEmail,
          tokens,
        });

        const user = await app.repos.users.findById(state.userId);
        let calendars = 0;
        if (user) {
          calendars = await app.calendar
            .syncCalendarList(user, connection.id, provider)
            .catch((err) => {
              logger().warn({ err: errorText(err) }, 'calendar discovery failed after connect');
              return 0;
            });
          await app.repos.emailAccounts.upsert({
            user_id: user.id,
            oauth_connection_id: connection.id,
            provider,
            address: accountEmail,
          });
        }

        await app.repos.audit.log({
          user_id: state.userId,
          action: 'OAUTH_CONNECTED',
          entity_type: 'oauth_connection',
          entity_id: connection.id,
          result: { provider, account: accountEmail, calendars },
        });

        return reply
          .type('text/html')
          .send(
            page(
              '✅ החיבור הושלם',
              `<p>חיברתי את <code>${accountEmail}</code>.</p><p>נמצאו ${calendars} יומנים.</p><p>אפשר לחזור ל-WhatsApp ולשאול "מה יש לי היום?".</p>`,
            ),
          );
      } catch (err) {
        logger().error({ provider, err: errorText(err) }, 'oauth callback failed');
        return reply
          .code(500)
          .type('text/html')
          .send(page('החיבור נכשל', `<p>${errorText(err)}</p>`));
      }
    });
  }
}
