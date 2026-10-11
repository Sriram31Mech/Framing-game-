import type { DbPool } from '@bh/core';

export interface CleanupResult {
  idempotencyKeys: number;
  sessions: number;
  domainEvents: number;
}

const BATCH = 5000;

/** Delete in bounded batches so cleanup never holds long locks. */
async function deleteInBatches(pool: DbPool, sql: string): Promise<number> {
  let total = 0;
  for (;;) {
    const res = await pool.query(sql, [BATCH]);
    const n = res.rowCount ?? 0;
    total += n;
    if (n < BATCH) return total;
  }
}

/**
 * Periodic housekeeping: idempotency keys older than 7 days (retries are only meaningful for
 * minutes), expired/revoked sessions, and domain events older than 90 days (the realtime outbox
 * and audit feed; notifications are kept — players read them as their history).
 */
export async function runCleanup(pool: DbPool): Promise<CleanupResult> {
  const idempotencyKeys = await deleteInBatches(
    pool,
    `DELETE FROM idempotency_keys WHERE ctid IN (
       SELECT ctid FROM idempotency_keys WHERE created_at < now() - interval '7 days' LIMIT $1)`,
  );
  const sessions = await deleteInBatches(
    pool,
    `DELETE FROM sessions WHERE ctid IN (
       SELECT ctid FROM sessions
       WHERE expires_at < now() - interval '1 day' OR revoked_at < now() - interval '1 day'
       LIMIT $1)`,
  );
  const domainEvents = await deleteInBatches(
    pool,
    `DELETE FROM domain_events WHERE ctid IN (
       SELECT ctid FROM domain_events WHERE occurred_at < now() - interval '90 days' LIMIT $1)`,
  );
  return { idempotencyKeys, sessions, domainEvents };
}
