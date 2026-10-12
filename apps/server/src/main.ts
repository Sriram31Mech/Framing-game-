/**
 * Server entrypoint: config → logger → pool → (migrations) → world bootstrap → HTTP/WS.
 */
import { bootstrapWorld, createPool, loadConfig, runMigrations } from '@bh/core';
import pino from 'pino';
import { buildApp } from './app';

/** Never log credentials, session tokens or Steam tickets. */
export const LOG_REDACT_PATHS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'req.headers["idempotency-key"]',
  'headers.authorization',
  'password',
  'token',
  'ticket',
  '*.password',
  '*.token',
  '*.ticket',
  '*.webApiKey',
  'config.sessionSecret',
];

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = pino({
    level: config.logLevel,
    redact: { paths: LOG_REDACT_PATHS, censor: '[redacted]' },
    base: { service: 'bh-server', env: config.appEnv },
  });
  const pool = createPool(config.databaseUrl, {
    max: config.databasePoolMax,
    applicationName: 'bh-server',
  });
  const deps = { pool, config, logger };

  if (process.env.RUN_MIGRATIONS_ON_BOOT === 'true') {
    const applied = await runMigrations(pool, undefined, (msg) => logger.info(msg));
    logger.info({ applied }, 'migrations complete');
  }
  const region = await pool.query('SELECT 1 FROM regions WHERE id = $1', [config.regionId]);
  if ((region.rowCount ?? 0) === 0) {
    const res = await bootstrapWorld(deps, { regionId: config.regionId });
    logger.info(res, 'world bootstrapped');
  }

  const { app } = await buildApp(deps, { defaultMetrics: true, rateLimits: config.rateLimits });

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'shutting down');
    const force = setTimeout(() => process.exit(1), 15_000);
    force.unref();
    try {
      await app.close();
      await pool.end();
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'error during shutdown');
      process.exit(1);
    }
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ host: config.host, port: config.port });
}

main().catch((err: unknown) => {
  console.error('server failed to start:', err instanceof Error ? err.message : err);
  process.exit(1);
});
