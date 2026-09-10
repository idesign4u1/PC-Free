import { PGlite } from '@electric-sql/pglite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Db, QueryResult } from '../../src/db/types.js';
import { runMigrations } from '../../src/db/migrate.js';

/**
 * A real Postgres engine, in-process.
 *
 * PGlite is actual Postgres compiled to WASM, so the integration tests execute
 * the production SQL — constraints, ON CONFLICT, FOR UPDATE SKIP LOCKED and
 * all — with no database server to provision.
 */
class PgliteDb implements Db {
  constructor(private readonly pg: PGlite) {}

  async query<R = Record<string, unknown>>(sql: string, params: readonly unknown[] = []): Promise<QueryResult<R>> {
    // exec() handles the multi-statement migration scripts; query() handles
    // parameterised single statements.
    if (!params.length && /;[\s\S]*\S/.test(sql.replace(/--[^\n]*/g, ''))) {
      await this.pg.exec(sql);
      return { rows: [], rowCount: 0 };
    }
    const res = await this.pg.query<R>(sql, params as unknown[]);
    return { rows: res.rows, rowCount: res.affectedRows ?? res.rows.length };
  }

  /**
   * PGlite holds a single connection, so a nested BEGIN would fail. Tests run
   * sequentially, which makes a flat transaction both correct and sufficient.
   */
  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    await this.pg.query('BEGIN');
    try {
      const out = await fn(this);
      await this.pg.query('COMMIT');
      return out;
    } catch (err) {
      await this.pg.query('ROLLBACK').catch(() => {});
      throw err;
    }
  }

  async close(): Promise<void> {
    await this.pg.close();
  }
}

const here = dirname(fileURLToPath(import.meta.url));

export async function createTestDb(): Promise<Db> {
  const pg = await PGlite.create({
    // Mirror the node-postgres type parsers configured in src/db/pg.ts, so the
    // tests see exactly the JS types production sees: DATE as 'YYYY-MM-DD'
    // text (never a timezone-shifted Date) and NUMERIC as a number.
    parsers: {
      1082: (value: string) => value,
      1700: (value: string) => Number(value),
    },
  });
  const db = new PgliteDb(pg);
  await runMigrations(db, join(here, '..', '..', 'migrations'));
  return db;
}
