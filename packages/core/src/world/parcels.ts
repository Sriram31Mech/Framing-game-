/**
 * Land parcel, lease and crop-plot row access shared by commands and queries.
 */
import type {
  CropId,
  CropPlotState,
  MapPoint,
  MarketDefinition,
  ParcelEnvironment,
} from '@bh/domain';
import type { Queryable } from '../db/pool';
import { notFound } from '../errors';

export type ParcelStatus = 'for_sale' | 'owned' | 'leased' | 'reserved';

export interface ParcelRow {
  id: string;
  regionId: string;
  areaHa: number;
  env: ParcelEnvironment;
  centroid: MapPoint;
  marketDistanceKm: number;
  nearestMarketId: string;
  basePricePaise: number;
  leaseRentPaise: number;
  isStarterPlot: boolean;
  ownerCompanyId: string | null;
  status: ParcelStatus;
  listPricePaise: number | null;
  version: number;
}

export interface ParcelDbRow {
  id: string;
  region_id: string;
  area_ha: number;
  env: ParcelEnvironment;
  centroid_x: number;
  centroid_y: number;
  market_distance_km: number;
  nearest_market_id: string;
  base_price_paise: number;
  lease_rent_paise: number;
  is_starter_plot: boolean;
  owner_company_id: string | null;
  status: ParcelStatus;
  list_price_paise: number | null;
  version: number;
}

/** Column list matching ParcelDbRow; `p` must alias land_parcels. */
export const PARCEL_COLUMNS = `p.id, p.region_id, p.area_ha, p.env, p.centroid_x, p.centroid_y,
  p.market_distance_km, p.nearest_market_id, p.base_price_paise, p.lease_rent_paise,
  p.is_starter_plot, p.owner_company_id, p.status, p.list_price_paise, p.version`;

export function mapParcel(r: ParcelDbRow): ParcelRow {
  return {
    id: r.id,
    regionId: r.region_id,
    areaHa: r.area_ha,
    env: r.env,
    centroid: { x: r.centroid_x, y: r.centroid_y },
    marketDistanceKm: r.market_distance_km,
    nearestMarketId: r.nearest_market_id,
    basePricePaise: r.base_price_paise,
    leaseRentPaise: r.lease_rent_paise,
    isStarterPlot: r.is_starter_plot,
    ownerCompanyId: r.owner_company_id,
    status: r.status,
    listPricePaise: r.list_price_paise,
    version: r.version,
  };
}

export async function getParcel(
  db: Queryable,
  regionId: string,
  parcelId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<ParcelRow> {
  const { rows } = await db.query<ParcelDbRow>(
    `SELECT ${PARCEL_COLUMNS} FROM land_parcels p WHERE p.id = $1 AND p.region_id = $2
     ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
    [parcelId, regionId],
  );
  const r = rows[0];
  if (!r) throw notFound('Parcel', parcelId);
  return mapParcel(r);
}

export interface LeaseRow {
  id: string;
  parcelId: string;
  lessorCompanyId: string | null;
  lesseeCompanyId: string;
  startDay: number;
  endDay: number;
  rentPaise: number;
}

export async function getActiveLease(db: Queryable, parcelId: string): Promise<LeaseRow | null> {
  const { rows } = await db.query<{
    id: string;
    parcel_id: string;
    lessor_company_id: string | null;
    lessee_company_id: string;
    start_day: number;
    end_day: number;
    rent_paise: number;
  }>(
    `SELECT id, parcel_id, lessor_company_id, lessee_company_id, start_day, end_day, rent_paise
     FROM land_leases WHERE parcel_id = $1 AND status = 'active'`,
    [parcelId],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: r.id,
    parcelId: r.parcel_id,
    lessorCompanyId: r.lessor_company_id,
    lesseeCompanyId: r.lessee_company_id,
    startDay: r.start_day,
    endDay: r.end_day,
    rentPaise: r.rent_paise,
  };
}

/** The company entitled to farm a parcel: the lessee during an active lease, else the owner. */
export function operatorOf(parcel: ParcelRow, lease: LeaseRow | null): string | null {
  if (lease) return lease.lesseeCompanyId;
  return parcel.ownerCompanyId;
}

export type PlotStatus = 'growing' | 'ready' | 'failed' | 'harvested' | 'cleared';
export const LIVE_PLOT_STATUSES: readonly PlotStatus[] = ['growing', 'ready', 'failed'];

export interface PlotRow {
  id: string;
  parcelId: string;
  companyId: string;
  cropId: CropId;
  status: PlotStatus;
  state: CropPlotState;
  sownDay: number;
  lastTickDay: number;
  costBasisPaise: number;
  harvestedKg: number | null;
  version: number;
}

interface PlotDbRow {
  id: string;
  parcel_id: string;
  company_id: string;
  crop_id: CropId;
  status: PlotStatus;
  state: CropPlotState;
  sown_day: number;
  last_tick_day: number;
  cost_basis_paise: number;
  harvested_kg: number | null;
  version: number;
}

export const PLOT_COLUMNS = `cp.id, cp.parcel_id, cp.company_id, cp.crop_id, cp.status, cp.state, cp.sown_day,
  cp.last_tick_day, cp.cost_basis_paise, cp.harvested_kg, cp.version`;

export function mapPlot(r: PlotDbRow): PlotRow {
  return {
    id: r.id,
    parcelId: r.parcel_id,
    companyId: r.company_id,
    cropId: r.crop_id,
    status: r.status,
    state: r.state,
    sownDay: r.sown_day,
    lastTickDay: r.last_tick_day,
    costBasisPaise: r.cost_basis_paise,
    harvestedKg: r.harvested_kg,
    version: r.version,
  };
}

export async function getLivePlotForParcel(
  db: Queryable,
  parcelId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<PlotRow | null> {
  const { rows } = await db.query<PlotDbRow>(
    `SELECT ${PLOT_COLUMNS} FROM crop_plots cp
     WHERE cp.parcel_id = $1 AND cp.status IN ('growing', 'ready', 'failed')
     ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
    [parcelId],
  );
  const r = rows[0];
  return r ? mapPlot(r) : null;
}

export async function getPlot(
  db: Queryable,
  plotId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<PlotRow> {
  const { rows } = await db.query<PlotDbRow>(
    `SELECT ${PLOT_COLUMNS} FROM crop_plots cp WHERE cp.id = $1 ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
    [plotId],
  );
  const r = rows[0];
  if (!r) throw notFound('Crop plot', plotId);
  return mapPlot(r);
}

export async function listPlots(
  db: Queryable,
  companyId: string,
  opts: { liveOnly?: boolean; limit?: number } = {},
): Promise<PlotRow[]> {
  const { rows } = await db.query<PlotDbRow>(
    `SELECT ${PLOT_COLUMNS} FROM crop_plots cp
     WHERE cp.company_id = $1 ${opts.liveOnly ? "AND cp.status IN ('growing', 'ready', 'failed')" : ''}
     ORDER BY (cp.status IN ('growing', 'ready', 'failed')) DESC, cp.created_at DESC
     LIMIT $2`,
    [companyId, opts.limit ?? 200],
  );
  return rows.map(mapPlot);
}

/** Straight-line distance × this factor approximates road distance to a market. */
export const ROAD_DISTANCE_FACTOR = 1.25;
/** Transport distance assumed when a company operates no land. */
export const DEFAULT_TRANSPORT_DISTANCE_KM = 5;

/**
 * Road distance (km) from the company's nearest owned or leased parcel to a market,
 * or DEFAULT_TRANSPORT_DISTANCE_KM if it operates no land.
 */
export async function companyDistanceToMarketKm(
  db: Queryable,
  companyId: string,
  market: MarketDefinition,
): Promise<number> {
  const { rows } = await db.query<{
    centroid_x: number;
    centroid_y: number;
    nearest_market_id: string;
    market_distance_km: number;
  }>(
    `SELECT p.centroid_x, p.centroid_y, p.nearest_market_id, p.market_distance_km
     FROM land_parcels p
     WHERE p.owner_company_id = $1
        OR p.id IN (SELECT parcel_id FROM land_leases WHERE lessee_company_id = $1 AND status = 'active')`,
    [companyId],
  );
  if (rows.length === 0) return DEFAULT_TRANSPORT_DISTANCE_KM;
  let best = Infinity;
  for (const r of rows) {
    const km =
      r.nearest_market_id === market.id
        ? r.market_distance_km
        : (Math.hypot(r.centroid_x - market.x, r.centroid_y - market.y) / 1000) *
          ROAD_DISTANCE_FACTOR;
    if (km < best) best = km;
  }
  return Math.round(best * 100) / 100;
}
