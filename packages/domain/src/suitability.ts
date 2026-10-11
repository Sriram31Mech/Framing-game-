import { DAYS_PER_MONTH } from './constants';
import { monthOfDay, monthsUntil, MONTH_SHORT_NAMES } from './calendar';
import { CROPS, cropDurationDays, isSowingOpen } from './crops';
import {
  CROP_IDS,
  type CropDefinition,
  type Drainage,
  type GameDay,
  type ParcelEnvironment,
  type Range4,
  type RegionClimate,
  type SoilTexture,
  type SuitabilityFactor,
  type SuitabilityFactorKey,
  type SuitabilityGrade,
  type SuitabilityResult,
  type WaterAccess,
} from './types';

/** Relative factor weights (sum to 1). Water and temperature dominate, as in FAO land evaluation. */
export const SUITABILITY_WEIGHTS: Record<SuitabilityFactorKey, number> = {
  temperature: 0.2,
  water: 0.22,
  soil: 0.15,
  ph: 0.1,
  drainage: 0.1,
  elevation: 0.06,
  slope: 0.07,
  fertility: 0.1,
};

const FACTOR_LABELS: Record<SuitabilityFactorKey, string> = {
  temperature: 'Temperature',
  water: 'Water',
  soil: 'Soil texture',
  ph: 'Soil pH',
  drainage: 'Drainage',
  elevation: 'Elevation',
  slope: 'Slope',
  fertility: 'Fertility',
};

const SOIL_LABELS: Record<SoilTexture, string> = {
  sandy: 'sandy',
  sandy_loam: 'sandy loam',
  loam: 'loam',
  clay_loam: 'clay loam',
  clay: 'clay',
  laterite: 'laterite',
};

const WATER_SOURCE_LABELS: Record<WaterAccess, string> = {
  none: 'a pump set',
  well: 'the well',
  canal: 'the canal',
  river: 'the river',
};

/** Default affinity for a soil texture a crop does not list. */
const DEFAULT_SOIL_AFFINITY = 0.3;

/** Plant-available water a root zone holds at field capacity, mm, by texture. */
const SOIL_WATER_CAPACITY_MM: Record<SoilTexture, number> = {
  sandy: 60,
  sandy_loam: 90,
  loam: 120,
  clay_loam: 140,
  clay: 150,
  laterite: 80,
};

/** Fraction of field capacity present in the soil at sowing (residual moisture). */
export const INITIAL_SOIL_MOISTURE_FRACTION = 0.6;

export function soilWaterCapacityMm(texture: SoilTexture): number {
  return SOIL_WATER_CAPACITY_MM[texture];
}

/** 1 inside [optMin, optMax], linear falloff to 0 at min/max, 0 outside. */
export function scoreRange4(value: number, range: Range4): number {
  if (value < range.min || value > range.max) return 0;
  if (value < range.optMin) return (value - range.min) / (range.optMin - range.min);
  if (value > range.optMax) return (range.max - value) / (range.max - range.optMax);
  return 1;
}

export function suitabilityGrade(score: number): SuitabilityGrade {
  if (score >= 80) return 'excellent';
  if (score >= 65) return 'good';
  if (score >= 50) return 'fair';
  if (score >= 30) return 'poor';
  return 'unsuitable';
}

/** The sowing month to evaluate: the current month if open, else the next month that opens. */
export function nextSowingMonth(crop: CropDefinition, fromMonth: number): number {
  let best = crop.sowingMonths[0] ?? fromMonth;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const month of crop.sowingMonths) {
    const distance = monthsUntil(fromMonth, month);
    if (distance < bestDistance) {
      best = month;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Climate normals over a crop's growing period sown at the start of `sowingMonth`:
 * day-weighted mean temperature at `elevationM` (lapse-rate adjusted) and total rain.
 */
export function growingPeriodClimate(
  crop: CropDefinition,
  climate: RegionClimate,
  sowingMonth: number,
  elevationM: number,
): { meanTempC: number; rainMm: number } {
  const days = cropDurationDays(crop);
  let tempSum = 0;
  let rain = 0;
  for (let day = 0; day < days; day++) {
    const monthIndex = (sowingMonth - 1 + Math.floor(day / DAYS_PER_MONTH)) % 12;
    tempSum += climate.monthlyMeanTempC[monthIndex] ?? 0;
    rain += (climate.monthlyRainMm[monthIndex] ?? 0) / DAYS_PER_MONTH;
  }
  const lapse = (climate.lapseRateCPerKm * (elevationM - climate.referenceElevationM)) / 1000;
  return { meanTempC: tempSum / days - lapse, rainMm: rain };
}

function fmt(value: number, digits = 0): string {
  return value.toLocaleString('en-IN', {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

/** Explains a Range4 score, e.g. "pH 5.2 is below the optimum 6.0–7.0". */
function describeRange(
  subject: string,
  value: number,
  range: Range4,
  unit: string,
  digits: number,
): string {
  const optimum = `${fmt(range.optMin, digits)}–${fmt(range.optMax, digits)}${unit}`;
  const shown = `${subject} ${fmt(value, digits)}${unit}`;
  if (value < range.min) {
    return `${shown} is below the minimum ${fmt(range.min, digits)}${unit} (optimum ${optimum})`;
  }
  if (value > range.max) {
    return `${shown} is above the maximum ${fmt(range.max, digits)}${unit} (optimum ${optimum})`;
  }
  if (value < range.optMin) return `${shown} is below the optimum ${optimum}`;
  if (value > range.optMax) return `${shown} is above the optimum ${optimum}`;
  return `${shown} is within the optimum ${optimum}`;
}

function factor(key: SuitabilityFactorKey, score: number, detail: string): SuitabilityFactor {
  return {
    key,
    label: FACTOR_LABELS[key],
    score: Math.round(Math.min(1, Math.max(0, score)) * 1000) / 1000,
    weight: SUITABILITY_WEIGHTS[key],
    detail,
  };
}

function waterFactor(
  crop: CropDefinition,
  env: ParcelEnvironment,
  rainMm: number,
  irrigated: boolean,
): SuitabilityFactor {
  const range = crop.requirements.rainMm;
  const stored = soilWaterCapacityMm(env.soilTexture) * INITIAL_SOIL_MOISTURE_FRACTION;
  const available = rainMm + stored;
  const need = `need ${fmt(range.optMin)}–${fmt(range.optMax)} mm`;
  const supply = `rain ${fmt(rainMm)} mm + soil moisture ${fmt(stored)} mm`;
  if (irrigated && available < range.optMin) {
    const source = WATER_SOURCE_LABELS[env.waterAccess];
    return factor(
      'water',
      1,
      `Irrigation from ${source} covers the shortfall (${supply}; ${need})`,
    );
  }
  const score = scoreRange4(available, range);
  let detail: string;
  if (available < range.optMin) {
    detail = `Rain-fed water ${fmt(available)} mm is short of the ${need} (${supply}); irrigation would help`;
  } else if (available > range.optMax) {
    detail = `Water ${fmt(available)} mm exceeds the ${need}; waterlogging risk`;
  } else {
    detail = `Water ${fmt(available)} mm meets the ${need} (${supply})`;
  }
  return factor('water', score, detail);
}

function soilFactor(crop: CropDefinition, texture: SoilTexture): SuitabilityFactor {
  const affinity = crop.requirements.soils[texture] ?? DEFAULT_SOIL_AFFINITY;
  const preferred = (Object.entries(crop.requirements.soils) as [SoilTexture, number][])
    .filter(([, value]) => value >= 0.95)
    .map(([soil]) => SOIL_LABELS[soil]);
  const quality =
    affinity >= 0.9 ? 'ideal' : affinity >= 0.7 ? 'good' : affinity >= 0.45 ? 'workable' : 'poor';
  return factor(
    'soil',
    affinity,
    `${SOIL_LABELS[texture][0]!.toUpperCase()}${SOIL_LABELS[texture].slice(1)} soil is ${quality} for ${crop.name.toLowerCase()} (prefers ${preferred.join(', ')})`,
  );
}

function drainageFactor(crop: CropDefinition, drainage: Drainage): SuitabilityFactor {
  const score = crop.requirements.drainage[drainage];
  const best = (Object.entries(crop.requirements.drainage) as [Drainage, number][]).reduce(
    (a, b) => (b[1] > a[1] ? b : a),
  )[0];
  const detail =
    score >= 0.95
      ? `${capitalise(drainage)} drainage suits this crop`
      : `${capitalise(drainage)} drainage; this crop prefers ${best} drainage`;
  return factor('drainage', score, detail);
}

function slopeFactor(crop: CropDefinition, slopePct: number): SuitabilityFactor {
  const max = crop.requirements.maxSlopePct;
  const comfortable = max * 0.4;
  const score =
    slopePct <= comfortable
      ? 1
      : slopePct >= max
        ? 0
        : 1 - (slopePct - comfortable) / (max - comfortable);
  const detail =
    slopePct <= comfortable
      ? `Slope ${fmt(slopePct, 1)}% is gentle (comfortable up to ${fmt(comfortable, 1)}%)`
      : slopePct >= max
        ? `Slope ${fmt(slopePct, 1)}% exceeds the ${fmt(max)}% maximum for this crop`
        : `Slope ${fmt(slopePct, 1)}% is steep for this crop (maximum ${fmt(max)}%); erosion and uneven water`;
  return factor('slope', score, detail);
}

function fertilityFactor(crop: CropDefinition, fertility: number): SuitabilityFactor {
  const need = crop.fertilityNeed ?? 0.6;
  const score = Math.max(0.2, Math.min(1, fertility / need));
  const detail =
    score >= 1
      ? `Fertility ${fmt(fertility, 2)} meets this crop's need (${fmt(need, 2)})`
      : `Fertility ${fmt(fertility, 2)} is below this crop's need (${fmt(need, 2)}); fertiliser recommended`;
  return factor('fertility', score, detail);
}

function capitalise(text: string): string {
  return `${text[0]!.toUpperCase()}${text.slice(1)}`;
}

/**
 * Combined score 0..100: an equal blend of the weighted arithmetic and geometric means, scaled
 * by the worst factor (Liebig's law of the minimum: one bad factor cannot be fully offset by
 * several good ones).
 */
function combineFactors(factors: SuitabilityFactor[]): number {
  let arithmetic = 0;
  let logGeometric = 0;
  let worst = 1;
  for (const f of factors) {
    arithmetic += f.weight * f.score;
    logGeometric += f.weight * Math.log(Math.max(f.score, 0.02));
    worst = Math.min(worst, f.score);
  }
  const blend = 0.5 * arithmetic + 0.5 * Math.exp(logGeometric);
  let score = 100 * blend * (0.5 + 0.5 * worst);
  const anyZero = worst <= 0;
  // A hard constraint (factor at zero) makes the crop unsuitable whatever the rest says.
  if (anyZero) score = Math.min(score, 20);
  return Math.round(score * 10) / 10;
}

/** Fraction of base yield expected at a suitability score (piecewise linear). */
const YIELD_CURVE: [score: number, fraction: number][] = [
  [0, 0],
  [20, 0.05],
  [40, 0.3],
  [60, 0.6],
  [80, 0.88],
  [100, 1],
];

export function yieldFractionForScore(score: number): number {
  for (let i = 1; i < YIELD_CURVE.length; i++) {
    const [x1, y1] = YIELD_CURVE[i]!;
    const [x0, y0] = YIELD_CURVE[i - 1]!;
    if (score <= x1) return y0 + ((y1 - y0) * (Math.max(score, x0) - x0)) / (x1 - x0);
  }
  return 1;
}

/**
 * Explainable weighted suitability. Each factor is scored 0..1 against the crop's
 * Range4 requirements (1 inside optimum, linear falloff to 0 at min/max, 0 outside).
 * Score = 100 * weighted geometric-ish blend with a hard penalty when any factor is 0.
 * Water accounts for irrigation when the parcel has water access (or irrigated=true).
 * Temperature uses climate normals over the crop's growing months adjusted by elevation lapse rate.
 * Yield range = baseYield * f(score, fertility) with low/high spread reflecting weather risk.
 *
 * The crop is evaluated for a sowing at the start of the current month of `sowingDay` if sowing
 * is open then, else at the next month that opens. Without `sowingDay` it is evaluated from June
 * (start of the game year). `irrigated` defaults to "the parcel has water access"; pass `false`
 * to see the rain-fed picture.
 */
export function computeSuitability(
  crop: CropDefinition,
  env: ParcelEnvironment,
  climate: RegionClimate,
  opts?: { sowingDay?: GameDay; irrigated?: boolean },
): SuitabilityResult {
  const referenceMonth = opts?.sowingDay === undefined ? 6 : monthOfDay(opts.sowingDay);
  const sowingMonth = nextSowingMonth(crop, referenceMonth);
  const irrigated = opts?.irrigated ?? env.waterAccess !== 'none';
  const req = crop.requirements;
  const period = growingPeriodClimate(crop, climate, sowingMonth, env.elevationM);
  const sownIn = MONTH_SHORT_NAMES[sowingMonth - 1];

  const factors: SuitabilityFactor[] = [
    factor(
      'temperature',
      scoreRange4(period.meanTempC, req.tempC),
      `${describeRange('Mean temperature', period.meanTempC, req.tempC, ' °C', 1)} (sown ${sownIn})`,
    ),
    waterFactor(crop, env, period.rainMm, irrigated),
    soilFactor(crop, env.soilTexture),
    factor('ph', scoreRange4(env.soilPh, req.ph), describeRange('pH', env.soilPh, req.ph, '', 1)),
    drainageFactor(crop, env.drainage),
    factor(
      'elevation',
      scoreRange4(env.elevationM, req.elevationM),
      describeRange('Elevation', env.elevationM, req.elevationM, ' m', 0),
    ),
    slopeFactor(crop, env.slopePct),
    fertilityFactor(crop, env.fertility),
  ];

  const score = combineFactors(factors);
  let limiting: SuitabilityFactor | null = null;
  for (const f of factors) {
    if (f.score < 1 && (limiting === null || f.score < limiting.score)) limiting = f;
  }

  const expected = crop.baseYieldKgPerHa * yieldFractionForScore(score);
  const waterScore = factors[1]!.score;
  const exposure =
    crop.risk.drought * (irrigated ? 0.15 : 0.3 + 0.7 * (1 - waterScore)) +
    crop.risk.flood * (env.drainage === 'poor' ? 0.5 : env.drainage === 'moderate' ? 0.2 : 0.05) +
    crop.risk.pest * 0.25 +
    crop.risk.heat * 0.1;
  const downside = Math.min(0.6, 0.08 + 0.3 * exposure);
  const upside = 0.08 + 0.04 * (1 - downside);

  return {
    cropId: crop.id,
    score,
    grade: suitabilityGrade(score),
    factors,
    limitingFactor: limiting?.key ?? null,
    yieldKgPerHa: {
      low: Math.round(expected * (1 - downside)),
      expected: Math.round(expected),
      high: Math.round(expected * (1 + upside)),
    },
    irrigationAssumed: irrigated,
    sowingOpen: opts?.sowingDay === undefined || isSowingOpen(crop, referenceMonth),
    nextSowingMonth: sowingMonth,
  };
}

/** Suitability for every crop, sorted by score descending. */
export function computeAllSuitability(
  env: ParcelEnvironment,
  climate: RegionClimate,
  opts?: { sowingDay?: GameDay; irrigated?: boolean },
): SuitabilityResult[] {
  return CROP_IDS.map((id) => computeSuitability(CROPS[id], env, climate, opts)).sort(
    (a, b) => b.score - a.score,
  );
}
