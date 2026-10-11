import type { GeneratedRegion } from './types';

export const DEFAULT_REGION_ID = 'hemavati';
export const DEFAULT_REGION_SEED = 20261011;

/**
 * Deterministically generate the Hemavati Valley region (fictionalised, inspired by the
 * Hassan district of Karnataka): ~4 km x 4 km, a meandering river, a highway and district
 * roads, villages, two markets (local APMC mandi near the town, district market at the edge),
 * and ~96 parcels with varied soils/elevations/water access. About a third are small
 * (0.5–1.5 ha) starter plots; the rest range 2–12 ha. Same seed => identical output.
 */
export function generateRegion(seed?: number, id?: string): GeneratedRegion {
  void seed;
  void id;
  throw new Error('not implemented');
}
