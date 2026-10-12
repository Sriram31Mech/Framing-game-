import { defineConfig, devices } from '@playwright/test';

/**
 * E2E runs against an isolated stack: a freshly reset `bharat_harvest_test_e2e` database, the API
 * on :8090 and the Vite client on :5190 (proxying to that API). Set E2E_BASE_URL / E2E_API_URL to
 * point at an already running stack instead (CI does this with the production build).
 */
const clientPort = Number(process.env.E2E_CLIENT_PORT ?? 5190);
const apiPort = Number(process.env.E2E_API_PORT ?? 8090);
const external = !!process.env.E2E_BASE_URL;

export default defineConfig({
  testDir: './tests/e2e',
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 60_000,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: process.env.E2E_BASE_URL ?? `http://localhost:${clientPort}`,
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: external
    ? undefined
    : [
        {
          command: 'bash scripts/e2e-server.sh',
          url: `http://localhost:${apiPort}/healthz`,
          reuseExistingServer: false,
          timeout: 120_000,
        },
        {
          command: `pnpm --filter @bh/client exec vite --port ${clientPort} --strictPort`,
          url: `http://localhost:${clientPort}`,
          reuseExistingServer: false,
          timeout: 60_000,
          env: { BH_API_TARGET: `http://localhost:${apiPort}` },
        },
      ],
});
