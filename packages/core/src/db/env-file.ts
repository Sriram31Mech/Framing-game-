/**
 * Load the repo-root `.env` for the CLIs (pnpm db:migrate / db:seed) when present.
 * Variables already set in the environment win; missing file is fine (CI, containers).
 */
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function loadRootEnvFile(): void {
  const file = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../../.env');
  if (existsSync(file)) process.loadEnvFile(file);
}
