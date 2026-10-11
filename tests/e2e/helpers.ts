/**
 * Shared Playwright fixtures and helpers for Bharat Harvest E2E tests.
 * All tests run against a server with ENABLE_DEV_AUTH=true (the .env.example default).
 */
import { expect, test as base, type Page } from '@playwright/test';

export { expect };

/** Unique-enough username for a test run. */
export function uid(prefix = 'e2e'): string {
  return `${prefix}_${Date.now()}_${Math.floor(Math.random() * 9999)}`;
}

/** Dev-login and wait for the game screen or company-creation screen. */
export async function devLogin(page: Page, username: string): Promise<void> {
  await page.goto('/');
  await page.getByTestId('dev-login-username').fill(username);
  await page.getByTestId('dev-login-submit').click();
  // Either the company form or the game HUD appears.
  await expect(page.getByTestId('company-form').or(page.getByTestId('nav-map'))).toBeVisible({
    timeout: 10_000,
  });
}

/** Create a company if the company-form is visible, then wait for the game HUD. */
export async function ensureCompany(page: Page, name: string): Promise<void> {
  const form = page.getByTestId('company-form');
  if (await form.isVisible()) {
    await page.getByLabel('Company name').fill(name);
    await page.getByTestId('company-submit').click();
    await expect(page.getByTestId('nav-map')).toBeVisible({ timeout: 10_000 });
  }
}

/** POST a command via the API directly (bypasses UI for setup). */
export async function apiPost(
  page: Page,
  path: string,
  body: Record<string, unknown>,
  token: string,
): Promise<unknown> {
  const res = await page.request.post(`http://localhost:8080${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': uid('idem'),
    },
    data: body,
  });
  return res.json();
}

/** Extended test fixture that provides a logged-in page with a company. */
export const test = base.extend<{
  gamePage: Page;
  username: string;
  companyName: string;
}>({
  username: async ({}, use) => use(uid('player')),
  companyName: async ({ username }, use) => use(`Farm_${username.slice(-6)}`),
  gamePage: async ({ page, username, companyName }, use) => {
    await devLogin(page, username);
    await ensureCompany(page, companyName);
    await use(page);
  },
});
