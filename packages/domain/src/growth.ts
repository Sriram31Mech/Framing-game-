import { OVERRIPE_FAIL_DAYS, PEST_CONTROL_PROTECTION_DAYS } from './constants';
import { cropDurationDays } from './crops';
import { assertPaise, roundHalfAwayFromZero } from './money';
import { INITIAL_SOIL_MOISTURE_FRACTION, soilWaterCapacityMm } from './suitability';
import type {
  CropDayContext,
  CropDefinition,
  CropEvent,
  CropPlotState,
  CropId,
  CropStage,
  Drainage,
  GameDay,
  HarvestEstimate,
  ParcelEnvironment,
  WaterAccess,
  YieldRange,
} from './types';

/*
 * Daily crop model (one call = one game day):
 *
 * 1. Water: a root-zone bucket (capacity by soil texture) gains rain and irrigation, loses
 *    crop uptake; water above capacity drains at a rate set by the parcel's drainage and
 *    otherwise ponds (waterlogging). Irrigated plots are topped up to 85% of capacity.
 * 2. Stress: water stress is the smoothed shortfall of uptake below crop need; waterlogging,
 *    heat (above the crop's optimum) and pest pressure are evaluated daily.
 * 3. Losses: each stress removes a small fraction of yield potential, scaled by the crop's
 *    risk sensitivity and the stage (flowering is most sensitive to drought and heat).
 * 4. Health tracks sustained stress; at 0 the crop dies. Quality at harvest follows health.
 * 5. After maturity the crop waits in the field; past the harvest window it loses yield daily
 *    and fails entirely after OVERRIPE_FAIL_DAYS more days.
 */

/** Relative daily water use by stage (crop coefficient). */
const STAGE_WATER_COEFFICIENT: Record<CropStage, number> = {
  germination: 0.6,
  vegetative: 1,
  flowering: 1.25,
  maturation: 0.8,
};
const STAGE_DROUGHT_SENSITIVITY: Record<CropStage, number> = {
  germination: 0.8,
  vegetative: 0.7,
  flowering: 1.5,
  maturation: 0.6,
};
const STAGE_FLOOD_SENSITIVITY: Record<CropStage, number> = {
  germination: 1.5,
  vegetative: 1,
  flowering: 1,
  maturation: 0.8,
};
const STAGE_HEAT_SENSITIVITY: Record<CropStage, number> = {
  germination: 0.5,
  vegetative: 0.5,
  flowering: 2,
  maturation: 0.7,
};

/** Fraction of water above field capacity still standing the next day, by drainage class. */
const PONDING_RETENTION: Record<Drainage, number> = { good: 0.1, moderate: 0.35, poor: 0.65 };

/** Irrigation tops the root zone up to this fraction of capacity, at most this many mm/day. */
const IRRIGATION_TARGET_FRACTION = 0.85;
const MAX_IRRIGATION_MM_PER_DAY = 30;
/** Root zone drier than this fraction of capacity limits uptake (the crop is water-stressed). */
const READILY_AVAILABLE_FRACTION = 0.5;
/** Smoothing of daily water stress (higher = reacts faster). */
const WATER_STRESS_SMOOTHING = 0.25;
/** Standing water (mm) at which waterlogging is total. */
const FULL_WATERLOGGING_MM = 30;

/** Maximum daily fractional yield loss per stress at full intensity and sensitivity 1. */
const DROUGHT_LOSS_RATE = 0.01;
const FLOOD_LOSS_RATE = 0.03;
const HEAT_LOSS_RATE = 0.02;
const PEST_LOSS_RATE = 0.012;
/** Daily loss after the harvest window: grains/cane vs perishables. */
const OVERRIPE_LOSS_RATE = 0.015;
const PERISHABLE_OVERRIPE_LOSS_RATE = 0.04;
const PERISHABLE_SHELF_LIFE_DAYS = 30;

/**
 * Health: recovers slowly when unstressed; stress load above the threshold damages it, up to
 * HEALTH_DAMAGE_PER_DAY at full load (so a total, sustained stress kills a crop in ~5 weeks).
 */
const HEALTH_RECOVERY_PER_DAY = 0.01;
const HEALTH_DAMAGE_PER_DAY = 0.03;
const HEALTH_DAMAGE_THRESHOLD = 0.45;

/** Pressure below this does not reduce yield. */
const PEST_DAMAGE_THRESHOLD = 0.25;
/** Daily multiplicative pest-pressure decay while protected by pest control. */
const PEST_CONTROL_DECAY = 0.8;

/** Thresholds at which notifications fire when crossed upward. */
const WATER_STRESS_ALERTS = [0.4, 0.7];
const PEST_ALERTS = [0.4, 0.7];
/** A yield_loss event fires each time cumulative loss crosses another multiple of this (%). */
const YIELD_LOSS_STEP_PCT = 5;
/** Below this fraction of the initial potential the crop is written off. */
const MIN_VIABLE_YIELD_FRACTION = 0.05;

/** Irrigation cost factor by water source (pumping from a dry parcel is the dearest). */
const IRRIGATION_SOURCE_COST: Record<WaterAccess, number> = {
  river: 0.8,
  canal: 0.7,
  well: 1,
  none: 1.6,
};

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number, decimals: number): number {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
}

/** Whether any threshold is crossed upward between `before` and `after`. */
function crossesUpward(before: number, after: number, thresholds: number[]): boolean {
  return thresholds.some((threshold) => before < threshold && after >= threshold);
}

/** Crop water use on a day in `stage`, mm. The crop's optimal minimum water is spread over its stages. */
export function dailyWaterNeedMm(crop: CropDefinition, stage: CropStage): number {
  const weightedDays = crop.stages.reduce(
    (total, s) => total + s.days * STAGE_WATER_COEFFICIENT[s.id],
    0,
  );
  return (crop.requirements.rainMm.optMin * STAGE_WATER_COEFFICIENT[stage]) / weightedDays;
}

/** Initial state for a freshly sown plot. */
export function createPlotState(input: {
  cropId: CropId;
  sownDay: GameDay;
  areaHa: number;
  expectedYield: YieldRange;
  irrigated: boolean;
  fertilized: boolean;
}): CropPlotState {
  if (!(input.areaHa > 0)) throw new RangeError(`areaHa must be positive, got ${input.areaHa}`);
  return {
    cropId: input.cropId,
    sownDay: input.sownDay,
    areaHa: input.areaHa,
    stageIndex: 0,
    stageDay: 0,
    daysSinceReady: null,
    status: 'growing',
    health: 1,
    yieldPotentialKgPerHa: Math.max(0, input.expectedYield.expected),
    waterStress: 0,
    pestPressure: 0,
    irrigated: input.irrigated,
    fertilized: input.fertilized,
    pestControlDay: null,
    waterReceivedMm: 0,
  };
}

/**
 * Fraction of potential lost to nutrient limitation without fertiliser: the crop's response
 * scaled down on fertile soil (a fertility-1 soil still loses 20% of the response).
 */
export function unfertilizedYieldPenalty(crop: CropDefinition, fertility: number): number {
  return (crop.fertilizerResponse ?? 0.3) * (1 - 0.8 * clamp01(fertility));
}

interface DailyLosses {
  drought: number;
  flood: number;
  heat: number;
  pest: number;
}

/**
 * Advance a plot by exactly one game day. Pure: same inputs -> same outputs.
 * Handles stage progression, water balance (rain + irrigation), heat/flood/drought stress,
 * pest pressure (suppressed by pest control), overripe losses after the harvest window,
 * and failure (health hits 0, or overripe beyond OVERRIPE_FAIL_DAYS).
 * Plots in status 'failed' or 'harvested' are returned unchanged with no events.
 *
 * Events fire on transitions only: stage changes, maturity, water stress / pest pressure
 * crossing 0.4 or 0.7 upward, and cumulative yield loss crossing each further 5% of the
 * initial potential (`lossPct` is that cumulative percentage; `reason` is the main cause today).
 */
export function advanceCropDay(
  state: CropPlotState,
  ctx: CropDayContext,
): { state: CropPlotState; events: CropEvent[] } {
  if (state.status === 'failed' || state.status === 'harvested') return { state, events: [] };
  const { crop, env } = ctx;
  const events: CropEvent[] = [];
  const next: CropPlotState = { ...state };
  const capacity = soilWaterCapacityMm(env.soilTexture);

  // Day one: residual soil moisture and the nutrient-limited potential.
  if (next.initialYieldKgPerHa === undefined) {
    if (!next.fertilized) {
      next.yieldPotentialKgPerHa *= 1 - unfertilizedYieldPenalty(crop, env.fertility);
    }
    next.yieldPotentialKgPerHa = round(next.yieldPotentialKgPerHa, 2);
    next.initialYieldKgPerHa = next.yieldPotentialKgPerHa;
    next.soilMoistureMm ??= capacity * INITIAL_SOIL_MOISTURE_FRACTION;
  }
  const initial = next.initialYieldKgPerHa;
  const lossPctBefore = cumulativeLossPct(state.yieldPotentialKgPerHa, initial);

  if (next.status === 'ready') {
    advanceReady(next, crop, events);
  } else {
    const losses = advanceGrowing(next, ctx, capacity, events);
    const dominant = (Object.entries(losses) as [keyof DailyLosses, number][]).reduce((a, b) =>
      b[1] > a[1] ? b : a,
    );
    const lossPctAfter = cumulativeLossPct(next.yieldPotentialKgPerHa, initial);
    if (dominant[1] > 0 && crossesLossStep(lossPctBefore, lossPctAfter)) {
      events.push({ type: 'yield_loss', reason: dominant[0], lossPct: round(lossPctAfter, 1) });
    }
    if (next.health <= 0) {
      fail(next, events, `Plants died from severe ${describeStress(dominant[0])}`);
    } else if (next.yieldPotentialKgPerHa < initial * MIN_VIABLE_YIELD_FRACTION) {
      fail(next, events, `Crop lost to ${describeStress(dominant[0])}`);
    } else {
      advanceStage(next, crop, events);
    }
  }
  return { state: next, events };
}

function describeStress(reason: keyof DailyLosses): string {
  return { drought: 'drought', flood: 'waterlogging', heat: 'heat', pest: 'pests' }[reason];
}

function cumulativeLossPct(potential: number, initial: number): number {
  return initial > 0 ? Math.max(0, (1 - potential / initial) * 100) : 0;
}

function crossesLossStep(beforePct: number, afterPct: number): boolean {
  return Math.floor(afterPct / YIELD_LOSS_STEP_PCT) > Math.floor(beforePct / YIELD_LOSS_STEP_PCT);
}

function fail(state: CropPlotState, events: CropEvent[], reason: string): void {
  state.status = 'failed';
  state.health = 0;
  events.push({ type: 'failed', reason });
}

/** Mature crop standing in the field: free during the harvest window, then losses, then rot. */
function advanceReady(state: CropPlotState, crop: CropDefinition, events: CropEvent[]): void {
  const initial = state.initialYieldKgPerHa ?? state.yieldPotentialKgPerHa;
  const lossPctBefore = cumulativeLossPct(state.yieldPotentialKgPerHa, initial);
  state.daysSinceReady = (state.daysSinceReady ?? 0) + 1;
  const overdue = state.daysSinceReady - crop.harvestWindowDays;
  if (overdue <= 0) return;
  if (overdue > OVERRIPE_FAIL_DAYS) {
    fail(state, events, 'Left unharvested too long; the crop rotted in the field');
    return;
  }
  const rate =
    crop.shelfLifeDays < PERISHABLE_SHELF_LIFE_DAYS
      ? PERISHABLE_OVERRIPE_LOSS_RATE
      : OVERRIPE_LOSS_RATE;
  state.yieldPotentialKgPerHa = round(state.yieldPotentialKgPerHa * (1 - rate), 2);
  const lossPctAfter = cumulativeLossPct(state.yieldPotentialKgPerHa, initial);
  if (overdue === 1 || crossesLossStep(lossPctBefore, lossPctAfter)) {
    events.push({ type: 'yield_loss', reason: 'overripe', lossPct: round(lossPctAfter, 1) });
  }
}

function advanceGrowing(
  state: CropPlotState,
  ctx: CropDayContext,
  capacity: number,
  events: CropEvent[],
): DailyLosses {
  const { crop, env, weather } = ctx;
  const stage = crop.stages[state.stageIndex]!.id;
  const { risk } = crop;

  // --- Water balance -------------------------------------------------------
  let moisture =
    (state.soilMoistureMm ?? capacity * INITIAL_SOIL_MOISTURE_FRACTION) + weather.rainMm;
  let irrigation = 0;
  if (state.irrigated) {
    irrigation = Math.min(
      MAX_IRRIGATION_MM_PER_DAY,
      Math.max(0, capacity * IRRIGATION_TARGET_FRACTION - moisture),
    );
    moisture += irrigation;
  }
  if (moisture > capacity) {
    moisture = capacity + (moisture - capacity) * PONDING_RETENTION[env.drainage];
  }
  // FAO-56 style: uptake runs at the full crop need while the root zone holds at least the
  // readily-available fraction of capacity, and falls off linearly as it dries below that.
  const need = dailyWaterNeedMm(crop, stage);
  const uptakeFactor = Math.min(1, moisture / (READILY_AVAILABLE_FRACTION * capacity));
  const uptake = Math.min(moisture, need * uptakeFactor);
  moisture -= uptake;
  const stressToday = 1 - uptakeFactor;
  const waterStress = clamp01(
    state.waterStress + WATER_STRESS_SMOOTHING * (stressToday - state.waterStress),
  );
  const waterlogging = clamp01(Math.max(0, moisture - capacity) / FULL_WATERLOGGING_MM);

  // --- Heat ------------------------------------------------------------------
  const heatExcess = clamp01((weather.tempC - (crop.requirements.tempC.optMax + 2)) / 6);

  // --- Pests -----------------------------------------------------------------
  const day = weather.day;
  const protectedByControl =
    state.pestControlDay !== null &&
    day >= state.pestControlDay &&
    day - state.pestControlDay < PEST_CONTROL_PROTECTION_DAYS;
  let pestPressure = state.pestPressure;
  if (protectedByControl) {
    pestPressure *= PEST_CONTROL_DECAY;
  } else {
    const susceptibility = 0.5 + risk.pest;
    let growth = 0.004 + (weather.rainMm >= 2 ? 0.005 : 0) + (weather.tempC >= 24 ? 0.003 : 0);
    if (weather.event === 'pest_outbreak') growth += 0.035;
    growth = growth * susceptibility + ctx.random() * 0.002;
    pestPressure = pestPressure + growth * (1 - pestPressure) - 0.002;
  }
  pestPressure = clamp01(pestPressure);

  // --- Yield losses ------------------------------------------------------------
  const losses: DailyLosses = {
    drought:
      risk.drought *
      STAGE_DROUGHT_SENSITIVITY[stage] *
      Math.max(0, waterStress - 0.15) *
      DROUGHT_LOSS_RATE,
    flood: risk.flood * STAGE_FLOOD_SENSITIVITY[stage] * waterlogging * FLOOD_LOSS_RATE,
    heat: risk.heat * STAGE_HEAT_SENSITIVITY[stage] * heatExcess * HEAT_LOSS_RATE,
    pest: risk.pest * Math.max(0, pestPressure - PEST_DAMAGE_THRESHOLD) * PEST_LOSS_RATE,
  };
  const retained =
    (1 - losses.drought) * (1 - losses.flood) * (1 - losses.heat) * (1 - losses.pest);

  // --- Health ------------------------------------------------------------------
  const load = Math.max(
    waterStress * (0.4 + 0.6 * risk.drought),
    waterlogging * risk.flood,
    heatExcess * risk.heat,
    pestPressure * risk.pest,
  );
  const health = clamp01(
    state.health +
      HEALTH_RECOVERY_PER_DAY * (1 - load) -
      (HEALTH_DAMAGE_PER_DAY * Math.max(0, load - HEALTH_DAMAGE_THRESHOLD)) /
        (1 - HEALTH_DAMAGE_THRESHOLD),
  );

  // --- Threshold events --------------------------------------------------------
  if (crossesUpward(state.waterStress, waterStress, WATER_STRESS_ALERTS))
    events.push({ type: 'water_stress', stress: round(waterStress, 2) });
  if (crossesUpward(state.pestPressure, pestPressure, PEST_ALERTS))
    events.push({ type: 'pest_alert', pressure: round(pestPressure, 2) });

  state.soilMoistureMm = round(moisture, 2);
  state.waterReceivedMm = round(state.waterReceivedMm + weather.rainMm + irrigation, 1);
  state.waterStress = round(waterStress, 4);
  state.pestPressure = round(pestPressure, 4);
  state.health = round(health, 4);
  state.yieldPotentialKgPerHa = round(state.yieldPotentialKgPerHa * retained, 2);
  return losses;
}

function advanceStage(state: CropPlotState, crop: CropDefinition, events: CropEvent[]): void {
  state.stageDay += 1;
  const current = crop.stages[state.stageIndex];
  if (!current || state.stageDay < current.days) return;
  state.stageIndex += 1;
  state.stageDay = 0;
  const nextStage = crop.stages[state.stageIndex];
  if (nextStage) {
    events.push({ type: 'stage_changed', stage: nextStage.id });
  } else {
    state.status = 'ready';
    state.daysSinceReady = 0;
    events.push({ type: 'ready' });
  }
}

/**
 * Harvestable quantity and quality for a plot in status 'ready'. Zero for other statuses.
 * Quality (0..100) follows plant health, fertiliser, residual pest pressure and days left
 * standing past the harvest window.
 */
export function estimateHarvest(state: CropPlotState, crop: CropDefinition): HarvestEstimate {
  if (state.status !== 'ready') return { quantityKg: 0, quality: 0 };
  const quantityKg = Math.max(0, Math.floor(state.yieldPotentialKgPerHa * state.areaHa));
  const overdue = Math.max(0, (state.daysSinceReady ?? 0) - crop.harvestWindowDays);
  const quality =
    45 +
    50 * clamp01(state.health) +
    (state.fertilized ? 5 : 0) -
    15 * clamp01(state.pestPressure) -
    2.5 * overdue;
  return { quantityKg, quality: Math.round(Math.min(100, Math.max(0, quality))) };
}

/** 0..1 fraction of total growth completed (for UI progress bars and crop-row rendering). */
export function growthProgress(state: CropPlotState, crop: CropDefinition): number {
  if (state.status === 'ready' || state.status === 'harvested') return 1;
  const total = cropDurationDays(crop);
  const completed = crop.stages
    .slice(0, state.stageIndex)
    .reduce((sum, stage) => sum + stage.days, 0);
  return clamp01((completed + state.stageDay) / total);
}

/**
 * Daily irrigation cost for a plot (0 if not irrigated), honouring machinery multiplier.
 * Charged only while growing; the crop's base rate is scaled by the water source
 * (canal 0.7, river 0.8, well 1.0, pumping on a dry parcel 1.6).
 */
export function dailyIrrigationCostPaise(
  state: CropPlotState,
  crop: CropDefinition,
  env: ParcelEnvironment,
  irrigationCostMultiplier?: number,
): number {
  if (!state.irrigated || state.status !== 'growing') return 0;
  const cost =
    crop.costs.irrigationPaisePerHaPerDay *
    state.areaHa *
    IRRIGATION_SOURCE_COST[env.waterAccess] *
    (irrigationCostMultiplier ?? 1);
  return assertPaise(roundHalfAwayFromZero(cost), 'irrigation cost');
}

/** Irrigation cost factor for a water source (used for forecasts). */
export function irrigationSourceCostFactor(waterAccess: WaterAccess): number {
  return IRRIGATION_SOURCE_COST[waterAccess];
}

/** Whether a parcel can be irrigated at all (water access, or a pump set enabling dry irrigation). */
export function canIrrigate(env: ParcelEnvironment, hasDryIrrigation: boolean): boolean {
  return env.waterAccess !== 'none' || hasDryIrrigation;
}
