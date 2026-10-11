import type {
  CropDayContext,
  CropDefinition,
  CropEvent,
  CropPlotState,
  CropId,
  GameDay,
  HarvestEstimate,
  ParcelEnvironment,
  YieldRange,
} from './types';

/** Initial state for a freshly sown plot. */
export function createPlotState(input: {
  cropId: CropId;
  sownDay: GameDay;
  areaHa: number;
  expectedYield: YieldRange;
  irrigated: boolean;
  fertilized: boolean;
}): CropPlotState {
  void input;
  throw new Error('not implemented');
}

/**
 * Advance a plot by exactly one game day. Pure: same inputs -> same outputs.
 * Handles stage progression, water balance (rain + irrigation), heat/flood/drought stress,
 * pest pressure (suppressed by pest control), overripe losses after the harvest window,
 * and failure (health hits 0, or overripe beyond OVERRIPE_FAIL_DAYS).
 * Plots in status 'failed' or 'harvested' are returned unchanged with no events.
 */
export function advanceCropDay(
  state: CropPlotState,
  ctx: CropDayContext,
): { state: CropPlotState; events: CropEvent[] } {
  void state;
  void ctx;
  throw new Error('not implemented');
}

/** Harvestable quantity and quality for a plot in status 'ready'. Zero for other statuses. */
export function estimateHarvest(state: CropPlotState, crop: CropDefinition): HarvestEstimate {
  void state;
  void crop;
  throw new Error('not implemented');
}

/** 0..1 fraction of total growth completed (for UI progress bars and crop-row rendering). */
export function growthProgress(state: CropPlotState, crop: CropDefinition): number {
  void state;
  void crop;
  throw new Error('not implemented');
}

/** Daily irrigation cost for a plot (0 if not irrigated), honouring machinery multiplier. */
export function dailyIrrigationCostPaise(
  state: CropPlotState,
  crop: CropDefinition,
  env: ParcelEnvironment,
  irrigationCostMultiplier?: number,
): number {
  void state;
  void crop;
  void env;
  void irrigationCostMultiplier;
  throw new Error('not implemented');
}

/** Whether a parcel can be irrigated at all (water access, or a pump set enabling dry irrigation). */
export function canIrrigate(env: ParcelEnvironment, hasDryIrrigation: boolean): boolean {
  void env;
  void hasDryIrrigation;
  throw new Error('not implemented');
}
