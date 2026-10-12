import { describe, expect, it } from 'vitest';
import {
  CROPS,
  OVERRIPE_FAIL_DAYS,
  advanceCropDay,
  canIrrigate,
  createPlotState,
  dailyIrrigationCostPaise,
  estimateHarvest,
  generateWeather,
  growthProgress,
  monthOfDay,
  rngFor,
  type CropPlotState,
  type DailyWeather,
} from '../src';
import { ENVS, HEMAVATI_CLIMATE, simulateSeason } from './helpers';

describe('weather', () => {
  it('is a pure function of (seed, day)', () => {
    for (const day of [0, 17, 200, 719]) {
      expect(generateWeather(7, day, HEMAVATI_CLIMATE)).toEqual(
        generateWeather(7, day, HEMAVATI_CLIMATE),
      );
    }
    const a = Array.from({ length: 60 }, (_, d) => generateWeather(1, d, HEMAVATI_CLIMATE).rainMm);
    const b = Array.from({ length: 60 }, (_, d) => generateWeather(2, d, HEMAVATI_CLIMATE).rainMm);
    expect(a).not.toEqual(b);
  });

  it('produces monsoon-shaped annual rain in a plausible band', () => {
    const totals: number[] = [];
    const monthly = new Array<number>(12).fill(0);
    for (let seed = 1; seed <= 12; seed++) {
      let total = 0;
      for (let day = 0; day < 360; day++) {
        const w = generateWeather(seed, day, HEMAVATI_CLIMATE);
        expect(w.rainMm).toBeGreaterThanOrEqual(0);
        expect(w.tempC).toBeGreaterThan(10);
        expect(w.tempC).toBeLessThan(40);
        total += w.rainMm;
        monthly[monthOfDay(day) - 1]! += w.rainMm;
      }
      totals.push(total);
    }
    const mean = totals.reduce((a, b) => a + b, 0) / totals.length;
    expect(mean).toBeGreaterThan(900);
    expect(mean).toBeLessThan(1300);
    for (const total of totals) expect(total > 500 && total < 2200).toBe(true);
    // Jun–Oct carries most of the rain; Jan–Feb are nearly dry.
    const monsoon = monthly.slice(5, 10).reduce((a, b) => a + b, 0);
    expect(monsoon / monthly.reduce((a, b) => a + b, 0)).toBeGreaterThan(0.7);
    expect((monthly[0]! + monthly[1]!) / 12).toBeLessThan(25);
  });

  it('emits persistent multi-day events including pest outbreaks', () => {
    const counts: Record<string, number> = {};
    let longestDrySpell = 0;
    let run = 0;
    for (let day = 0; day < 720; day++) {
      const w = generateWeather(3, day, HEMAVATI_CLIMATE);
      counts[w.event] = (counts[w.event] ?? 0) + 1;
      run = w.event === 'dry_spell' ? run + 1 : 0;
      longestDrySpell = Math.max(longestDrySpell, run);
      if (w.event === 'heavy_rain') expect(w.rainMm).toBeGreaterThanOrEqual(30);
    }
    expect(counts.pest_outbreak).toBeGreaterThan(0);
    expect(counts.heatwave).toBeGreaterThan(0);
    expect(counts.dry_spell).toBeGreaterThan(0);
    expect(longestDrySpell).toBeGreaterThanOrEqual(7);
    expect(counts.none!).toBeGreaterThan(500);
  });
});

function fixedWeather(overrides: Partial<DailyWeather> = {}): (day: number) => DailyWeather {
  return (day) => ({ day, rainMm: 0, tempC: 24, event: 'none', ...overrides });
}

describe('crop growth', () => {
  const rice = CROPS.rice;

  it('takes a well-managed, suited crop to maturity near its expected yield', () => {
    for (const seed of [1, 2, 3]) {
      const season = simulateSeason({
        cropId: 'rice',
        env: ENVS.canalClayLoam,
        sowDay: 0,
        seed,
        irrigate: true,
        fertilize: true,
        pestControl: true,
      });
      expect(season.state.status).toBe('ready');
      expect(season.days).toBe(125);
      expect(season.state.yieldPotentialKgPerHa).toBeGreaterThan(season.expectedKgPerHa * 0.9);
      const stages = season.events
        .filter((e) => e.type === 'stage_changed')
        .map((e) => e.type === 'stage_changed' && e.stage);
      expect(stages).toEqual(['vegetative', 'flowering', 'maturation']);
      expect(season.events.filter((e) => e.type === 'ready')).toHaveLength(1);
      const harvest = estimateHarvest(season.state, rice);
      expect(harvest.quantityKg).toBe(Math.floor(season.state.yieldPotentialKgPerHa));
      expect(harvest.quality).toBeGreaterThanOrEqual(90);
    }
  });

  it('loses yield to drought without irrigation', () => {
    const run = (irrigate: boolean, seed: number) =>
      simulateSeason({
        cropId: 'rice',
        env: ENVS.canalClayLoam,
        sowDay: 0,
        seed,
        irrigate,
        fertilize: true,
        pestControl: true,
      });
    for (const seed of [1, 2, 3, 4]) {
      const irrigated = run(true, seed);
      const rainfed = run(false, seed);
      expect(rainfed.state.yieldPotentialKgPerHa).toBeLessThan(
        irrigated.state.yieldPotentialKgPerHa * 0.75,
      );
      expect(rainfed.state.waterReceivedMm).toBeLessThan(irrigated.state.waterReceivedMm);
      expect(rainfed.events.some((e) => e.type === 'yield_loss' && e.reason === 'drought')).toBe(
        true,
      );
      expect(rainfed.events.some((e) => e.type === 'water_stress')).toBe(true);
    }
  });

  it('emits stress alerts on threshold crossings, not every day', () => {
    const season = simulateSeason({
      cropId: 'rice',
      env: ENVS.canalClayLoam,
      sowDay: 0,
      seed: 2,
      irrigate: false,
      fertilize: false,
      pestControl: false,
      weather: fixedWeather({ rainMm: 2 }),
    });
    const alerts = season.events.filter((e) => e.type === 'water_stress');
    expect(alerts.length).toBeGreaterThan(0);
    expect(alerts.length).toBeLessThanOrEqual(2);
    const losses = season.events.filter((e) => e.type === 'yield_loss');
    // One event per 5% of cumulative loss at most.
    const finalLossPct =
      100 * (1 - season.state.yieldPotentialKgPerHa / season.state.initialYieldKgPerHa!);
    expect(losses.length).toBeLessThanOrEqual(Math.floor(finalLossPct / 5) + 1);
  });

  it('kills a crop in a total drought', () => {
    const season = simulateSeason({
      cropId: 'tomato',
      env: { ...ENVS.dryLaterite, soilTexture: 'sandy' },
      sowDay: 300,
      seed: 1,
      irrigate: false,
      fertilize: true,
      pestControl: true,
      weather: fixedWeather({ tempC: 27 }),
    });
    expect(season.state.status).toBe('failed');
    const failed = season.events.find((e) => e.type === 'failed');
    expect(failed).toBeDefined();
    expect(failed!.type === 'failed' && failed!.reason).toMatch(/drought/);
    expect(estimateHarvest(season.state, CROPS.tomato)).toEqual({ quantityKg: 0, quality: 0 });
  });

  it('hurts neglected crops noticeably without always failing them', () => {
    let managedTotal = 0;
    let neglectedTotal = 0;
    for (const seed of [1, 2, 3, 4]) {
      const common = {
        cropId: 'maize' as const,
        env: ENVS.canalClayLoam,
        sowDay: 0,
        seed,
        irrigate: false,
      };
      const managed = simulateSeason({ ...common, fertilize: true, pestControl: true });
      const neglected = simulateSeason({ ...common, fertilize: false, pestControl: false });
      expect(neglected.state.status).toBe('ready');
      managedTotal += managed.state.yieldPotentialKgPerHa;
      neglectedTotal += neglected.state.yieldPotentialKgPerHa;
      expect(neglected.state.pestPressure).toBeGreaterThan(managed.state.pestPressure);
    }
    expect(neglectedTotal / managedTotal).toBeLessThan(0.85);
    expect(neglectedTotal / managedTotal).toBeGreaterThan(0.5);
  });

  it('suppresses pest pressure while pest control protects the plot', () => {
    const base: CropPlotState = {
      ...createPlotState({
        cropId: 'tomato',
        sownDay: 0,
        areaHa: 1,
        expectedYield: { low: 15000, expected: 20000, high: 22000 },
        irrigated: true,
        fertilized: true,
      }),
      pestPressure: 0.6,
    };
    const ctx = (day: number) => ({
      crop: CROPS.tomato,
      env: ENVS.canalClayLoam,
      weather: { day, rainMm: 5, tempC: 26, event: 'pest_outbreak' as const },
      random: rngFor('pests', day),
    });
    let unprotected = base;
    let protectedState: CropPlotState = { ...base, pestControlDay: 0 };
    for (let day = 0; day < 10; day++) {
      unprotected = advanceCropDay(unprotected, ctx(day)).state;
      protectedState = advanceCropDay(protectedState, ctx(day)).state;
    }
    expect(unprotected.pestPressure).toBeGreaterThan(0.6);
    expect(protectedState.pestPressure).toBeLessThan(0.1);
  });

  it('loses yield after the harvest window and fails when left too long', () => {
    const season = simulateSeason({
      cropId: 'ragi',
      env: ENVS.dryLaterite,
      sowDay: 30,
      seed: 5,
      irrigate: false,
      fertilize: true,
      pestControl: true,
    });
    let state = season.state;
    expect(state.status).toBe('ready');
    expect(state.daysSinceReady).toBe(0);
    const ready = state.yieldPotentialKgPerHa;
    const crop = CROPS.ragi;
    const events = [];
    let day = 30 + season.days;
    while (state.status === 'ready') {
      const result = advanceCropDay(state, {
        crop,
        env: ENVS.dryLaterite,
        weather: generateWeather(5, day, HEMAVATI_CLIMATE),
        random: rngFor(5, day),
      });
      if (result.state.daysSinceReady === crop.harvestWindowDays) {
        expect(result.state.yieldPotentialKgPerHa).toBe(ready);
      }
      events.push(
        ...result.events.map((e) => ({ ...e, daysSinceReady: result.state.daysSinceReady })),
      );
      state = result.state;
      day += 1;
    }
    expect(state.status).toBe('failed');
    expect(state.daysSinceReady).toBe(crop.harvestWindowDays + OVERRIPE_FAIL_DAYS + 1);
    const firstLoss = events.find((e) => e.type === 'yield_loss');
    expect(firstLoss).toMatchObject({
      reason: 'overripe',
      daysSinceReady: crop.harvestWindowDays + 1,
    });
    expect(events.at(-1)).toMatchObject({ type: 'failed' });
  });

  it('leaves failed and harvested plots untouched', () => {
    const plot = createPlotState({
      cropId: 'rice',
      sownDay: 0,
      areaHa: 1,
      expectedYield: { low: 1, expected: 2, high: 3 },
      irrigated: false,
      fertilized: false,
    });
    for (const status of ['failed', 'harvested'] as const) {
      const state = { ...plot, status };
      const result = advanceCropDay(state, {
        crop: rice,
        env: ENVS.riverClay,
        weather: { day: 1, rainMm: 100, tempC: 40, event: 'heavy_rain' },
        random: () => 0.5,
      });
      expect(result.state).toBe(state);
      expect(result.events).toEqual([]);
    }
  });

  it('is deterministic for identical inputs', () => {
    const args = {
      cropId: 'maize' as const,
      env: ENVS.canalClayLoam,
      sowDay: 0,
      seed: 9,
      irrigate: true,
      fertilize: true,
      pestControl: false,
    };
    expect(simulateSeason(args)).toEqual(simulateSeason(args));
  });

  it('reports growth progress monotonically from 0 to 1', () => {
    let state = createPlotState({
      cropId: 'chickpea',
      sownDay: 150,
      areaHa: 2,
      expectedYield: { low: 1000, expected: 1300, high: 1400 },
      irrigated: true,
      fertilized: true,
    });
    expect(growthProgress(state, CROPS.chickpea)).toBe(0);
    let previous = 0;
    for (let day = 150; state.status === 'growing'; day++) {
      state = advanceCropDay(state, {
        crop: CROPS.chickpea,
        env: ENVS.canalClayLoam,
        weather: fixedWeather({ rainMm: 3 })(day),
        random: rngFor(day),
      }).state;
      const progress = growthProgress(state, CROPS.chickpea);
      expect(progress).toBeGreaterThanOrEqual(previous);
      previous = progress;
    }
    expect(previous).toBe(1);
    expect(estimateHarvest(state, CROPS.chickpea).quantityKg).toBeGreaterThan(2000);
  });

  it('charges irrigation by area, water source and machinery while growing', () => {
    const plot = createPlotState({
      cropId: 'rice',
      sownDay: 0,
      areaHa: 2.5,
      expectedYield: { low: 1, expected: 2, high: 3 },
      irrigated: true,
      fertilized: true,
    });
    const perHa = rice.costs.irrigationPaisePerHaPerDay;
    expect(dailyIrrigationCostPaise(plot, rice, { ...ENVS.riverClay, waterAccess: 'well' })).toBe(
      perHa * 2.5,
    );
    expect(
      dailyIrrigationCostPaise(plot, rice, { ...ENVS.riverClay, waterAccess: 'well' }, 0.75),
    ).toBe(Math.round(perHa * 2.5 * 0.75));
    expect(dailyIrrigationCostPaise(plot, rice, ENVS.canalClayLoam)).toBeLessThan(perHa * 2.5);
    expect(dailyIrrigationCostPaise(plot, rice, ENVS.dryLaterite)).toBeGreaterThan(perHa * 2.5);
    expect(dailyIrrigationCostPaise({ ...plot, irrigated: false }, rice, ENVS.riverClay)).toBe(0);
    expect(dailyIrrigationCostPaise({ ...plot, status: 'ready' }, rice, ENVS.riverClay)).toBe(0);
    expect(canIrrigate(ENVS.dryLaterite, false)).toBe(false);
    expect(canIrrigate(ENVS.dryLaterite, true)).toBe(true);
    expect(canIrrigate(ENVS.riverClay, false)).toBe(true);
  });

  it('caps yield of unfertilised plots on poor soil', () => {
    const run = (fertilize: boolean) =>
      simulateSeason({
        cropId: 'maize',
        env: ENVS.dryLaterite,
        sowDay: 0,
        seed: 4,
        irrigate: false,
        fertilize,
        pestControl: true,
      });
    const fertilised = run(true).state;
    const unfertilised = run(false).state;
    expect(unfertilised.initialYieldKgPerHa!).toBeLessThan(fertilised.initialYieldKgPerHa! * 0.8);
    expect(estimateHarvest(unfertilised, CROPS.maize).quality).toBeLessThan(
      estimateHarvest(fertilised, CROPS.maize).quality,
    );
  });
});
