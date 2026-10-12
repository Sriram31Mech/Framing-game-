/**
 * The guided core loop on the starter plot: plant → (skip time) → harvest → sell.
 */
import { apiFor, devAdvance, dismissModals, expect, test } from './helpers';

test.describe('guided farming loop', () => {
  test('plants, harvests and sells following the next-step card', async ({ gamePage: page }) => {
    // Skipping a whole growing season runs ~100 simulated days on the server.
    test.setTimeout(240_000);
    const guide = page.getByTestId('next-step');
    await expect(guide).toBeVisible({ timeout: 15_000 });
    await expect(guide).toContainText('Plant your first crop');

    await page.getByTestId('guide-plant').click();
    // Any open crop except sugarcane (a 300+ day crop) keeps the loop short.
    const open = page.locator(
      '[data-testid^="plant-crop-"]:not([disabled]):not([data-testid="plant-crop-sugarcane"])',
    );
    await expect(open.first()).toBeVisible({ timeout: 10_000 });
    await open.first().click();
    await page.getByTestId('plant-confirm').click();
    await expect(guide).toContainText('is growing', { timeout: 15_000 });

    // Dev-only: jump straight to the crop's ready day (never past its harvest window).
    const api = apiFor(page);
    const me = await api.get<{ company: { id: string } }>('/me');
    const world = await api.get<{ gameDay: number }>('/world');
    const plots = await api.get<{ plots: { readyDay: number | null }[] }>(
      `/companies/${me.company.id}/plots`,
    );
    const readyDay = plots.plots[0]?.readyDay ?? world.gameDay + 1;
    await devAdvance(page, Math.max(1, readyDay - world.gameDay + 1));
    await page.reload();
    await expect(page.getByTestId('guide-harvest')).toBeVisible({ timeout: 30_000 });
    await dismissModals(page);
    await page.getByTestId('guide-harvest').click();
    await expect(guide).toContainText('Sell', { timeout: 15_000 });

    await page.getByTestId('guide-sell').click();
    await expect(page.getByTestId('sell-quote')).toBeVisible({ timeout: 10_000 });
    await page.getByTestId('sell-submit').click();
    await expect(guide).not.toContainText('Sell', { timeout: 15_000 });
  });
});
