/**
 * World bootstrap: creates the region, its parcels (PostGIS geometry), markets, market item
 * states, world clock and AI companies. Idempotent and convergent: re-running never duplicates
 * anything and only tops up missing AI companies.
 */
import {
  CROP_IDS,
  DEFAULT_REGION_SEED,
  getCrop,
  initialMarketItemState,
  statewideDemandScale,
  generateRegion,
  RULESET_VERSION,
  type AiPersonality,
  type GeneratedParcel,
  type GeneratedRegion,
} from '@bh/domain';
import type { CoreDeps } from '../commands/types';
import type { DbClient } from '../db/pool';
import { withTransaction } from '../db/tx';
import { createCompanyInTx } from '../companies/create';
import type { RegionMapFeatures } from './region';

/** Advisory lock key serialising bootstrap runs (server boot, seed CLI, tests). */
const BOOTSTRAP_LOCK_KEY = 72_210_002;

const AI_PERSONALITY_CYCLE: AiPersonality[] = ['cautious', 'expansionist', 'trader'];
const AI_COMPANY_NAMES = [
  'Kaveri Delta Agro',
  'Kongu Green Farms',
  'Chola Traders',
  'Pandya Harvest Co',
  'Nilgiri Produce',
  'Thanjai Agri Holdings',
  'Vaigai Valley Foods',
  'Palar Growers',
  'Thamirabarani Estates',
  'Coromandel Agro Collective',
];

export interface BootstrapOptions {
  regionId?: string;
  seed?: number;
}

export interface BootstrapResult {
  created: boolean;
  regionId: string;
  aiCompaniesCreated: number;
}

/** WKT for a parcel ring; WKT rings must be closed (first point repeated at the end). */
export function polygonWkt(points: { x: number; y: number }[]): string {
  if (points.length < 3) throw new Error('polygon needs at least 3 points');
  const ring = [...points, points[0]!].map((p) => `${p.x} ${p.y}`).join(', ');
  return `POLYGON((${ring}))`;
}

export async function bootstrapWorld(
  deps: CoreDeps,
  opts: BootstrapOptions = {},
): Promise<BootstrapResult> {
  const regionId = opts.regionId ?? deps.config.regionId;
  const seed = opts.seed ?? DEFAULT_REGION_SEED;

  return withTransaction(deps.pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1)', [BOOTSTRAP_LOCK_KEY]);
    await client.query(
      `INSERT INTO ruleset_versions (version, description) VALUES ($1, $2)
       ON CONFLICT (version) DO NOTHING`,
      [RULESET_VERSION, `Bharat Harvest ruleset ${RULESET_VERSION}`],
    );

    const exists = await client.query('SELECT 1 FROM regions WHERE id = $1', [regionId]);
    let created = false;
    if ((exists.rowCount ?? 0) === 0) {
      const region = generateRegion(seed, regionId);
      await insertRegion(client, region, deps.config.realSecondsPerGameDay);
      created = true;
      deps.logger.info(
        { regionId, parcels: region.parcels.length, markets: region.markets.length },
        'world bootstrapped',
      );
    }

    const aiCompaniesCreated = await ensureAiCompanies(
      client,
      regionId,
      deps.config.aiCompanyCount,
    );
    return { created, regionId, aiCompaniesCreated };
  });
}

async function insertRegion(
  client: DbClient,
  region: GeneratedRegion,
  realSecondsPerGameDay: number,
): Promise<void> {
  const mapFeatures: RegionMapFeatures = {
    roads: region.roads,
    river: region.river,
    features: region.features,
    districts: region.districts ?? [],
    segments: region.segments ?? [],
  };
  await client.query(
    `INSERT INTO regions (id, name, seed, half_size_m, origin_lat, origin_lon, climate, map_features)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      region.id,
      region.name,
      region.seed,
      region.halfSizeM,
      region.originLat,
      region.originLon,
      JSON.stringify(region.climate),
      JSON.stringify(mapFeatures),
    ],
  );

  // One statewide price per item; every mandi row of an item holds the same state.
  const statewide = CROP_IDS.map((itemId) =>
    initialMarketItemState(getCrop(itemId), 0, statewideDemandScale(region.markets)),
  );
  for (const market of region.markets) {
    await client.query(
      'INSERT INTO markets (id, region_id, name, definition) VALUES ($1, $2, $3, $4)',
      [market.id, region.id, market.name, JSON.stringify(market)],
    );
    for (const state of statewide) {
      const itemId = state.itemId;
      await client.query(
        `INSERT INTO market_item_states (market_id, item_id, price_paise_per_kg, supply_pressure_kg, demand_kg_per_day, updated_day)
         VALUES ($1, $2, $3, $4, $5, 0)`,
        [
          market.id,
          itemId,
          state.pricePaisePerKg,
          Math.max(0, Math.round(state.supplyPressureKg)),
          Math.max(0, Math.round(state.demandKgPerDay)),
        ],
      );
    }
  }

  for (const parcel of region.parcels) await insertParcel(client, region.id, parcel);

  await client.query(
    `INSERT INTO world_clock (region_id, game_day, epoch_at, real_seconds_per_game_day, ruleset_version)
     VALUES ($1, 0, now(), $2, $3)`,
    [region.id, realSecondsPerGameDay, RULESET_VERSION],
  );
}

async function insertParcel(
  client: DbClient,
  regionId: string,
  parcel: GeneratedParcel,
): Promise<void> {
  const status = parcel.isStarterPlot ? 'reserved' : 'for_sale';
  await client.query(
    `INSERT INTO land_parcels (id, region_id, geom, centroid_x, centroid_y, area_ha, env,
       market_distance_km, nearest_market_id, base_price_paise, lease_rent_paise, is_starter_plot,
       status, list_price_paise)
     VALUES ($1, $2, ST_GeomFromText($3, 0), $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
    [
      parcel.id,
      regionId,
      polygonWkt(parcel.polygon),
      parcel.centroid.x,
      parcel.centroid.y,
      parcel.env.areaHa,
      JSON.stringify(parcel.env),
      parcel.marketDistanceKm,
      parcel.nearestMarketId,
      parcel.basePricePaise,
      parcel.leaseRentPaisePerSeason,
      parcel.isStarterPlot,
      status,
      status === 'for_sale' ? parcel.basePricePaise : null,
    ],
  );
}

/** Create AI companies (and their 'ai' accounts) until the region has `count` of them. */
async function ensureAiCompanies(
  client: DbClient,
  regionId: string,
  count: number,
): Promise<number> {
  const { rows } = await client.query<{ name: string }>(
    `SELECT name FROM companies WHERE region_id = $1 AND kind = 'ai'`,
    [regionId],
  );
  const existingNames = new Set(rows.map((r) => r.name.toLowerCase()));
  let have = rows.length;
  let created = 0;
  for (let i = 0; i < AI_COMPANY_NAMES.length && have < count; i++) {
    const name = AI_COMPANY_NAMES[i]!;
    if (existingNames.has(name.toLowerCase())) continue;
    const username = `ai_${regionId}_${i + 1}`;
    const account = await client.query<{ id: string }>(
      `INSERT INTO accounts (username, display_name, kind) VALUES ($1, $2, 'ai')
       ON CONFLICT ((lower(username))) DO UPDATE SET display_name = EXCLUDED.display_name
       RETURNING id`,
      [username, name],
    );
    await createCompanyInTx(client, {
      accountId: account.rows[0]!.id,
      name,
      kind: 'ai',
      aiPersonality: AI_PERSONALITY_CYCLE[i % AI_PERSONALITY_CYCLE.length]!,
      regionId,
    });
    have++;
    created++;
  }
  return created;
}
