/**
 * Minimal query surface shared by node-postgres and the embedded PGlite driver
 * used in tests. Every repository takes a `Db`, so the integration tests run the
 * real SQL against a real Postgres engine without needing a server.
 */
export interface QueryResult<R> {
  rows: R[];
  rowCount: number;
}

export interface Db {
  query<R = Record<string, unknown>>(sql: string, params?: readonly unknown[]): Promise<QueryResult<R>>;
  /** Runs `fn` inside a transaction, rolling back on throw. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
