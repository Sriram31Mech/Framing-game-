/**
 * Integration-test database helpers. Uses TEST_DATABASE_URL (see .env.example); never the dev DB.
 * Each call to resetTestDb() drops and recreates the public schema and re-applies migrations,
 * giving every test file a clean, fully-migrated database.
 */
import pino from 'pino';
import { loadConfig, type AppConfig } from '../../src/config';
import { createPool, type DbPool } from '../../src/db/pool';
import { runMigrations } from '../../src/db/migrate';
import type { CoreDeps } from '../../src/commands/types';

export const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ??
  'postgres://bh:bh_dev_password@localhost:54329/bharat_harvest_test';

export function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const base = loadConfig({
    APP_ENV: 'test',
    DATABASE_URL: TEST_DATABASE_URL,
    SESSION_SECRET: 'test-session-secret-at-least-32-characters-long',
    ENABLE_DEV_AUTH: 'true',
    ENABLE_DEV_ADMIN: 'true',
    REAL_SECONDS_PER_GAME_DAY: '60',
    AI_COMPANY_COUNT: '2',
    LOG_LEVEL: 'silent',
  });
  return { ...base, ...overrides };
}

export async function resetTestDb(): Promise<DbPool> {
  if (!/_test\b/.test(TEST_DATABASE_URL)) {
    throw new Error(
      `Refusing to reset a database whose name does not end in _test: ${TEST_DATABASE_URL}`,
    );
  }
  const pool = createPool(TEST_DATABASE_URL, { max: 30, applicationName: 'bh-tests' });
  await pool.query('DROP SCHEMA IF EXISTS public CASCADE');
  await pool.query('CREATE SCHEMA public');
  await runMigrations(pool);
  return pool;
}

export async function createTestDeps(overrides: Partial<AppConfig> = {}): Promise<CoreDeps> {
  const pool = await resetTestDb();
  return { pool, config: testConfig(overrides), logger: pino({ level: 'silent' }) };
}
