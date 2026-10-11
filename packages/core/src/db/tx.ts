import type { DbClient, DbPool } from './pool';

export type IsolationLevel = 'READ COMMITTED' | 'REPEATABLE READ' | 'SERIALIZABLE';

const RETRYABLE_SQLSTATES = new Set([
  '40001', // serialization_failure
  '40P01', // deadlock_detected
]);

export interface TxOptions {
  isolation?: IsolationLevel;
  /** Retries for serialization failures / deadlocks (default 3). */
  retries?: number;
}

/**
 * Run `fn` inside a transaction. Commits on success, rolls back on any error.
 * Serialization failures and deadlocks are retried with jittered backoff; `fn` must therefore be
 * safe to re-run (it is, as long as it only touches the DB through `client`).
 */
export async function withTransaction<T>(
  pool: DbPool,
  fn: (client: DbClient) => Promise<T>,
  opts: TxOptions = {},
): Promise<T> {
  const retries = opts.retries ?? 3;
  for (let attempt = 0; ; attempt++) {
    const client = await pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${opts.isolation ?? 'READ COMMITTED'}`);
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      const code = (err as { code?: string }).code;
      if (code && RETRYABLE_SQLSTATES.has(code) && attempt < retries) {
        await new Promise((r) => setTimeout(r, 10 * 2 ** attempt + Math.floor(Math.random() * 20)));
        continue;
      }
      throw err;
    } finally {
      client.release();
    }
  }
}
