import {
  CROPS,
  PEST_CONTROL_PROTECTION_DAYS,
  advanceCropDay,
  computeSuitability,
  createPlotState,
  dailyIrrigationCostPaise,
  generateWeather,
  harvestCostPaise,
  pestControlCostPaise,
  plantingCostPaise,
  rngFor,
  type CropEvent,
  type CropId,
  type CropPlotState,
  type DailyWeather,
  type ParcelEnvironment,
  type RegionClimate,
} from '../src';

/** Calibration fixture: a ~950 m monsoon plateau (the original Hemavati Valley climate). */
export const HEMAVATI_CLIMATE: RegionClimate = {
  monthlyRainMm: [3, 5, 14, 55, 115, 135, 215, 160, 130, 165, 60, 15],
  monthlyMeanTempC: [21.5, 23.5, 25.5, 26.5, 26, 23, 22, 22, 22.5, 22.5, 21.5, 20.5],
  lapseRateCPerKm: 6.5,
  referenceElevationM: 950,
};

/** Representative parcels of the Hemavati Valley. */
export const ENVS = {
  /** Black clay on the river floodplain, river water. */
  riverClay: {
    areaHa: 1,
    elevationM: 922,
    slopePct: 0.8,
    soilTexture: 'clay',
    soilPh: 7.2,
    fertility: 0.7,
    drainage: 'poor',
    waterAccess: 'river',
    roadDistanceKm: 0.2,
  },
  /** Canal-irrigated clay loam in the valley. */
  canalClayLoam: {
    areaHa: 1,
    elevationM: 930,
    slopePct: 1.5,
    soilTexture: 'clay_loam',
    soilPh: 7.1,
    fertility: 0.66,
    drainage: 'moderate',
    waterAccess: 'canal',
    roadDistanceKm: 0.2,
  },
  /** Red laterite on the dry western uplands. */
  dryLaterite: {
    areaHa: 1,
    elevationM: 1020,
    slopePct: 6,
    soilTexture: 'laterite',
    soilPh: 5.4,
    fertility: 0.35,
    drainage: 'good',
    waterAccess: 'none',
    roadDistanceKm: 0.4,
  },
} satisfies Record<string, ParcelEnvironment>;

export interface SeasonResult {
  state: CropPlotState;
  events: CropEvent[];
  expectedKgPerHa: number;
  plantingCostPaise: number;
  irrigationCostPaise: number;
  pestControlCostPaise: number;
  harvestCostPaise: number;
  days: number;
}

/**
 * Simulates one crop from sowing until it is ready (or fails), the way the worker does:
 * daily weather, irrigation cost, optional pest control when pressure builds.
 */
export function simulateSeason(input: {
  cropId: CropId;
  env: ParcelEnvironment;
  sowDay: number;
  seed: number;
  irrigate: boolean;
  fertilize: boolean;
  pestControl: boolean;
  weather?: (day: number) => DailyWeather;
}): SeasonResult {
  const crop = CROPS[input.cropId];
  const suitability = computeSuitability(crop, input.env, HEMAVATI_CLIMATE, {
    sowingDay: input.sowDay,
    irrigated: input.irrigate,
  });
  let state = createPlotState({
    cropId: input.cropId,
    sownDay: input.sowDay,
    areaHa: input.env.areaHa,
    expectedYield: suitability.yieldKgPerHa,
    irrigated: input.irrigate,
    fertilized: input.fertilize,
  });
  const events: CropEvent[] = [];
  let irrigationCostPaise = 0;
  let pestControlCost = 0;
  let day = input.sowDay;
  while (state.status === 'growing' && day < input.sowDay + 1000) {
    const unprotected =
      state.pestControlDay === null || day - state.pestControlDay >= PEST_CONTROL_PROTECTION_DAYS;
    if (input.pestControl && state.pestPressure >= 0.3 && unprotected) {
      state = { ...state, pestControlDay: day };
      pestControlCost += pestControlCostPaise(crop, input.env.areaHa);
    }
    irrigationCostPaise += dailyIrrigationCostPaise(state, crop, input.env);
    const weather = input.weather?.(day) ?? generateWeather(input.seed, day, HEMAVATI_CLIMATE);
    const result = advanceCropDay(state, {
      crop,
      env: input.env,
      weather,
      random: rngFor(input.seed, 'plot', day),
    });
    state = result.state;
    events.push(...result.events);
    day += 1;
  }
  return {
    state,
    events,
    expectedKgPerHa: suitability.yieldKgPerHa.expected,
    plantingCostPaise: plantingCostPaise(crop, input.env.areaHa, { fertilize: input.fertilize }),
    irrigationCostPaise,
    pestControlCostPaise: pestControlCost,
    harvestCostPaise: state.status === 'ready' ? harvestCostPaise(crop, input.env.areaHa) : 0,
    days: day - input.sowDay,
  };
}
