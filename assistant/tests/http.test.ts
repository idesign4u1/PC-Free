import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createHmac } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { createTestDb } from './helpers/pglite.js';
import { FakeSender, ScriptedAiProvider, testEnv } from './helpers/fakes.js';
import { buildApp, type App } from '../src/app.js';
import { createServer } from '../src/api/server.js';
import type { Db } from '../src/db/types.js';
import type { User } from '../src/domain/types.js';

/**
 * Exercises the real Fastify stack — content-type parser, signature check,
 * routing, auth — via light-weight injection rather than a listening socket.
 */

const PHONE = '972500000004';
const APP_SECRET = 'test-app-secret';
const ADMIN = 'test-admin-token';

let db: Db;
let app: App;
let server: FastifyInstance;
let sender: FakeSender;
let user: User;

function signed(body: unknown): { payload: string; headers: Record<string, string> } {
  const payload = JSON.stringify(body);
  return {
    payload,
    headers: {
      'content-type': 'application/json',
      'x-hub-signature-256': `sha256=${createHmac('sha256', APP_SECRET).update(payload).digest('hex')}`,
    },
  };
}

function webhookBody(text: string, id = `wamid.${Math.random().toString(36).slice(2)}`): unknown {
  return {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: '1234567890' },
              contacts: [{ wa_id: PHONE, profile: { name: 'Shay' } }],
              messages: [
                { id, from: PHONE, timestamp: '1789000000', type: 'text', text: { body: text } },
              ],
            },
          },
        ],
      },
    ],
  };
}

/** Lets the fire-and-forget webhook processing settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i += 1) await new Promise((r) => setImmediate(r));
  await new Promise((r) => setTimeout(r, 50));
}

beforeAll(async () => {
  db = await createTestDb();
  sender = new FakeSender();
  app = buildApp(testEnv(), db, { sender, ai: new ScriptedAiProvider([]) });
  server = await createServer(app);
  await server.ready();
  user = await app.repos.users.create({
    display_name: 'Shay',
    whatsapp_phone: PHONE,
    email: 'shay@example.com',
    timezone: 'Asia/Jerusalem',
  });
});
afterAll(async () => {
  await server.close();
  await db.close();
});

describe('webhook verification handshake', () => {
  it('echoes the challenge for the correct verify token', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=test-verify&hub.challenge=987654',
    });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe('987654');
  });

  it('rejects a wrong verify token', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/webhooks/whatsapp?hub.mode=subscribe&hub.verify_token=wrong&hub.challenge=1',
    });
    expect(res.statusCode).toBe(403);
  });
});

describe('inbound webhook', () => {
  it('rejects an unsigned POST', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: { 'content-type': 'application/json' },
      payload: JSON.stringify(webhookBody('תזכיר לי מחר ב־10 לבדוק')),
    });
    expect(res.statusCode).toBe(401);
    await settle();
    expect(sender.sent).toHaveLength(0);
  });

  it('rejects a POST signed with the wrong secret', async () => {
    const payload = JSON.stringify(webhookBody('תזכיר לי מחר ב־10 לבדוק'));
    const res = await server.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers: {
        'content-type': 'application/json',
        'x-hub-signature-256': `sha256=${createHmac('sha256', 'wrong').update(payload).digest('hex')}`,
      },
      payload,
    });
    expect(res.statusCode).toBe(401);
  });

  it('accepts a correctly signed POST and acts on the message', async () => {
    sender.clear();
    const { payload, headers } = signed(webhookBody('תזכיר לי מחר ב־10 להתקשר לספק'));
    const res = await server.inject({
      method: 'POST',
      url: '/webhooks/whatsapp',
      headers,
      payload,
    });

    expect(res.statusCode).toBe(200);
    await settle();
    expect(sender.last()).toContain('✅ הוספתי');

    const tasks = await app.repos.tasks.list(user.id, { search: 'ספק' });
    expect(tasks).toHaveLength(1);
  });

  it('answers within the Meta retry budget', async () => {
    const { payload, headers } = signed(webhookBody('מה המשימות שלי?'));
    const started = Date.now();
    await server.inject({ method: 'POST', url: '/webhooks/whatsapp', headers, payload });
    expect(Date.now() - started).toBeLessThan(2000);
    await settle();
  });
});

describe('health endpoints', () => {
  it('reports liveness and capability without auth', async () => {
    const res = await server.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.status).toBe('ok');
    expect(body.database).toBe('ok');
    expect(body.capabilities.whatsapp).toBe(true);
    expect(body.capabilities.google).toBe(false);
  });

  it('guards the detailed report behind the admin token', async () => {
    expect((await server.inject({ method: 'GET', url: '/health/full' })).statusCode).toBe(401);

    const res = await server.inject({ method: 'GET', url: `/health/full?token=${ADMIN}` });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.users[0].name).toBe('Shay');
    expect(body.missingCredentials).toContain('AI_API_KEY');
  });
});

describe('REST API', () => {
  it('requires the admin token', async () => {
    expect((await server.inject({ method: 'GET', url: '/api/tasks' })).statusCode).toBe(401);
  });

  it('creates and lists a task', async () => {
    const create = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ title: 'משימה מה-API', due_date: '2026-10-01', due_time: '14:00' }),
    });
    expect(create.statusCode).toBe(201);
    expect(create.json().task.title).toBe('משימה מה-API');
    expect(create.json().reminderAt).toBeTruthy();

    const list = await server.inject({
      method: 'GET',
      url: '/api/tasks?search=API',
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(list.json().tasks).toHaveLength(1);
  });

  it('rejects an invalid body with the validation issues', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/tasks',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ title: '', due_date: 'not-a-date' }),
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().issues.length).toBeGreaterThan(0);
  });

  it('runs a message through the full pipeline without WhatsApp', async () => {
    const res = await server.inject({
      method: 'POST',
      url: '/api/message',
      headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
      payload: JSON.stringify({ text: 'תזכיר לי מחר ב־8 בבוקר לבדוק מיילים' }),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().intent).toBe('CREATE_TASK');
    expect(res.json().resolvedBy).toBe('rules');
    expect(res.json().reply).toContain('מחר ב־08:00');
  });

  it('exposes the Hebrew date parser for debugging', async () => {
    const res = await server.inject({
      method: 'GET',
      url: `/api/parse-date?text=${encodeURIComponent('בעוד שבועיים')}`,
      headers: { authorization: `Bearer ${ADMIN}` },
    });
    expect(res.json().date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(res.json().confidence).toBeGreaterThan(0.8);
  });
});

describe('admin dashboard', () => {
  it('requires the token', async () => {
    expect((await server.inject({ method: 'GET', url: '/admin' })).statusCode).toBe(401);
  });

  it('renders the operations view', async () => {
    const res = await server.inject({ method: 'GET', url: `/admin?token=${ADMIN}` });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Shay AI Assistant');
    expect(res.body).toContain('משימות פתוחות');
    expect(res.body).toContain('משימה מה-API');
  });

  it('escapes task titles so stored content cannot inject markup', async () => {
    const settings = await app.repos.settings.get(user.id);
    await app.tasks.create(
      { user, title: '<img src=x onerror=alert(1)>', source: 'api' },
      settings,
    );
    const res = await server.inject({ method: 'GET', url: `/admin?token=${ADMIN}` });
    expect(res.body).not.toContain('<img src=x');
    expect(res.body).toContain('&lt;img src=x');
  });
});

describe('OAuth routes', () => {
  it('reports Google as unconfigured rather than crashing', async () => {
    const res = await server.inject({ method: 'GET', url: '/oauth/google/start' });
    expect(res.statusCode).toBe(501);
  });

  it('rejects a callback carrying an unknown state', async () => {
    const res = await server.inject({
      method: 'GET',
      url: '/oauth/google/callback?code=abc&state=forged',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('state');
  });
});
