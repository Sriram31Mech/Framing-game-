/**
 * The playable world: Tamil Nadu on its real map.
 *
 * Districts (Census 2011) and segments (assembly-constituency areas) come from DataMeet
 * boundaries (CC BY 2.5 IN), pre-projected to local metres by scripts/geo/build_tamilnadu.py.
 * Each rural segment holds a set of farm holdings (1–15 acres) that companies buy or lease; the
 * map itself is not cut into tiles. Holdings take their soil, water, elevation and climate from
 * their district profile (tamilnadu.ts) with deterministic local variation.
 */
import geo from './data/tamilnadu-geo.json';
import { boundingBox, distance, pointInPolygon, polygonCentroid } from './geometry';
import { roundHalfAwayFromZero } from './money';
import { hashSeed, randomBetween, rngFor } from './rng';
import { computeAllSuitability } from './suitability';
import { climateForEnv, stateClimate, TN_DISTRICTS, ZONE_PROFILES } from './tamilnadu';
import type {
  Drainage,
  GeneratedDistrict,
  GeneratedParcel,
  GeneratedRegion,
  GeneratedRoad,
  GeneratedSegment,
  MapPoint,
  MarketDefinition,
  ParcelEnvironment,
  SoilTexture,
  WaterAccess,
} from './types';

export const DEFAULT_REGION_ID = 'tamil-nadu';
export const DEFAULT_REGION_SEED = 20261012;

const ACRES_PER_HA = 2.47105;
/** Regular holdings, acres. */
const HOLDING_ACRES: [number, number] = [2, 15];
/** Starter holdings granted to new companies, acres. */
const STARTER_ACRES: [number, number] = [1, 2.5];
const STARTERS_PER_DISTRICT = 2;
/** Farmland per generated holding, ha (controls holdings per segment). */
const FARMLAND_HA_PER_HOLDING = 2500;
const MIN_HOLDINGS_PER_SEGMENT = 3;
const MAX_HOLDINGS_PER_SEGMENT = 12;
const ROAD_TRAVEL_FACTOR = 1.25;

interface GeoFile {
  origin: { lat: number; lon: number };
  districts: { id: string; name: string; rings: [number, number][][] }[];
  segments: {
    id: string;
    name: string;
    acNo: number;
    districtId: string;
    ring: [number, number][];
    centroid: [number, number];
    areaHa: number;
  }[];
}
const GEO = geo as unknown as GeoFile;

const M_PER_DEG_LAT = 110_574;
const M_PER_DEG_LON = 111_320 * Math.cos((GEO.origin.lat * Math.PI) / 180);

/** Project WGS84 lat/lon to the game's local metres (x east, y south). */
export function projectLatLon(lat: number, lon: number): MapPoint {
  return {
    x: Math.round((lon - GEO.origin.lon) * M_PER_DEG_LON),
    y: Math.round(-(lat - GEO.origin.lat) * M_PER_DEG_LAT),
  };
}

/** Inverse of projectLatLon. */
export function unprojectToLatLon(p: MapPoint): { lat: number; lon: number } {
  return { lat: GEO.origin.lat - p.y / M_PER_DEG_LAT, lon: GEO.origin.lon + p.x / M_PER_DEG_LON };
}

export function haToAcres(ha: number): number {
  return ha * ACRES_PER_HA;
}

export function acresToHa(acres: number): number {
  return acres / ACRES_PER_HA;
}

/** District headquarters (lat, lon) where each regulated market (mandi) sits. */
const DISTRICT_HQ: Record<string, [number, number]> = {
  ariyalur: [11.14, 79.08],
  chennai: [13.07, 80.19],
  coimbatore: [11.02, 76.96],
  cuddalore: [11.75, 79.75],
  dharmapuri: [12.13, 78.16],
  dindigul: [10.36, 77.98],
  erode: [11.34, 77.72],
  kancheepuram: [12.83, 79.7],
  kanniyakumari: [8.18, 77.41],
  karur: [10.96, 78.08],
  krishnagiri: [12.52, 78.21],
  madurai: [9.93, 78.12],
  nagappattinam: [10.77, 79.84],
  namakkal: [11.22, 78.17],
  perambalur: [11.23, 78.88],
  pudukkottai: [10.38, 78.82],
  ramanathapuram: [9.37, 78.83],
  salem: [11.66, 78.15],
  sivaganga: [9.85, 78.48],
  thanjavur: [10.79, 79.14],
  'the-nilgiris': [11.41, 76.7],
  theni: [10.01, 77.48],
  thiruvallur: [13.14, 79.91],
  thiruvarur: [10.77, 79.64],
  thoothukkudi: [8.76, 78.13],
  tiruchirappalli: [10.79, 78.7],
  tirunelveli: [8.71, 77.76],
  tiruppur: [11.11, 77.34],
  tiruvannamalai: [12.23, 79.07],
  vellore: [12.92, 79.13],
  viluppuram: [11.94, 79.49],
  virudunagar: [9.58, 77.96],
};

/** Approximate national-highway corridors (lat, lon waypoints). */
export const HIGHWAYS: { id: string; name: string; points: [number, number][] }[] = [
  {
    id: 'nh44',
    name: 'NH 44',
    points: [
      [12.74, 77.83],
      [12.52, 78.21],
      [12.13, 78.16],
      [11.66, 78.15],
      [11.22, 78.17],
      [10.96, 78.08],
      [10.36, 77.98],
      [9.93, 78.12],
      [9.58, 77.96],
      [8.71, 77.76],
      [8.08, 77.55],
    ],
  },
  {
    id: 'nh38',
    name: 'NH 38',
    points: [
      [13.07, 80.24],
      [12.69, 79.98],
      [11.94, 79.49],
      [11.23, 78.88],
      [10.79, 78.7],
      [10.36, 78.82],
      [9.93, 78.12],
    ],
  },
  {
    id: 'nh544',
    name: 'NH 544',
    points: [
      [11.66, 78.15],
      [11.34, 77.72],
      [11.11, 77.34],
      [11.02, 76.96],
    ],
  },
  {
    id: 'nh48',
    name: 'NH 48',
    points: [
      [13.07, 80.24],
      [12.83, 79.7],
      [12.92, 79.13],
      [12.52, 78.21],
    ],
  },
  {
    id: 'nh83',
    name: 'NH 83',
    points: [
      [11.02, 76.96],
      [10.96, 78.08],
      [10.79, 78.7],
      [10.79, 79.14],
      [10.77, 79.64],
      [10.77, 79.84],
    ],
  },
  {
    id: 'ecr',
    name: 'East Coast Road',
    points: [
      [13.07, 80.27],
      [12.62, 80.19],
      [11.93, 79.83],
      [11.75, 79.75],
      [11.1, 79.85],
      [10.77, 79.84],
    ],
  },
  {
    id: 'nh87',
    name: 'NH 87',
    points: [
      [9.93, 78.12],
      [9.85, 78.48],
      [9.37, 78.83],
      [9.28, 79.31],
    ],
  },
  {
    id: 'nh138',
    name: 'NH 138',
    points: [
      [8.71, 77.76],
      [8.76, 78.13],
    ],
  },
  {
    id: 'nh77',
    name: 'NH 77',
    points: [
      [12.92, 79.13],
      [12.23, 79.07],
      [11.94, 79.49],
    ],
  },
];

/** River Kaveri (Cauvery) from Mettur to the sea at Poompuhar. */
const CAUVERY: [number, number][] = [
  [12.2, 77.75],
  [11.79, 77.8],
  [11.45, 77.68],
  [11.08, 77.89],
  [10.95, 78.25],
  [10.85, 78.55],
  [10.86, 78.7],
  [10.88, 79.1],
  [10.97, 79.39],
  [11.05, 79.65],
  [11.14, 79.85],
];

const SOIL_PH: Record<SoilTexture, number> = {
  laterite: 5.4,
  sandy_loam: 6.3,
  sandy: 6.8,
  loam: 6.8,
  clay_loam: 7.4,
  clay: 7.9,
};
const SOIL_FERTILITY: Record<SoilTexture, number> = {
  sandy: 0.25,
  laterite: 0.38,
  sandy_loam: 0.45,
  loam: 0.6,
  clay_loam: 0.66,
  clay: 0.7,
};
const WATER_VALUE: Record<WaterAccess, number> = { river: 1, canal: 0.85, well: 0.6, none: 0 };

const toPoint = ([x, y]: [number, number]): MapPoint => ({ x, y });
const fromLatLon = ([lat, lon]: [number, number]): MapPoint => projectLatLon(lat, lon);

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function weightedPick<K extends string>(
  weights: Partial<Record<K, number>>,
  random: () => number,
): K {
  const entries = Object.entries(weights) as [K, number][];
  const total = entries.reduce((sum, [, w]) => sum + w, 0);
  let roll = random() * total;
  for (const [key, w] of entries) {
    roll -= w;
    if (roll <= 0) return key;
  }
  return entries[entries.length - 1]![0];
}

/** Real district outlines (cheap; no holdings). */
export function tamilNaduDistricts(): GeneratedDistrict[] {
  return GEO.districts.map((d) => {
    const profile = TN_DISTRICTS[d.id];
    if (!profile) throw new Error(`missing district profile for ${d.id}`);
    const polygons = d.rings.map((ring) => ring.map(toPoint));
    const largest = polygons.reduce((a, b) => (b.length > a.length ? b : a));
    return {
      id: d.id,
      name: profile.name,
      tamilName: profile.tamilName,
      zone: ZONE_PROFILES[profile.zone].label,
      polygons,
      centroid: polygonCentroid(largest),
    };
  });
}

/** Real segment (assembly-constituency) outlines with farmland estimates (cheap). */
export function tamilNaduSegments(): GeneratedSegment[] {
  return GEO.segments.map((s) => {
    const profile = TN_DISTRICTS[s.districtId]!;
    return {
      id: s.id,
      name: s.name,
      districtId: s.districtId,
      polygon: s.ring.map(toPoint),
      centroid: toPoint(s.centroid),
      areaHa: s.areaHa,
      farmlandHa: Math.round(s.areaHa * profile.farmlandShare),
    };
  });
}

function markets(): MarketDefinition[] {
  return Object.values(TN_DISTRICTS).map((d) => {
    const hq = DISTRICT_HQ[d.id];
    if (!hq) throw new Error(`missing HQ for ${d.id}`);
    const p = fromLatLon(hq);
    if (d.id === 'chennai') {
      return {
        id: 'mandi-chennai',
        name: 'Koyambedu Wholesale Market',
        x: p.x,
        y: p.y,
        feeBps: 150,
        demandScale: 3,
      };
    }
    return {
      id: `mandi-${d.id}`,
      name: `${d.name} Regulated Market`,
      x: p.x,
      y: p.y,
      feeBps: 100,
      demandScale: Math.round((0.5 + d.farmlandShare * 1.4) * 100) / 100,
    };
  });
}

/** A random point inside `ring` (rejection sampling within its bounding box). */
function pointInside(ring: MapPoint[], random: () => number): MapPoint {
  const box = boundingBox(ring);
  for (let i = 0; i < 200; i++) {
    const p = {
      x: Math.round(randomBetween(random, box.minX, box.maxX)),
      y: Math.round(randomBetween(random, box.minY, box.maxY)),
    };
    if (pointInPolygon(p, ring)) return p;
  }
  return polygonCentroid(ring);
}

/** Square footprint of `areaHa` centred on `c`, counter-clockwise (positive shoelace area). */
function squareFootprint(c: MapPoint, areaHa: number): MapPoint[] {
  const half = Math.sqrt(areaHa * 10_000) / 2;
  return [
    { x: Math.round(c.x - half), y: Math.round(c.y - half) },
    { x: Math.round(c.x + half), y: Math.round(c.y - half) },
    { x: Math.round(c.x + half), y: Math.round(c.y + half) },
    { x: Math.round(c.x - half), y: Math.round(c.y + half) },
  ];
}

function describeHolding(
  seed: number,
  segment: GeneratedSegment,
  centroid: MapPoint,
  areaHa: number,
  random: () => number,
  riverPoints: MapPoint[],
): ParcelEnvironment {
  const district = TN_DISTRICTS[segment.districtId]!;
  const zone = district.zone;
  const soilTexture = weightedPick(district.soils, random);
  const nearRiverKm = Math.min(...riverPoints.map((p) => distance(p, centroid))) / 1000;
  let waterAccess = weightedPick(district.water, random);
  if (nearRiverKm < 6 && waterAccess === 'none') waterAccess = 'canal';
  if (nearRiverKm < 2.5 && random() < 0.5) waterAccess = 'river';
  const [lo, hi] = district.elevationM;
  const elevationM = Math.round(lo + (hi - lo) * random());
  const slopeRange: [number, number] =
    zone === 'hilly' ? [4, 18] : zone === 'north_western' ? [1, 6] : [0.2, 2.5];
  const slopePct = Math.round(randomBetween(random, ...slopeRange) * 10) / 10;
  const drainage: Drainage =
    soilTexture === 'clay' && slopePct < 1
      ? 'poor'
      : soilTexture === 'sandy' || soilTexture === 'laterite' || slopePct > 5
        ? 'good'
        : random() < 0.5
          ? 'moderate'
          : 'good';
  const soilPh =
    Math.round(clamp(SOIL_PH[soilTexture] + randomBetween(random, -0.5, 0.5), 4.8, 8.6) * 10) / 10;
  const fertility =
    Math.round(
      clamp(SOIL_FERTILITY[soilTexture] + randomBetween(random, -0.12, 0.12), 0.1, 0.95) * 100,
    ) / 100;
  void seed;
  return {
    areaHa,
    elevationM,
    slopePct,
    soilTexture,
    soilPh,
    fertility,
    drainage,
    waterAccess,
    roadDistanceKm: Math.round(randomBetween(random, 0.1, 3) * 10) / 10,
    districtId: segment.districtId,
    segmentId: segment.id,
  };
}

/**
 * Land value per hectare: ₹2–6 lakh base from water security, agronomic potential and access,
 * scaled by the district's land price factor (urban fringe, delta wetland...), capped at ₹20 L/ha.
 * Seasonal lease rent is 8% of value, rising to 10% for land with secure water.
 */
function priceHolding(
  env: ParcelEnvironment,
  marketDistanceKm: number,
): { basePricePaise: number; leaseRentPaisePerSeason: number } {
  const climate = climateForEnv(env, stateClimate());
  const topThree = computeAllSuitability(env, climate).slice(0, 3);
  const quality = topThree.reduce((sum, r) => sum + r.score, 0) / (100 * topThree.length);
  const water = WATER_VALUE[env.waterAccess];
  const road = clamp(1 - env.roadDistanceKm / 3, 0, 1);
  const market = clamp(1 - marketDistanceKm / 60, 0, 1);
  const factor = TN_DISTRICTS[env.districtId ?? '']?.landPriceFactor ?? 1;
  const lakhPerHa = clamp(
    (1.2 + 1.4 * water + 2.4 * quality * quality + 0.4 * road + 0.6 * market) * factor,
    1.5,
    20,
  );
  const rupees = lakhPerHa * 100_000 * env.areaHa;
  const basePricePaise = roundHalfAwayFromZero(rupees / 1000) * 1000 * 100;
  const rentRate = 0.08 + 0.02 * water;
  const leaseRentPaisePerSeason =
    roundHalfAwayFromZero((basePricePaise * rentRate) / 10_000) * 10_000;
  return { basePricePaise, leaseRentPaisePerSeason };
}

function holdings(
  seed: number,
  segs: GeneratedSegment[],
  mkts: MarketDefinition[],
  riverPoints: MapPoint[],
): GeneratedParcel[] {
  const out: GeneratedParcel[] = [];
  const startersLeft = new Map<string, number>();
  for (const id of Object.keys(TN_DISTRICTS)) {
    startersLeft.set(id, id === 'chennai' ? 0 : STARTERS_PER_DISTRICT);
  }

  for (const segment of segs) {
    if (segment.districtId === 'chennai') continue; // urban: no farmland to trade
    const random = rngFor(seed, 'segment', segment.id);
    const count = clamp(
      Math.round(segment.farmlandHa / FARMLAND_HA_PER_HOLDING),
      MIN_HOLDINGS_PER_SEGMENT,
      MAX_HOLDINGS_PER_SEGMENT,
    );
    for (let i = 0; i < count; i++) {
      const isStarterPlot = (startersLeft.get(segment.districtId) ?? 0) > 0 && i === 0;
      if (isStarterPlot)
        startersLeft.set(segment.districtId, startersLeft.get(segment.districtId)! - 1);
      const [aMin, aMax] = isStarterPlot ? STARTER_ACRES : HOLDING_ACRES;
      const acres = Math.round(randomBetween(random, aMin, aMax) * 2) / 2;
      const areaHa = Math.round(acresToHa(acres) * 1000) / 1000;
      const centroid = pointInside(segment.polygon, random);
      const env = describeHolding(seed, segment, centroid, areaHa, random, riverPoints);
      let nearest = mkts[0]!;
      let nearestKm = Number.POSITIVE_INFINITY;
      for (const m of mkts) {
        const km = (distance(centroid, m) / 1000) * ROAD_TRAVEL_FACTOR;
        if (km < nearestKm) {
          nearestKm = km;
          nearest = m;
        }
      }
      const marketDistanceKm = Math.round(nearestKm * 10) / 10;
      const { basePricePaise, leaseRentPaisePerSeason } = priceHolding(env, marketDistanceKm);
      out.push({
        id: `TN-${String(segment.id.slice(-3))}-${String(i + 1).padStart(2, '0')}`,
        polygon: squareFootprint(centroid, areaHa),
        centroid,
        env,
        marketDistanceKm,
        nearestMarketId: nearest.id,
        basePricePaise,
        leaseRentPaisePerSeason,
        isStarterPlot,
        segmentId: segment.id,
        districtId: segment.districtId,
      });
    }
  }
  return out;
}

/** Deterministically generate the Tamil Nadu world. Same seed => identical output. */
export function generateRegion(
  seed = DEFAULT_REGION_SEED,
  id = DEFAULT_REGION_ID,
): GeneratedRegion {
  const segs = tamilNaduSegments();
  const mkts = markets();
  const riverPoints = CAUVERY.map(fromLatLon);
  const roads: GeneratedRoad[] = HIGHWAYS.map((h) => ({
    id: h.id,
    kind: 'highway',
    points: h.points.map(fromLatLon),
    widthM: 1200,
  }));
  const parcels = holdings(seed, segs, mkts, riverPoints);
  let half = 0;
  for (const s of segs) {
    for (const p of s.polygon) half = Math.max(half, Math.abs(p.x), Math.abs(p.y));
  }
  return {
    id,
    name: 'Tamil Nadu',
    seed,
    halfSizeM: Math.ceil(half / 1000) * 1000,
    originLat: GEO.origin.lat,
    originLon: GEO.origin.lon,
    climate: stateClimate(),
    markets: mkts,
    parcels,
    roads,
    river: { points: riverPoints, widthM: 800 },
    features: [],
    districts: tamilNaduDistricts(),
    segments: segs,
  };
}

/** Stable hash of the generated world, for provenance checks. */
export function regionFingerprint(region: GeneratedRegion): number {
  return hashSeed(region.id, region.seed, region.parcels.length, region.segments?.length ?? 0);
}
