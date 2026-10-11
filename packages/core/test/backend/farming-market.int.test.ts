import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getCrop, plantingCostPaise } from '@bh/domain';
import type { CoreDeps } from '../../src/commands/types';
import { computePlantingCost } from '../../src/commands/farming';
import { getCompanyLoans } from '../../src/queries/company';
import { getSaleQuote } from '../../src/queries/markets';
import {
  cashOf,
  expectError,
  expectLedgerReconciles,
  forceReady,
  freeParcel,
  newPlayer,
  ok,
  REGION,
  run,
  setupWorld,
  type Player,
} from './helpers';

let deps: CoreDeps;
let a: Player;
let b: Player;
let plotId: string;
let marketId: string;

beforeAll(async () => {
  deps = await setupWorld();
  a = await newPlayer(deps, 'Cauvery Growers');
  b = await newPlayer(deps, 'Intruder Agro');
  const m = await deps.pool.query<{ id: string }>('SELECT id FROM markets ORDER BY id LIMIT 1');
  marketId = m.rows[0]!.id;
});
afterAll(async () => {
  await deps.pool.end();
});

async function inventoryKg(companyId: string, itemId: string): Promise<number> {
  const { rows } = await deps.pool.query<{ kg: number }>(
    `SELECT COALESCE(SUM(quantity_kg), 0)::bigint AS kg FROM inventory_lots WHERE company_id = $1 AND item_id = $2`,
    [companyId, itemId],
  );
  return Number(rows[0]!.kg);
}

describe('plant → harvest → sell', () => {
  it('plants rice on the starter plot (server-computed cost; forged cost rejected)', async () => {
    const parcelId = a.starterParcelId!;
    const area = await deps.pool.query<{ area_ha: number }>(
      'SELECT area_ha FROM land_parcels WHERE id = $1',
      [parcelId],
    );
    const cost = plantingCostPaise(getCrop('rice'), area.rows[0]!.area_ha, { fertilize: true });
    const cmd = {
      type: 'plant' as const,
      parcelId,
      cropId: 'rice' as const,
      irrigate: false,
      fertilize: true,
      expectedCostPaise: cost - 1,
    };
    expectError(await run(deps, a, cmd), 'PRICE_CHANGED');
    expectError(await run(deps, b, { ...cmd, expectedCostPaise: cost }), 'RULE_VIOLATION');
    // Out of season: sugarcane is sown Jan–Mar; day 0 is 1 June.
    expectError(
      await run(deps, a, { ...cmd, cropId: 'sugarcane', expectedCostPaise: cost }),
      'RULE_VIOLATION',
    );

    const cash = await cashOf(deps, a.companyId);
    const res = ok<{ plotId: string; costPaise: number }>(
      await run(deps, a, { ...cmd, expectedCostPaise: cost }),
    );
    plotId = res.plotId;
    expect(res.costPaise).toBe(cost);
    expect(await cashOf(deps, a.companyId)).toBe(cash - cost);
    expectError(await run(deps, a, { ...cmd, expectedCostPaise: cost }), 'CONFLICT');
    await expectLedgerReconciles(deps);
  });

  it('applies plot operations and refuses them on other companies’ plots', async () => {
    const cash = await cashOf(deps, a.companyId);
    const res = ok<{ costPaise: number }>(
      await run(deps, a, { type: 'plot_operation', plotId, op: 'pest_control' }),
    );
    expect(res.costPaise).toBeGreaterThan(0);
    expect(await cashOf(deps, a.companyId)).toBe(cash - res.costPaise);
    expectError(
      await run(deps, a, { type: 'plot_operation', plotId, op: 'pest_control' }),
      'RULE_VIOLATION',
    );
    expectError(
      await run(deps, a, { type: 'plot_operation', plotId, op: 'fertilize' }),
      'RULE_VIOLATION',
    );
    expectError(
      await run(deps, b, { type: 'plot_operation', plotId, op: 'irrigation_off' }),
      'FORBIDDEN',
    );
    const basis = await deps.pool.query<{ cost_basis_paise: number }>(
      'SELECT cost_basis_paise FROM crop_plots WHERE id = $1',
      [plotId],
    );
    expect(basis.rows[0]!.cost_basis_paise).toBeGreaterThan(res.costPaise);
  });

  it('cannot harvest before ready, nor harvest someone else’s plot', async () => {
    expectError(await run(deps, a, { type: 'harvest', plotId }), 'RULE_VIOLATION');
    await forceReady(deps, plotId);
    expectError(await run(deps, b, { type: 'harvest', plotId }), 'FORBIDDEN');
  });

  it('harvests into an inventory lot carried at cost', async () => {
    const basis = await deps.pool.query<{ cost_basis_paise: number }>(
      'SELECT cost_basis_paise FROM crop_plots WHERE id = $1',
      [plotId],
    );
    const res = ok<{
      lotId: string;
      quantityKg: number;
      quality: number;
      harvestLaborPaise: number;
      costBasisPaise: number;
    }>(await run(deps, a, { type: 'harvest', plotId }));
    expect(res.quantityKg).toBeGreaterThan(0);
    expect(res.costBasisPaise).toBe(basis.rows[0]!.cost_basis_paise + res.harvestLaborPaise);
    const lot = await deps.pool.query(
      'SELECT quantity_kg, quality, cost_basis_paise, source FROM inventory_lots WHERE id = $1',
      [res.lotId],
    );
    expect(lot.rows[0]).toEqual({
      quantity_kg: res.quantityKg,
      quality: res.quality,
      cost_basis_paise: res.costBasisPaise,
      source: 'harvest',
    });
    const inv = await deps.pool.query<{ total: number }>(
      `SELECT SUM(amount_paise)::bigint AS total FROM ledger_entries WHERE company_id = $1 AND account_code = 'inventory'`,
      [a.companyId],
    );
    expect(Number(inv.rows[0]!.total)).toBe(res.costBasisPaise);
    const plot = await deps.pool.query('SELECT status FROM crop_plots WHERE id = $1', [plotId]);
    expect(plot.rows[0]).toEqual({ status: 'harvested' });
    expectError(await run(deps, a, { type: 'harvest', plotId }), 'RULE_VIOLATION');
    await expectLedgerReconciles(deps);
  });

  it('mandi sale updates inventory, cash and ledger exactly once (replay-safe, slippage-guarded)', async () => {
    const totalKg = await inventoryKg(a.companyId, 'rice');
    const qty = Math.max(1, Math.floor(totalKg / 2));
    const quote = await getSaleQuote(deps, a.auth, marketId, { itemId: 'rice', quantityKg: qty });
    expect(quote.netPaise).toBe(quote.grossPaise - quote.feePaise - quote.transportPaise);
    const minNet = Math.floor(quote.netPaise / qty);

    expectError(
      await run(deps, a, {
        type: 'sell_to_market',
        marketId,
        itemId: 'rice',
        quantityKg: qty,
        minNetUnitPricePaise: minNet + 1_000,
      }),
      'PRICE_CHANGED',
    );
    expectError(
      await run(deps, a, {
        type: 'sell_to_market',
        marketId,
        itemId: 'rice',
        quantityKg: totalKg + 1,
        minNetUnitPricePaise: 0,
      }),
      'INSUFFICIENT_STOCK',
    );

    const cash = await cashOf(deps, a.companyId);
    const cmd = {
      type: 'sell_to_market' as const,
      marketId,
      itemId: 'rice' as const,
      quantityKg: qty,
      minNetUnitPricePaise: minNet,
    };
    const first = await run(deps, a, cmd, 'sale-key-0001');
    const sale = ok<{ netPaise: number; grossPaise: number; tradeId: string }>(first);
    expect(sale.netPaise).toBe(quote.netPaise);
    const replay = await run(deps, a, cmd, 'sale-key-0001');
    expect(replay.replayed).toBe(true);
    expect(await cashOf(deps, a.companyId)).toBe(cash + sale.netPaise);
    expect(await inventoryKg(a.companyId, 'rice')).toBe(totalKg - qty);
    const trades = await deps.pool.query(
      `SELECT COUNT(*)::int AS n FROM trades WHERE seller_company_id = $1 AND kind = 'market_sale'`,
      [a.companyId],
    );
    expect(trades.rows[0]).toEqual({ n: 1 });
    // Market price moved down by the sale's volume.
    const after = await getSaleQuote(deps, a.auth, marketId, { itemId: 'rice', quantityKg: 1 });
    expect(after.unitPricePaise).toBeLessThanOrEqual(quote.unitPricePaise);
    await expectLedgerReconciles(deps);
  });

  it('clears a plot only for its owner', async () => {
    const live = await deps.pool.query<{ id: string }>(
      `SELECT id FROM land_parcels WHERE owner_company_id = $1`,
      [a.companyId],
    );
    expect(live.rowCount).toBe(1);
    expectError(await run(deps, a, { type: 'clear_plot', plotId }), 'RULE_VIOLATION');
  });
});

describe('new-player expansion path', () => {
  it('a fresh company leases state land and plants at exactly computePlantingCost', async () => {
    const fresh = await newPlayer(deps, 'Fresh Start Agro');
    const parcel = await freeParcel(deps);
    const cash = await cashOf(deps, fresh.companyId);
    expect(parcel.rent).toBeLessThan(cash);
    ok(
      await run(deps, fresh, {
        type: 'lease_parcel',
        parcelId: parcel.id,
        expectedVersion: parcel.version,
        seasons: 2,
        expectedRentPaise: parcel.rent * 2,
      }),
    );
    const cost = await computePlantingCost(deps.pool, {
      companyId: fresh.companyId,
      regionId: REGION,
      parcelId: parcel.id,
      cropId: 'ragi',
      fertilize: true,
    });
    const res = ok<{ costPaise: number }>(
      await run(deps, fresh, {
        type: 'plant',
        parcelId: parcel.id,
        cropId: 'ragi',
        irrigate: false,
        fertilize: true,
        expectedCostPaise: cost.totalPaise,
      }),
    );
    expect(res.costPaise).toBe(cost.totalPaise);
    // Rice (125 days) would not fit a 1-season lease: guarded.
    const other = await freeParcel(deps, [parcel.id]);
    ok(
      await run(deps, fresh, {
        type: 'lease_parcel',
        parcelId: other.id,
        expectedVersion: other.version,
        seasons: 1,
        expectedRentPaise: other.rent,
      }),
    );
    const riceCost = await computePlantingCost(deps.pool, {
      companyId: fresh.companyId,
      regionId: REGION,
      parcelId: other.id,
      cropId: 'rice',
      fertilize: false,
    });
    expectError(
      await run(deps, fresh, {
        type: 'plant',
        parcelId: other.id,
        cropId: 'rice',
        irrigate: false,
        fertilize: false,
        expectedCostPaise: riceCost.totalPaise,
      }),
      'RULE_VIOLATION',
    );
    const loans = await getCompanyLoans(deps, fresh.auth, fresh.companyId);
    expect(loans.offer.maxPrincipalPaise).toBeGreaterThan(0);
    await expectLedgerReconciles(deps);
  });

  it('maps domain RangeErrors to VALIDATION_FAILED', async () => {
    expectError(
      await run(deps, a, {
        type: 'sell_to_market',
        marketId,
        itemId: 'rice',
        quantityKg: 1.5,
        minNetUnitPricePaise: 0,
      }),
      'VALIDATION_FAILED',
    );
  });
});
