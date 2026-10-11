/**
 * `pnpm db:migrate` — apply pending SQL migrations to DATABASE_URL.
 */
import { loadRootEnvFile } from './env-file';
import { createPool } from './pool';
import { runMigrations } from './migrate';

async function main(): Promise<void> {
  loadRootEnvFile();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL is required');
  const pool = createPool(url, { max: 2, applicationName: 'bh-migrate' });
  try {
    const applied = await runMigrations(pool, undefined, (msg) => console.warn(msg));
    console.warn(
      applied.length ? `applied ${applied.length} migration(s)` : 'database is up to date',
    );
  } finally {
    await pool.end();
  }
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
