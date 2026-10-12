/**
 * Two players trade through the server: a P2P listing bought in the UI, and a buy contract
 * accepted and delivered. Setup (growing a crop) uses the API to keep the test fast.
 */
import { expect, test as base } from '@playwright/test';
import { apiFor, devLogin, dismissModals, ensureCompany, growAndHarvest, uid } from './helpers';

base.describe('Multiplayer trade', () => {
  base.setTimeout(300_000);

  base('two players complete a P2P listing purchase', async ({ browser }) => {
    const seller = await (await browser.newContext()).newPage();
    const buyer = await (await browser.newContext()).newPage();
    const su = uid('seller');
    const bu = uid('buyer');
    await devLogin(seller, su);
    await ensureCompany(seller, `Seller ${su.slice(-4)}`);
    await devLogin(buyer, bu);
    await ensureCompany(buyer, `Buyer ${bu.slice(-4)}`);

    const stock = await growAndHarvest(seller);
    const sellerApi = apiFor(seller);
    const markets = await sellerApi.get<{
      markets: { prices: { itemId: string; pricePaisePerKg: number }[] }[];
    }>('/markets');
    const best = Math.max(
      ...markets.markets.flatMap((m) =>
        m.prices.filter((p) => p.itemId === stock.itemId).map((p) => p.pricePaisePerKg),
      ),
    );
    const qty = Math.min(100, stock.availableKg);
    await sellerApi.post('/market-listings', {
      itemId: stock.itemId,
      quantityKg: qty,
      unitPricePaise: best,
      durationDays: 30,
    });

    // Buyer finds and buys it in the UI.
    await buyer.reload();
    await dismissModals(buyer);
    await buyer.getByTestId('nav-market').click();
    await buyer.getByTestId('market-tab-p2p').click();
    const row = buyer
      .getByTestId('p2p-listings')
      .locator('tr', { hasText: `Seller ${su.slice(-4)}` })
      .first();
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByTestId('listing-buy-button').click();
    const dialog = buyer.getByRole('dialog');
    await dialog.getByTestId('listing-buy-quantity').fill(String(Math.min(10, qty)));
    await dialog.getByRole('button', { name: /buy/i }).last().click();
    await expect(buyer.getByText('Purchase complete').first()).toBeVisible({ timeout: 15_000 });

    const buyerApi = apiFor(buyer);
    const me = await buyerApi.get<{ company: { id: string } }>('/me');
    const inv = await buyerApi.get<{ totals: { itemId: string; quantityKg: number }[] }>(
      `/companies/${me.company.id}/inventory`,
    );
    expect(inv.totals.find((t) => t.itemId === stock.itemId)?.quantityKg).toBe(Math.min(10, qty));
  });

  base('buy contract: buyer posts, seller accepts and delivers', async ({ browser }) => {
    const buyer = await (await browser.newContext()).newPage();
    const seller = await (await browser.newContext()).newPage();
    const bu = uid('cbuyer');
    const su = uid('cseller');
    await devLogin(buyer, bu);
    await ensureCompany(buyer, `Contract Buyer ${bu.slice(-4)}`);
    await devLogin(seller, su);
    await ensureCompany(seller, `Contract Seller ${su.slice(-4)}`);

    const stock = await growAndHarvest(seller);
    const buyerApi = apiFor(buyer);
    const sellerApi = apiFor(seller);
    const markets = await buyerApi.get<{
      markets: { prices: { itemId: string; pricePaisePerKg: number }[] }[];
    }>('/markets');
    const price = markets.markets[0]!.prices.find(
      (p) => p.itemId === stock.itemId,
    )!.pricePaisePerKg;
    const qty = Math.min(50, stock.availableKg);
    const created = await buyerApi.post<{ result: { contract: { id: string } } | { id: string } }>(
      '/contracts',
      {
        itemId: stock.itemId,
        quantityKg: qty,
        minQuality: 0,
        unitPricePaise: price,
        deliveryWithinDays: 30,
      },
    );
    const contractId =
      'contract' in created.result
        ? created.result.contract.id
        : (created.result as { id: string }).id;
    const open = await sellerApi.get<{
      contracts: { id: string; version: number; termsHash: string }[];
    }>('/contracts?scope=open');
    const c = open.contracts.find((x) => x.id === contractId)!;
    await sellerApi.post(`/contracts/${c.id}/accept`, {
      expectedVersion: c.version,
      termsHash: c.termsHash,
    });
    await sellerApi.post(`/contracts/${c.id}/deliver`, {});

    // Buyer sees the fulfilled contract in the UI.
    await buyer.reload();
    await dismissModals(buyer);
    await buyer.getByTestId('nav-contracts').click();
    await expect(buyer.getByText(/fulfilled/i).first()).toBeVisible({ timeout: 15_000 });
  });
});
