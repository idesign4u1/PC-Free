import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import type { App } from '../app.js';
import { isAuthorised } from './health-routes.js';
import { parseHebrewDateTime } from '../nlp/hebrew-datetime.js';
import type { HandlerContext } from '../orchestrator/context.js';

/**
 * A small authenticated REST surface. It exists so the system is testable and
 * scriptable outside WhatsApp, and so a future dashboard or mobile client has
 * something to talk to. It is not the primary interface.
 */

const CreateTaskBody = z.object({
  title: z.string().min(1),
  description: z.string().nullish(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).nullish(),
  due_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  due_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullish(),
  reminder_date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullish(),
  reminder_time: z
    .string()
    .regex(/^\d{2}:\d{2}$/)
    .nullish(),
  project: z.string().nullish(),
  client: z.string().nullish(),
  tags: z.array(z.string()).optional(),
});

const MessageBody = z.object({
  text: z.string().min(1),
  user_id: z.string().uuid().optional(),
});

export function registerTaskRoutes(server: FastifyInstance, app: App): void {
  const guard = async (req: FastifyRequest, reply: FastifyReply): Promise<boolean> => {
    if (isAuthorised(req, app)) return true;
    await reply.code(401).send({ error: 'unauthorized' });
    return false;
  };

  const resolveUser = async (userId?: string) =>
    userId ? app.repos.users.findById(userId) : ((await app.repos.users.listActive())[0] ?? null);

  server.get('/api/tasks', async (req, reply) => {
    if (!(await guard(req, reply))) return reply;
    const q = req.query as { user_id?: string; status?: string; limit?: string; search?: string };
    const user = await resolveUser(q.user_id);
    if (!user) return reply.code(404).send({ error: 'no user' });

    const tasks = await app.repos.tasks.list(user.id, {
      ...(q.status ? { statuses: [q.status as never] } : {}),
      ...(q.search ? { search: q.search } : {}),
      limit: q.limit ? Number(q.limit) : 50,
      includeSnoozed: true,
    });
    return reply.send({ tasks });
  });

  server.post('/api/tasks', async (req, reply) => {
    if (!(await guard(req, reply))) return reply;
    const parsed = CreateTaskBody.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });

    const user = await resolveUser((req.query as { user_id?: string }).user_id);
    if (!user) return reply.code(404).send({ error: 'no user' });
    const settings = await app.repos.settings.get(user.id);
    const body = parsed.data;

    const created = await app.tasks.create(
      {
        user,
        title: body.title,
        description: body.description ?? null,
        priority: body.priority ?? null,
        project: body.project ?? null,
        client: body.client ?? null,
        tags: body.tags ?? [],
        due: body.due_date ? { date: body.due_date, time: body.due_time ?? null } : null,
        reminder: body.reminder_date
          ? { date: body.reminder_date, time: body.reminder_time ?? null }
          : null,
        source: 'api',
      },
      settings,
    );
    return reply.code(201).send({ task: created.task, reminderAt: created.reminderAt });
  });

  server.post('/api/tasks/:id/complete', async (req, reply) => {
    if (!(await guard(req, reply))) return reply;
    const user = await resolveUser((req.query as { user_id?: string }).user_id);
    if (!user) return reply.code(404).send({ error: 'no user' });
    const task = await app.repos.tasks.findById(user.id, (req.params as { id: string }).id);
    if (!task) return reply.code(404).send({ error: 'task not found' });
    const settings = await app.repos.settings.get(user.id);
    const result = await app.tasks.complete(user, task, settings);
    return reply.send({ task: result.task, nextTask: result.nextTask });
  });

  /**
   * Runs a natural-language message through the full pipeline and returns the
   * reply without touching WhatsApp. This is the endpoint the acceptance tests
   * and manual smoke checks use.
   */
  server.post('/api/message', async (req, reply) => {
    if (!(await guard(req, reply))) return reply;
    const parsed = MessageBody.safeParse(req.body);
    if (!parsed.success)
      return reply.code(400).send({ error: 'invalid body', issues: parsed.error.issues });

    const user = await resolveUser(parsed.data.user_id);
    if (!user) return reply.code(404).send({ error: 'no user' });
    const settings = await app.repos.settings.get(user.id);
    const now = new Date();

    const ctx: HandlerContext = {
      repos: app.repos,
      tasks: app.tasks,
      calendar: app.calendar,
      messenger: app.messenger,
      ai: app.ai,
      user,
      settings,
      now,
      timezone: user.timezone,
      source: 'api',
    };
    const result = await app.router.route(ctx, { text: parsed.data.text });

    if (result.focusTaskId !== undefined)
      await app.repos.conversation.setLastTask(user.id, result.focusTaskId);
    if (result.pendingConfirmation) {
      await app.repos.confirmations.create({
        user_id: user.id,
        kind: result.pendingConfirmation.kind,
        payload: result.pendingConfirmation.payload,
        prompt: result.pendingConfirmation.prompt,
      });
    }

    return reply.send({
      reply: result.reply,
      intent: result.intent?.intent ?? null,
      confidence: result.intent?.confidence ?? null,
      resolvedBy: result.intentResult?.resolvedBy ?? null,
    });
  });

  /** Exposes the Hebrew date parser for debugging what the assistant "heard". */
  server.get('/api/parse-date', async (req, reply) => {
    if (!(await guard(req, reply))) return reply;
    const q = req.query as { text?: string; tz?: string };
    if (!q.text) return reply.code(400).send({ error: 'text is required' });
    return reply.send(
      parseHebrewDateTime(q.text, { now: new Date(), timezone: q.tz ?? app.env.TIMEZONE }),
    );
  });

  /**
   * A live round-trip to the AI provider. Model ids change and keys get
   * revoked; without this, a wrong value shows up only as every message
   * quietly falling back to the rules path.
   */
  server.get('/api/ai-check', async (req, reply) => {
    if (!(await guard(req, reply))) return reply;
    if (!app.ai) {
      return reply.code(503).send({
        ok: false,
        provider: app.env.AI_PROVIDER,
        error: 'AI_API_KEY is not configured — only the deterministic rules path is active.',
      });
    }

    const started = Date.now();
    try {
      const res = await app.ai.generateStructured<{ ok: boolean }>({
        name: 'health_check',
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: { ok: { type: 'boolean' } },
          required: ['ok'],
        },
        system: 'Reply with {"ok": true}.',
        user: 'ping',
        maxTokens: 300,
      });
      return reply.send({
        ok: !res.refused,
        provider: app.ai.name,
        configuredModel: app.env.aiModel,
        respondingModel: res.model,
        latencyMs: res.latencyMs,
        ...(res.refused ? { error: 'the model refused the probe' } : {}),
      });
    } catch (err) {
      return reply.code(502).send({
        ok: false,
        provider: app.ai.name,
        configuredModel: app.env.aiModel,
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  server.post('/api/scheduler/tick', async (req, reply) => {
    if (!(await guard(req, reply))) return reply;
    await app.scheduler.tick();
    return reply.send({ ok: true, status: app.scheduler.status() });
  });
}
