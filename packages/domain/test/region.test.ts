import { describe, expect, it } from 'vitest';
import {
  computeAllSuitability,
  districtClimate,
  generateRegion,
  haToAcres,
  pointInPolygon,
  projectLatLon,
  stateClimate,
  tamilSeasonOfMonth,
  TN_DISTRICTS,
  unprojectToLatLon,
} from '../src';

const region = generateRegion();

describe('Tamil Nadu region', () => {
  it('is deterministic', () => {
    expect(generateRegion()).toEqual(region);
  });

  it('uses the real 32 districts and 234 assembly-constituency segments', () => {
    expect(region.districts).toHaveLength(32);
    expect(region.segments).toHaveLength(234);
    for (const d of region.districts!) expect(TN_DISTRICTS[d.id]).toBeDefined();
    const names = new Set(region.segments!.map((s) => s.name));
    for (const n of ['Thanjavur', 'Thiruvaiyaru', 'Kumbakonam', 'Mannargudi'])
      expect(names.has(n)).toBe(true);
  });

  it('assigns delta segments to delta districts', () => {
    const byName = new Map(region.segments!.map((s) => [s.name, s.districtId]));
    expect(byName.get('Thanjavur')).toBe('thanjavur');
    expect(byName.get('Mannargudi')).toBe('thiruvarur');
    expect(byName.get('Ponneri')).toBe('thiruvallur');
  });

  it('projects real places consistently', () => {
    const thanjavur = projectLatLon(10.79, 79.14);
    const seg = region.segments!.find((s) => s.name === 'Thanjavur')!;
    expect(
      pointInPolygon(thanjavur, seg.polygon) ||
        Math.hypot(thanjavur.x - seg.centroid.x, thanjavur.y - seg.centroid.y) < 15_000,
    ).toBe(true);
    const back = unprojectToLatLon(thanjavur);
    expect(back.lat).toBeCloseTo(10.79, 2);
    expect(back.lon).toBeCloseTo(79.14, 2);
  });

  it('places holdings inside their segment with acre-scale sizes', () => {
    expect(region.parcels.length).toBeGreaterThan(1200);
    const segs = new Map(region.segments!.map((s) => [s.id, s]));
    for (const p of region.parcels) {
      const seg = segs.get(p.segmentId!)!;
      expect(seg).toBeDefined();
      expect(pointInPolygon(p.centroid, seg.polygon)).toBe(true);
      expect(p.env.districtId).toBe(seg.districtId);
      const acres = haToAcres(p.env.areaHa);
      expect(acres).toBeGreaterThanOrEqual(0.9);
      expect(acres).toBeLessThanOrEqual(15.1);
      expect(Number.isSafeInteger(p.basePricePaise)).toBe(true);
      expect(Number.isSafeInteger(p.leaseRentPaisePerSeason)).toBe(true);
    }
    expect(new Set(region.parcels.map((p) => p.id)).size).toBe(region.parcels.length);
  });

  it('has starter plots in every rural district and none in Chennai', () => {
    const starters = region.parcels.filter((p) => p.isStarterPlot);
    expect(starters.length).toBe(62);
    expect(region.parcels.some((p) => p.districtId === 'chennai')).toBe(false);
  });

  it('has one mandi per district with Koyambedu as the largest', () => {
    expect(region.markets).toHaveLength(32);
    const koyambedu = region.markets.find((m) => m.id === 'mandi-chennai')!;
    expect(koyambedu.demandScale).toBeGreaterThan(2);
  });

  it('gives each district a plausible climate', () => {
    const delta = districtClimate('thanjavur');
    // North-east monsoon (Oct–Dec) dominates the delta.
    const ne = delta.monthlyRainMm.slice(9, 12).reduce((a, b) => a + b, 0);
    const sw = delta.monthlyRainMm.slice(5, 9).reduce((a, b) => a + b, 0);
    expect(ne).toBeGreaterThan(sw);
    const annual = delta.monthlyRainMm.reduce((a, b) => a + b, 0);
    expect(annual).toBeGreaterThan(1050);
    expect(annual).toBeLessThan(1150);
    expect(districtClimate('the-nilgiris').monthlyMeanTempC[4]).toBeLessThan(22);
    expect(stateClimate().monthlyRainMm).toHaveLength(12);
  });

  it('makes rice the strong choice on irrigated delta clay', () => {
    const deltaRice = region.parcels.find(
      (p) =>
        p.districtId === 'thanjavur' &&
        p.env.soilTexture === 'clay' &&
        p.env.waterAccess !== 'none',
    )!;
    expect(deltaRice).toBeDefined();
    const ranked = computeAllSuitability(deltaRice.env, districtClimate('thanjavur'));
    expect(ranked.slice(0, 3).map((r) => r.cropId)).toContain('rice');
  });

  it('names Tamil seasons', () => {
    expect(tamilSeasonOfMonth(7).name).toBe('Kuruvai');
    expect(tamilSeasonOfMonth(10).id).toBe('samba');
    expect(tamilSeasonOfMonth(1).id).toBe('navarai');
  });
});
