import { loadEnv } from '../config/env.js';
import { createPgDb } from './pg.js';
import { runMigrations } from './migrate.js';

const env = loadEnv();
if (!env.DATABASE_URL) {
  console.error('DATABASE_URL is required to run migrations.');
  process.exit(1);
}
const db = createPgDb(env.DATABASE_URL, env.DATABASE_SSL);
try {
  const ran = await runMigrations(db);
  console.log(ran.length ? `Applied ${ran.length} migration(s): ${ran.join(', ')}` : 'Database already up to date.');
} finally {
  await db.close();
}
