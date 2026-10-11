import { describe, expect, it } from 'vitest';
import {
  DEFAULT_REGION_ID,
  DEFAULT_REGION_SEED,
  HEMAVATI_CLIMATE,
  MIN_LOAN_CAP_PAISE,
  SOIL_TEXTURES,
  STARTING_CASH_PAISE,
  computeAllSuitability,
  generateRegion,
  isConvexPolygon,
  polygonArea,
  polygonPolylineDistance,
  riverCenterX,
  signedPolygonArea,
  terrainHeightM,
  terrainSlopePct,
  type MapPoint,
} from '../src';

const region = generateRegion();

/** Independent overlap check: any edge crossing, or any vertex of one ring inside the other. */
function ringsOverlap(a: MapPoint[], b: MapPoint[]): boolean {
  const cross = (o: MapPoint, p: MapPoint, q: MapPoint) =>
    (p.x - o.x) * (q.y - o.y) - (p.y - o.y) * (q.x - o.x);
  const inside = (p: MapPoint, ring: MapPoint[]) => {
    let result = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const u = ring[i]!;
      const v = ring[j]!;
      if (u.y > p.y !== v.y > p.y && p.x < u.x + ((p.y - u.y) * (v.x - u.x)) / (v.y - u.y))
        result = !result;
    }
    return result;
  };
  for (let i = 0; i < a.length; i++) {
    const p1 = a[i]!;
    const p2 = a[(i + 1) % a.length]!;
    for (let j = 0; j < b.length; j++) {
      const q1 = b[j]!;
      const q2 = b[(j + 1) % b.length]!;
      const d1 = cross(q1, q2, p1);
      const d2 = cross(q1, q2, p2);
      const d3 = cross(p1, p2, q1);
      const d4 = cross(p1, p2, q2);
      if (d1 * d2 < 0 && d3 * d4 < 0) return true;
    }
  }
  return a.some((p) => inside(p, b)) || b.some((p) => inside(p, a));
}

describe('generateRegion', () => {
  it('is deterministic for a seed and differs across seeds', () => {
    expect(generateRegion(DEFAULT_REGION_SEED, DEFAULT_REGION_ID)).toEqual(region);
    const other = generateRegion(12345);
    expect(other.parcels[0]!.polygon).not.toEqual(region.parcels[0]!.polygon);
    expect(generateRegion(12345, 'alt').id).toBe('alt');
  });

  it('describes the Hemavati Valley', () => {
    expect(region).toMatchObject({
      id: 'hemavati',
      name: 'Hemavati Valley',
      seed: DEFAULT_REGION_SEED,
      halfSizeM: 2000,
    });
    expect(region.climate).toEqual(HEMAVATI_CLIMATE);
    const annualRain = HEMAVATI_CLIMATE.monthlyRainMm.reduce((a, b) => a + b, 0);
    expect(annualRain).toBeGreaterThan(1000);
    expect(annualRain).toBeLessThan(1200);
  });

  it('places ~96 parcels with stable ids, a third of them starter plots', () => {
    expect(region.parcels).toHaveLength(96);
    expect(region.parcels.map((p) => p.id)).toEqual(
      Array.from({ length: 96 }, (_, i) => `HV-${String(i + 1).padStart(3, '0')}`),
    );
    const starters = region.parcels.filter((p) => p.isStarterPlot);
    expect(starters).toHaveLength(32);
    for (const parcel of region.parcels) {
      const [min, max] = parcel.isStarterPlot ? [0.5, 1.5] : [2, 12];
      expect(parcel.env.areaHa).toBeGreaterThanOrEqual(min);
      expect(parcel.env.areaHa).toBeLessThanOrEqual(max);
    }
  });

  it('builds valid counter-clockwise convex polygons inside the map whose area matches', () => {
    for (const parcel of region.parcels) {
      expect(parcel.polygon.length).toBeGreaterThanOrEqual(4);
      expect(signedPolygonArea(parcel.polygon)).toBeGreaterThan(0);
      expect(isConvexPolygon(parcel.polygon)).toBe(true);
      expect(polygonArea(parcel.polygon) / 10_000).toBeCloseTo(parcel.env.areaHa, 2);
      for (const p of parcel.polygon) {
        expect(Math.abs(p.x)).toBeLessThan(region.halfSizeM);
        expect(Math.abs(p.y)).toBeLessThan(region.halfSizeM);
      }
    }
  });

  it('never overlaps parcels with each other, the river or roads', () => {
    const parcels = region.parcels;
    for (let i = 0; i < parcels.length; i++) {
      for (let j = i + 1; j < parcels.length; j++) {
        expect(
          ringsOverlap(parcels[i]!.polygon, parcels[j]!.polygon),
          `${parcels[i]!.id} vs ${parcels[j]!.id}`,
        ).toBe(false);
      }
      const polygon = parcels[i]!.polygon;
      expect(polygonPolylineDistance(polygon, region.river.points)).toBeGreaterThan(
        region.river.widthM / 2,
      );
      for (const road of region.roads) {
        expect(
          polygonPolylineDistance(polygon, road.points),
          `${parcels[i]!.id} vs ${road.id}`,
        ).toBeGreaterThan(road.widthM / 2);
      }
    }
  });

  it('lays out a north–south river, roads of every class and landmarks', () => {
    const river = region.river.points;
    expect(river[0]!.y).toBe(-2000);
    expect(river.at(-1)!.y).toBe(2000);
    expect(new Set(region.roads.map((r) => r.kind))).toEqual(
      new Set(['highway', 'district', 'village', 'farm_track']),
    );
    const kinds = new Set(region.features.map((f) => f.kind));
    for (const kind of ['village', 'warehouse', 'temple', 'water_tank', 'tree_cluster', 'school']) {
      expect(kinds.has(kind as never)).toBe(true);
    }
    expect(new Set(region.features.map((f) => f.id)).size).toBe(region.features.length);
    expect(new Set(region.roads.map((r) => r.id)).size).toBe(region.roads.length);
  });

  it('has the two markets with the documented terms', () => {
    const [apmc, district] = region.markets;
    expect(apmc).toMatchObject({ id: 'hemavati-apmc', feeBps: 100, priceScale: 1, demandScale: 1 });
    expect(district).toMatchObject({ id: 'district-market', feeBps: 150 });
    expect(district!.priceScale).toBeGreaterThan(1);
    expect(district!.demandScale).toBeGreaterThan(1);
    expect(apmc!.x).toBeGreaterThan(0);
    expect(Math.max(Math.abs(district!.x), Math.abs(district!.y))).toBeGreaterThan(1500);
    const nearest = new Set(region.parcels.map((p) => p.nearestMarketId));
    expect(nearest).toEqual(new Set(['hemavati-apmc', 'district-market']));
  });

  it('derives varied, plausible environments consistent with the terrain', () => {
    const soils = new Set(region.parcels.map((p) => p.env.soilTexture));
    expect(soils.size).toBeGreaterThanOrEqual(5);
    for (const soil of soils) expect(SOIL_TEXTURES).toContain(soil);
    const access = new Set(region.parcels.map((p) => p.env.waterAccess));
    expect(access).toEqual(new Set(['river', 'canal', 'well', 'none']));
    for (const parcel of region.parcels) {
      const { env, centroid } = parcel;
      expect(env.elevationM).toBe(Math.round(terrainHeightM(region.seed, centroid.x, centroid.y)));
      expect(env.elevationM).toBeGreaterThan(850);
      expect(env.elevationM).toBeLessThan(1100);
      expect(env.soilPh).toBeGreaterThanOrEqual(5);
      expect(env.soilPh).toBeLessThanOrEqual(8);
      expect(env.fertility > 0 && env.fertility < 1).toBe(true);
      expect(env.slopePct).toBeGreaterThanOrEqual(0);
      expect(env.roadDistanceKm).toBeGreaterThanOrEqual(0);
      expect(parcel.marketDistanceKm).toBeGreaterThan(0);
      if (env.waterAccess === 'river') {
        expect(polygonPolylineDistance(parcel.polygon, region.river.points)).toBeLessThanOrEqual(
          150,
        );
      }
    }
    // Western uplands are higher and red; the river corridor is black clay.
    const west = region.parcels.filter((p) => p.centroid.x < -1200);
    const valley = region.parcels.filter(
      (p) => Math.abs(p.centroid.x - riverCenterX(region.seed, p.centroid.y)) < 300,
    );
    const mean = (list: typeof west) =>
      list.reduce((s, p) => s + p.env.elevationM, 0) / list.length;
    expect(mean(west)).toBeGreaterThan(mean(valley) + 40);
    expect(
      west.filter((p) => ['laterite', 'sandy_loam'].includes(p.env.soilTexture)).length /
        west.length,
    ).toBeGreaterThan(0.5);
    expect(
      valley.filter((p) => ['clay', 'clay_loam', 'sandy'].includes(p.env.soilTexture)).length /
        valley.length,
    ).toBeGreaterThan(0.6);
  });

  it('prices land at ₹2–6 lakh per hectare with 8–10% seasonal rent, in safe integer paise', () => {
    for (const parcel of region.parcels) {
      expect(Number.isSafeInteger(parcel.basePricePaise)).toBe(true);
      expect(Number.isSafeInteger(parcel.leaseRentPaisePerSeason)).toBe(true);
      const lakhPerHa = parcel.basePricePaise / 100 / 100_000 / parcel.env.areaHa;
      expect(lakhPerHa).toBeGreaterThanOrEqual(1.98);
      expect(lakhPerHa).toBeLessThanOrEqual(6.02);
      const rent = parcel.leaseRentPaisePerSeason / parcel.basePricePaise;
      expect(rent).toBeGreaterThanOrEqual(0.079);
      expect(rent).toBeLessThanOrEqual(0.101);
    }
    // Water and potential are priced in: river land costs more per hectare than dry land.
    const perHa = (access: string) => {
      const list = region.parcels.filter((p) => p.env.waterAccess === access);
      return list.reduce((s, p) => s + p.basePricePaise / p.env.areaHa, 0) / list.length;
    };
    expect(perHa('river')).toBeGreaterThan(perHa('none'));
    // Beyond the free starter plot, a new player can lease land at once and buy a first
    // holding with starting cash plus the minimum loan cap.
    const regular = region.parcels.filter((p) => !p.isStarterPlot);
    const cheapest = Math.min(...regular.map((p) => p.basePricePaise));
    expect(cheapest).toBeLessThanOrEqual(STARTING_CASH_PAISE + MIN_LOAN_CAP_PAISE);
    const cheapRents = regular.filter(
      (p) => p.leaseRentPaisePerSeason <= STARTING_CASH_PAISE * 0.15,
    );
    expect(cheapRents.length).toBeGreaterThanOrEqual(3);
  });

  it('offers land where every launch crop has a good home', () => {
    const bestCrops = new Set(
      region.parcels.map((p) => computeAllSuitability(p.env, region.climate)[0]!.cropId),
    );
    for (const crop of ['rice', 'ragi', 'maize', 'sugarcane'])
      expect(bestCrops.has(crop as never)).toBe(true);
  });
});

describe('terrain', () => {
  it('is smooth, deterministic and carves the river valley', () => {
    const seed = DEFAULT_REGION_SEED;
    expect(terrainHeightM(seed, 123, 456)).toBe(terrainHeightM(seed, 123, 456));
    for (let y = -1800; y <= 1800; y += 300) {
      const riverX = riverCenterX(seed, y);
      const atRiver = terrainHeightM(seed, riverX, y);
      expect(atRiver).toBeLessThan(terrainHeightM(seed, riverX - 1200, y));
      // Neighbouring samples 10 m apart differ by well under a metre or two.
      expect(
        Math.abs(terrainHeightM(seed, riverX + 600, y) - terrainHeightM(seed, riverX + 610, y)),
      ).toBeLessThan(2);
    }
    let maxSlope = 0;
    for (let x = -1900; x <= 1900; x += 100) {
      for (let y = -1900; y <= 1900; y += 100) {
        const h = terrainHeightM(seed, x, y);
        expect(h).toBeGreaterThan(850);
        expect(h).toBeLessThan(1100);
        // The river channel's banks are steep by design; measure the land around it.
        if (Math.abs(x - riverCenterX(seed, y)) > 60)
          maxSlope = Math.max(maxSlope, terrainSlopePct(seed, x, y));
      }
    }
    expect(maxSlope).toBeLessThan(25);
    expect(terrainHeightM(seed, -1900, 0)).toBeGreaterThan(terrainHeightM(seed, 1900, 0));
  });
});
