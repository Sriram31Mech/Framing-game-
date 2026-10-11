/**
 * E2E: Multiplayer trade.
 * GDD acceptance criterion: "Two players can complete a validated trade or contract."
 */
import { expect, test as base } from '@playwright/test';
import { devLogin, ensureCompany, uid } from './helpers';

base.describe('Multiplayer trade', () => {
  base.skip(
    () => process.env.E2E_SKIP_MULTIPLAYER === '1',
    'Set E2E_SKIP_MULTIPLAYER=0 to run multiplayer tests (requires a seeded DB with inventory)',
  );

  base('two players complete a P2P listing purchase', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const seller = await ctx1.newPage();
    const buyer = await ctx2.newPage();

    const su = uid('seller');
    const bu = uid('buyer');
    await devLogin(seller, su);
    await ensureCompany(seller, `Sell_${su.slice(-4)}`);
    await devLogin(buyer, bu);
    await ensureCompany(buyer, `Buy_${bu.slice(-4)}`);

    const sellerTok = await seller.evaluate(() => localStorage.getItem('bh_token'));
    const buyerTok = await buyer.evaluate(() => localStorage.getItem('bh_token'));

    // Advance time so the seller has some inventory (via dev endpoint).
    await seller.request.post('http://localhost:8080/api/v1/dev/advance', {
      headers: {
        Authorization: `Bearer ${sellerTok}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': uid('adv'),
      },
      data: { days: 120 },
    });

    // Check seller inventory.
    const meRes = await seller.request.get('http://localhost:8080/api/v1/me', {
      headers: { Authorization: `Bearer ${sellerTok}` },
    });
    const me = (await meRes.json()) as { company: { id: string } };
    const invRes = await seller.request.get(
      `http://localhost:8080/api/v1/companies/${me.company.id}/inventory`,
      {
        headers: { Authorization: `Bearer ${sellerTok}` },
      },
    );
    const inv = (await invRes.json()) as { totals: { itemId: string; availableKg: number }[] };
    const stock = inv.totals.find((t) => t.availableKg >= 50);
    if (!stock) {
      await ctx1.close();
      await ctx2.close();
      base.skip(true, 'Seller has no inventory after advance');
      return;
    }

    // Get mandi price for the band check.
    const mktRes = await seller.request.get('http://localhost:8080/api/v1/markets');
    const mkt = (await mktRes.json()) as {
      markets: { id: string; prices: { itemId: string; pricePaisePerKg: number }[] }[];
    };
    const price =
      mkt.markets[0]?.prices.find((p) => p.itemId === stock.itemId)?.pricePaisePerKg ?? 0;
    if (!price) {
      await ctx1.close();
      await ctx2.close();
      base.skip(true, 'No market price available');
      return;
    }

    // Seller creates a listing.
    const listRes = await seller.request.post('http://localhost:8080/api/v1/market-listings', {
      headers: {
        Authorization: `Bearer ${sellerTok}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': uid('list'),
      },
      data: { itemId: stock.itemId, quantityKg: 50, unitPricePaise: price, durationDays: 7 },
    });
    expect(listRes.status()).toBe(200);
    const listData = (await listRes.json()) as { result: { listingId: string } };
    const listingId = listData.result?.listingId;
    expect(listingId).toBeTruthy();

    // Buyer purchases from the listing.
    const buyRes = await buyer.request.post(
      `http://localhost:8080/api/v1/market-listings/${listingId}/purchase`,
      {
        headers: {
          Authorization: `Bearer ${buyerTok}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': uid('buy'),
        },
        data: { quantityKg: 50, expectedUnitPricePaise: price },
      },
    );
    expect(buyRes.status()).toBe(200);

    // Buyer's inventory should now contain the item.
    const buyerMeRes = await buyer.request.get('http://localhost:8080/api/v1/me', {
      headers: { Authorization: `Bearer ${buyerTok}` },
    });
    const buyerMe = (await buyerMeRes.json()) as { company: { id: string } };
    const buyerInvRes = await buyer.request.get(
      `http://localhost:8080/api/v1/companies/${buyerMe.company.id}/inventory`,
      {
        headers: { Authorization: `Bearer ${buyerTok}` },
      },
    );
    const buyerInv = (await buyerInvRes.json()) as {
      totals: { itemId: string; availableKg: number }[];
    };
    const received = buyerInv.totals.find((t) => t.itemId === stock.itemId);
    expect(received?.availableKg).toBeGreaterThanOrEqual(50);

    await ctx1.close();
    await ctx2.close();
  });

  base('forward contract: buyer posts, seller accepts and delivers', async ({ browser }) => {
    const ctx1 = await browser.newContext();
    const ctx2 = await browser.newContext();
    const buyer = await ctx1.newPage();
    const seller = await ctx2.newPage();

    const bu = uid('cbuyer');
    const su = uid('cseller');
    await devLogin(buyer, bu);
    await ensureCompany(buyer, `CB_${bu.slice(-4)}`);
    await devLogin(seller, su);
    await ensureCompany(seller, `CS_${su.slice(-4)}`);

    const buyerTok = await buyer.evaluate(() => localStorage.getItem('bh_token'));
    const sellerTok = await seller.evaluate(() => localStorage.getItem('bh_token'));

    // Advance so seller has inventory.
    await seller.request.post('http://localhost:8080/api/v1/dev/advance', {
      headers: {
        Authorization: `Bearer ${sellerTok}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': uid('adv2'),
      },
      data: { days: 120 },
    });

    const sellerMeRes = await seller.request.get('http://localhost:8080/api/v1/me', {
      headers: { Authorization: `Bearer ${sellerTok}` },
    });
    const sellerMe = (await sellerMeRes.json()) as { company: { id: string } };
    const invRes = await seller.request.get(
      `http://localhost:8080/api/v1/companies/${sellerMe.company.id}/inventory`,
      {
        headers: { Authorization: `Bearer ${sellerTok}` },
      },
    );
    const inv = (await invRes.json()) as { totals: { itemId: string; availableKg: number }[] };
    const stock = inv.totals.find((t) => t.availableKg >= 100);
    if (!stock) {
      await ctx1.close();
      await ctx2.close();
      base.skip(true, 'Seller has no inventory');
      return;
    }

    // Buyer posts a contract.
    const contractRes = await buyer.request.post('http://localhost:8080/api/v1/contracts', {
      headers: {
        Authorization: `Bearer ${buyerTok}`,
        'Content-Type': 'application/json',
        'Idempotency-Key': uid('contract'),
      },
      data: {
        itemId: stock.itemId,
        quantityKg: 100,
        minQuality: 0,
        unitPricePaise: 100,
        deliveryWithinDays: 30,
      },
    });
    expect(contractRes.status()).toBe(200);
    const contractData = (await contractRes.json()) as { result: { contractId: string } };
    const contractId = contractData.result?.contractId;
    expect(contractId).toBeTruthy();

    // Fetch the contract to get version + termsHash.
    const contractsRes = await seller.request.get(
      'http://localhost:8080/api/v1/contracts?scope=open',
      {
        headers: { Authorization: `Bearer ${sellerTok}` },
      },
    );
    const contracts = (await contractsRes.json()) as {
      contracts: { id: string; version: number; termsHash: string }[];
    };
    const contract = contracts.contracts.find((c) => c.id === contractId);
    expect(contract).toBeTruthy();

    // Seller accepts.
    const acceptRes = await seller.request.post(
      `http://localhost:8080/api/v1/contracts/${contractId}/accept`,
      {
        headers: {
          Authorization: `Bearer ${sellerTok}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': uid('accept'),
        },
        data: { expectedVersion: contract!.version, termsHash: contract!.termsHash },
      },
    );
    expect(acceptRes.status()).toBe(200);

    // Seller delivers.
    const deliverRes = await seller.request.post(
      `http://localhost:8080/api/v1/contracts/${contractId}/deliver`,
      {
        headers: {
          Authorization: `Bearer ${sellerTok}`,
          'Content-Type': 'application/json',
          'Idempotency-Key': uid('deliver'),
        },
        data: {},
      },
    );
    expect(deliverRes.status()).toBe(200);

    // Contract should now be fulfilled.
    const finalRes = await buyer.request.get('http://localhost:8080/api/v1/contracts?scope=mine', {
      headers: { Authorization: `Bearer ${buyerTok}` },
    });
    const final = (await finalRes.json()) as { contracts: { id: string; status: string }[] };
    const done = final.contracts.find((c) => c.id === contractId);
    expect(done?.status).toBe('fulfilled');

    await ctx1.close();
    await ctx2.close();
  });
});
