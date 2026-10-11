import {
  getCrop,
  nextMarketItemState,
  rngFor,
  type ItemId,
  type MarketDefinition,
  type MarketItemState,
} from '@bh/domain';
import { tickEvent } from '../effects';
import type { TickContext } from '../types';

interface StateRow {
  market_id: string;
  item_id: ItemId;
  price_paise_per_kg: number;
  supply_pressure_kg: number;
  demand_kg_per_day: number;
  definition: MarketDefinition;
  sold_kg: number;
}

/**
 * Step 5 — daily market update for every market × item: `nextMarketItemState` (mean reversion,
 * supply-pressure decay, seeded noise rngFor(regionSeed, 'market', marketId, itemId, day)),
 * then a snapshot of day D's closing price (after the day's sales moved it) and the volume sold
 * into that market during day D. The updated state is the opening price of day D+1.
 * Emits one public `market.price_updated` per market.
 */
export async function updateMarkets(ctx: TickContext): Promise<void> {
  const { rows } = await ctx.client.query<StateRow>(
    `SELECT s.market_id, s.item_id, s.price_paise_per_kg, s.supply_pressure_kg, s.demand_kg_per_day,
            m.definition,
            COALESCE((SELECT SUM(t.quantity_kg) FROM trades t
                      WHERE t.kind = 'market_sale' AND t.market_id = s.market_id
                        AND t.item_id = s.item_id AND t.game_day = $2), 0)::bigint AS sold_kg
     FROM market_item_states s JOIN markets m ON m.id = s.market_id
     WHERE m.region_id = $1
     ORDER BY s.market_id, s.item_id
     FOR UPDATE OF s`,
    [ctx.regionId, ctx.day],
  );
  if (rows.length === 0) return;

  const next: { row: StateRow; state: MarketItemState }[] = rows.map((row) => {
    const current: MarketItemState = {
      itemId: row.item_id,
      pricePaisePerKg: row.price_paise_per_kg,
      supplyPressureKg: row.supply_pressure_kg,
      demandKgPerDay: row.demand_kg_per_day,
    };
    const state = nextMarketItemState(current, {
      market: row.definition,
      crop: getCrop(row.item_id),
      day: ctx.day,
      random: rngFor(ctx.regionSeed, 'market', row.market_id, row.item_id, ctx.day),
    });
    return { row, state };
  });

  const marketIds = next.map((n) => n.row.market_id);
  const itemIds = next.map((n) => n.row.item_id);
  const prices = next.map((n) => n.state.pricePaisePerKg);
  await ctx.client.query(
    `UPDATE market_item_states s
     SET price_paise_per_kg = u.price, supply_pressure_kg = u.supply, demand_kg_per_day = u.demand,
         updated_day = $1, version = s.version + 1
     FROM unnest($2::text[], $3::text[], $4::bigint[], $5::bigint[], $6::bigint[])
       AS u(market_id, item_id, price, supply, demand)
     WHERE s.market_id = u.market_id AND s.item_id = u.item_id`,
    [
      ctx.day,
      marketIds,
      itemIds,
      prices,
      next.map((n) => Math.max(0, Math.round(n.state.supplyPressureKg))),
      next.map((n) => Math.max(0, Math.round(n.state.demandKgPerDay))),
    ],
  );
  await ctx.client.query(
    `INSERT INTO market_price_snapshots (market_id, item_id, game_day, price_paise_per_kg, volume_kg)
     SELECT u.market_id, u.item_id, $1, u.price, u.volume
     FROM unnest($2::text[], $3::text[], $4::bigint[], $5::bigint[]) AS u(market_id, item_id, price, volume)
     ON CONFLICT (market_id, item_id, game_day)
     DO UPDATE SET price_paise_per_kg = EXCLUDED.price_paise_per_kg, volume_kg = EXCLUDED.volume_kg`,
    [
      ctx.day,
      marketIds,
      itemIds,
      next.map((n) => n.row.price_paise_per_kg),
      next.map((n) => n.row.sold_kg),
    ],
  );
  ctx.stats.marketItemsUpdated += next.length;

  const byMarket = new Map<string, { itemId: ItemId; pricePaisePerKg: number }[]>();
  for (const n of next) {
    const list = byMarket.get(n.row.market_id) ?? [];
    list.push({ itemId: n.row.item_id, pricePaisePerKg: n.state.pricePaisePerKg });
    byMarket.set(n.row.market_id, list);
  }
  for (const [marketId, list] of byMarket) {
    await tickEvent(ctx, {
      type: 'market.price_updated',
      companyId: null,
      entityType: 'market',
      entityId: marketId,
      payload: { marketId, prices: list },
    });
  }
}
