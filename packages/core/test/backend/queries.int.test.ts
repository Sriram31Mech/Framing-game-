import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  AwaySummaryResponse,
  CompanyOverviewResponse,
  ContractsResponse,
  CropsResponse,
  InventoryResponse,
  LeaderboardResponse,
  LedgerResponse,
  ListingsResponse,
  LoansResponse,
  MachineryResponse,
  MarketsResponse,
  MeResponse,
  NotificationsResponse,
  ParcelDetailResponse,
  ParcelSuitabilityResponse,
  PlotsResponse,
  PriceHistoryResponse,
  RegionMapResponse,
  SaleQuoteResponse,
  WorldResponse,
} from '@bh/contracts';
import { getCrop, plantingCostPaise } from '@bh/domain';
import type { CoreDeps } from '../../src/commands/types';
import * as q from '../../src/queries/company';
import * as m from '../../src/queries/markets';
import * as w from '../../src/queries/world';
import { bootstrapWorld } from '../../src/world/bootstrap';
import { grantLot, newPlayer, ok, REGION, run, setupWorld, type Player } from './helpers';

let deps: CoreDeps;
let a: Player;
let b: Player;
let marketId: string;

beforeAll(async () => {
  deps = await setupWorld();
  await bootstrapWorld(
    { ...deps, config: { ...deps.config, aiCompanyCount: 2 } },
    { regionId: REGION },
  );
  a = await newPlayer(deps, 'Query Farms');
  b = await newPlayer(deps, 'Nosy Neighbours');
  const area = await deps.pool.query<{ area_ha: number }>(
    'SELECT area_ha FROM land_parcels WHERE id = $1',
    [a.starterParcelId],
  );
  ok(
    await run(deps, a, {
      type: 'plant',
      parcelId: a.starterParcelId!,
      cropId: 'ragi',
      irrigate: false,
      fertilize: false,
      expectedCostPaise: plantingCostPaise(getCrop('ragi'), area.rows[0]!.area_ha, {
        fertilize: false,
      }),
    }),
  );
  await grantLot(deps, a.companyId, { itemId: 'maize', quantityKg: 800, quality: 75 });
  marketId = (await deps.pool.query<{ id: string }>('SELECT id FROM markets ORDER BY id LIMIT 1'))
    .rows[0]!.id;
  // A few market snapshots for history / 7-day change.
  await deps.pool.query(
    `INSERT INTO market_price_snapshots (market_id, item_id, game_day, price_paise_per_kg, volume_kg)
     SELECT market_id, item_id, 0, price_paise_per_kg, 0 FROM market_item_states`,
  );
  ok(
    await run(deps, a, {
      type: 'create_listing',
      itemId: 'maize',
      quantityKg: 100,
      unitPricePaise: (await m.getMarkets(deps, a.auth)).markets[0]!.prices.find(
        (p) => p.itemId === 'maize',
      )!.pricePaisePerKg,
      durationDays: 7,
    }),
  );
});
afterAll(async () => {
  await deps.pool.end();
});

describe('query DTOs parse with the contract schemas', () => {
  it('world-level queries', async () => {
    MeResponse.parse(await w.getMe(deps, a.auth));
    const world = WorldResponse.parse(await w.getWorld(deps, a.auth));
    expect(world.date.label).toMatch(/Year 1/);
    const map = RegionMapResponse.parse(await w.getRegionMap(deps, REGION));
    const starter = map.parcels.find((p) => p.id === a.starterParcelId)!;
    expect(starter.ownerName).toBe('Query Farms');
    expect(starter.crop?.cropId).toBe('ragi');
    expect(starter.polygon.length).toBeGreaterThanOrEqual(3);
    CropsResponse.parse(await w.getCrops(deps, a.auth));
    const suit = ParcelSuitabilityResponse.parse(
      await w.getParcelSuitability(deps, a.auth, a.starterParcelId!),
    );
    expect(suit.results).toHaveLength(6);
  });

  it('parcel detail: actions with reasons; private plot data only for the operator', async () => {
    const mine = ParcelDetailResponse.parse(
      await w.getParcelDetail(deps, a.auth, a.starterParcelId!),
    );
    expect(mine.plot?.cropId).toBe('ragi');
    expect(mine.actions.canPlant).toBe(false);
    expect(mine.actions.reasons.canPlant).toBeDefined();
    const theirs = ParcelDetailResponse.parse(
      await w.getParcelDetail(deps, b.auth, a.starterParcelId!),
    );
    expect(theirs.plot).toBeNull();
    expect(theirs.parcel.crop?.cropId).toBe('ragi');
    expect(theirs.actions.canPurchase).toBe(false);
  });

  it('company queries', async () => {
    const overview = CompanyOverviewResponse.parse(
      await q.getCompanyOverview(deps, a.auth, a.companyId),
    );
    expect(overview.counts.plotsGrowing).toBe(1);
    expect(overview.counts.openListings).toBe(1);
    expect(overview.profitAndLoss.expensesPaise).toBeGreaterThan(0);
    expect(overview.cashSeries.at(-1)?.cashPaise).toBe(overview.company.cashPaise);
    expect(overview.upcoming.some((u) => u.kind === 'land_tax')).toBe(true);
    InventoryResponse.parse(await q.getCompanyInventory(deps, a.auth, a.companyId));
    const plots = PlotsResponse.parse(await q.getCompanyPlots(deps, a.auth, a.companyId));
    expect(plots.plots[0]!.readyDay).toBeGreaterThan(0);
    LoansResponse.parse(await q.getCompanyLoans(deps, a.auth, a.companyId));
    MachineryResponse.parse(await q.getCompanyMachinery(deps, a.auth, a.companyId));
    const notes = NotificationsResponse.parse(
      await q.getCompanyNotifications(deps, a.auth, a.companyId, { unreadOnly: false, limit: 50 }),
    );
    expect(notes.unreadCount).toBeGreaterThan(0);
    const away = AwaySummaryResponse.parse(
      await q.getAwaySummary(deps, a.auth, a.companyId, { since: 0 }),
    );
    expect(away.toDay).toBe(0);
  });

  it('ledger pagination by entry id (desc) with a cursor', async () => {
    const first = LedgerResponse.parse(
      await q.getCompanyLedger(deps, a.auth, a.companyId, { limit: 2 }),
    );
    expect(first.entries).toHaveLength(2);
    expect(first.nextCursor).not.toBeNull();
    const second = LedgerResponse.parse(
      await q.getCompanyLedger(deps, a.auth, a.companyId, { limit: 2, cursor: first.nextCursor! }),
    );
    expect(Number(second.entries[0]!.id)).toBeLessThan(Number(first.entries[1]!.id));
    const cashOnly = await q.getCompanyLedger(deps, a.auth, a.companyId, {
      limit: 50,
      accountCode: 'cash',
    });
    expect(cashOnly.entries.every((e) => e.accountCode === 'cash')).toBe(true);
    await expect(
      q.getCompanyLedger(deps, a.auth, a.companyId, { limit: 2, cursor: 'abc' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });

  it('market queries', async () => {
    const markets = MarketsResponse.parse(await m.getMarkets(deps, a.auth));
    expect(markets.markets.length).toBeGreaterThan(0);
    const history = PriceHistoryResponse.parse(
      await m.getPriceHistory(deps, a.auth, marketId, { days: 30 }),
    );
    expect(history.series.length).toBe(6);
    SaleQuoteResponse.parse(
      await m.getSaleQuote(deps, a.auth, marketId, { itemId: 'maize', quantityKg: 100 }),
    );
    await expect(
      m.getSaleQuote(deps, b.auth, marketId, { itemId: 'maize', quantityKg: 100 }),
    ).rejects.toMatchObject({ code: 'INSUFFICIENT_STOCK' });
    const listings = ListingsResponse.parse(
      await m.getListings(deps, b.auth, { mine: false, status: 'open', limit: 50 }),
    );
    expect(listings.listings[0]?.sellerName).toBe('Query Farms');
    ContractsResponse.parse(await m.getContracts(deps, a.auth, { scope: 'mine', limit: 50 }));
    const board = LeaderboardResponse.parse(await m.getLeaderboard(deps, a.auth));
    expect(board.entries.length).toBe(4);
    expect(board.entries[0]!.rank).toBe(1);
  });
});

describe('authorization', () => {
  it("company B cannot read A's private data", async () => {
    const calls = [
      () => q.getCompanyOverview(deps, b.auth, a.companyId),
      () => q.getCompanyLedger(deps, b.auth, a.companyId, { limit: 10 }),
      () => q.getCompanyInventory(deps, b.auth, a.companyId),
      () => q.getCompanyPlots(deps, b.auth, a.companyId),
      () => q.getCompanyLoans(deps, b.auth, a.companyId),
      () => q.getCompanyMachinery(deps, b.auth, a.companyId),
      () => q.getCompanyNotifications(deps, b.auth, a.companyId, { unreadOnly: false, limit: 10 }),
      () => q.getAwaySummary(deps, b.auth, a.companyId),
    ];
    for (const call of calls) await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    const noCompany = { ...b.auth, companyId: null };
    await expect(
      q.getCompanyLedger(deps, noCompany, a.companyId, { limit: 10 }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
    await expect(
      m.getListings(deps, noCompany, { mine: true, status: 'open', limit: 10 }),
    ).rejects.toMatchObject({ code: 'COMPANY_REQUIRED' });
  });
});
