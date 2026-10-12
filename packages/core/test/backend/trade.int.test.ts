import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { applyBps, P2P_TRADE_FEE_BPS, p2pPriceBand } from '@bh/domain';
import type { CoreDeps } from '../../src/commands/types';
import { getContracts, getListings } from '../../src/queries/markets';
import { statewidePricePaise } from '../../src/world/region';
import {
  cashOf,
  expectError,
  expectLedgerReconciles,
  grantLot,
  newPlayer,
  ok,
  REGION,
  run,
  type Player,
  setupWorld,
} from './helpers';

let deps: CoreDeps;
let seller: Player;
let buyer: Player;
let buyer2: Player;
let price: number;

beforeAll(async () => {
  deps = await setupWorld();
  seller = await newPlayer(deps, 'Seller Co');
  buyer = await newPlayer(deps, 'Buyer Co');
  buyer2 = await newPlayer(deps, 'Second Buyer');
  price = await statewidePricePaise(deps.pool, REGION, 'ragi');
});
afterAll(async () => {
  await deps.pool.end();
});

async function lot(id: string) {
  const { rows } = await deps.pool.query<{ quantity_kg: number; reserved_kg: number }>(
    'SELECT quantity_kg, reserved_kg FROM inventory_lots WHERE id = $1',
    [id],
  );
  return rows[0]!;
}

describe('P2P listings', () => {
  let lotId: string;
  let listingId: string;

  it('creates a listing within the price band, reserving stock', async () => {
    lotId = await grantLot(deps, seller.companyId, {
      itemId: 'ragi',
      quantityKg: 1_000,
      quality: 82,
    });
    const [floor, ceiling] = p2pPriceBand(price);
    expectError(
      await run(deps, seller, {
        type: 'create_listing',
        itemId: 'ragi',
        quantityKg: 500,
        unitPricePaise: ceiling + 1,
        durationDays: 10,
      }),
      'RULE_VIOLATION',
    );
    expectError(
      await run(deps, seller, {
        type: 'create_listing',
        itemId: 'ragi',
        quantityKg: 5_000,
        unitPricePaise: price,
        durationDays: 10,
      }),
      'INSUFFICIENT_STOCK',
    );
    expect(floor).toBeLessThan(price);
    const res = ok<{ listingId: string; lotId: string }>(
      await run(deps, seller, {
        type: 'create_listing',
        itemId: 'ragi',
        quantityKg: 600,
        unitPricePaise: price,
        durationDays: 10,
      }),
    );
    listingId = res.listingId;
    expect(res.lotId).toBe(lotId);
    expect(await lot(lotId)).toEqual({ quantity_kg: 1_000, reserved_kg: 600 });
    // Reserved stock cannot be sold elsewhere.
    expectError(
      await run(deps, seller, {
        type: 'create_listing',
        itemId: 'ragi',
        quantityKg: 500,
        unitPricePaise: price,
        durationDays: 10,
      }),
      'INSUFFICIENT_STOCK',
    );
    const listings = await getListings(deps, buyer.auth, {
      itemId: 'ragi',
      mine: false,
      status: 'open',
      limit: 50,
    });
    expect(listings.listings.map((l) => l.id)).toContain(listingId);
  });

  it('buyer purchases part of a listing: funds, fee sink, stock and notifications move once', async () => {
    expectError(
      await run(deps, seller, {
        type: 'buy_listing',
        listingId,
        quantityKg: 10,
        expectedUnitPricePaise: price,
      }),
      'RULE_VIOLATION',
    );
    expectError(
      await run(deps, buyer, {
        type: 'buy_listing',
        listingId,
        quantityKg: 10,
        expectedUnitPricePaise: price - 1,
      }),
      'PRICE_CHANGED',
    );
    const cashS = await cashOf(deps, seller.companyId);
    const cashB = await cashOf(deps, buyer.companyId);
    const res = ok<{ lotId: string; totalPaise: number; remainingKg: number }>(
      await run(deps, buyer, {
        type: 'buy_listing',
        listingId,
        quantityKg: 300,
        expectedUnitPricePaise: price,
      }),
    );
    const gross = price * 300;
    expect(res.totalPaise).toBe(gross);
    expect(res.remainingKg).toBe(300);
    expect(await cashOf(deps, buyer.companyId)).toBe(cashB - gross);
    expect(await cashOf(deps, seller.companyId)).toBe(
      cashS + gross - applyBps(gross, P2P_TRADE_FEE_BPS),
    );
    expect(await lot(lotId)).toEqual({ quantity_kg: 700, reserved_kg: 300 });
    const bought = await deps.pool.query(
      'SELECT quantity_kg, quality, source FROM inventory_lots WHERE id = $1',
      [res.lotId],
    );
    expect(bought.rows[0]).toEqual({ quantity_kg: 300, quality: 82, source: 'trade' });
    const note = await deps.pool.query(
      `SELECT 1 FROM notifications WHERE company_id = $1 AND type = 'listing_sold'`,
      [seller.companyId],
    );
    expect(note.rowCount).toBe(1);
    await expectLedgerReconciles(deps);
  });

  it('last-stock race: two buyers for the remaining stock, exactly one succeeds; no negative stock', async () => {
    const cash1 = await cashOf(deps, buyer.companyId);
    const cash2 = await cashOf(deps, buyer2.companyId);
    const cmd = {
      type: 'buy_listing' as const,
      listingId,
      quantityKg: 300,
      expectedUnitPricePaise: price,
    };
    const results = await Promise.all([run(deps, buyer, cmd), run(deps, buyer2, cmd)]);
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const loser = results.find((r) => !r.ok)!;
    expect(['CONFLICT', 'INSUFFICIENT_STOCK']).toContain(loser.ok ? '' : loser.error.code);
    const loserCompany = results[0]!.ok ? buyer2 : buyer;
    expect(await cashOf(deps, loserCompany.companyId)).toBe(loserCompany === buyer ? cash1 : cash2);
    expect(await lot(lotId)).toEqual({ quantity_kg: 400, reserved_kg: 0 });
    const listing = await deps.pool.query(
      'SELECT status, remaining_kg FROM market_listings WHERE id = $1',
      [listingId],
    );
    expect(listing.rows[0]).toEqual({ status: 'filled', remaining_kg: 0 });
    expectError(await run(deps, buyer, { ...cmd, quantityKg: 1 }), 'CONFLICT');
    await expectLedgerReconciles(deps);
  });

  it('cancelling a listing releases the reservation (seller only)', async () => {
    const res = ok<{ listingId: string }>(
      await run(deps, seller, {
        type: 'create_listing',
        itemId: 'ragi',
        quantityKg: 100,
        unitPricePaise: price,
        durationDays: 5,
        lotId,
      }),
    );
    expect(await lot(lotId)).toEqual({ quantity_kg: 400, reserved_kg: 100 });
    expectError(
      await run(deps, buyer, { type: 'cancel_listing', listingId: res.listingId }),
      'FORBIDDEN',
    );
    ok(await run(deps, seller, { type: 'cancel_listing', listingId: res.listingId }));
    expect(await lot(lotId)).toEqual({ quantity_kg: 400, reserved_kg: 0 });
    expectError(
      await run(deps, seller, { type: 'cancel_listing', listingId: res.listingId }),
      'CONFLICT',
    );
  });
});

describe('contracts', () => {
  let contractId: string;
  let version: number;
  let termsHash: string;

  it('buyer creates a contract and escrows the total', async () => {
    const cash = await cashOf(deps, buyer.companyId);
    const res = ok<{ contractId: string; totalPaise: number; termsHash: string; version: number }>(
      await run(deps, buyer, {
        type: 'create_contract',
        itemId: 'ragi',
        quantityKg: 250,
        minQuality: 70,
        unitPricePaise: price,
        deliveryWithinDays: 20,
      }),
    );
    ({ contractId, termsHash, version } = res);
    expect(res.totalPaise).toBe(price * 250);
    expect(await cashOf(deps, buyer.companyId)).toBe(cash - res.totalPaise);
    const c = await deps.pool.query<{ escrow_paise: number }>(
      'SELECT escrow_paise FROM companies WHERE id = $1',
      [buyer.companyId],
    );
    expect(c.rows[0]!.escrow_paise).toBe(res.totalPaise);
    const open = await getContracts(deps, seller.auth, { scope: 'open', limit: 50 });
    expect(open.contracts.find((k) => k.id === contractId)?.termsHash).toBe(termsHash);
    await expectLedgerReconciles(deps);
  });

  it('seller accepts only the exact version and terms', async () => {
    expectError(
      await run(deps, buyer, {
        type: 'accept_contract',
        contractId,
        expectedVersion: version,
        termsHash,
      }),
      'RULE_VIOLATION',
    );
    expectError(
      await run(deps, seller, {
        type: 'accept_contract',
        contractId,
        expectedVersion: version,
        termsHash: '0'.repeat(64),
      }),
      'CONFLICT',
    );
    expectError(
      await run(deps, seller, {
        type: 'accept_contract',
        contractId,
        expectedVersion: version + 1,
        termsHash,
      }),
      'CONFLICT',
    );
    ok(
      await run(deps, seller, {
        type: 'accept_contract',
        contractId,
        expectedVersion: version,
        termsHash,
      }),
    );
    expectError(
      await run(deps, buyer2, {
        type: 'accept_contract',
        contractId,
        expectedVersion: version,
        termsHash,
      }),
      'CONFLICT',
    );
    expectError(await run(deps, buyer, { type: 'cancel_contract', contractId }), 'CONFLICT');
  });

  it('seller delivers qualifying stock; escrow pays the seller less fee; buyer gets the produce', async () => {
    // Low-quality stock does not count toward delivery.
    const low = await grantLot(deps, seller.companyId, {
      itemId: 'ragi',
      quantityKg: 5_000,
      quality: 40,
    });
    expectError(await run(deps, buyer2, { type: 'deliver_contract', contractId }), 'FORBIDDEN');
    const cashS = await cashOf(deps, seller.companyId);
    const total = price * 250;
    const res = ok<{ netPaise: number; quality: number }>(
      await run(deps, seller, { type: 'deliver_contract', contractId }),
    );
    expect(res.netPaise).toBe(total - applyBps(total, P2P_TRADE_FEE_BPS));
    expect(res.quality).toBe(82);
    expect(await cashOf(deps, seller.companyId)).toBe(cashS + res.netPaise);
    expect(await lot(low)).toEqual({ quantity_kg: 5_000, reserved_kg: 0 });
    const esc = await deps.pool.query<{ escrow_paise: number }>(
      'SELECT escrow_paise FROM companies WHERE id = $1',
      [buyer.companyId],
    );
    expect(esc.rows[0]!.escrow_paise).toBe(0);
    const got = await deps.pool.query<{ kg: number }>(
      `SELECT SUM(quantity_kg)::bigint AS kg FROM inventory_lots WHERE company_id = $1 AND source = 'contract'`,
      [buyer.companyId],
    );
    expect(Number(got.rows[0]!.kg)).toBe(250);
    const k = await deps.pool.query('SELECT status, escrow_paise FROM contracts WHERE id = $1', [
      contractId,
    ]);
    expect(k.rows[0]).toEqual({ status: 'fulfilled', escrow_paise: 0 });
    const note = await deps.pool.query(
      `SELECT 1 FROM notifications WHERE company_id = $1 AND type = 'contract_delivered'`,
      [buyer.companyId],
    );
    expect(note.rowCount).toBe(1);
    expectError(await run(deps, seller, { type: 'deliver_contract', contractId }), 'CONFLICT');
    await expectLedgerReconciles(deps);
  });

  it('buyer cancels an open contract and the escrow is refunded', async () => {
    const cash = await cashOf(deps, buyer.companyId);
    const res = ok<{ contractId: string; totalPaise: number }>(
      await run(deps, buyer, {
        type: 'create_contract',
        itemId: 'ragi',
        quantityKg: 10,
        minQuality: 0,
        unitPricePaise: price,
        deliveryWithinDays: 5,
      }),
    );
    expectError(
      await run(deps, seller, { type: 'cancel_contract', contractId: res.contractId }),
      'FORBIDDEN',
    );
    ok(await run(deps, buyer, { type: 'cancel_contract', contractId: res.contractId }));
    expect(await cashOf(deps, buyer.companyId)).toBe(cash);
    const k = await deps.pool.query('SELECT status FROM contracts WHERE id = $1', [res.contractId]);
    expect(k.rows[0]).toEqual({ status: 'cancelled' });
    await expectLedgerReconciles(deps);
  });

  it('cannot escrow more than the buyer has', async () => {
    const poor = await newPlayer(deps);
    const cash = await cashOf(deps, poor.companyId);
    const qty = Math.ceil(cash / price) + 10;
    expectError(
      await run(deps, poor, {
        type: 'create_contract',
        itemId: 'ragi',
        quantityKg: qty,
        minQuality: 0,
        unitPricePaise: price,
        deliveryWithinDays: 5,
      }),
      'INSUFFICIENT_FUNDS',
    );
    expect(await cashOf(deps, poor.companyId)).toBe(cash);
    const k = await deps.pool.query('SELECT 1 FROM contracts WHERE buyer_company_id = $1', [
      poor.companyId,
    ]);
    expect(k.rowCount).toBe(0);
  });
});
