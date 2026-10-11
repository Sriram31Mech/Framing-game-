import pg from 'pg';
import type { Logger } from 'pino';

/** Advisory-lock class for worker leadership (one ticking worker per region). */
export const LEADER_LOCK_CLASS = 72_210_011;

/**
 * Session-level advisory lock held on a dedicated connection (outside the pool). Only the holder
 * ticks; other workers stay idle and retry, so running two workers is safe. If the connection
 * drops, Postgres releases the lock automatically and another worker can take over; correctness
 * never depends on this lock alone (ticks are idempotent and also serialised per transaction).
 */
export class LeaderLock {
  private client: pg.Client | null = null;
  private held = false;

  constructor(
    private readonly connectionString: string,
    private readonly regionId: string,
    private readonly logger: Logger,
  ) {}

  get isLeader(): boolean {
    return this.held;
  }

  /** Try to become leader; returns the current leadership state. Never throws. */
  async tryAcquire(): Promise<boolean> {
    if (this.held) return true;
    try {
      if (!this.client) {
        const client = new pg.Client({
          connectionString: this.connectionString,
          application_name: 'bh-worker-leader',
        });
        client.on('error', (err) => {
          this.logger.warn({ err }, 'leader connection lost; leadership released');
          this.held = false;
          this.client = null;
        });
        await client.connect();
        this.client = client;
      }
      const { rows } = await this.client.query<{ ok: boolean }>(
        'SELECT pg_try_advisory_lock($1, hashtext($2)) AS ok',
        [LEADER_LOCK_CLASS, this.regionId],
      );
      this.held = rows[0]?.ok === true;
      if (this.held)
        this.logger.info({ regionId: this.regionId }, 'acquired simulation leadership');
    } catch (err) {
      this.logger.warn({ err }, 'could not acquire leadership');
      await this.reset();
    }
    return this.held;
  }

  /** Cheap liveness check of the leader connection; drops leadership if it is gone. */
  async verify(): Promise<boolean> {
    if (!this.held || !this.client) return false;
    try {
      await this.client.query('SELECT 1');
      return true;
    } catch (err) {
      this.logger.warn({ err }, 'leader connection check failed; leadership released');
      await this.reset();
      return false;
    }
  }

  async release(): Promise<void> {
    if (this.client && this.held) {
      await this.client
        .query('SELECT pg_advisory_unlock($1, hashtext($2))', [LEADER_LOCK_CLASS, this.regionId])
        .catch(() => {});
      this.logger.info({ regionId: this.regionId }, 'released simulation leadership');
    }
    await this.reset();
  }

  private async reset(): Promise<void> {
    this.held = false;
    const client = this.client;
    this.client = null;
    if (client) await client.end().catch(() => {});
  }
}
