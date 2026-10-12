/**
 * Land on the real Tamil Nadu map: browse an area, inspect a holding's suitability, buy it.
 */
import { expect, openCheapestHoldingForSale, test } from './helpers';

test.describe('land', () => {
  test('finds an area, shows its climate and holdings', async ({ gamePage: page }) => {
    await page.getByTestId('nav-map').click();
    await page.getByLabel('Search places').fill('Thanjavur');
    await page.getByTestId('find-land').locator('.tn-find-list button').first().click();
    const panel = page.getByTestId('segment-panel');
    await expect(panel).toBeVisible();
    await expect(panel.getByText('Cauvery Delta Zone')).toBeVisible();
    await expect(panel.getByLabel('Monthly rainfall and temperature')).toBeVisible();
    await expect(panel.locator('.tn-holding').first()).toBeVisible();
  });

  test('inspects and buys a holding', async ({ gamePage: page }) => {
    await openCheapestHoldingForSale(page);
    await expect(page.getByTestId('suitability-table')).toBeVisible({ timeout: 8_000 });
    const buy = page.getByTestId('parcel-buy-button');
    await expect(buy).toBeVisible();
    await buy.click();
    // Confirmation explains the cost before the expensive action.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await dialog.getByRole('button', { name: /buy/i }).last().click();
    await expect(page.getByTestId('parcel-plant-button')).toBeVisible({ timeout: 10_000 });
  });

  test('switches map layers', async ({ gamePage: page }) => {
    for (const layer of ['rain', 'land', 'mine', 'zone']) {
      await page.getByTestId(`layer-${layer}`).click();
      await expect(page.getByTestId(`layer-${layer}`)).toHaveAttribute('aria-checked', 'true');
    }
  });
});
