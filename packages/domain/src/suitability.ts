import type {
  CropDefinition,
  GameDay,
  ParcelEnvironment,
  RegionClimate,
  SuitabilityResult,
} from './types';

/**
 * Explainable weighted suitability. Each factor is scored 0..1 against the crop's
 * Range4 requirements (1 inside optimum, linear falloff to 0 at min/max, 0 outside).
 * Score = 100 * weighted geometric-ish blend with a hard penalty when any factor is 0.
 * Water accounts for irrigation when the parcel has water access (or irrigated=true).
 * Temperature uses climate normals over the crop's growing months adjusted by elevation lapse rate.
 * Yield range = baseYield * f(score, fertility) with low/high spread reflecting weather risk.
 */
export function computeSuitability(
  crop: CropDefinition,
  env: ParcelEnvironment,
  climate: RegionClimate,
  opts?: { sowingDay?: GameDay; irrigated?: boolean },
): SuitabilityResult {
  void crop;
  void env;
  void climate;
  void opts;
  throw new Error('not implemented');
}

/** Suitability for every crop, sorted by score descending. */
export function computeAllSuitability(
  env: ParcelEnvironment,
  climate: RegionClimate,
  opts?: { sowingDay?: GameDay; irrigated?: boolean },
): SuitabilityResult[] {
  void env;
  void climate;
  void opts;
  throw new Error('not implemented');
}
