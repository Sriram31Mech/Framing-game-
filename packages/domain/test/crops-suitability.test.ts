import { describe, expect, it } from 'vitest';
import {
  CROP_IDS,
  CROP_STAGES,
  CROPS,
  DRAINAGE_CLASSES,
  HEMAVATI_CLIMATE,
  SUITABILITY_FACTOR_KEYS,
  computeAllSuitability,
  computeSuitability,
  cropDurationDays,
  estimateCropEconomics,
  getCrop,
  growingPeriodClimate,
  isSowingOpen,
  plantingCostPaise,
  scoreRange4,
  type ParcelEnvironment,
  type Range4,
} from '../src';
import { ENVS } from './helpers';

function expectOrdered(range: Range4) {
  expect(range.min).toBeLessThanOrEqual(range.optMin);
  expect(range.optMin).toBeLessThan(range.optMax);
  expect(range.optMax).toBeLessThanOrEqual(range.max);
}

describe('crop data', () => {
  it.each(CROP_IDS)('%s has complete, consistent data', (id) => {
    const crop = CROPS[id];
    expect(crop.id).toBe(id);
    expect(getCrop(id)).toBe(crop);
    expect(crop.stages.map((s) => s.id)).toEqual([...CROP_STAGES]);
    for (const stage of crop.stages) expect(stage.days).toBeGreaterThan(0);
    expect(crop.sowingMonths.length).toBeGreaterThan(0);
    for (const month of crop.sowingMonths) expect(month >= 1 && month <= 12).toBe(true);
    expect(crop.harvestWindowDays).toBeGreaterThan(0);
    const { requirements: req } = crop;
    for (const range of [req.tempC, req.rainMm, req.ph, req.elevationM]) expectOrdered(range);
    for (const drainage of DRAINAGE_CLASSES) {
      expect(req.drainage[drainage]).toBeGreaterThanOrEqual(0);
      expect(req.drainage[drainage]).toBeLessThanOrEqual(1);
    }
    for (const affinity of Object.values(req.soils))
      expect(affinity >= 0 && affinity <= 1).toBe(true);
    expect(crop.seasonalPriceFactor).toHaveLength(12);
    const meanFactor = crop.seasonalPriceFactor.reduce((a, b) => a + b, 0) / 12;
    expect(meanFactor).toBeGreaterThan(0.97);
    expect(meanFactor).toBeLessThan(1.03);
    for (const value of Object.values(crop.costs))
      expect(Number.isSafeInteger(value) && value > 0).toBe(true);
    expect(Number.isSafeInteger(crop.basePricePaisePerKg)).toBe(true);
    expect(crop.baseYieldKgPerHa).toBeGreaterThan(0);
    expect(crop.baseDemandKgPerDay).toBeGreaterThan(0);
    expect(crop.shelfLifeDays).toBeGreaterThan(0);
    for (const sensitivity of Object.values(crop.risk))
      expect(sensitivity >= 0 && sensitivity <= 1).toBe(true);
  });

  it('has the documented crop identities', () => {
    expect(cropDurationDays(CROPS.sugarcane)).toBeGreaterThanOrEqual(300);
    expect(cropDurationDays(CROPS.tomato)).toBeLessThanOrEqual(105);
    expect(CROPS.tomato.shelfLifeDays).toBe(12);
    expect(isSowingOpen(CROPS.rice, 7)).toBe(true);
    expect(isSowingOpen(CROPS.rice, 12)).toBe(false);
    expect(isSowingOpen(CROPS.chickpea, 11)).toBe(true);
    expect(isSowingOpen(CROPS.tomato, 7)).toBe(false);
    expect(isSowingOpen(CROPS.maize, 6) && isSowingOpen(CROPS.maize, 11)).toBe(true);
    expect(CROPS.sugarcane.sowingMonths).toEqual([1, 2, 3]);
  });

  it('computes planting costs as integer paise honouring options', () => {
    const rice = CROPS.rice;
    const base = rice.costs.seedPaisePerHa + rice.costs.sowingLaborPaisePerHa;
    expect(plantingCostPaise(rice, 1, { fertilize: false })).toBe(base);
    expect(plantingCostPaise(rice, 1, { fertilize: true })).toBe(
      base + rice.costs.fertilizerPaisePerHa,
    );
    const withTractor = plantingCostPaise(rice, 1.333, {
      fertilize: false,
      sowingLaborMultiplier: 0.6,
    });
    expect(Number.isSafeInteger(withTractor)).toBe(true);
    expect(withTractor).toBeLessThan(plantingCostPaise(rice, 1.333, { fertilize: false }));
  });

  it.each(CROP_IDS)('%s is profitable at base yield and price with recommended inputs', (id) => {
    const crop = CROPS[id];
    const economics = estimateCropEconomics(crop, {
      areaHa: 1,
      yieldKgPerHa: crop.baseYieldKgPerHa * 0.9,
      pricePaisePerKg: crop.basePricePaisePerKg,
      fertilize: true,
      irrigate: crop.requirements.waterNeed !== 'low',
    });
    const margin = economics.profitPaise / economics.revenuePaise;
    expect(margin).toBeGreaterThan(0.2);
    expect(margin).toBeLessThan(0.65);
    for (const value of Object.values(economics)) expect(Number.isSafeInteger(value)).toBe(true);
  });
});

describe('suitability', () => {
  const riverRice = computeSuitability(CROPS.rice, ENVS.riverClay, HEMAVATI_CLIMATE, {
    sowingDay: 0,
  });

  it('scores Range4 values with linear falloff', () => {
    const range = { min: 4, optMin: 6, optMax: 7, max: 9 };
    expect(scoreRange4(6.5, range)).toBe(1);
    expect(scoreRange4(5, range)).toBe(0.5);
    expect(scoreRange4(8.5, range)).toBe(0.25);
    expect(scoreRange4(3, range)).toBe(0);
    expect(scoreRange4(10, range)).toBe(0);
  });

  it('returns explainable factors whose weights sum to 1', () => {
    expect(riverRice.factors.map((f) => f.key).sort()).toEqual([...SUITABILITY_FACTOR_KEYS].sort());
    const weightSum = riverRice.factors.reduce((sum, f) => sum + f.weight, 0);
    expect(weightSum).toBeCloseTo(1, 10);
    for (const factor of riverRice.factors) {
      expect(factor.score >= 0 && factor.score <= 1).toBe(true);
      expect(factor.label.length).toBeGreaterThan(0);
      expect(factor.detail.length).toBeGreaterThan(10);
    }
    expect(riverRice.irrigationAssumed).toBe(true);
    expect(riverRice.factors.find((f) => f.key === 'water')!.detail).toMatch(
      /Irrigation from the river/,
    );
  });

  it('explains pH problems in plain words', () => {
    const detail = (soilPh: number) =>
      computeSuitability(CROPS.chickpea, { ...ENVS.canalClayLoam, soilPh }, HEMAVATI_CLIMATE, {
        sowingDay: 150,
      }).factors.find((f) => f.key === 'ph')!.detail;
    expect(detail(6)).toBe('pH 6.0 is below the optimum 6.5–7.8');
    expect(detail(5.2)).toBe('pH 5.2 is below the minimum 5.5 (optimum 6.5–7.8)');
    expect(detail(7)).toBe('pH 7.0 is within the optimum 6.5–7.8');
  });

  it('picks the lowest-scoring factor as limiting and grades by score band', () => {
    const result = computeSuitability(CROPS.rice, ENVS.dryLaterite, HEMAVATI_CLIMATE);
    const lowest = Math.min(...result.factors.map((f) => f.score));
    expect(result.factors.find((f) => f.key === result.limitingFactor)!.score).toBe(lowest);
    expect(['poor', 'unsuitable']).toContain(result.grade);
    expect(['excellent', 'good']).toContain(riverRice.grade);
    expect(riverRice.score).toBeGreaterThan(result.score);
  });

  it('ranks rice best on irrigated clay near the river', () => {
    const ranked = computeAllSuitability(ENVS.riverClay, HEMAVATI_CLIMATE, { sowingDay: 0 });
    expect(ranked[0]!.cropId).toBe('rice');
    for (let i = 1; i < ranked.length; i++) {
      expect(ranked[i - 1]!.score).toBeGreaterThanOrEqual(ranked[i]!.score);
    }
  });

  it('ranks ragi best on dry laterite uplands', () => {
    const ranked = computeAllSuitability(ENVS.dryLaterite, HEMAVATI_CLIMATE, { sowingDay: 30 });
    expect(ranked[0]!.cropId).toBe('ragi');
    expect(ranked[0]!.grade).toBe('excellent');
    const rice = ranked.find((r) => r.cropId === 'rice')!;
    expect(rice.irrigationAssumed).toBe(false);
    expect(rice.factors.find((f) => f.key === 'water')!.detail).toMatch(/short of the need/);
  });

  it('rates chickpea poorly on waterlogged ground', () => {
    const waterlogged: ParcelEnvironment = {
      ...ENVS.canalClayLoam,
      soilTexture: 'clay',
      drainage: 'poor',
    };
    const wet = computeSuitability(CROPS.chickpea, waterlogged, HEMAVATI_CLIMATE, {
      sowingDay: 150,
    });
    const dry = computeSuitability(CROPS.chickpea, ENVS.canalClayLoam, HEMAVATI_CLIMATE, {
      sowingDay: 150,
    });
    expect(wet.limitingFactor).toBe('drainage');
    expect(['poor', 'unsuitable']).toContain(wet.grade);
    expect(dry.score - wet.score).toBeGreaterThan(20);
  });

  it('credits irrigation only when the parcel can be irrigated (or it is requested)', () => {
    const rainfed = computeSuitability(CROPS.rice, ENVS.riverClay, HEMAVATI_CLIMATE, {
      sowingDay: 0,
      irrigated: false,
    });
    expect(rainfed.irrigationAssumed).toBe(false);
    expect(rainfed.score).toBeLessThan(riverRice.score);
    expect(rainfed.yieldKgPerHa.expected).toBeLessThan(riverRice.yieldKgPerHa.expected);
    const pumped = computeSuitability(CROPS.rice, ENVS.dryLaterite, HEMAVATI_CLIMATE, {
      irrigated: true,
    });
    expect(pumped.factors.find((f) => f.key === 'water')!.score).toBe(1);
  });

  it('gives an ordered yield range that widens with risk', () => {
    for (const result of [
      riverRice,
      computeSuitability(CROPS.tomato, ENVS.dryLaterite, HEMAVATI_CLIMATE),
    ]) {
      const { low, expected, high } = result.yieldKgPerHa;
      expect(low).toBeLessThanOrEqual(expected);
      expect(expected).toBeLessThanOrEqual(high);
      expect(Number.isInteger(low) && Number.isInteger(expected) && Number.isInteger(high)).toBe(
        true,
      );
    }
    const rainfed = computeSuitability(CROPS.rice, ENVS.riverClay, HEMAVATI_CLIMATE, {
      sowingDay: 0,
      irrigated: false,
    });
    const spread = (r: typeof riverRice) => 1 - r.yieldKgPerHa.low / r.yieldKgPerHa.expected;
    expect(spread(rainfed)).toBeGreaterThan(spread(riverRice));
  });

  it('reports sowing windows from the sowing day', () => {
    const december = 190; // 11 Dec, Year 1
    const result = computeSuitability(CROPS.rice, ENVS.riverClay, HEMAVATI_CLIMATE, {
      sowingDay: december,
    });
    expect(result.sowingOpen).toBe(false);
    expect(result.nextSowingMonth).toBe(6);
    const chickpea = computeSuitability(CROPS.chickpea, ENVS.riverClay, HEMAVATI_CLIMATE, {
      sowingDay: december,
    });
    expect(chickpea.sowingOpen).toBe(true);
    expect(chickpea.nextSowingMonth).toBe(12);
  });

  it('cools the growing season with elevation via the lapse rate', () => {
    const low = growingPeriodClimate(CROPS.ragi, HEMAVATI_CLIMATE, 7, 950);
    const high = growingPeriodClimate(CROPS.ragi, HEMAVATI_CLIMATE, 7, 1950);
    expect(low.meanTempC - high.meanTempC).toBeCloseTo(6.5, 6);
    expect(low.rainMm).toBe(high.rainMm);
    // Ragi sown in July sees Jul–Oct rains.
    expect(low.rainMm).toBeGreaterThan(550);
    expect(low.rainMm).toBeLessThan(750);
  });
});
