/**
 * Read helpers for static-ish world data: regions, markets, market item states.
 * Shared by the command layer and queries (backend-owned; see docs/IMPLEMENTATION.md §6).
 */
import type {
  GeneratedDistrict,
  GeneratedFeature,
  GeneratedSegment,
  GeneratedRoad,
  ItemId,
  MapPoint,
  MarketDefinition,
  MarketItemState,
  RegionClimate,
} from '@bh/domain';
import type { Queryable } from '../db/pool';
import { notFound } from '../errors';

export interface RegionRow {
  id: string;
  name: string;
  seed: number;
  halfSizeM: number;
  originLat: number;
  originLon: number;
  climate: RegionClimate;
  mapFeatures: RegionMapFeatures;
  maxHumanCompanies: number;
}

/** Static render data persisted in regions.map_features. */
export interface RegionMapFeatures {
  roads: GeneratedRoad[];
  river: { points: MapPoint[]; widthM: number };
  features: GeneratedFeature[];
  districts: GeneratedDistrict[];
  segments: GeneratedSegment[];
}

export async function getRegion(db: Queryable, regionId: string): Promise<RegionRow> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    seed: number;
    half_size_m: number;
    origin_lat: number;
    origin_lon: number;
    climate: RegionClimate;
    map_features: RegionMapFeatures;
    max_human_companies: number;
  }>(
    `SELECT id, name, seed, half_size_m, origin_lat, origin_lon, climate, map_features, max_human_companies
     FROM regions WHERE id = $1`,
    [regionId],
  );
  const r = rows[0];
  if (!r) throw notFound('Region', regionId);
  return {
    id: r.id,
    name: r.name,
    seed: r.seed,
    halfSizeM: r.half_size_m,
    originLat: r.origin_lat,
    originLon: r.origin_lon,
    climate: r.climate,
    mapFeatures: r.map_features,
    maxHumanCompanies: r.max_human_companies,
  };
}

export async function listMarkets(db: Queryable, regionId: string): Promise<MarketDefinition[]> {
  const { rows } = await db.query<{ definition: MarketDefinition }>(
    'SELECT definition FROM markets WHERE region_id = $1 ORDER BY id',
    [regionId],
  );
  return rows.map((r) => r.definition);
}

export async function getMarket(
  db: Queryable,
  regionId: string,
  marketId: string,
): Promise<MarketDefinition> {
  const { rows } = await db.query<{ definition: MarketDefinition }>(
    'SELECT definition FROM markets WHERE id = $1 AND region_id = $2',
    [marketId, regionId],
  );
  const r = rows[0];
  if (!r) throw notFound('Market', marketId);
  return r.definition;
}

export interface MarketItemStateRow extends MarketItemState {
  marketId: string;
  updatedDay: number;
  version: number;
}

interface MarketItemStateDbRow {
  market_id: string;
  item_id: ItemId;
  price_paise_per_kg: number;
  supply_pressure_kg: number;
  demand_kg_per_day: number;
  updated_day: number;
  version: number;
}

const mapState = (r: MarketItemStateDbRow): MarketItemStateRow => ({
  marketId: r.market_id,
  itemId: r.item_id,
  pricePaisePerKg: r.price_paise_per_kg,
  supplyPressureKg: r.supply_pressure_kg,
  demandKgPerDay: r.demand_kg_per_day,
  updatedDay: r.updated_day,
  version: r.version,
});

/**
 * The statewide state of an item. Tamil Nadu has one price per crop: every mandi's row for the
 * item holds the same state (see `writeStatewideItemState`). `forUpdate` locks all of those rows
 * in market_id order (the tick's lock order), so sales at any mandi are serialised.
 */
export async function getStatewideItemState(
  db: Queryable,
  regionId: string,
  itemId: ItemId,
  opts: { forUpdate?: boolean } = {},
): Promise<MarketItemStateRow> {
  const { rows } = await db.query<MarketItemStateDbRow>(
    `SELECT s.market_id, s.item_id, s.price_paise_per_kg, s.supply_pressure_kg, s.demand_kg_per_day,
            s.updated_day, s.version
     FROM market_item_states s JOIN markets m ON m.id = s.market_id
     WHERE m.region_id = $1 AND s.item_id = $2
     ORDER BY s.market_id ${opts.forUpdate ? 'FOR UPDATE OF s' : ''}`,
    [regionId, itemId],
  );
  const r = rows[0];
  if (!r) throw notFound('Market item', `${regionId}/${itemId}`);
  return mapState(r);
}

/** Write the statewide state of an item to every mandi's row (callers hold the row locks). */
export async function writeStatewideItemState(
  db: Queryable,
  regionId: string,
  state: MarketItemState,
): Promise<void> {
  await db.query(
    `UPDATE market_item_states s
     SET price_paise_per_kg = $3, supply_pressure_kg = $4, demand_kg_per_day = $5,
         version = s.version + 1
     FROM markets m
     WHERE m.id = s.market_id AND m.region_id = $1 AND s.item_id = $2`,
    [
      regionId,
      state.itemId,
      Math.max(1, Math.round(state.pricePaisePerKg)),
      Math.max(0, Math.round(state.supplyPressureKg)),
      Math.max(0, Math.round(state.demandKgPerDay)),
    ],
  );
}

export async function listMarketItemStates(
  db: Queryable,
  regionId: string,
): Promise<MarketItemStateRow[]> {
  const { rows } = await db.query<MarketItemStateDbRow>(
    `SELECT s.market_id, s.item_id, s.price_paise_per_kg, s.supply_pressure_kg, s.demand_kg_per_day,
            s.updated_day, s.version
     FROM market_item_states s JOIN markets m ON m.id = s.market_id
     WHERE m.region_id = $1 ORDER BY s.market_id, s.item_id`,
    [regionId],
  );
  return rows.map(mapState);
}

/** Current statewide price of an item: the reference for the P2P anti-manipulation band. */
export async function statewidePricePaise(
  db: Queryable,
  regionId: string,
  itemId: ItemId,
): Promise<number> {
  return Number((await getStatewideItemState(db, regionId, itemId)).pricePaisePerKg);
}

/**
 * Conservative (lowest) current price per item across the region's markets, used to value
 * inventory on balance sheets.
 */
export async function conservativePrices(
  db: Queryable,
  regionId: string,
): Promise<Map<ItemId, number>> {
  const { rows } = await db.query<{ item_id: ItemId; price: number }>(
    `SELECT s.item_id, MIN(s.price_paise_per_kg)::bigint AS price
     FROM market_item_states s JOIN markets m ON m.id = s.market_id
     WHERE m.region_id = $1 GROUP BY s.item_id`,
    [regionId],
  );
  return new Map(rows.map((r) => [r.item_id, Number(r.price)]));
}
