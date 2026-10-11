import pg from 'pg';

const { Pool, types } = pg;

/**
 * BIGINT (int8) columns hold paise and kg. Parse them to JS numbers but refuse values outside
 * the safe-integer range instead of silently losing precision.
 */
types.setTypeParser(20, (value: string) => {
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(`BIGINT ${value} exceeds safe integer range`);
  return n;
});
/** NUMERIC (area_ha etc.) -> number. Never used for money. */
types.setTypeParser(1700, (value: string) => Number(value));

export type DbPool = pg.Pool;
export type DbClient = pg.PoolClient;
/** Anything that can run a query: a pool or a client inside a transaction. */
export type Queryable = Pick<pg.Pool, 'query'> | Pick<pg.PoolClient, 'query'>;

export function createPool(
  connectionString: string,
  opts: { max?: number; applicationName?: string } = {},
): DbPool {
  const pool = new Pool({
    connectionString,
    max: opts.max ?? 20,
    application_name: opts.applicationName ?? 'bharat-harvest',
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: 30_000,
  });
  // An idle client erroring (e.g. DB restart) must not crash the process.
  pool.on('error', () => {});
  return pool;
}
