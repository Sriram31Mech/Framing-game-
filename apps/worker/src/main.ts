/**
 * Bharat Harvest simulation worker: world clock, daily ticks, offline catch-up, AI companies,
 * reconciliation and housekeeping. Safe to run more than one instance (leader election via a
 * Postgres advisory lock; ticks are idempotent).
 */
import { createPool, loadConfig, type CoreDeps, type DbPool } from '@bh/core';
import pino from 'pino';
import { startHttpServer } from './http';
import { LeaderLock } from './leader';
import { createWorkerMetrics } from './metrics';
import { SimulationWorker } from './worker';

const DEFAULT_METRICS_PORT = 9464;

function metricsPort(): number {
  const raw = process.env.WORKER_METRICS_PORT;
  const port = raw ? Number(raw) : DEFAULT_METRICS_PORT;
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`Invalid WORKER_METRICS_PORT: ${raw}`);
  }
  return port;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Wait until the database is reachable, migrated and the region is bootstrapped. */
async function waitForWorld(
  pool: DbPool,
  regionId: string,
  logger: pino.Logger,
  isStopping: () => boolean,
): Promise<boolean> {
  for (let attempt = 0; !isStopping(); attempt++) {
    try {
      const { rows } = await pool.query<{ migrated: boolean }>(
        `SELECT to_regclass('public.world_clock') IS NOT NULL AS migrated`,
      );
      if (rows[0]?.migrated) {
        const clock = await pool.query('SELECT 1 FROM world_clock WHERE region_id = $1', [
          regionId,
        ]);
        if ((clock.rowCount ?? 0) > 0) return true;
        logger.info({ regionId }, 'waiting for the world to be bootstrapped (server/seed)');
      } else {
        logger.info('waiting for database migrations');
      }
    } catch (err) {
      logger.warn({ err, attempt }, 'database not reachable yet');
    }
    await sleep(Math.min(30_000, 500 * 2 ** Math.min(attempt, 6)));
  }
  return false;
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({
    level: config.logLevel,
    base: { service: 'bh-worker', region: config.regionId },
    redact: ['*.authorization', '*.cookie', '*.password', '*.token', '*.ticket'],
  });
  const pool = createPool(config.databaseUrl, {
    max: Math.min(config.databasePoolMax, 10),
    applicationName: 'bh-worker',
  });
  const deps: CoreDeps = { pool, config, logger };
  const metrics = createWorkerMetrics();
  const leader = new LeaderLock(config.databaseUrl, config.regionId, logger);
  const worker = new SimulationWorker(deps, leader, metrics);

  let stopping = false;
  const server = await startHttpServer({
    port: metricsPort(),
    metrics,
    status: () => worker.status,
    stallAfterMs: Math.max(120_000, config.workerPollMs * 30),
  });
  logger.info({ port: metricsPort() }, 'worker metrics/health listening');

  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'shutting down: finishing the current tick');
    const force = setTimeout(() => {
      logger.error('graceful shutdown timed out; exiting');
      process.exit(1);
    }, 60_000);
    force.unref();
    try {
      await worker.stop();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
      logger.info('worker stopped');
    } finally {
      clearTimeout(force);
      process.exit(0);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  const ready = await waitForWorld(pool, config.regionId, logger, () => stopping);
  if (!ready) return;
  logger.info(
    {
      pollMs: config.workerPollMs,
      maxCatchupDaysPerBatch: config.maxCatchupDaysPerBatch,
      realSecondsPerGameDay: config.realSecondsPerGameDay,
    },
    'simulation worker started',
  );
  worker.start();
}

main().catch((err: unknown) => {
  // Logger may not exist yet (bad configuration); write a structured line to stderr.
  console.error(
    JSON.stringify({ level: 'fatal', msg: 'worker failed to start', err: String(err) }),
  );
  process.exit(1);
});
