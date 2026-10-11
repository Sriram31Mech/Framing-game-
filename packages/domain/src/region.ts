import {
  boundingBox,
  convexPolygonsOverlap,
  distance,
  isConvexPolygon,
  pointPolygonDistance,
  pointPolylineDistance,
  pointSegmentDistance,
  polygonArea,
  polygonCentroid,
  polygonPolylineDistance,
  signedPolygonArea,
} from './geometry';
import { roundHalfAwayFromZero } from './money';
import { hashSeed, randomBetween, rngFor } from './rng';
import { computeAllSuitability } from './suitability';
import {
  fieldNoise,
  RIVER_WIDTH_M,
  riverCenterX,
  riverLevelM,
  terrainHeightM,
  terrainSlopePct,
} from './terrain';
import type {
  Drainage,
  GeneratedFeature,
  GeneratedParcel,
  GeneratedRegion,
  GeneratedRoad,
  MapPoint,
  MarketDefinition,
  ParcelEnvironment,
  RegionClimate,
  SoilTexture,
  WaterAccess,
} from './types';

export const DEFAULT_REGION_ID = 'hemavati';
export const DEFAULT_REGION_SEED = 20261011;

/**
 * Climate normals for the Hemavati Valley, modelled on the Hassan plateau (~950 m):
 * south-west monsoon Jun–Sep with a second (north-east) peak in October, ~1,070 mm a year,
 * mild temperatures (20–27 °C monthly means).
 */
export const HEMAVATI_CLIMATE: RegionClimate = {
  monthlyRainMm: [3, 5, 14, 55, 115, 135, 215, 160, 130, 165, 60, 15],
  monthlyMeanTempC: [21.5, 23.5, 25.5, 26.5, 26, 23, 22, 22, 22.5, 22.5, 21.5, 20.5],
  lapseRateCPerKm: 6.5,
  referenceElevationM: 950,
};

const HALF_SIZE_M = 2000;
const STARTER_PLOT_COUNT = 32;
const REGULAR_PARCEL_COUNT = 64;
const STARTER_AREA_HA: [number, number] = [0.5, 1.5];
const REGULAR_AREA_HA: [number, number] = [2, 12];
/** Minimum clearance between neighbouring parcels (bunds/hedges), m. */
const PARCEL_GAP_M = 8;
/** Clearance from the map edge, road verges and the river bank, m. */
const EDGE_MARGIN_M = 25;
const ROAD_VERGE_M = 6;
const RIVER_BANK_M = 25;
/** Straight-line distances are stretched by this factor to approximate road travel. */
const ROAD_TRAVEL_FACTOR = 1.25;

const MARKET_APMC_ID = 'hemavati-apmc';
const MARKET_DISTRICT_ID = 'district-market';

interface Circle {
  x: number;
  y: number;
  r: number;
}

interface Settlement {
  x: number;
  y: number;
  scale: number;
}

interface Layout {
  seed: number;
  river: MapPoint[];
  roads: GeneratedRoad[];
  markets: MarketDefinition[];
  villages: Settlement[];
  tanks: Circle[];
  features: GeneratedFeature[];
  /** Areas parcels must keep out of (settlements, tanks, buildings). */
  exclusions: Circle[];
}

/**
 * Deterministically generate the Hemavati Valley region (fictionalised, inspired by the
 * Hassan district of Karnataka): ~4 km x 4 km, a meandering river, a highway and district
 * roads, villages, two markets (local APMC mandi near the town, district market at the edge),
 * and ~96 parcels with varied soils/elevations/water access. About a third are small
 * (0.5–1.5 ha) starter plots; the rest range 2–12 ha. Same seed => identical output.
 */
export function generateRegion(
  seed: number = DEFAULT_REGION_SEED,
  id: string = DEFAULT_REGION_ID,
): GeneratedRegion {
  const layout = buildLayout(seed);
  // Ids follow reading order (400 m bands north → south, west → east) so they are stable.
  const parcels = placeParcels(layout)
    .map((placed) => ({ ...placed, centroid: polygonCentroid(placed.polygon) }))
    .sort(
      (a, b) =>
        Math.floor((a.centroid.y + HALF_SIZE_M) / 400) -
          Math.floor((b.centroid.y + HALF_SIZE_M) / 400) ||
        a.centroid.x - b.centroid.x ||
        a.centroid.y - b.centroid.y,
    )
    .map((placed, index) => describeParcel(layout, placed, index));
  const features = [...layout.features, ...placeTreeClusters(layout, parcels)];

  return {
    id,
    name: 'Hemavati Valley',
    seed,
    halfSizeM: HALF_SIZE_M,
    originLat: 13.0,
    originLon: 76.1,
    climate: HEMAVATI_CLIMATE,
    markets: layout.markets,
    parcels,
    roads: layout.roads,
    river: { points: layout.river, widthM: RIVER_WIDTH_M },
    features,
  };
}

// ---------------------------------------------------------------------------
// Layout: river, settlements, markets, roads, landmarks

function roundPoint(p: MapPoint): MapPoint {
  return { x: Math.round(p.x * 100) / 100, y: Math.round(p.y * 100) / 100 };
}

/** Catmull-Rom spline through control points, sampled roughly every `spacing` metres. */
function smoothPath(controls: MapPoint[], spacing = 40): MapPoint[] {
  const points: MapPoint[] = [];
  for (let i = 0; i + 1 < controls.length; i++) {
    const p0 = controls[Math.max(0, i - 1)]!;
    const p1 = controls[i]!;
    const p2 = controls[i + 1]!;
    const p3 = controls[Math.min(controls.length - 1, i + 2)]!;
    const steps = Math.max(1, Math.ceil(distance(p1, p2) / spacing));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const t2 = t * t;
      const t3 = t2 * t;
      const blend = (a: number, b: number, c: number, d: number) =>
        0.5 *
        (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t2 + (-a + 3 * b - 3 * c + d) * t3);
      points.push(
        roundPoint({ x: blend(p0.x, p1.x, p2.x, p3.x), y: blend(p0.y, p1.y, p2.y, p3.y) }),
      );
    }
  }
  points.push(roundPoint(controls[controls.length - 1]!));
  return points;
}

/** Moves a point east/west until it is at least `clearance` metres from the river centreline. */
function awayFromRiver(seed: number, p: MapPoint, clearance: number): MapPoint {
  const riverX = riverCenterX(seed, p.y);
  const offset = p.x - riverX;
  if (Math.abs(offset) >= clearance) return p;
  return { x: riverX + (offset >= 0 ? clearance : -clearance), y: p.y };
}

function buildLayout(seed: number): Layout {
  const random = rngFor(seed, 'layout');
  const jitter = (amount: number) => randomBetween(random, -amount, amount);

  const river: MapPoint[] = [];
  for (let y = -HALF_SIZE_M; y <= HALF_SIZE_M; y += 40) {
    river.push(roundPoint({ x: riverCenterX(seed, y), y }));
  }

  const town = {
    ...awayFromRiver(seed, { x: 900 + jitter(60), y: -520 + jitter(60) }, 500),
    scale: 2.4,
  };
  const villageAnchors: MapPoint[] = [
    { x: -1350, y: -1300 },
    { x: -1150, y: 1050 },
    { x: -1350, y: -150 },
    { x: 380, y: 1350 },
    { x: 1450, y: -1350 },
    { x: 1450, y: 450 },
  ];
  const villages: Settlement[] = villageAnchors.map((anchor) => ({
    ...awayFromRiver(seed, { x: anchor.x + jitter(120), y: anchor.y + jitter(120) }, 280),
    scale: 1 + random() * 0.5,
  }));

  const apmc = { x: town.x + 170, y: town.y + 110 };
  const districtMarket = { x: 1760 + jitter(40), y: 1640 + jitter(40) };
  const markets: MarketDefinition[] = [
    {
      id: MARKET_APMC_ID,
      name: 'Hemavati APMC Mandi',
      x: Math.round(apmc.x),
      y: Math.round(apmc.y),
      feeBps: 100,
      demandScale: 1,
      priceScale: 1,
    },
    {
      id: MARKET_DISTRICT_ID,
      name: 'District Wholesale Market',
      x: Math.round(districtMarket.x),
      y: Math.round(districtMarket.y),
      feeBps: 150,
      demandScale: 1.5,
      priceScale: 1.08,
    },
  ];

  const highway = smoothPath([
    { x: -HALF_SIZE_M, y: -720 + jitter(80) },
    { x: -1000, y: -600 + jitter(80) },
    { x: 0, y: -660 + jitter(60) },
    { x: town.x, y: town.y },
    { x: HALF_SIZE_M, y: -420 + jitter(80) },
  ]);
  const districtSouth = smoothPath([
    { x: 980 + jitter(60), y: -HALF_SIZE_M },
    { x: 920, y: -1150 },
    { x: town.x, y: town.y },
    { x: 1020, y: 300 },
    { x: 1380, y: 1100 },
    { x: districtMarket.x - 60, y: districtMarket.y - 60 },
    { x: HALF_SIZE_M, y: 1880 },
  ]);
  const westBranchStart = districtSouth[Math.floor(districtSouth.length * 0.55)]!;
  const districtWest = smoothPath([
    westBranchStart,
    { x: 300, y: 420 + jitter(60) },
    { x: -400, y: 330 + jitter(60) },
    { x: -1200, y: 520 + jitter(60) },
    { x: -HALF_SIZE_M, y: 430 + jitter(60) },
  ]);
  const roads: GeneratedRoad[] = [
    { id: 'road-highway', kind: 'highway', points: highway, widthM: 14 },
    { id: 'road-district-1', kind: 'district', points: districtSouth, widthM: 9 },
    { id: 'road-district-2', kind: 'district', points: districtWest, widthM: 8 },
  ];
  const majorRoads = [...roads];

  // Village roads: each village links to the nearest point of a major road.
  villages.forEach((village, index) => {
    const target = nearestPointOnRoads(village, majorRoads);
    if (distance(village, target) < 60) return;
    const mid = {
      x: (village.x + target.x) / 2 + jitter(60),
      y: (village.y + target.y) / 2 + jitter(60),
    };
    const points = smoothPath([village, mid, target], 30);
    if (crossesRiver(seed, points)) return;
    roads.push({ id: `road-village-${index + 1}`, kind: 'village', points, widthM: 5 });
  });

  // Farm tracks: short spurs from roads into the fields.
  const trackRandom = rngFor(seed, 'tracks');
  let trackIndex = 0;
  for (let attempt = 0; attempt < 40 && trackIndex < 6; attempt++) {
    const road = roads[Math.floor(trackRandom() * roads.length)]!;
    const i = 1 + Math.floor(trackRandom() * (road.points.length - 2));
    const a = road.points[i - 1]!;
    const b = road.points[i]!;
    const length = 250 + trackRandom() * 400;
    const side = trackRandom() < 0.5 ? -1 : 1;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const norm = Math.hypot(dx, dy) || 1;
    const end = { x: b.x + (side * -dy * length) / norm, y: b.y + (side * dx * length) / norm };
    const bend = {
      x: (b.x + end.x) / 2 + randomBetween(trackRandom, -40, 40),
      y: (b.y + end.y) / 2 + randomBetween(trackRandom, -40, 40),
    };
    const points = smoothPath([b, bend, end], 30);
    if (!insideMap(end, 80) || crossesRiver(seed, points)) continue;
    trackIndex += 1;
    roads.push({ id: `track-${trackIndex}`, kind: 'farm_track', points, widthM: 3 });
  }

  // Landmarks.
  const features: GeneratedFeature[] = [];
  const exclusions: Circle[] = [];
  const addFeature = (
    kind: GeneratedFeature['kind'],
    p: MapPoint,
    scale: number,
    radius: number,
  ) => {
    features.push({
      id: `${kind.replace('_', '-')}-${features.filter((f) => f.kind === kind).length + 1}`,
      kind,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      rotation: Math.round(random() * Math.PI * 2 * 1000) / 1000,
      scale: Math.round(scale * 100) / 100,
    });
    exclusions.push({ x: p.x, y: p.y, r: radius });
  };
  addFeature('village', town, town.scale, 340);
  for (const village of villages)
    addFeature('village', village, village.scale, 130 * village.scale);
  for (const market of markets) exclusions.push({ x: market.x, y: market.y, r: 90 });
  addFeature('warehouse', { x: apmc.x + 90, y: apmc.y + 60 }, 1, 60);
  addFeature('temple', { x: town.x - 120, y: town.y - 130 }, 1.2, 45);
  addFeature('temple', { x: villages[0]!.x + 140, y: villages[0]!.y + 60 }, 1, 40);
  addFeature('school', { x: town.x + 60, y: town.y - 200 }, 1, 50);
  addFeature('school', { x: villages[3]!.x - 150, y: villages[3]!.y - 40 }, 1, 45);

  // Hilltop temple: the highest of a few sampled points in the western uplands.
  const hilltop = Array.from({ length: 24 }, () => ({
    x: randomBetween(random, -1900, -900),
    y: randomBetween(random, -1600, 1600),
  })).reduce((best, p) =>
    terrainHeightM(seed, p.x, p.y) > terrainHeightM(seed, best.x, best.y) ? p : best,
  );
  addFeature('temple', hilltop, 0.9, 40);

  // Water tanks (keres): low-lying spots on the plains, away from the river and settlements.
  const tanks: Circle[] = [];
  for (let attempt = 0; attempt < 400 && tanks.length < 4; attempt++) {
    const p = { x: randomBetween(random, -1800, 1800), y: randomBetween(random, -1800, 1800) };
    const scale = 1 + random() * 0.8;
    const radius = 70 * scale;
    const riverGap = Math.abs(p.x - riverCenterX(seed, p.y));
    if (riverGap < 500 || !insideMap(p, radius + 60)) continue;
    if (exclusions.some((c) => distance(c, p) < c.r + radius + 40)) continue;
    if (roads.some((r) => pointPolylineDistance(p, r.points) < radius + r.widthM)) continue;
    if (tanks.some((t) => distance(t, p) < 700)) continue;
    tanks.push({ x: p.x, y: p.y, r: radius });
    addFeature('water_tank', p, scale, radius + 15);
  }

  return { seed, river, roads, markets, villages, tanks, features, exclusions };
}

function insideMap(p: MapPoint, margin: number): boolean {
  return Math.abs(p.x) <= HALF_SIZE_M - margin && Math.abs(p.y) <= HALF_SIZE_M - margin;
}

function crossesRiver(seed: number, points: MapPoint[]): boolean {
  const first = points[0]!;
  const side = Math.sign(first.x - riverCenterX(seed, first.y));
  return points.some((p) => Math.sign(p.x - riverCenterX(seed, p.y)) !== side);
}

function nearestPointOnRoads(p: MapPoint, roads: GeneratedRoad[]): MapPoint {
  let best = roads[0]!.points[0]!;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const road of roads) {
    for (let i = 0; i + 1 < road.points.length; i++) {
      const a = road.points[i]!;
      const b = road.points[i + 1]!;
      const d = pointSegmentDistance(p, a, b);
      if (d < bestDistance) {
        bestDistance = d;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const lengthSq = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / lengthSq));
        best = { x: a.x + t * dx, y: a.y + t * dy };
      }
    }
  }
  return best;
}

/** Direction (radians) of the road segment nearest to `p`. */
function nearestRoadHeading(p: MapPoint, roads: GeneratedRoad[]): number {
  let heading = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const road of roads) {
    for (let i = 0; i + 1 < road.points.length; i++) {
      const a = road.points[i]!;
      const b = road.points[i + 1]!;
      const d = pointSegmentDistance(p, a, b);
      if (d < bestDistance) {
        bestDistance = d;
        heading = Math.atan2(b.y - a.y, b.x - a.x);
      }
    }
  }
  return heading;
}

// ---------------------------------------------------------------------------
// Parcels

/**
 * A jittered rectangle (optionally with one corner chamfered) of roughly `areaM2`, rotated by
 * `heading`, counter-clockwise in the x-right/y-up sense (positive shoelace area).
 */
function makeParcelShape(
  random: () => number,
  center: MapPoint,
  areaM2: number,
  heading: number,
): MapPoint[] {
  const aspect = 1 + random() * 0.9;
  const width = Math.sqrt(areaM2 * aspect);
  const height = areaM2 / width;
  const wobble = Math.min(width, height) * 0.07;
  const corners: MapPoint[] = [
    { x: -width / 2, y: -height / 2 },
    { x: width / 2, y: -height / 2 },
    { x: width / 2, y: height / 2 },
    { x: -width / 2, y: height / 2 },
  ].map((c) => ({
    x: c.x + randomBetween(random, -wobble, wobble),
    y: c.y + randomBetween(random, -wobble, wobble),
  }));

  let local = corners;
  if (random() < 0.3) {
    // Chamfer one corner: replace it with two points a quarter of the way along its edges.
    const k = Math.floor(random() * 4);
    const prev = corners[(k + 3) % 4]!;
    const corner = corners[k]!;
    const next = corners[(k + 1) % 4]!;
    const cut = 0.2 + random() * 0.15;
    local = [
      ...corners.slice(0, k),
      { x: corner.x + (prev.x - corner.x) * cut, y: corner.y + (prev.y - corner.y) * cut },
      { x: corner.x + (next.x - corner.x) * cut, y: corner.y + (next.y - corner.y) * cut },
      ...corners.slice(k + 1),
    ];
  }
  const cos = Math.cos(heading);
  const sin = Math.sin(heading);
  const ring = local.map((p) =>
    roundPoint({ x: center.x + p.x * cos - p.y * sin, y: center.y + p.x * sin + p.y * cos }),
  );
  return signedPolygonArea(ring) < 0 ? ring.reverse() : ring;
}

interface PlacedParcel {
  polygon: MapPoint[];
  box: ReturnType<typeof boundingBox>;
  starter: boolean;
}

function parcelFits(layout: Layout, polygon: MapPoint[], placed: PlacedParcel[]): boolean {
  if (!isConvexPolygon(polygon)) return false;
  if (!polygon.every((p) => insideMap(p, EDGE_MARGIN_M))) return false;
  const box = boundingBox(polygon);
  for (const other of placed) {
    if (
      other.box.minX - PARCEL_GAP_M > box.maxX ||
      box.minX - PARCEL_GAP_M > other.box.maxX ||
      other.box.minY - PARCEL_GAP_M > box.maxY ||
      box.minY - PARCEL_GAP_M > other.box.maxY
    ) {
      continue;
    }
    if (convexPolygonsOverlap(polygon, other.polygon, PARCEL_GAP_M)) return false;
  }
  for (const circle of layout.exclusions) {
    if (pointPolygonDistance(circle, polygon) < circle.r) return false;
  }
  const riverClearance = RIVER_WIDTH_M / 2 + RIVER_BANK_M;
  if (polygonPolylineDistance(polygon, layout.river, riverClearance) < riverClearance) return false;
  for (const road of layout.roads) {
    const clearance = road.widthM / 2 + ROAD_VERGE_M;
    if (polygonPolylineDistance(polygon, road.points, clearance) < clearance) return false;
  }
  return true;
}

function placeParcels(layout: Layout): PlacedParcel[] {
  const placed: PlacedParcel[] = [];
  const random = rngFor(layout.seed, 'parcels');
  const accept = (polygon: MapPoint[], starter: boolean) =>
    placed.push({ polygon, box: boundingBox(polygon), starter });

  // Starter plots ring the villages, so new players start near a settlement.
  const villages = layout.villages;
  for (let n = 0; n < STARTER_PLOT_COUNT; n++) {
    for (let attempt = 0; attempt < 600; attempt++) {
      const village = villages[(n + Math.floor(attempt / 150)) % villages.length]!;
      const angle = random() * Math.PI * 2;
      const radius = village.scale * 130 + 40 + random() * 420;
      const center = {
        x: village.x + Math.cos(angle) * radius,
        y: village.y + Math.sin(angle) * radius,
      };
      const areaHa = randomBetween(random, STARTER_AREA_HA[0] + 0.05, STARTER_AREA_HA[1] - 0.05);
      const heading = nearestRoadHeading(center, layout.roads) + randomBetween(random, -0.15, 0.15);
      const polygon = makeParcelShape(random, center, areaHa * 10_000, heading);
      const actualHa = polygonArea(polygon) / 10_000;
      if (actualHa < STARTER_AREA_HA[0] || actualHa > STARTER_AREA_HA[1]) continue;
      if (parcelFits(layout, polygon, placed)) {
        accept(polygon, true);
        break;
      }
    }
  }

  // Larger holdings anywhere on the map; the target size shrinks when space is hard to find.
  for (
    let n = 0;
    placed.length < STARTER_PLOT_COUNT + REGULAR_PARCEL_COUNT && n < REGULAR_PARCEL_COUNT * 2;
    n++
  ) {
    let targetHa = REGULAR_AREA_HA[0] + (REGULAR_AREA_HA[1] - REGULAR_AREA_HA[0]) * random() ** 1.7;
    for (let attempt = 0; attempt < 800; attempt++) {
      if (attempt > 0 && attempt % 150 === 0)
        targetHa = Math.max(REGULAR_AREA_HA[0] + 0.3, targetHa * 0.8);
      const center = {
        x: randomBetween(random, -HALF_SIZE_M + 150, HALF_SIZE_M - 150),
        y: randomBetween(random, -HALF_SIZE_M + 150, HALF_SIZE_M - 150),
      };
      const areaHa = targetHa * randomBetween(random, 0.92, 1.08);
      const heading = nearestRoadHeading(center, layout.roads) + randomBetween(random, -0.2, 0.2);
      const polygon = makeParcelShape(random, center, areaHa * 10_000, heading);
      const actualHa = polygonArea(polygon) / 10_000;
      if (actualHa < REGULAR_AREA_HA[0] || actualHa > REGULAR_AREA_HA[1]) continue;
      if (parcelFits(layout, polygon, placed)) {
        accept(polygon, false);
        break;
      }
    }
  }
  return placed;
}

// ---------------------------------------------------------------------------
// Parcel environment and pricing

const SOIL_PH: Record<SoilTexture, number> = {
  laterite: 5.3,
  sandy_loam: 6.0,
  sandy: 6.4,
  loam: 6.6,
  clay_loam: 7.2,
  clay: 7.5,
};
const SOIL_FERTILITY: Record<SoilTexture, number> = {
  sandy: 0.25,
  laterite: 0.35,
  sandy_loam: 0.45,
  loam: 0.6,
  clay_loam: 0.68,
  clay: 0.7,
};
const DRAINAGE_ORDER: Drainage[] = ['poor', 'moderate', 'good'];
const WATER_VALUE: Record<WaterAccess, number> = { river: 1, canal: 0.85, well: 0.55, none: 0 };

/**
 * Soil zones: black alluvial clay along the river, red laterite / red sandy loam on the western
 * uplands, loams with black clay-loam patches on the eastern plain, river sand in a few spots.
 */
function soilAt(seed: number, p: MapPoint, riverDistance: number, slopePct: number): SoilTexture {
  const zoneNoise = fieldNoise(hashSeed(seed, 'soil-zone'), p.x, p.y, 900);
  const patchNoise = fieldNoise(hashSeed(seed, 'soil-patch'), p.x, p.y, 450);
  if (riverDistance < 160 && patchNoise > 0.45) return 'sandy';
  if (riverDistance < 320 + 180 * zoneNoise) return slopePct < 2.5 ? 'clay' : 'clay_loam';
  const westness = Math.min(1, Math.max(0, (-p.x - 200) / 1200)) + 0.35 * zoneNoise;
  if (westness > 0.6) return patchNoise > -0.15 ? 'laterite' : 'sandy_loam';
  if (westness > 0.3) return patchNoise > 0.1 ? 'sandy_loam' : 'loam';
  if (patchNoise > 0.3) return 'clay_loam';
  if (patchNoise < -0.4) return 'sandy_loam';
  return 'loam';
}

function drainageFor(texture: SoilTexture, slopePct: number, riverDistance: number): Drainage {
  const base: Record<SoilTexture, Drainage> = {
    sandy: 'good',
    sandy_loam: 'good',
    laterite: 'good',
    loam: slopePct >= 1.5 ? 'good' : 'moderate',
    clay_loam: 'moderate',
    clay: 'poor',
  };
  let index = DRAINAGE_ORDER.indexOf(base[texture]);
  if (slopePct > 5) index += 1;
  if (slopePct < 1 && riverDistance < 300) index -= 1;
  return DRAINAGE_ORDER[Math.min(2, Math.max(0, index))]!;
}

function waterAccessFor(
  layout: Layout,
  p: MapPoint,
  polygon: MapPoint[],
  riverDistance: number,
  elevationM: number,
): WaterAccess {
  if (riverDistance <= 150) return 'river';
  // Gravity canal from an upstream weir reaches low land along the valley.
  if (riverDistance <= 650 && elevationM <= riverLevelM(p.y) + 22) return 'canal';
  // Tank-fed channels irrigate land just around each kere.
  if (layout.tanks.some((tank) => pointPolygonDistance(tank, polygon) < tank.r + 300))
    return 'canal';
  const wellOdds = p.x < -700 ? 0.2 : 0.5;
  const roll = (fieldNoise(hashSeed(layout.seed, 'aquifer'), p.x, p.y, 500) + 1) / 2;
  return roll < wellOdds ? 'well' : 'none';
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function describeParcel(
  layout: Layout,
  placed: PlacedParcel & { centroid: MapPoint },
  index: number,
): GeneratedParcel {
  const { seed } = layout;
  const { polygon, centroid } = placed;
  const areaHa = Math.round((polygonArea(polygon) / 10_000) * 1000) / 1000;
  const elevationM = Math.round(terrainHeightM(seed, centroid.x, centroid.y));
  // Parcel-scale slope: average over the centroid and points halfway to each corner.
  const samples = [
    centroid,
    ...polygon.map((v) => ({ x: (v.x + centroid.x) / 2, y: (v.y + centroid.y) / 2 })),
  ];
  const slopePct =
    Math.round(
      (samples.reduce((sum, s) => sum + terrainSlopePct(seed, s.x, s.y), 0) / samples.length) * 10,
    ) / 10;
  const riverDistance = polygonPolylineDistance(polygon, layout.river);
  const soilTexture = soilAt(seed, centroid, riverDistance, slopePct);
  const noise = (salt: string, cell: number) =>
    fieldNoise(hashSeed(seed, salt), centroid.x, centroid.y, cell);
  const soilPh = Math.round(clamp(SOIL_PH[soilTexture] + 0.45 * noise('ph', 600), 5, 8) * 10) / 10;
  const fertility =
    Math.round(
      clamp(SOIL_FERTILITY[soilTexture] + 0.18 * noise('fertility', 500), 0.15, 0.95) * 100,
    ) / 100;
  const majorRoads = layout.roads.filter((r) => r.kind !== 'farm_track');
  const roadDistanceKm =
    Math.round(
      (Math.min(...majorRoads.map((r) => polygonPolylineDistance(polygon, r.points))) / 1000) * 100,
    ) / 100;

  const env: ParcelEnvironment = {
    areaHa,
    elevationM,
    slopePct,
    soilTexture,
    soilPh,
    fertility,
    drainage: drainageFor(soilTexture, slopePct, riverDistance),
    waterAccess: waterAccessFor(layout, centroid, polygon, riverDistance, elevationM),
    roadDistanceKm,
  };

  let nearestMarketId = layout.markets[0]!.id;
  let marketDistanceKm = Number.POSITIVE_INFINITY;
  for (const market of layout.markets) {
    const km = (distance(centroid, market) * ROAD_TRAVEL_FACTOR) / 1000 + roadDistanceKm;
    if (km < marketDistanceKm) {
      marketDistanceKm = km;
      nearestMarketId = market.id;
    }
  }
  marketDistanceKm = Math.round(marketDistanceKm * 100) / 100;

  const { basePricePaise, leaseRentPaisePerSeason } = priceParcel(env, marketDistanceKm);
  return {
    id: `HV-${String(index + 1).padStart(3, '0')}`,
    polygon,
    centroid: roundPoint(centroid),
    env,
    marketDistanceKm,
    nearestMarketId,
    basePricePaise,
    leaseRentPaisePerSeason,
    isStarterPlot: placed.starter,
  };
}

/**
 * Land value per hectare between ₹2 and ₹6 lakh: a floor plus premiums for secure water,
 * agronomic potential, road access and market proximity.
 * Seasonal lease rent is 8% of value, rising to 10% for land with secure water.
 */
function priceParcel(
  env: ParcelEnvironment,
  marketDistanceKm: number,
): { basePricePaise: number; leaseRentPaisePerSeason: number } {
  // Agronomic potential: mean score of the three best crops (rewards versatile land).
  const topThree = computeAllSuitability(env, HEMAVATI_CLIMATE).slice(0, 3);
  const quality = topThree.reduce((sum, result) => sum + result.score, 0) / (100 * topThree.length);
  const water = WATER_VALUE[env.waterAccess];
  const road = clamp(1 - env.roadDistanceKm / 1.2, 0, 1);
  const market = clamp(1 - (marketDistanceKm - 0.5) / 4.5, 0, 1);
  const lakhPerHa = clamp(
    1.2 + 1.4 * water + 2.4 * quality * quality + 0.6 * road + 0.5 * market,
    2,
    6,
  );
  const rupees = lakhPerHa * 100_000 * env.areaHa;
  const basePricePaise = roundHalfAwayFromZero(rupees / 1000) * 1000 * 100;
  const rentRate = 0.08 + 0.02 * water;
  const leaseRentPaisePerSeason =
    roundHalfAwayFromZero((basePricePaise * rentRate) / 10_000) * 10_000;
  return { basePricePaise, leaseRentPaisePerSeason };
}

// ---------------------------------------------------------------------------
// Decorative trees in the gaps between parcels, roads and the river

function placeTreeClusters(layout: Layout, parcels: GeneratedParcel[]): GeneratedFeature[] {
  const random = rngFor(layout.seed, 'trees');
  const trees: GeneratedFeature[] = [];
  for (let attempt = 0; attempt < 1500 && trees.length < 48; attempt++) {
    const p = {
      x: randomBetween(random, -HALF_SIZE_M + 40, HALF_SIZE_M - 40),
      y: randomBetween(random, -HALF_SIZE_M + 40, HALF_SIZE_M - 40),
    };
    const scale = 0.7 + random() * 0.9;
    const radius = 18 * scale;
    if (parcels.some((parcel) => pointPolygonDistance(p, parcel.polygon) < radius + 4)) continue;
    if (layout.exclusions.some((c) => distance(c, p) < c.r * 0.8 + radius)) continue;
    if (pointPolylineDistance(p, layout.river) < RIVER_WIDTH_M / 2 + radius + 6) continue;
    if (layout.roads.some((r) => pointPolylineDistance(p, r.points) < r.widthM / 2 + radius + 3))
      continue;
    if (trees.some((t) => distance(t, p) < 70)) continue;
    trees.push({
      id: `tree-cluster-${trees.length + 1}`,
      kind: 'tree_cluster',
      x: Math.round(p.x * 10) / 10,
      y: Math.round(p.y * 10) / 10,
      rotation: Math.round(random() * Math.PI * 2 * 1000) / 1000,
      scale: Math.round(scale * 100) / 100,
    });
  }
  return trees;
}
