import pg from 'pg';
import type { Db, QueryResult } from './types.js';

/**
 * Postgres returns DATE as a JS Date shifted by the server timezone, which would
 * silently move a due_date across a day boundary. We want the literal
 * 'YYYY-MM-DD' text instead and do all date maths in Luxon.
 */
pg.types.setTypeParser(1082, (value: string) => value);
/** NUMERIC as a JS number — all our numerics are small confidence scores. */
pg.types.setTypeParser(1700, (value: string) => Number(value));
/** int8 counts fit comfortably in a JS number. */
pg.types.setTypeParser(20, (value: string) => Number(value));

class PgDb implements Db {
  constructor(private readonly pool: pg.Pool) {}

  async query<R = Record<string, unknown>>(
    sql: string,
    params: readonly unknown[] = [],
  ): Promise<QueryResult<R>> {
    const res = await this.pool.query(sql, params as unknown[]);
    return { rows: res.rows as R[], rowCount: res.rowCount ?? res.rows.length };
  }

  async transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const tx: Db = {
        query: async <R>(sql: string, params: readonly unknown[] = []) => {
          const res = await client.query(sql, params as unknown[]);
          return { rows: res.rows as R[], rowCount: res.rowCount ?? res.rows.length };
        },
        transaction: async <U>(inner: (t: Db) => Promise<U>) => inner(tx),
        close: async () => {},
      };
      const out = await fn(tx);
      await client.query('COMMIT');
      return out;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

export function createPgDb(connectionString: string, ssl: boolean): Db {
  const pool = new pg.Pool({
    connectionString,
    ...(ssl ? { ssl: { rejectUnauthorized: false } } : {}),
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  return new PgDb(pool);
}
