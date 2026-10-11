import type { CropDefinition, CropId } from './types';

/**
 * Data-driven launch crop set for the Hemavati Valley region (inspired by the
 * Hassan/Malnad belt of Karnataka). Values are calibrated for gameplay and labelled
 * as a simulation, not agronomic advice.
 */
export const CROPS: Record<CropId, CropDefinition> = {} as Record<CropId, CropDefinition>;

export function getCrop(id: CropId): CropDefinition {
  void id;
  throw new Error('not implemented');
}

/** Total days from sowing to maturity. */
export function cropDurationDays(crop: CropDefinition): number {
  void crop;
  throw new Error('not implemented');
}

export function isSowingOpen(crop: CropDefinition, month: number): boolean {
  void crop;
  void month;
  throw new Error('not implemented');
}

/** Up-front cost to plant `areaHa` (seed + sowing labor [+ fertilizer]), before machinery multipliers. */
export function plantingCostPaise(
  crop: CropDefinition,
  areaHa: number,
  opts: { fertilize: boolean; sowingLaborMultiplier?: number },
): number {
  void crop;
  void areaHa;
  void opts;
  throw new Error('not implemented');
}
