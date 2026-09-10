import Fastify, { type FastifyBaseLogger, type FastifyError, type FastifyInstance } from 'fastify';
import type { App } from '../app.js';
import { registerWhatsAppRoutes } from './whatsapp-routes.js';
import { registerOAuthRoutes } from './oauth-routes.js';
import { registerHealthRoutes } from './health-routes.js';
import { registerTaskRoutes } from './task-routes.js';
import { registerAdminDashboard } from '../admin/dashboard.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../utils/errors.js';

export async function createServer(app: App): Promise<FastifyInstance> {
  const server = Fastify({
    // pino's concrete Logger type is narrower than FastifyBaseLogger; the
    // shapes are compatible at runtime.
    loggerInstance: logger() as unknown as FastifyBaseLogger,
    trustProxy: true,
    bodyLimit: 2 * 1024 * 1024,
  });

  /**
   * Meta signs the *raw* bytes of the webhook body. Fastify parses JSON before
   * the handler runs, and re-serialising the parsed object produces different
   * bytes — so we keep the original buffer on the request.
   */
  server.addContentTypeParser('application/json', { parseAs: 'buffer' }, (req, body, done) => {
    (req as unknown as { rawBody: Buffer }).rawBody = body as Buffer;
    if (!(body as Buffer).length) return done(null, {});
    try {
      done(null, JSON.parse((body as Buffer).toString('utf8')));
    } catch (err) {
      done(err as Error, undefined);
    }
  });

  server.setErrorHandler((error: FastifyError, _req, reply) => {
    if (error instanceof AppError) {
      logger().warn({ code: error.code, err: error.message }, 'request failed');
      return reply.code(error.httpStatus).send({ error: error.code, message: error.message });
    }
    logger().error({ err: error.message, stack: error.stack }, 'unhandled request error');
    return reply.code(500).send({ error: 'internal_error' });
  });

  registerHealthRoutes(server, app);
  registerWhatsAppRoutes(server, app);
  registerOAuthRoutes(server, app);
  registerTaskRoutes(server, app);
  registerAdminDashboard(server, app);

  server.get('/', async (_req, reply) =>
    reply.type('text/html; charset=utf-8').send(
      `<!doctype html><meta charset="utf-8"><title>Shay AI Assistant</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:5rem auto;padding:0 1.5rem;line-height:1.6}</style>
<h1>Shay AI Assistant</h1>
<p>WhatsApp personal assistant. Endpoints: <code>/health</code>, <code>/admin</code>,
<code>/webhooks/whatsapp</code>, <code>/oauth/google/start</code>, <code>/oauth/microsoft/start</code>.</p>`,
    ),
  );

  return server;
}
