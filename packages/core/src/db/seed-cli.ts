/**
 * `pnpm db:seed` — migrate, then bootstrap the world (region, parcels, markets, clock, AI
 * companies). Idempotent: safe to run against an existing world.
 */
import pino from 'pino';
import { loadConfig } from '../config';
import { bootstrapWorld } from '../world/bootstrap';
import { loadRootEnvFile } from './env-file';
import { createPool } from './pool';
import { runMigrations } from './migrate';

async function main(): Promise<void> {
  loadRootEnvFile();
  const config = loadConfig();
  const logger = pino({ level: config.logLevel });
  const pool = createPool(config.databaseUrl, { max: 4, applicationName: 'bh-seed' });
  try {
    await runMigrations(pool, undefined, (msg) => logger.info(msg));
    const seedEnv = process.env.REGION_SEED;
    const result = await bootstrapWorld(
      { pool, config, logger },
      { regionId: config.regionId, seed: seedEnv ? Number(seedEnv) : undefined },
    );
    logger.info(result, result.created ? 'world created' : 'world already existed');
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
