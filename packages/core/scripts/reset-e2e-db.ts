/**
 * Recreate the end-to-end test database from scratch: drop schema, migrate, bootstrap the world.
 * Refuses any database whose name does not contain "_test" (never touches dev/prod data).
 */
import pino from 'pino';
import { bootstrapWorld, createPool, loadConfig, runMigrations } from '../src';

const url = process.env.DATABASE_URL ?? '';
if (!/\/[A-Za-z0-9_]*_test[A-Za-z0-9_]*(\?|$)/.test(url)) {
  console.error(`refusing to reset non-test database: ${url}`);
  process.exit(1);
}
const config = loadConfig();
const pool = createPool(url, { applicationName: 'bh-e2e-reset' });
await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
await pool.query('CREATE SCHEMA public');
await runMigrations(pool);
await bootstrapWorld({ pool, config, logger: pino({ level: 'warn' }) });
await pool.end();
console.log('e2e database ready');
