import type { MachineryDefinition, MachineryType } from './types';

export const MACHINERY: Record<MachineryType, MachineryDefinition> = {} as Record<
  MachineryType,
  MachineryDefinition
>;

export function getMachinery(type: MachineryType): MachineryDefinition {
  void type;
  throw new Error('not implemented');
}

/** Combined multiplicative effects of all owned machinery (missing = 1 / false / 0). */
export function combinedMachineryEffects(
  owned: MachineryType[],
): Required<MachineryDefinition['effects']> {
  void owned;
  throw new Error('not implemented');
}
