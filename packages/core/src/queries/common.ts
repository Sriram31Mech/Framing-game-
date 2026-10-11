/**
 * Shared helpers for queries: authorization and DTO mappers.
 */
import type { CropPlotDto, ParcelSummaryDto } from '@bh/contracts';
import {
  cropDurationDays,
  dailyIrrigationCostPaise,
  estimateHarvest,
  getCrop,
  growthProgress,
  PEST_CONTROL_PROTECTION_DAYS,
  type CropId,
  type CropPlotState,
  type ParcelEnvironment,
} from '@bh/domain';
import type { AuthContext } from '../auth/sessions';
import { DomainError, forbidden } from '../errors';
import { elapsedGrowthDays } from '../commands/farming';
import type { PlotRow } from '../world/parcels';

/**
 * Company-scoped data is visible only to members of that company. The membership comes from the
 * session (never from the request), so other companies' private data cannot leak.
 */
export function assertCompanyAccess(auth: AuthContext, companyId: string): void {
  if (auth.companyId === null || auth.companyId !== companyId) {
    throw forbidden('You can only view your own company');
  }
}

export function requireCompany(auth: AuthContext): string {
  if (!auth.companyId) throw new DomainError('COMPANY_REQUIRED', 'Create a company first');
  return auth.companyId;
}

const clamp01 = (v: number) => (Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0);
const nonNegInt = (v: number) => (Number.isFinite(v) ? Math.max(0, Math.round(v)) : 0);

/** Harvest estimate for a plot as if harvested at maturity under its current condition. */
function projectedHarvest(state: CropPlotState, status: PlotRow['status']) {
  const crop = getCrop(state.cropId);
  if (status === 'ready') return estimateHarvest(state, crop);
  if (status === 'growing') {
    return estimateHarvest({ ...state, status: 'ready', daysSinceReady: 0 }, crop);
  }
  return { quantityKg: 0, quality: 0 };
}

export function toPlotDto(
  plot: PlotRow,
  day: number,
  env: ParcelEnvironment,
  irrigationCostMultiplier: number,
): CropPlotDto {
  const crop = getCrop(plot.cropId);
  const s = plot.state;
  const stage =
    plot.status === 'ready'
      ? 'ready'
      : plot.status === 'growing'
        ? (crop.stages[Math.min(s.stageIndex, crop.stages.length - 1)]?.id ?? 'germination')
        : plot.status;
  const estimate = projectedHarvest(s, plot.status);
  const live = plot.status === 'growing' || plot.status === 'ready';
  let readyDay: number | null = null;
  if (plot.status === 'growing') {
    readyDay = day + Math.max(0, cropDurationDays(crop) - elapsedGrowthDays(s, crop));
  } else if (plot.status === 'ready') {
    readyDay = Math.max(0, day - (s.daysSinceReady ?? 0));
  }
  return {
    id: plot.id,
    parcelId: plot.parcelId,
    companyId: plot.companyId,
    cropId: plot.cropId,
    status: plot.status,
    sownDay: plot.sownDay,
    stage,
    progress: plot.status === 'harvested' ? 1 : clamp01(growthProgress(s, crop)),
    health: clamp01(s.health),
    waterStress: clamp01(s.waterStress),
    pestPressure: clamp01(s.pestPressure),
    irrigated: s.irrigated,
    fertilized: s.fertilized,
    pestProtectedUntilDay:
      s.pestControlDay === null ? null : s.pestControlDay + PEST_CONTROL_PROTECTION_DAYS,
    expectedHarvestKg:
      plot.status === 'harvested' ? (plot.harvestedKg ?? 0) : nonNegInt(estimate.quantityKg),
    expectedQuality: nonNegInt(estimate.quality),
    readyDay,
    harvestDeadlineDay: live && readyDay !== null ? readyDay + crop.harvestWindowDays : null,
    costBasisPaise: plot.costBasisPaise,
    dailyIrrigationCostPaise:
      plot.status === 'growing' && s.irrigated
        ? dailyIrrigationCostPaise(s, crop, env, irrigationCostMultiplier)
        : 0,
    version: plot.version,
  };
}

export interface ParcelSummaryDbRow {
  id: string;
  geojson: { type: string; coordinates: number[][][] };
  centroid_x: number;
  centroid_y: number;
  area_ha: number;
  status: ParcelSummaryDto['status'];
  owner_company_id: string | null;
  owner_name: string | null;
  lessee_company_id: string | null;
  list_price_paise: number | null;
  is_starter_plot: boolean;
  env: ParcelEnvironment;
  version: number;
  plot_crop_id: CropId | null;
  plot_status: 'growing' | 'ready' | 'failed' | null;
  plot_state: CropPlotState | null;
}

/** SELECT list + joins for ParcelSummaryDbRow; append WHERE on `p`. */
export const PARCEL_SUMMARY_SQL = `
  SELECT p.id, ST_AsGeoJSON(p.geom)::json AS geojson, p.centroid_x, p.centroid_y, p.area_ha, p.status,
         p.owner_company_id, oc.name AS owner_name, l.lessee_company_id, p.list_price_paise,
         p.is_starter_plot, p.env, p.version,
         cp.crop_id AS plot_crop_id, cp.status AS plot_status, cp.state AS plot_state
  FROM land_parcels p
  LEFT JOIN companies oc ON oc.id = p.owner_company_id
  LEFT JOIN land_leases l ON l.parcel_id = p.id AND l.status = 'active'
  LEFT JOIN crop_plots cp ON cp.parcel_id = p.id AND cp.status IN ('growing', 'ready', 'failed')`;

export function toParcelSummary(r: ParcelSummaryDbRow): ParcelSummaryDto {
  const ring = r.geojson.coordinates[0] ?? [];
  // GeoJSON rings repeat the first point at the end; the contract wants an open ring.
  const open = ring.length > 1 ? ring.slice(0, -1) : ring;
  let crop: ParcelSummaryDto['crop'] = null;
  if (r.plot_crop_id && r.plot_status && r.plot_state) {
    const def = getCrop(r.plot_crop_id);
    crop = {
      cropId: r.plot_crop_id,
      status: r.plot_status,
      progress: r.plot_status === 'ready' ? 1 : clamp01(growthProgress(r.plot_state, def)),
      health: clamp01(r.plot_state.health),
    };
  }
  return {
    id: r.id,
    polygon: open.map(([x, y]) => ({ x: x ?? 0, y: y ?? 0 })),
    centroid: { x: r.centroid_x, y: r.centroid_y },
    areaHa: r.area_ha,
    status: r.status,
    ownerCompanyId: r.owner_company_id,
    ownerName: r.owner_name,
    operatorCompanyId: r.lessee_company_id ?? r.owner_company_id,
    listPricePaise: r.status === 'for_sale' ? r.list_price_paise : null,
    isStarterPlot: r.is_starter_plot,
    soilTexture: r.env.soilTexture,
    waterAccess: r.env.waterAccess,
    elevationM: r.env.elevationM,
    version: r.version,
    crop,
  };
}

export function isoDate(d: Date): string {
  return d.toISOString();
}
