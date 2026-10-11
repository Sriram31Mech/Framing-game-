import { MACHINERY_TYPES, type MachineryDefinition, type MachineryType } from './types';

/**
 * Machinery and facilities. Prices are typical Indian small-farm purchases (₹1.5–8 lakh);
 * effects are multiplicative on the relevant operating costs.
 */
export const MACHINERY: Record<MachineryType, MachineryDefinition> = {
  tractor: {
    type: 'tractor',
    name: 'Tractor (45 HP) with implements',
    pricePaise: 6_50_000_00,
    usefulLifeDays: 3600,
    salvageFraction: 0.2,
    maintenancePaisePerDay: 60_00,
    description:
      'Ploughs, sows and hauls a trolley: cuts sowing labour by 40%, harvest labour by 15% and transport costs by 15%.',
    effects: {
      sowingLaborMultiplier: 0.6,
      harvestLaborMultiplier: 0.85,
      transportCostMultiplier: 0.85,
    },
  },
  harvester: {
    type: 'harvester',
    name: 'Mini combine harvester',
    pricePaise: 8_00_000_00,
    usefulLifeDays: 2880,
    salvageFraction: 0.15,
    maintenancePaisePerDay: 90_00,
    description: 'Mechanised harvesting: cuts harvest labour by 55%.',
    effects: { harvestLaborMultiplier: 0.45 },
  },
  pump_set: {
    type: 'pump_set',
    name: 'Borewell and 5 HP pump set',
    pricePaise: 1_50_000_00,
    usefulLifeDays: 2160,
    salvageFraction: 0.1,
    maintenancePaisePerDay: 20_00,
    description:
      'Lets you irrigate parcels without river, canal or well access, and cuts irrigation costs by 25% everywhere.',
    effects: { irrigationCostMultiplier: 0.75, enablesDryIrrigation: true },
  },
  truck: {
    type: 'truck',
    name: 'Light goods truck (3.5 t)',
    pricePaise: 7_50_000_00,
    usefulLifeDays: 2880,
    salvageFraction: 0.25,
    maintenancePaisePerDay: 80_00,
    description: 'Own transport to the mandi: cuts transport costs by 55%.',
    effects: { transportCostMultiplier: 0.45 },
  },
  warehouse: {
    type: 'warehouse',
    name: 'Ventilated storage warehouse',
    pricePaise: 5_00_000_00,
    usefulLifeDays: 7200,
    salvageFraction: 0.3,
    maintenancePaisePerDay: 30_00,
    description:
      'Adds 100 t of storage and extends produce shelf life by 60%, so you can wait for better prices.',
    effects: { shelfLifeMultiplier: 1.6, storageCapacityKg: 100_000 },
  },
};

export function getMachinery(type: MachineryType): MachineryDefinition {
  const definition = MACHINERY[type];
  if (!definition) throw new RangeError(`unknown machinery type: ${String(type)}`);
  return definition;
}

/**
 * Combined multiplicative effects of all owned machinery (missing = 1 / false / 0).
 * Cost and shelf-life multipliers apply once per machinery type (a second tractor does not
 * halve labour again); storage capacity adds up per unit owned.
 */
export function combinedMachineryEffects(
  owned: MachineryType[],
): Required<MachineryDefinition['effects']> {
  const combined: Required<MachineryDefinition['effects']> = {
    sowingLaborMultiplier: 1,
    harvestLaborMultiplier: 1,
    transportCostMultiplier: 1,
    irrigationCostMultiplier: 1,
    enablesDryIrrigation: false,
    shelfLifeMultiplier: 1,
    storageCapacityKg: 0,
  };
  for (const type of owned)
    combined.storageCapacityKg += getMachinery(type).effects.storageCapacityKg ?? 0;
  for (const type of MACHINERY_TYPES) {
    if (!owned.includes(type)) continue;
    const { effects } = MACHINERY[type];
    combined.sowingLaborMultiplier *= effects.sowingLaborMultiplier ?? 1;
    combined.harvestLaborMultiplier *= effects.harvestLaborMultiplier ?? 1;
    combined.transportCostMultiplier *= effects.transportCostMultiplier ?? 1;
    combined.irrigationCostMultiplier *= effects.irrigationCostMultiplier ?? 1;
    combined.shelfLifeMultiplier *= effects.shelfLifeMultiplier ?? 1;
    combined.enablesDryIrrigation ||= effects.enablesDryIrrigation ?? false;
  }
  return combined;
}
