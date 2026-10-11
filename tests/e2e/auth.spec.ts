/**
 * E2E: Authentication flows.
 * GDD acceptance criterion: "Player can log in, resume the same company, and see persisted
 * assets after restart."
 */
import { expect, test } from '@playwright/test';
import { devLogin, ensureCompany, uid } from './helpers';

test.describe('Auth', () => {
  test('dev-login creates a session and shows the game HUD', async ({ page }) => {
    const username = uid('auth');
    await devLogin(page, username);
    await ensureCompany(page, `Co_${username.slice(-6)}`);
    await expect(page.getByTestId('nav-map')).toBeVisible();
    await expect(page.getByTestId('nav-farm')).toBeVisible();
  });

  test('session persists across page reload', async ({ page }) => {
    const username = uid('persist');
    await devLogin(page, username);
    await ensureCompany(page, `Co_${username.slice(-6)}`);

    // Reload — the token in localStorage should restore the session.
    await page.reload();
    await expect(page.getByTestId('nav-map')).toBeVisible({ timeout: 10_000 });
  });

  test('sign-out returns to the auth screen', async ({ page }) => {
    const username = uid('signout');
    await devLogin(page, username);
    await ensureCompany(page, `Co_${username.slice(-6)}`);

    await page.getByTestId('nav-settings').click();
    await expect(page.getByTestId('settings-panel')).toBeVisible();
    await page.getByTestId('settings-logout').click();
    await expect(page.getByTestId('dev-login-form')).toBeVisible({ timeout: 8_000 });
  });

  test('second login with same username resumes the same company', async ({ page }) => {
    const username = uid('resume');
    const coName = `Co_${username.slice(-6)}`;

    await devLogin(page, username);
    await ensureCompany(page, coName);

    // Sign out.
    await page.getByTestId('nav-settings').click();
    await page.getByTestId('settings-logout').click();
    await expect(page.getByTestId('dev-login-form')).toBeVisible();

    // Log back in — should skip company creation and go straight to the HUD.
    await page.getByTestId('dev-login-username').fill(username);
    await page.getByTestId('dev-login-submit').click();
    await expect(page.getByTestId('nav-map')).toBeVisible({ timeout: 10_000 });
  });
});
