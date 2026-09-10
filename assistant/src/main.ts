import { loadEnv, missingCredentials } from './config/env.js';
import { initLogger, logger } from './utils/logger.js';
import { createPgDb } from './db/pg.js';
import { runMigrations } from './db/migrate.js';
import { buildApp } from './app.js';
import { createServer } from './api/server.js';
import { errorText } from './utils/errors.js';

const env = loadEnv();
initLogger(env.LOG_LEVEL, env.NODE_ENV !== 'production');

if (!env.DATABASE_URL) {
  logger().fatal('DATABASE_URL is required. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

const db = createPgDb(env.DATABASE_URL, env.DATABASE_SSL);

try {
  const ran = await runMigrations(db);
  if (ran.length) logger().info({ migrations: ran }, 'database migrated');
} catch (err) {
  logger().fatal({ err: errorText(err) }, 'migration failed');
  process.exit(1);
}

const app = buildApp(env, db);

// Register the single user on first boot so the assistant is usable immediately.
if (env.BOOTSTRAP_USER_PHONE) {
  const phone = env.BOOTSTRAP_USER_PHONE.replace(/[^\d]/g, '');
  const existing = await app.repos.users.findByPhone(phone);
  if (!existing) {
    const user = await app.repos.users.create({
      display_name: env.BOOTSTRAP_USER_NAME,
      whatsapp_phone: phone,
      email: env.BOOTSTRAP_USER_EMAIL || null,
      timezone: env.TIMEZONE,
    });
    logger().info({ userId: user.id, name: user.display_name }, 'bootstrapped user');
  }
}

const missing = missingCredentials(env);
if (missing.length)
  logger().warn({ missing }, 'running with reduced capability — some credentials are missing');

const server = await createServer(app);
await server.listen({ port: env.PORT, host: env.HOST });
logger().info({ url: env.APP_URL, port: env.PORT }, 'server listening');

if (env.SCHEDULER_ENABLED) app.scheduler.start();

const shutdown = async (signal: string): Promise<void> => {
  logger().info({ signal }, 'shutting down');
  app.scheduler.stop();
  await server.close().catch(() => {});
  await db.close().catch(() => {});
  process.exit(0);
};
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
