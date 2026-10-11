import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['packages/*/test/**/*.test.ts', 'apps/*/test/**/*.test.{ts,tsx}'],
          exclude: ['**/*.int.test.ts', '**/node_modules/**'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'integration',
          include: [
            'packages/*/test/**/*.int.test.ts',
            'apps/*/test/**/*.int.test.ts',
            'tests/integration/**/*.int.test.ts',
          ],
          environment: 'node',
          // Integration tests share one Postgres instance; run files serially.
          fileParallelism: false,
          testTimeout: 60_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
