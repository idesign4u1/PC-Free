import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestDb } from './helpers/pglite.js';
import { createRepositories, type Repositories } from '../src/db/repositories.js';
import type { Db } from '../src/db/types.js';

let db: Db;
let repos: Repositories;

beforeAll(async () => {
  db = await createTestDb();
  repos = createRepositories(db);
});
afterAll(async () => { await db.close(); });

describe('schema and repositories', () => {
  it('applies every migration', async () => {
    const { rows } = await db.query<{ name: string }>('SELECT name FROM schema_migrations ORDER BY name');
    expect(rows.map((r) => r.name)).toEqual(['0001_core.sql', '0002_messaging_ai.sql']);
  });

  it('creates a user with default settings', async () => {
    const user = await repos.users.create({
      display_name: 'Shay', whatsapp_phone: '972500000001', email: 'shay@example.com', timezone: 'Asia/Jerusalem',
    });
    const settings = await repos.settings.get(user.id);
    expect(settings.daily_briefing_time).toBe('07:30');
    expect(settings.quiet_hours_start).toBe('23:00');
    expect(settings.max_followups).toBe(2);
  });

  it('stores a due_date as a plain local date, not a shifted timestamp', async () => {
    const user = await repos.users.findByPhone('972500000001');
    const task = await repos.tasks.create({
      user_id: user!.id, title: 'לבדוק תאריך', timezone: 'Asia/Jerusalem',
      due_date: '2026-09-10', due_time: '10:00', source: 'api',
    });
    expect(task.due_date).toBe('2026-09-10');
  });
});
