/**
 * World, map, parcel and crop queries.
 */
import type {
  CropsResponse,
  MeResponse,
  ParcelDetailResponse,
  ParcelSuitabilityResponse,
  RegionMapResponse,
  DistrictDto,
  SegmentDetailResponse,
  SegmentSummaryDto,
  WorldResponse,
} from '@bh/contracts';
import {
  canIrrigate,
  computeAllSuitability,
  CROP_IDS,
  cropDurationDays,
  getCrop,
  landTaxPaise,
  toGameDate,
  climateForEnv,
  districtClimate,
  TN_DISTRICTS,
  ZONE_PROFILES,
  type GeneratedDistrict,
  type GeneratedSegment,
} from '@bh/domain';
import { getAccount } from '../auth/accounts';
import type { AuthContext } from '../auth/sessions';
import type { CoreDeps } from '../commands/types';
import { askingPricePaise } from '../commands/land';
import { findCompany, machineryEffectsFor } from '../companies/company';
import { notFound } from '../errors';
import { getWorldClock, wallTimeOfDay } from '../world/clock';
import { getActiveLease, getLivePlotForParcel, getParcel, operatorOf } from '../world/parcels';
import { getRegion, listMarkets } from '../world/region';
import { PARCEL_SUMMARY_SQL, toParcelSummary, toPlotDto, type ParcelSummaryDbRow } from './common';

export async function getMe(deps: CoreDeps, auth: AuthContext): Promise<MeResponse> {
  const account = await getAccount(deps.pool, auth.accountId);
  const company = auth.companyId ? await findCompany(deps.pool, auth.companyId) : null;
  return {
    account,
    company: company
      ? {
          id: company.id,
          name: company.name,
          kind: company.kind,
          status: company.status,
          cashPaise: company.cashPaise,
          aiPersonality: company.aiPersonality,
        }
      : null,
    regionId: auth.regionId,
  };
}

export async function getWorld(deps: CoreDeps, auth: AuthContext): Promise<WorldResponse> {
  const [clock, region] = await Promise.all([
    getWorldClock(deps.pool, auth.regionId),
    getRegion(deps.pool, auth.regionId),
  ]);
  const weather = await deps.pool.query<{ rain_mm: number; temp_c: number; event: string }>(
    `SELECT rain_mm, temp_c, event FROM weather_records
     WHERE region_id = $1 AND game_day <= $2 ORDER BY game_day DESC LIMIT 1`,
    [auth.regionId, clock.gameDay],
  );
  const w = weather.rows[0];
  return {
    regionId: region.id,
    regionName: region.name,
    gameDay: clock.gameDay,
    date: toGameDate(clock.gameDay),
    realSecondsPerGameDay: clock.realSecondsPerGameDay,
    // Day D ends (and D+1 begins) at epoch + (D+1) × secondsPerDay.
    nextTickAt: wallTimeOfDay(clock, clock.gameDay + 1).toISOString(),
    rulesetVersion: clock.rulesetVersion,
    paused: clock.paused,
    weather: w ? { rainMm: w.rain_mm, tempC: w.temp_c, event: w.event } : null,
  };
}

interface SegmentStatsRow {
  segment_id: string;
  holdings: number;
  for_sale: number;
  min_price: number | null;
  mine: number;
}

async function segmentStats(
  deps: CoreDeps,
  regionId: string,
  companyId: string | null,
  segmentId?: string,
): Promise<Map<string, SegmentStatsRow>> {
  const { rows } = await deps.pool.query<SegmentStatsRow>(
    `SELECT p.env->>'segmentId' AS segment_id,
            COUNT(*)::int AS holdings,
            COUNT(*) FILTER (WHERE p.status = 'for_sale')::int AS for_sale,
            MIN(p.list_price_paise) FILTER (WHERE p.status = 'for_sale') AS min_price,
            COUNT(*) FILTER (WHERE $2::uuid IS NOT NULL
                             AND (p.owner_company_id = $2 OR l.lessee_company_id = $2))::int AS mine
     FROM land_parcels p
     LEFT JOIN land_leases l ON l.parcel_id = p.id AND l.status = 'active'
     WHERE p.region_id = $1 AND ($3::text IS NULL OR p.env->>'segmentId' = $3)
     GROUP BY 1`,
    [regionId, companyId, segmentId ?? null],
  );
  return new Map(rows.map((r) => [r.segment_id, r]));
}

function toSegmentSummary(
  s: GeneratedSegment,
  stats: SegmentStatsRow | undefined,
): SegmentSummaryDto {
  return {
    id: s.id,
    name: s.name,
    districtId: s.districtId,
    polygon: s.polygon,
    centroid: s.centroid,
    areaHa: s.areaHa,
    farmlandHa: s.farmlandHa,
    holdings: stats?.holdings ?? 0,
    holdingsForSale: stats?.for_sale ?? 0,
    minPricePaise: stats?.min_price ?? null,
    mine: stats?.mine ?? 0,
  };
}

function toDistrictDto(d: GeneratedDistrict): DistrictDto {
  const profile = TN_DISTRICTS[d.id];
  return {
    id: d.id,
    name: d.name,
    tamilName: d.tamilName,
    zone: d.zone,
    polygons: d.polygons,
    centroid: d.centroid,
    annualRainMm: profile?.annualRainMm ?? 0,
    knownFor: profile?.knownFor ?? [],
  };
}

/**
 * The real Tamil Nadu map: district outlines, segments with holding stats, and only the
 * holdings someone operates (state land is browsed per segment via getSegmentDetail).
 */
export async function getRegionMap(
  deps: CoreDeps,
  regionId: string,
  companyId: string | null = null,
): Promise<RegionMapResponse> {
  const region = await getRegion(deps.pool, regionId);
  const [parcels, markets, stats] = await Promise.all([
    deps.pool.query<ParcelSummaryDbRow>(
      `${PARCEL_SUMMARY_SQL}
       WHERE p.region_id = $1 AND (p.owner_company_id IS NOT NULL OR l.lessee_company_id IS NOT NULL)
       ORDER BY p.id`,
      [regionId],
    ),
    listMarkets(deps.pool, regionId),
    segmentStats(deps, regionId, companyId),
  ]);
  const features = region.mapFeatures;
  return {
    region: { id: region.id, name: region.name, seed: region.seed, halfSizeM: region.halfSizeM },
    districts: (features.districts ?? []).map(toDistrictDto),
    segments: (features.segments ?? []).map((s) => toSegmentSummary(s, stats.get(s.id))),
    parcels: parcels.rows.map(toParcelSummary),
    roads: features.roads,
    river: features.river,
    features: features.features,
    markets: markets.map((m) => ({
      id: m.id,
      name: m.name,
      x: m.x,
      y: m.y,
      feeBps: m.feeBps,
      demandScale: m.demandScale,
    })),
  };
}

/** One segment: its district's climate and soils, and every holding in it. */
export async function getSegmentDetail(
  deps: CoreDeps,
  auth: AuthContext,
  segmentId: string,
): Promise<SegmentDetailResponse> {
  const region = await getRegion(deps.pool, auth.regionId);
  const segment = (region.mapFeatures.segments ?? []).find((s) => s.id === segmentId);
  if (!segment) throw notFound('Segment', segmentId);
  const district = (region.mapFeatures.districts ?? []).find((d) => d.id === segment.districtId);
  const profile = TN_DISTRICTS[segment.districtId];
  if (!district || !profile) throw notFound('District', segment.districtId);
  const [rows, stats] = await Promise.all([
    deps.pool.query<ParcelSummaryDbRow & { base_price_paise: number; lease_rent_paise: number }>(
      `${PARCEL_SUMMARY_SQL.replace('p.is_starter_plot,', 'p.is_starter_plot, p.base_price_paise, p.lease_rent_paise,')}
       WHERE p.region_id = $1 AND p.env->>'segmentId' = $2 ORDER BY p.id`,
      [auth.regionId, segmentId],
    ),
    segmentStats(deps, auth.regionId, auth.companyId, segmentId),
  ]);
  const climate = districtClimate(segment.districtId);
  const { polygons: _polygons, ...districtInfo } = toDistrictDto(district);
  return {
    segment: toSegmentSummary(segment, stats.get(segmentId)),
    district: {
      ...districtInfo,
      zoneLabel: ZONE_PROFILES[profile.zone].label,
      monthlyRainMm: climate.monthlyRainMm,
      monthlyMeanTempC: climate.monthlyMeanTempC,
      soils: profile.soils as Record<string, number>,
      water: profile.water as Record<string, number>,
    },
    holdings: rows.rows.map((r) => ({
      ...toParcelSummary(r),
      basePricePaise: r.base_price_paise,
      leaseRentPaisePerSeason: r.lease_rent_paise,
    })),
  };
}

export async function getParcelDetail(
  deps: CoreDeps,
  auth: AuthContext,
  parcelId: string,
): Promise<ParcelDetailResponse> {
  const db = deps.pool;
  const summaryRows = await db.query<ParcelSummaryDbRow>(
    `${PARCEL_SUMMARY_SQL} WHERE p.id = $1 AND p.region_id = $2`,
    [parcelId, auth.regionId],
  );
  const summaryRow = summaryRows.rows[0];
  if (!summaryRow) throw notFound('Parcel', parcelId);
  const [parcel, lease, plot, clock] = await Promise.all([
    getParcel(db, auth.regionId, parcelId),
    getActiveLease(db, parcelId),
    getLivePlotForParcel(db, parcelId),
    getWorldClock(db, auth.regionId),
  ]);
  const day = clock.gameDay;
  const me = auth.companyId;
  const operator = operatorOf(parcel, lease);
  const company = me ? await findCompany(db, me) : null;
  const effects = me ? await machineryEffectsFor(db, me) : null;
  const lessee = lease ? await findCompany(db, lease.lesseeCompanyId) : null;

  const reasons: Record<string, string> = {};
  const deny = (key: string, why: string) => {
    reasons[key] ??= why;
    return false;
  };
  const companyOk = (key: string) =>
    !company
      ? deny(key, 'Create a company first')
      : company.status !== 'active'
        ? deny(key, 'Your company is in financial distress')
        : true;

  let canPurchase = companyOk('canPurchase');
  if (canPurchase) {
    if (parcel.status !== 'for_sale') canPurchase = deny('canPurchase', 'Not for sale');
    else if (parcel.ownerCompanyId === me) canPurchase = deny('canPurchase', 'You own this parcel');
    else if (plot) canPurchase = deny('canPurchase', 'A crop is growing here');
    else if (company!.cashPaise < askingPricePaise(parcel))
      canPurchase = deny('canPurchase', 'Not enough cash');
  }

  let canLease = companyOk('canLease');
  if (canLease) {
    if (parcel.ownerCompanyId !== null || parcel.status !== 'for_sale')
      canLease = deny('canLease', 'Only available state land can be leased');
    else if (plot) canLease = deny('canLease', 'A crop is growing here');
    else if (company!.cashPaise < parcel.leaseRentPaise)
      canLease = deny('canLease', 'Not enough cash for one season of rent');
  }

  let canPlant = companyOk('canPlant');
  if (canPlant) {
    if (operator !== me) canPlant = deny('canPlant', 'You do not own or lease this parcel');
    else if (parcel.status === 'for_sale') canPlant = deny('canPlant', 'Delist the parcel first');
    else if (plot) canPlant = deny('canPlant', 'A crop is already planted');
    else {
      const month = toGameDate(day).month;
      const open = CROP_IDS.some((id) => getCrop(id).sowingMonths.includes(month));
      if (!open) canPlant = deny('canPlant', 'No crop can be sown this month');
    }
  }

  const ownerChecks = (key: string): boolean => {
    if (!company) return deny(key, 'Create a company first');
    if (parcel.ownerCompanyId !== me) return deny(key, 'You do not own this parcel');
    if (lease) return deny(key, 'The parcel is leased');
    if (plot) return deny(key, 'Harvest or clear the crop first');
    return true;
  };
  let canListForSale = ownerChecks('canListForSale');
  if (canListForSale && parcel.status !== 'owned')
    canListForSale = deny('canListForSale', 'Already listed for sale');
  let canSellToState = ownerChecks('canSellToState');
  if (canSellToState && parcel.status !== 'owned' && parcel.status !== 'for_sale')
    canSellToState = deny('canSellToState', 'Cannot be sold right now');

  const summary = toParcelSummary(summaryRow);
  return {
    parcel: {
      ...summary,
      env: { ...parcel.env },
      marketDistanceKm: parcel.marketDistanceKm,
      nearestMarketId: parcel.nearestMarketId,
      basePricePaise: parcel.basePricePaise,
      leaseRentPaisePerSeason: parcel.leaseRentPaise,
      lease:
        lease && lessee
          ? {
              id: lease.id,
              lesseeCompanyId: lease.lesseeCompanyId,
              lesseeName: lessee.name,
              startDay: lease.startDay,
              endDay: lease.endDay,
              rentPaise: lease.rentPaise,
            }
          : null,
      monthlyLandTaxPaise: landTaxPaise(parcel.areaHa),
    },
    // Plot details include private costs: only the operating company sees them.
    plot:
      plot && me && plot.companyId === me
        ? toPlotDto(plot, day, parcel.env, effects?.irrigationCostMultiplier ?? 1)
        : null,
    actions: {
      canPurchase,
      canLease,
      canPlant,
      canListForSale,
      canSellToState,
      reasons,
    },
  };
}

export async function getParcelSuitability(
  deps: CoreDeps,
  auth: AuthContext,
  parcelId: string,
): Promise<ParcelSuitabilityResponse> {
  const [parcel, region, clock] = await Promise.all([
    getParcel(deps.pool, auth.regionId, parcelId),
    getRegion(deps.pool, auth.regionId),
    getWorldClock(deps.pool, auth.regionId),
  ]);
  const effects = auth.companyId ? await machineryEffectsFor(deps.pool, auth.companyId) : null;
  const irrigationAvailable = canIrrigate(parcel.env, effects?.enablesDryIrrigation ?? false);
  const results = computeAllSuitability(parcel.env, climateForEnv(parcel.env, region.climate), {
    sowingDay: clock.gameDay,
    irrigated: irrigationAvailable,
  });
  return {
    parcelId,
    gameDay: clock.gameDay,
    irrigationAvailable,
    results: results.map((r) => ({
      cropId: r.cropId,
      score: r.score,
      grade: r.grade,
      factors: r.factors.map((f) => ({ ...f })),
      limitingFactor: r.limitingFactor,
      yieldKgPerHa: { ...r.yieldKgPerHa },
      irrigationAssumed: r.irrigationAssumed,
      sowingOpen: r.sowingOpen,
      nextSowingMonth: r.nextSowingMonth,
    })),
  };
}

export async function getCrops(deps: CoreDeps, auth: AuthContext): Promise<CropsResponse> {
  const clock = await getWorldClock(deps.pool, auth.regionId);
  return {
    rulesetVersion: clock.rulesetVersion,
    crops: CROP_IDS.map((id) => {
      const c = getCrop(id);
      return {
        id: c.id,
        name: c.name,
        localName: c.localName,
        sowingMonths: [...c.sowingMonths],
        durationDays: cropDurationDays(c),
        harvestWindowDays: c.harvestWindowDays,
        baseYieldKgPerHa: c.baseYieldKgPerHa,
        basePricePaisePerKg: c.basePricePaisePerKg,
        shelfLifeDays: c.shelfLifeDays,
        waterNeed: c.requirements.waterNeed,
        costs: { ...c.costs },
      };
    }),
  };
}
