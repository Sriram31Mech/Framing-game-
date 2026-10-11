/**
 * Core domain types for Bharat Harvest.
 *
 * Conventions (binding for every package):
 * - Money is integer paise (1 rupee = 100 paise). Never use floats for stored money.
 *   All money values must satisfy Number.isSafeInteger.
 * - Quantities of produce are integer kilograms.
 * - Game time is an integer `GameDay` counted from 0 at world start.
 *   The calendar is 12 months x 30 days = 360 days/year. Day 0 is 1 June, Year 1 (start of Kharif).
 * - Local map coordinates are metres on a flat plane: x grows east, y grows south. (Client maps y -> three.js z.)
 * - Everything in this package is pure and deterministic given its inputs (including seeds).
 */

export type Paise = number;
export type GameDay = number;
export type Kg = number;

export const CROP_IDS = ['rice', 'ragi', 'maize', 'sugarcane', 'tomato', 'chickpea'] as const;
export type CropId = (typeof CROP_IDS)[number];

/** MVP: only produce is tradeable inventory. */
export type ItemId = CropId;
export const ITEM_IDS = CROP_IDS;

export const SOIL_TEXTURES = [
  'sandy',
  'sandy_loam',
  'loam',
  'clay_loam',
  'clay',
  'laterite',
] as const;
export type SoilTexture = (typeof SOIL_TEXTURES)[number];

export const DRAINAGE_CLASSES = ['poor', 'moderate', 'good'] as const;
export type Drainage = (typeof DRAINAGE_CLASSES)[number];

export const WATER_ACCESS = ['none', 'well', 'canal', 'river'] as const;
export type WaterAccess = (typeof WATER_ACCESS)[number];

export const SEASONS = ['kharif', 'rabi', 'zaid'] as const;
export type Season = (typeof SEASONS)[number];

export interface GameDate {
  day: GameDay;
  year: number; // 1-based
  month: number; // 1..12 (1 = January)
  dayOfMonth: number; // 1..30
  dayOfYear: number; // 0..359, counted from 1 January
  season: Season;
  label: string; // e.g. "12 Jul, Year 1"
}

/** Physical and access characteristics of a land parcel. */
export interface ParcelEnvironment {
  areaHa: number;
  elevationM: number;
  slopePct: number;
  soilTexture: SoilTexture;
  soilPh: number;
  /** 0..1 proxy for organic carbon / nutrient status. */
  fertility: number;
  drainage: Drainage;
  waterAccess: WaterAccess;
  /** Distance to the nearest road, km. */
  roadDistanceKm: number;
}

/** Monthly climate normals for a region; arrays have 12 entries, index 0 = January. */
export interface RegionClimate {
  monthlyRainMm: number[];
  monthlyMeanTempC: number[];
  /** Temperature lapse rate per 1000 m above the region's reference elevation. */
  lapseRateCPerKm: number;
  referenceElevationM: number;
}

export interface Range4 {
  min: number;
  optMin: number;
  optMax: number;
  max: number;
}

export const CROP_STAGES = ['germination', 'vegetative', 'flowering', 'maturation'] as const;
export type CropStage = (typeof CROP_STAGES)[number];

export interface CropDefinition {
  id: CropId;
  name: string;
  localName: string;
  /** Months (1..12) in which sowing is permitted. */
  sowingMonths: number[];
  stages: { id: CropStage; days: number }[];
  /** Days after maturity during which harvest incurs no loss. */
  harvestWindowDays: number;
  requirements: {
    tempC: Range4; // mean temperature over the growing period
    rainMm: Range4; // total water over the growing period (rain + irrigation equivalent)
    ph: Range4;
    elevationM: Range4;
    maxSlopePct: number;
    /** Affinity 0..1 per soil texture; missing = 0.3. */
    soils: Partial<Record<SoilTexture, number>>;
    drainage: Record<Drainage, number>;
    waterNeed: 'low' | 'medium' | 'high';
  };
  baseYieldKgPerHa: number;
  costs: {
    seedPaisePerHa: Paise;
    sowingLaborPaisePerHa: Paise;
    fertilizerPaisePerHa: Paise;
    pestControlPaisePerHa: Paise;
    harvestLaborPaisePerHa: Paise;
    irrigationPaisePerHaPerDay: Paise;
  };
  /** Reference farm-gate price at the local mandi in an average month. */
  basePricePaisePerKg: Paise;
  /** Monthly multiplier on base price, 12 entries (index 0 = January). */
  seasonalPriceFactor: number[];
  /** Average regional mandi demand, kg per day. */
  baseDemandKgPerDay: Kg;
  shelfLifeDays: number;
  /** Sensitivities 0..1. */
  risk: { drought: number; flood: number; pest: number; heat: number };
  /** Soil fertility (0..1) at or above which the fertility factor scores 1. Default 0.6. */
  fertilityNeed?: number;
  /**
   * Fraction of yield potential lost when grown without fertiliser on soil of zero fertility
   * (scaled down on fertile soils). Default 0.3.
   */
  fertilizerResponse?: number;
  /** Typical day-to-day relative price noise at the mandi (e.g. 0.01 = 1%). Default 0.01. */
  priceVolatility?: number;
}

// ---------------------------------------------------------------------------
// Suitability

export const SUITABILITY_FACTOR_KEYS = [
  'temperature',
  'water',
  'soil',
  'ph',
  'drainage',
  'elevation',
  'slope',
  'fertility',
] as const;
export type SuitabilityFactorKey = (typeof SUITABILITY_FACTOR_KEYS)[number];

export interface SuitabilityFactor {
  key: SuitabilityFactorKey;
  label: string;
  /** 0..1, 1 = optimal. */
  score: number;
  /** Relative weight; weights of a result sum to 1. */
  weight: number;
  /** Human-readable explanation, e.g. "pH 5.2 is below the optimum 6.0–7.0". */
  detail: string;
}

export type SuitabilityGrade = 'excellent' | 'good' | 'fair' | 'poor' | 'unsuitable';

export interface YieldRange {
  low: Kg; // per hectare
  expected: Kg;
  high: Kg;
}

export interface SuitabilityResult {
  cropId: CropId;
  /** 0..100. */
  score: number;
  grade: SuitabilityGrade;
  factors: SuitabilityFactor[];
  limitingFactor: SuitabilityFactorKey | null;
  yieldKgPerHa: YieldRange;
  irrigationAssumed: boolean;
  /** Whether sowing is allowed in the month of `sowingDay` (if given). */
  sowingOpen: boolean;
  /** Next month (1..12) in which sowing opens. */
  nextSowingMonth: number;
}

// ---------------------------------------------------------------------------
// Weather

export type WeatherEvent = 'none' | 'heavy_rain' | 'heatwave' | 'dry_spell' | 'pest_outbreak';

export interface DailyWeather {
  day: GameDay;
  rainMm: number;
  tempC: number;
  event: WeatherEvent;
}

// ---------------------------------------------------------------------------
// Crop growth

export type CropPlotStatus = 'growing' | 'ready' | 'failed' | 'harvested';

export interface CropPlotState {
  cropId: CropId;
  sownDay: GameDay;
  areaHa: number;
  /** Index into crop.stages; equals stages.length once mature. */
  stageIndex: number;
  /** Days spent in the current stage. */
  stageDay: number;
  /** Days since maturity (0 on the day it becomes ready); null while growing. */
  daysSinceReady: number | null;
  status: CropPlotStatus;
  /** 0..1 overall plant health. */
  health: number;
  /** Current yield potential per hectare after accumulated losses. */
  yieldPotentialKgPerHa: Kg;
  /** 0..1 */
  waterStress: number;
  /** 0..1 */
  pestPressure: number;
  irrigated: boolean;
  fertilized: boolean;
  /** Day pest control was last applied, or null. Protection lasts PEST_CONTROL_PROTECTION_DAYS. */
  pestControlDay: GameDay | null;
  /** Total water received (rain + irrigation), mm. */
  waterReceivedMm: number;
  /**
   * Plant-available water in the root zone, mm (may exceed field capacity while ponded).
   * Initialised by the first `advanceCropDay`; absent on a freshly created plot.
   */
  soilMoistureMm?: number;
  /**
   * Yield potential per hectare established on the first simulated day (after the nutrient
   * limit for unfertilised plots). Reference for cumulative yield-loss percentages.
   */
  initialYieldKgPerHa?: Kg;
}

export type CropEvent =
  | { type: 'stage_changed'; stage: CropStage }
  | { type: 'ready' }
  | { type: 'pest_alert'; pressure: number }
  | { type: 'water_stress'; stress: number }
  | {
      type: 'yield_loss';
      reason: 'drought' | 'flood' | 'heat' | 'pest' | 'overripe';
      lossPct: number;
    }
  | { type: 'failed'; reason: string };

export interface CropDayContext {
  crop: CropDefinition;
  env: ParcelEnvironment;
  weather: DailyWeather;
  /** Deterministic random in [0,1) for this plot and day. */
  random: () => number;
}

export interface HarvestEstimate {
  quantityKg: Kg;
  /** 0..100 */
  quality: number;
}

// ---------------------------------------------------------------------------
// Market

export interface MarketDefinition {
  id: string;
  name: string;
  /** Map position in metres. */
  x: number;
  y: number;
  /** Mandi fee charged on sales to this market, basis points. */
  feeBps: number;
  /** Multiplier on regional demand this market absorbs. */
  demandScale: number;
  /** Price premium multiplier vs the local base (district markets pay more but are further). */
  priceScale: number;
}

export interface MarketItemState {
  itemId: ItemId;
  pricePaisePerKg: Paise;
  /** Recent supply pressure (kg), decays daily. */
  supplyPressureKg: Kg;
  /** Effective daily demand, kg. */
  demandKgPerDay: Kg;
}

export interface MarketSaleQuote {
  quantityKg: Kg;
  /** Average realised unit price after volume impact and quality adjustment. */
  unitPricePaise: Paise;
  grossPaise: Paise;
  feePaise: Paise;
  netPaise: Paise;
  /** Percentage the price dropped due to this sale's volume. */
  priceImpactPct: number;
}

// ---------------------------------------------------------------------------
// Finance

export const MACHINERY_TYPES = ['tractor', 'harvester', 'pump_set', 'truck', 'warehouse'] as const;
export type MachineryType = (typeof MACHINERY_TYPES)[number];

export interface MachineryDefinition {
  type: MachineryType;
  name: string;
  pricePaise: Paise;
  usefulLifeDays: number;
  salvageFraction: number;
  maintenancePaisePerDay: Paise;
  description: string;
  effects: {
    sowingLaborMultiplier?: number;
    harvestLaborMultiplier?: number;
    transportCostMultiplier?: number;
    /** Lets parcels with waterAccess 'none' be irrigated at extra cost; reduces irrigation cost elsewhere. */
    irrigationCostMultiplier?: number;
    enablesDryIrrigation?: boolean;
    /** Multiplier on produce shelf life. */
    shelfLifeMultiplier?: number;
    /** Extra storage capacity, kg. */
    storageCapacityKg?: Kg;
  };
}

export interface LoanTerms {
  principalPaise: Paise;
  annualRateBps: number;
  /** Number of 30-day instalments. */
  termMonths: number;
  /** Equal monthly instalment, paise (rounded up). */
  emiPaise: Paise;
  totalRepayablePaise: Paise;
}

export type CompanyStatus = 'active' | 'distressed' | 'bankrupt';

export interface SolvencyInput {
  cashPaise: Paise;
  status: CompanyStatus;
  distressSinceDay: GameDay | null;
  day: GameDay;
}

export interface SolvencyResult {
  status: CompanyStatus;
  distressSinceDay: GameDay | null;
  /** Days left before bankruptcy proceedings, when distressed. */
  graceDaysRemaining: number | null;
  /** True exactly on the transition into a new status. */
  changed: boolean;
}

export interface BalanceSheetInput {
  cashPaise: Paise;
  inventoryValuePaise: Paise;
  landValuePaise: Paise;
  machineryBookValuePaise: Paise;
  escrowPaise: Paise;
  loanOutstandingPaise: Paise;
}

// ---------------------------------------------------------------------------
// Region generation

export interface MapPoint {
  x: number;
  y: number;
}

export interface GeneratedParcel {
  /** Stable id, e.g. "HV-001". */
  id: string;
  /** Closed polygon ring (first point not repeated), metres, counter-clockwise. */
  polygon: MapPoint[];
  centroid: MapPoint;
  env: ParcelEnvironment;
  /** Distance to nearest market, km (straight-line via road factor). */
  marketDistanceKm: number;
  nearestMarketId: string;
  basePricePaise: Paise;
  /** Rent per season (120 days) when leased from the state. */
  leaseRentPaisePerSeason: Paise;
  /** Small starter plots are reserved for new companies. */
  isStarterPlot: boolean;
}

export interface GeneratedRoad {
  id: string;
  kind: 'highway' | 'district' | 'village' | 'farm_track';
  points: MapPoint[];
  widthM: number;
}

export interface GeneratedFeature {
  id: string;
  kind: 'village' | 'warehouse' | 'temple' | 'water_tank' | 'tree_cluster' | 'school';
  x: number;
  y: number;
  rotation: number;
  scale: number;
}

export interface GeneratedRegion {
  id: string;
  name: string;
  seed: number;
  /** Map extent: x and y range over [-halfSize, halfSize]. */
  halfSizeM: number;
  originLat: number;
  originLon: number;
  climate: RegionClimate;
  markets: MarketDefinition[];
  parcels: GeneratedParcel[];
  roads: GeneratedRoad[];
  /** River centreline. */
  river: { points: MapPoint[]; widthM: number };
  features: GeneratedFeature[];
}

// ---------------------------------------------------------------------------
// AI companies

export type AiPersonality = 'cautious' | 'expansionist' | 'trader';

export interface AiWorldView {
  companyId: string;
  personality: AiPersonality;
  day: GameDay;
  cashPaise: Paise;
  loanOutstandingPaise: Paise;
  ownedParcels: {
    parcelId: string;
    env: ParcelEnvironment;
    plot: {
      plotId: string;
      cropId: CropId;
      status: CropPlotStatus;
      irrigated: boolean;
      /** 0..1, when known; lets the AI decide on pest control. */
      pestPressure?: number;
      pestControlDay?: GameDay | null;
    } | null;
    leased: boolean;
  }[];
  parcelsForSale: {
    parcelId: string;
    env: ParcelEnvironment;
    pricePaise: Paise;
    version: number;
  }[];
  inventory: {
    itemId: ItemId;
    availableKg: Kg;
    quality: number;
    /** Earliest expiry among the available lots, when known (perishables are sold before it). */
    expiresDay?: GameDay;
  }[];
  markets: { marketId: string; prices: Record<ItemId, Paise>; distanceKm: number }[];
  climate: RegionClimate;
}

export type AiIntent =
  | { kind: 'buy_parcel'; parcelId: string; expectedVersion: number; maxPricePaise: Paise }
  | { kind: 'plant'; parcelId: string; cropId: CropId; irrigate: boolean; fertilize: boolean }
  | { kind: 'harvest'; plotId: string }
  | { kind: 'clear_plot'; plotId: string }
  | { kind: 'pest_control'; plotId: string }
  | { kind: 'sell_market'; marketId: string; itemId: ItemId; quantityKg: Kg }
  | {
      kind: 'create_listing';
      itemId: ItemId;
      quantityKg: Kg;
      unitPricePaise: Paise;
      durationDays: number;
    }
  | { kind: 'take_loan'; principalPaise: Paise; termMonths: number };
