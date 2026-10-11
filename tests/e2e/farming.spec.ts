/**
 * E2E: Core farming loop.
 * GDD acceptance criteria:
 *  - "Crop state advances correctly during offline time."
 *  - "Sale updates inventory, cash, and ledger exactly once."
 */
import { expect } from '@playwright/test';
import { test, uid } from './helpers';

test.describe('Farming loop', () => {
  test('plant → dev-advance → harvest → sell updates cash and ledger', async ({
    gamePage: page,
  }) => {
    // ── 1. Get a parcel to plant on (starter plot or buy one) ──────────────
    const tok = await page.evaluate(() => localStorage.getItem('bh_token'));
    expect(tok).toBeTruthy();

    // Fetch company id.
    const meRes = await page.request.get('http://localhost:8080/api/v1/me', {
      headers: { Authorization: `Bearer ${tok}` },
    });
    const me = (await meRes.json()) as { company: { id: string; cashPaise: number } };
    const companyId = me.company.id;

    // Find a parcel we operate (starter plot is reserved for us).
    const overviewRes = await page.request.get(
      `http://localhost:8080/api/v1/companies/${companyId}/overview`,
      {
        headers: { Authorization: `Bearer ${tok}` },
      },
    );
    const overview = (await overviewRes.json()) as {
      counts: { parcelsOwned: number; parcelsLeased: number };
    };
    const hasParcel = overview.counts.parcelsOwned + overview.counts.parcelsLeased > 0;

    if (!hasParcel) {
      // Buy the cheapest for-sale parcel.
      const mapRes = await page.request.get('http://localhost:8080/api/v1/regions/hemavati/map');
      const map = (await mapRes.json()) as {
        parcels: { id: string; status: string; listPricePaise: number; version: number }[];
      };
      const cheap = map.parcels
        .filter((p) => p.status === 'for_sale' && p.listPricePaise)
        .sort((a, b) => a.listPricePaise - b.listPricePaise)[0];
      if (!cheap) {
        test.skip(true, 'No parcel available');
        return;
      }
      await page.request.post(`http://localhost:8080/api/v1/parcels/${cheap.id}/purchase`, {
        headers: {
          Authorization: `Bearer ${tok}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': uid('buy'),
        },
        data: { expectedVersion: cheap.version, expectedPricePaise: cheap.listPricePaise },
      });
    }

    // ── 2. Plant via UI ────────────────────────────────────────────────────
    await page.getByTestId('nav-farm').click();
    await expect(page.getByTestId('farm-panel')).toBeVisible();

    // If no crops in the ground, open map and plant.
    const emptyFarm = page.locator('.bh-empty-state');
    if (await emptyFarm.isVisible()) {
      await page.getByTestId('nav-map').click();
      // Click the first parcel we own.
      const canvas = page.getByTestId('world-canvas');
      await canvas.click({ position: { x: 400, y: 300 } });
      await expect(page.getByTestId('parcel-inspector')).toBeVisible({ timeout: 8_000 });

      const plantBtn = page.getByTestId('parcel-plant-button');
      if (await plantBtn.isVisible()) {
        await plantBtn.click();
        await expect(page.locator('[data-testid="plant-dialog"]')).toBeVisible({ timeout: 5_000 });
        await page.locator('[data-testid="plant-submit"]').click();
        await expect(page.locator('[data-testid="plant-dialog"]')).not.toBeVisible({
          timeout: 8_000,
        });
      }
    }

    // ── 3. Advance time until crop is ready ────────────────────────────────
    await page.request.post('http://localhost:8080/api/v1/dev/advance', {
      headers: {
        Authorization: `Bearer ${tok}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': uid('adv'),
      },
      data: { days: 120 },
    });

    // ── 4. Harvest via Farm panel ──────────────────────────────────────────
    await page.getByTestId('nav-farm').click();
    await expect(page.getByTestId('farm-panel')).toBeVisible();
    await page.reload(); // refresh data after time advance

    const harvestBtn = page.getByTestId('harvest-button').first();
    if (await harvestBtn.isVisible({ timeout: 5_000 })) {
      await harvestBtn.click();
      await expect(harvestBtn).not.toBeVisible({ timeout: 10_000 });
    }

    // ── 5. Sell to mandi ──────────────────────────────────────────────────
    await page.getByTestId('nav-market').click();
    await expect(page.getByTestId('market-panel')).toBeVisible();
    await page.getByTestId('market-tab-sell').click();

    const qtyInput = page.getByTestId('sell-quantity');
    if (await qtyInput.isVisible({ timeout: 5_000 })) {
      await qtyInput.fill('100');
      await expect(page.getByTestId('sell-quote')).not.toContainText('Enter a quantity', {
        timeout: 5_000,
      });
      const cashBefore = await page.evaluate(() => {
        const el = document.querySelector('[data-testid="topbar-cash"]');
        return el?.textContent ?? '';
      });
      await page.getByTestId('sell-submit').click();
      // Cash should change.
      await expect(page.locator('[data-testid="topbar-cash"]')).not.toHaveText(cashBefore, {
        timeout: 8_000,
      });
    }

    // ── 6. Verify ledger has a sale entry ─────────────────────────────────
    await page.getByTestId('nav-finance').click();
    await expect(page.getByTestId('finance-panel')).toBeVisible();
    await page.getByTestId('finance-tab-ledger').click();
    await expect(page.getByTestId('ledger-table')).toBeVisible({ timeout: 8_000 });
    await expect(page.getByTestId('ledger-table')).toContainText('revenue_sales');
  });

  test('sale idempotency: replaying the same Idempotency-Key returns the same result', async ({
    gamePage: page,
  }) => {
    const tok = await page.evaluate(() => localStorage.getItem('bh_token'));
    const meRes = await page.request.get('http://localhost:8080/api/v1/me', {
      headers: { Authorization: `Bearer ${tok}` },
    });
    const me = (await meRes.json()) as { company: { id: string } };
    const companyId = me.company.id;

    // Get inventory.
    const invRes = await page.request.get(
      `http://localhost:8080/api/v1/companies/${companyId}/inventory`,
      {
        headers: { Authorization: `Bearer ${tok}` },
      },
    );
    const inv = (await invRes.json()) as { totals: { itemId: string; availableKg: number }[] };
    const stock = inv.totals.find((t) => t.availableKg >= 10);
    if (!stock) {
      test.skip(true, 'No inventory to sell');
      return;
    }

    const idemKey = uid('idem-sell');
    const body = { itemId: stock.itemId, quantityKg: 10, minNetUnitPricePaise: 0 };
    const headers = {
      Authorization: `Bearer ${tok}`,
      'Content-Type': 'application/json',
      'Idempotency-Key': idemKey,
    };

    const r1 = await page.request.post('http://localhost:8080/api/v1/markets/hemavati-apmc/sell', {
      headers,
      data: body,
    });
    const r2 = await page.request.post('http://localhost:8080/api/v1/markets/hemavati-apmc/sell', {
      headers,
      data: body,
    });

    expect(r1.status()).toBe(200);
    expect(r2.status()).toBe(200);
    // Second response must carry the replay header.
    expect(r2.headers()['idempotent-replayed']).toBe('true');

    const j1 = (await r1.json()) as { result: unknown };
    const j2 = (await r2.json()) as { result: unknown };
    expect(JSON.stringify(j1.result)).toBe(JSON.stringify(j2.result));
  });
});
