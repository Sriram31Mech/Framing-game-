import { assertPaise, mulPaise, roundHalfAwayFromZero } from './money';
import type { CropDefinition, CropId, Paise } from './types';

/**
 * Data-driven launch crop set for the Hemavati Valley region (inspired by the
 * Hassan/Malnad belt of Karnataka). Values are calibrated for gameplay and labelled
 * as a simulation, not agronomic advice.
 *
 * Calibration targets (1 ha, well-suited land, recommended inputs, base price):
 * revenue covers seed + sowing + fertiliser + harvest + irrigation + pest control with a
 * 30–55% margin; tomato and sugarcane earn more per hectare but carry more cash, risk and
 * (for tomato) perishability. Water requirements are total water over the growing period
 * (rain + stored soil moisture + irrigation).
 */
export const CROPS: Record<CropId, CropDefinition> = {
  rice: {
    id: 'rice',
    name: 'Rice (paddy)',
    localName: 'Bhatta',
    // Kuruvai (Jun–Jul), Samba (Aug–Sep), Thaladi (Oct) and Navarai (Dec) plantings.
    sowingMonths: [6, 7, 8, 9, 10, 12],
    stages: [
      { id: 'germination', days: 20 },
      { id: 'vegetative', days: 50 },
      { id: 'flowering', days: 25 },
      { id: 'maturation', days: 30 },
    ],
    harvestWindowDays: 12,
    requirements: {
      tempC: { min: 16, optMin: 21, optMax: 30, max: 36 },
      rainMm: { min: 500, optMin: 1000, optMax: 1600, max: 2400 },
      ph: { min: 4.5, optMin: 5.5, optMax: 7.0, max: 8.2 },
      elevationM: { min: 0, optMin: 0, optMax: 950, max: 1500 },
      maxSlopePct: 6,
      soils: { clay: 1, clay_loam: 0.95, loam: 0.7, sandy_loam: 0.35, laterite: 0.3, sandy: 0.1 },
      drainage: { poor: 1, moderate: 0.85, good: 0.55 },
      waterNeed: 'high',
    },
    baseYieldKgPerHa: 5000,
    costs: {
      seedPaisePerHa: 3_000_00,
      sowingLaborPaisePerHa: 15_000_00,
      fertilizerPaisePerHa: 9_000_00,
      pestControlPaisePerHa: 3_500_00,
      harvestLaborPaisePerHa: 12_000_00,
      irrigationPaisePerHaPerDay: 110_00,
    },
    basePricePaisePerKg: 22_00,
    seasonalPriceFactor: [0.97, 0.99, 1.02, 1.04, 1.06, 1.05, 1.05, 1.04, 1.05, 0.96, 0.9, 0.92],
    baseDemandKgPerDay: 8000,
    shelfLifeDays: 360,
    risk: { drought: 0.85, flood: 0.15, pest: 0.6, heat: 0.5 },
    fertilityNeed: 0.6,
    fertilizerResponse: 0.35,
    priceVolatility: 0.006,
  },
  ragi: {
    id: 'ragi',
    name: 'Finger millet',
    localName: 'Ragi',
    sowingMonths: [6, 7, 8],
    stages: [
      { id: 'germination', days: 10 },
      { id: 'vegetative', days: 45 },
      { id: 'flowering', days: 25 },
      { id: 'maturation', days: 30 },
    ],
    harvestWindowDays: 15,
    requirements: {
      tempC: { min: 15, optMin: 19, optMax: 28, max: 34 },
      rainMm: { min: 250, optMin: 400, optMax: 800, max: 1300 },
      ph: { min: 4.5, optMin: 5.0, optMax: 7.2, max: 8.2 },
      elevationM: { min: 0, optMin: 0, optMax: 1300, max: 2300 },
      maxSlopePct: 18,
      soils: {
        sandy_loam: 1,
        laterite: 0.95,
        loam: 0.85,
        sandy: 0.6,
        clay_loam: 0.5,
        clay: 0.3,
      },
      drainage: { poor: 0.3, moderate: 0.85, good: 1 },
      waterNeed: 'low',
    },
    baseYieldKgPerHa: 2100,
    costs: {
      seedPaisePerHa: 1_000_00,
      sowingLaborPaisePerHa: 10_000_00,
      fertilizerPaisePerHa: 5_500_00,
      pestControlPaisePerHa: 1_500_00,
      harvestLaborPaisePerHa: 13_000_00,
      irrigationPaisePerHaPerDay: 60_00,
    },
    basePricePaisePerKg: 38_00,
    seasonalPriceFactor: [0.92, 0.95, 0.98, 1.02, 1.05, 1.07, 1.08, 1.08, 1.05, 1.0, 0.94, 0.9],
    baseDemandKgPerDay: 3500,
    shelfLifeDays: 540,
    risk: { drought: 0.3, flood: 0.5, pest: 0.25, heat: 0.3 },
    fertilityNeed: 0.35,
    fertilizerResponse: 0.22,
    priceVolatility: 0.006,
  },
  maize: {
    id: 'maize',
    name: 'Maize',
    localName: 'Mekkejola',
    sowingMonths: [6, 7, 10, 11],
    stages: [
      { id: 'germination', days: 8 },
      { id: 'vegetative', days: 45 },
      { id: 'flowering', days: 22 },
      { id: 'maturation', days: 35 },
    ],
    harvestWindowDays: 20,
    requirements: {
      tempC: { min: 14, optMin: 19, optMax: 28, max: 34 },
      rainMm: { min: 350, optMin: 500, optMax: 850, max: 1300 },
      ph: { min: 5.0, optMin: 5.8, optMax: 7.2, max: 8.3 },
      elevationM: { min: 0, optMin: 0, optMax: 1200, max: 2000 },
      maxSlopePct: 12,
      soils: {
        loam: 1,
        sandy_loam: 0.85,
        clay_loam: 0.8,
        laterite: 0.55,
        clay: 0.45,
        sandy: 0.4,
      },
      drainage: { poor: 0.25, moderate: 0.8, good: 1 },
      waterNeed: 'medium',
    },
    baseYieldKgPerHa: 5000,
    costs: {
      seedPaisePerHa: 5_000_00,
      sowingLaborPaisePerHa: 9_000_00,
      fertilizerPaisePerHa: 10_000_00,
      pestControlPaisePerHa: 3_000_00,
      harvestLaborPaisePerHa: 11_000_00,
      irrigationPaisePerHaPerDay: 85_00,
    },
    basePricePaisePerKg: 21_00,
    seasonalPriceFactor: [1.02, 0.96, 0.94, 0.98, 1.04, 1.08, 1.1, 1.06, 0.95, 0.9, 0.96, 1.01],
    baseDemandKgPerDay: 6000,
    shelfLifeDays: 240,
    risk: { drought: 0.6, flood: 0.7, pest: 0.55, heat: 0.55 },
    fertilityNeed: 0.65,
    fertilizerResponse: 0.4,
    priceVolatility: 0.01,
  },
  sugarcane: {
    id: 'sugarcane',
    name: 'Sugarcane',
    localName: 'Kabbu',
    sowingMonths: [1, 2, 3],
    stages: [
      { id: 'germination', days: 35 },
      { id: 'vegetative', days: 95 },
      { id: 'flowering', days: 130 },
      { id: 'maturation', days: 70 },
    ],
    harvestWindowDays: 30,
    requirements: {
      tempC: { min: 16, optMin: 21, optMax: 32, max: 38 },
      rainMm: { min: 1100, optMin: 1600, optMax: 2500, max: 3500 },
      ph: { min: 5.0, optMin: 6.0, optMax: 7.8, max: 8.5 },
      elevationM: { min: 0, optMin: 0, optMax: 900, max: 1400 },
      maxSlopePct: 8,
      soils: {
        clay_loam: 1,
        loam: 0.95,
        clay: 0.8,
        sandy_loam: 0.6,
        laterite: 0.45,
        sandy: 0.25,
      },
      drainage: { poor: 0.5, moderate: 1, good: 0.9 },
      waterNeed: 'high',
    },
    baseYieldKgPerHa: 95000,
    costs: {
      seedPaisePerHa: 35_000_00,
      sowingLaborPaisePerHa: 20_000_00,
      fertilizerPaisePerHa: 25_000_00,
      pestControlPaisePerHa: 6_000_00,
      harvestLaborPaisePerHa: 60_000_00,
      irrigationPaisePerHaPerDay: 140_00,
    },
    basePricePaisePerKg: 3_40,
    seasonalPriceFactor: [0.98, 0.98, 0.99, 1.0, 1.01, 1.02, 1.02, 1.02, 1.01, 1.0, 0.99, 0.98],
    baseDemandKgPerDay: 40000,
    shelfLifeDays: 7,
    risk: { drought: 0.6, flood: 0.35, pest: 0.4, heat: 0.3 },
    fertilityNeed: 0.7,
    fertilizerResponse: 0.4,
    priceVolatility: 0.003,
  },
  tomato: {
    id: 'tomato',
    name: 'Tomato',
    localName: 'Tomato',
    sowingMonths: [1, 2, 3, 4, 5, 9, 10, 11, 12],
    stages: [
      { id: 'germination', days: 12 },
      { id: 'vegetative', days: 35 },
      { id: 'flowering', days: 25 },
      { id: 'maturation', days: 28 },
    ],
    harvestWindowDays: 8,
    requirements: {
      tempC: { min: 12, optMin: 18, optMax: 25, max: 32 },
      rainMm: { min: 250, optMin: 400, optMax: 650, max: 1000 },
      ph: { min: 5.0, optMin: 6.0, optMax: 7.0, max: 8.0 },
      elevationM: { min: 0, optMin: 0, optMax: 1500, max: 2400 },
      maxSlopePct: 10,
      soils: {
        loam: 1,
        sandy_loam: 0.95,
        clay_loam: 0.7,
        laterite: 0.55,
        sandy: 0.5,
        clay: 0.35,
      },
      drainage: { poor: 0.15, moderate: 0.7, good: 1 },
      waterNeed: 'high',
    },
    baseYieldKgPerHa: 24000,
    costs: {
      seedPaisePerHa: 30_000_00,
      sowingLaborPaisePerHa: 45_000_00,
      fertilizerPaisePerHa: 35_000_00,
      pestControlPaisePerHa: 20_000_00,
      harvestLaborPaisePerHa: 90_000_00,
      irrigationPaisePerHaPerDay: 250_00,
    },
    basePricePaisePerKg: 18_00,
    seasonalPriceFactor: [0.75, 0.72, 0.85, 1.1, 1.3, 1.4, 1.35, 1.15, 0.95, 0.85, 0.85, 0.78],
    baseDemandKgPerDay: 5000,
    shelfLifeDays: 12,
    risk: { drought: 0.75, flood: 0.85, pest: 0.9, heat: 0.7 },
    fertilityNeed: 0.7,
    fertilizerResponse: 0.4,
    priceVolatility: 0.045,
  },
  chickpea: {
    id: 'chickpea',
    name: 'Chickpea (Bengal gram)',
    localName: 'Kadale',
    sowingMonths: [10, 11, 12],
    stages: [
      { id: 'germination', days: 10 },
      { id: 'vegetative', days: 35 },
      { id: 'flowering', days: 25 },
      { id: 'maturation', days: 30 },
    ],
    harvestWindowDays: 12,
    requirements: {
      tempC: { min: 10, optMin: 16, optMax: 25, max: 30 },
      rainMm: { min: 120, optMin: 220, optMax: 420, max: 700 },
      ph: { min: 5.5, optMin: 6.5, optMax: 7.8, max: 8.6 },
      elevationM: { min: 0, optMin: 0, optMax: 1100, max: 1800 },
      maxSlopePct: 10,
      soils: {
        clay_loam: 1,
        clay: 0.85,
        loam: 0.8,
        sandy_loam: 0.5,
        laterite: 0.35,
        sandy: 0.25,
      },
      drainage: { poor: 0.1, moderate: 0.75, good: 1 },
      waterNeed: 'low',
    },
    baseYieldKgPerHa: 1500,
    costs: {
      seedPaisePerHa: 6_000_00,
      sowingLaborPaisePerHa: 7_000_00,
      fertilizerPaisePerHa: 4_000_00,
      pestControlPaisePerHa: 3_000_00,
      harvestLaborPaisePerHa: 9_000_00,
      irrigationPaisePerHaPerDay: 60_00,
    },
    basePricePaisePerKg: 55_00,
    seasonalPriceFactor: [1.0, 0.94, 0.9, 0.94, 0.98, 1.02, 1.05, 1.07, 1.07, 1.05, 1.0, 1.0],
    baseDemandKgPerDay: 2000,
    shelfLifeDays: 300,
    risk: { drought: 0.35, flood: 0.95, pest: 0.6, heat: 0.6 },
    fertilityNeed: 0.35,
    fertilizerResponse: 0.15,
    priceVolatility: 0.01,
  },
};

export function getCrop(id: CropId): CropDefinition {
  const crop = CROPS[id];
  if (!crop) throw new RangeError(`unknown crop: ${String(id)}`);
  return crop;
}

/** Total days from sowing to maturity. */
export function cropDurationDays(crop: CropDefinition): number {
  return crop.stages.reduce((total, stage) => total + stage.days, 0);
}

export function isSowingOpen(crop: CropDefinition, month: number): boolean {
  return crop.sowingMonths.includes(month);
}

/** Up-front cost to plant `areaHa` (seed + sowing labor [+ fertilizer]), before machinery multipliers. */
export function plantingCostPaise(
  crop: CropDefinition,
  areaHa: number,
  opts: { fertilize: boolean; sowingLaborMultiplier?: number },
): number {
  const { costs } = crop;
  const sowing = costs.sowingLaborPaisePerHa * (opts.sowingLaborMultiplier ?? 1);
  const fertilizer = opts.fertilize ? costs.fertilizerPaisePerHa : 0;
  return assertPaise(
    roundHalfAwayFromZero((costs.seedPaisePerHa + sowing + fertilizer) * areaHa),
    'planting cost',
  );
}

/** Harvest labour cost for `areaHa`, honouring an optional machinery multiplier. */
export function harvestCostPaise(
  crop: CropDefinition,
  areaHa: number,
  harvestLaborMultiplier = 1,
): Paise {
  return mulPaise(crop.costs.harvestLaborPaisePerHa, areaHa * harvestLaborMultiplier);
}

/** Cost of one pest-control application on `areaHa`. */
export function pestControlCostPaise(crop: CropDefinition, areaHa: number): Paise {
  return mulPaise(crop.costs.pestControlPaisePerHa, areaHa);
}

export interface CropEconomicsEstimate {
  revenuePaise: Paise;
  plantingCostPaise: Paise;
  harvestCostPaise: Paise;
  irrigationCostPaise: Paise;
  pestControlCostPaise: Paise;
  totalCostPaise: Paise;
  profitPaise: Paise;
}

/**
 * Back-of-envelope economics of one crop cycle, used by the land inspector and the AI.
 * Irrigation is charged for every growing day at the crop's base daily rate × `irrigationCostFactor`
 * (water source and pump-set effects); pest control is `pestControlApplications` sprays.
 */
export function estimateCropEconomics(
  crop: CropDefinition,
  input: {
    areaHa: number;
    yieldKgPerHa: number;
    pricePaisePerKg: Paise;
    fertilize: boolean;
    irrigate: boolean;
    irrigationCostFactor?: number;
    pestControlApplications?: number;
    sowingLaborMultiplier?: number;
    harvestLaborMultiplier?: number;
  },
): CropEconomicsEstimate {
  const { areaHa } = input;
  const revenuePaise = mulPaise(input.pricePaisePerKg, Math.floor(input.yieldKgPerHa * areaHa));
  const planting = plantingCostPaise(crop, areaHa, {
    fertilize: input.fertilize,
    sowingLaborMultiplier: input.sowingLaborMultiplier,
  });
  const harvest = harvestCostPaise(crop, areaHa, input.harvestLaborMultiplier);
  const irrigation = input.irrigate
    ? mulPaise(
        crop.costs.irrigationPaisePerHaPerDay,
        areaHa * cropDurationDays(crop) * (input.irrigationCostFactor ?? 1),
      )
    : 0;
  const pest = pestControlCostPaise(crop, areaHa) * (input.pestControlApplications ?? 1);
  const totalCostPaise = planting + harvest + irrigation + pest;
  return {
    revenuePaise,
    plantingCostPaise: planting,
    harvestCostPaise: harvest,
    irrigationCostPaise: irrigation,
    pestControlCostPaise: pest,
    totalCostPaise,
    profitPaise: revenuePaise - totalCostPaise,
  };
}
