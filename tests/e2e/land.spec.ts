/**
 * E2E: Land system.
 * GDD acceptance criteria:
 *  - "Land purchase cannot succeed twice under concurrent requests."
 *  - "Suitability and yield predictions show their key contributing factors."
 */
import { expect } from '@playwright/test';
import { test } from './helpers';

test.describe('Land', () => {
  test('parcel inspector shows suitability scores with factor breakdown', async ({
    gamePage: page,
  }) => {
    // Open the map panel and click the first for-sale parcel.
    await page.getByTestId('nav-map').click();
    await expect(page.getByTestId('map-panel')).toBeVisible();

    // Click a parcel on the 3D canvas (or use the map list if available).
    // The map panel lists parcels; click the first for-sale one.
    const firstParcel = page.getByTestId('map-parcel-row').first();
    if (await firstParcel.isVisible()) {
      await firstParcel.click();
    } else {
      // Fallback: click the canvas centre to select a parcel.
      const canvas = page.getByTestId('world-canvas');
      await canvas.click({ position: { x: 400, y: 300 } });
    }

    await expect(page.getByTestId('parcel-inspector')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTestId('suitability-table')).toBeVisible({ timeout: 8_000 });

    // Expand the first suitability row and check factors are shown.
    const firstRow = page.getByTestId(/^suitability-/).first();
    await firstRow.click();
    // After expanding, factor detail text should appear.
    await expect(page.locator('.bh-factor').first()).toBeVisible();
  });

  test('buying a parcel updates cash and shows it as owned', async ({ gamePage: page }) => {
    // Open map, find a for-sale parcel.
    await page.getByTestId('nav-map').click();
    const firstParcel = page.getByTestId('map-parcel-row').first();
    if (await firstParcel.isVisible()) await firstParcel.click();
    else {
      const canvas = page.getByTestId('world-canvas');
      await canvas.click({ position: { x: 400, y: 300 } });
    }

    await expect(page.getByTestId('parcel-inspector')).toBeVisible({ timeout: 8_000 });

    const buyBtn = page.getByTestId('parcel-buy-button');
    if (!(await buyBtn.isVisible())) {
      test.skip(true, 'No for-sale parcel available in this run');
      return;
    }

    await buyBtn.click();
    // Confirm dialog appears.
    await expect(page.locator('[role="dialog"]')).toBeVisible();
    await page
      .locator(
        '[role="dialog"] button[data-variant="primary"], [role="dialog"] button.bh-btn-primary',
      )
      .first()
      .click();

    // Inspector should now show the parcel as owned.
    await expect(page.getByTestId('parcel-inspector')).toContainText('Yours', { timeout: 8_000 });
  });

  test('concurrent purchase of the same parcel: only one succeeds', async ({ browser }) => {
    // Two separate browser contexts race to buy the same parcel.
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const p1 = await ctx1.newPage();
    const p2 = await ctx2.newPage();

    const { devLogin, ensureCompany, uid } = await import('./helpers');
    const u1 = uid('race1');
    const u2 = uid('race2');
    await devLogin(p1, u1);
    await ensureCompany(p1, `R1_${u1.slice(-4)}`);
    await devLogin(p2, u2);
    await ensureCompany(p2, `R2_${u2.slice(-4)}`);

    // Both navigate to the map and open the same parcel.
    await p1.getByTestId('nav-map').click();
    await p2.getByTestId('nav-map').click();

    // Get the first parcel id from the API.
    const mapRes = await p1.request.get('http://localhost:8080/api/v1/regions/hemavati/map');
    const map = (await mapRes.json()) as {
      parcels: { id: string; status: string; listPricePaise: number; version: number }[];
    };
    const forSale = map.parcels.find((p) => p.status === 'for_sale' && p.listPricePaise);
    if (!forSale) {
      await ctx1.close();
      await ctx2.close();
      test.skip(true, 'No for-sale parcel available');
      return;
    }

    // Get tokens from localStorage.
    const tok1 = await p1.evaluate(() => localStorage.getItem('bh_token'));
    const tok2 = await p2.evaluate(() => localStorage.getItem('bh_token'));

    // Race both purchase requests simultaneously.
    const [r1, r2] = await Promise.all([
      p1.request.post(`http://localhost:8080/api/v1/parcels/${forSale.id}/purchase`, {
        headers: {
          Authorization: `Bearer ${tok1}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': uid('r1'),
        },
        data: { expectedVersion: forSale.version, expectedPricePaise: forSale.listPricePaise },
      }),
      p2.request.post(`http://localhost:8080/api/v1/parcels/${forSale.id}/purchase`, {
        headers: {
          Authorization: `Bearer ${tok2}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': uid('r2'),
        },
        data: { expectedVersion: forSale.version, expectedPricePaise: forSale.listPricePaise },
      }),
    ]);

    const statuses = [r1.status(), r2.status()].sort();
    // Exactly one 200 and one 409 (or both 409 if the parcel was already sold).
    expect(statuses.filter((s) => s === 200).length).toBeLessThanOrEqual(1);
    expect(statuses.some((s) => s === 409 || s === 422)).toBe(true);

    await ctx1.close();
    await ctx2.close();
  });
});
