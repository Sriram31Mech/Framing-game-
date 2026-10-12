/**
 * Tamil Nadu reference data: agro-climatic zones and per-district climate, soils and water.
 *
 * Sources (summarised and rounded for gameplay; not an agronomic guarantee):
 * - Agro-climatic zones of Tamil Nadu: TNAU Agritech Portal (agritech.tnau.ac.in).
 * - Annual rainfall: IMD district normals (approx., mm/year). Monthly shape follows each zone's
 *   south-west (Jun–Sep) vs north-east (Oct–Dec) monsoon split.
 * - Dominant soils and irrigation sources: TNAU district profiles / Season & Crop Reports.
 * Values are versioned with RULESET_VERSION; record provenance in reference_datasets.
 */
import { hashSeed } from './rng';
import type { DailyWeather, GameDay, RegionClimate, SoilTexture, WaterAccess } from './types';
import { generateWeather } from './weather';

export const AGRO_ZONES = [
  'north_eastern',
  'north_western',
  'western',
  'cauvery_delta',
  'southern',
  'high_rainfall',
  'hilly',
] as const;
export type AgroZone = (typeof AGRO_ZONES)[number];

interface ZoneProfile {
  label: string;
  /** Relative monthly rainfall shape (Jan..Dec); scaled to the district's annual normal. */
  rainShape: number[];
  monthlyMeanTempC: number[];
  referenceElevationM: number;
}

export const ZONE_PROFILES: Record<AgroZone, ZoneProfile> = {
  north_eastern: {
    label: 'North Eastern Zone',
    rainShape: [25, 8, 5, 15, 50, 55, 85, 120, 125, 230, 330, 150],
    monthlyMeanTempC: [25, 26.5, 28.5, 31, 33, 32, 30.5, 30, 29.5, 28, 26, 25],
    referenceElevationM: 60,
  },
  north_western: {
    label: 'North Western Zone',
    rainShape: [5, 5, 10, 45, 105, 60, 80, 110, 160, 170, 110, 30],
    monthlyMeanTempC: [23.5, 25.5, 28, 30, 30, 27.5, 26.5, 26.5, 26.5, 25.5, 24, 23],
    referenceElevationM: 450,
  },
  western: {
    label: 'Western Zone',
    rainShape: [10, 10, 15, 55, 70, 35, 30, 30, 50, 170, 150, 40],
    monthlyMeanTempC: [24, 25.5, 27.5, 29, 28.5, 26, 25.5, 25.5, 26, 25.5, 24.5, 23.5],
    referenceElevationM: 350,
  },
  cauvery_delta: {
    label: 'Cauvery Delta Zone',
    rainShape: [40, 15, 15, 30, 55, 35, 50, 90, 110, 200, 300, 190],
    monthlyMeanTempC: [25.5, 26.5, 28.5, 31, 33, 32.5, 31.5, 31, 30.5, 28.5, 26.5, 25.5],
    referenceElevationM: 40,
  },
  southern: {
    label: 'Southern Zone',
    rainShape: [30, 20, 25, 60, 55, 15, 20, 35, 55, 190, 230, 110],
    monthlyMeanTempC: [25.5, 27, 29, 30.5, 31.5, 31, 30.5, 30.5, 30, 28.5, 26.5, 25.5],
    referenceElevationM: 100,
  },
  high_rainfall: {
    label: 'High Rainfall Zone',
    rainShape: [30, 30, 45, 120, 150, 190, 120, 100, 100, 250, 260, 90],
    monthlyMeanTempC: [26.5, 27, 28, 28.5, 28.5, 27, 26.5, 26.5, 27, 27, 26.5, 26.5],
    referenceElevationM: 60,
  },
  hilly: {
    label: 'Hilly Zone',
    rainShape: [30, 20, 30, 110, 150, 230, 300, 200, 140, 250, 200, 80],
    monthlyMeanTempC: [16, 17, 19, 20.5, 20.5, 18, 17, 17, 17.5, 17.5, 16.5, 16],
    referenceElevationM: 1400,
  },
};

export interface DistrictProfile {
  id: string;
  name: string;
  tamilName: string;
  zone: AgroZone;
  /** IMD normal annual rainfall, mm (approx.). */
  annualRainMm: number;
  /** Elevation range of farmland, m. */
  elevationM: [number, number];
  /** Relative weights of dominant soil textures. */
  soils: Partial<Record<SoilTexture, number>>;
  /** Relative weights of irrigation sources (tanks are modelled as 'canal'). */
  water: Partial<Record<WaterAccess, number>>;
  /** Approximate share of the district's area that is cultivated. */
  farmlandShare: number;
  /** Multiplier on land value (urban fringe, delta wetland, etc.). */
  landPriceFactor: number;
  /** Signature crops, for flavour text. */
  knownFor: string[];
}

const p = (d: DistrictProfile) => d;

/** Keyed by the district id used in tamilnadu-geo.json (Census 2011 names). */
export const TN_DISTRICTS: Record<string, DistrictProfile> = Object.fromEntries(
  [
    p({
      id: 'ariyalur',
      name: 'Ariyalur',
      tamilName: 'அரியலூர்',
      zone: 'cauvery_delta',
      annualRainMm: 1030,
      elevationM: [40, 120],
      soils: { clay_loam: 3, sandy_loam: 2, clay: 2 },
      water: { well: 4, canal: 2, none: 3 },
      farmlandShare: 0.5,
      landPriceFactor: 0.9,
      knownFor: ['cotton', 'maize', 'cashew'],
    }),
    p({
      id: 'chennai',
      name: 'Chennai',
      tamilName: 'சென்னை',
      zone: 'north_eastern',
      annualRainMm: 1400,
      elevationM: [2, 20],
      soils: { sandy: 3, clay_loam: 2 },
      water: { well: 3, none: 2 },
      farmlandShare: 0.01,
      landPriceFactor: 4,
      knownFor: ['Koyambedu market'],
    }),
    p({
      id: 'coimbatore',
      name: 'Coimbatore',
      tamilName: 'கோயம்புத்தூர்',
      zone: 'western',
      annualRainMm: 690,
      elevationM: [300, 520],
      soils: { clay: 3, sandy_loam: 2, loam: 2 },
      water: { well: 6, canal: 1, none: 3 },
      farmlandShare: 0.45,
      landPriceFactor: 1.4,
      knownFor: ['coconut', 'maize', 'cotton', 'tomato'],
    }),
    p({
      id: 'cuddalore',
      name: 'Cuddalore',
      tamilName: 'கடலூர்',
      zone: 'north_eastern',
      annualRainMm: 1250,
      elevationM: [5, 60],
      soils: { clay_loam: 3, sandy: 2, sandy_loam: 2 },
      water: { canal: 3, well: 4, none: 2 },
      farmlandShare: 0.55,
      landPriceFactor: 1,
      knownFor: ['rice', 'sugarcane', 'cashew'],
    }),
    p({
      id: 'dharmapuri',
      name: 'Dharmapuri',
      tamilName: 'தருமபுரி',
      zone: 'north_western',
      annualRainMm: 850,
      elevationM: [400, 650],
      soils: { sandy_loam: 4, laterite: 2, loam: 1 },
      water: { well: 4, none: 5, canal: 1 },
      farmlandShare: 0.4,
      landPriceFactor: 0.75,
      knownFor: ['ragi', 'tomato', 'mango'],
    }),
    p({
      id: 'dindigul',
      name: 'Dindigul',
      tamilName: 'திண்டுக்கல்',
      zone: 'southern',
      annualRainMm: 860,
      elevationM: [250, 450],
      soils: { sandy_loam: 3, clay: 2, loam: 2 },
      water: { well: 5, canal: 1, none: 3 },
      farmlandShare: 0.45,
      landPriceFactor: 0.9,
      knownFor: ['maize', 'tomato', 'onion'],
    }),
    p({
      id: 'erode',
      name: 'Erode',
      tamilName: 'ஈரோடு',
      zone: 'western',
      annualRainMm: 720,
      elevationM: [180, 400],
      soils: { sandy_loam: 3, clay_loam: 2, clay: 2 },
      water: { canal: 4, well: 4, none: 2 },
      farmlandShare: 0.5,
      landPriceFactor: 1.2,
      knownFor: ['turmeric', 'sugarcane', 'rice'],
    }),
    p({
      id: 'kancheepuram',
      name: 'Kancheepuram',
      tamilName: 'காஞ்சிபுரம்',
      zone: 'north_eastern',
      annualRainMm: 1210,
      elevationM: [10, 100],
      soils: { clay_loam: 3, sandy_loam: 3, sandy: 1 },
      water: { canal: 5, well: 3, none: 1 },
      farmlandShare: 0.45,
      landPriceFactor: 2,
      knownFor: ['rice', 'groundnut'],
    }),
    p({
      id: 'kanniyakumari',
      name: 'Kanniyakumari',
      tamilName: 'கன்னியாகுமரி',
      zone: 'high_rainfall',
      annualRainMm: 1450,
      elevationM: [10, 250],
      soils: { laterite: 4, sandy_loam: 2, clay_loam: 1 },
      water: { canal: 4, river: 2, well: 2 },
      farmlandShare: 0.45,
      landPriceFactor: 1.5,
      knownFor: ['rice', 'banana', 'rubber', 'coconut'],
    }),
    p({
      id: 'karur',
      name: 'Karur',
      tamilName: 'கரூர்',
      zone: 'western',
      annualRainMm: 650,
      elevationM: [100, 220],
      soils: { sandy_loam: 3, clay_loam: 2, clay: 1 },
      water: { river: 2, well: 4, none: 3 },
      farmlandShare: 0.5,
      landPriceFactor: 0.9,
      knownFor: ['banana', 'sugarcane', 'rice'],
    }),
    p({
      id: 'krishnagiri',
      name: 'Krishnagiri',
      tamilName: 'கிருஷ்ணகிரி',
      zone: 'north_western',
      annualRainMm: 830,
      elevationM: [450, 900],
      soils: { sandy_loam: 4, laterite: 2, loam: 2 },
      water: { well: 4, canal: 1, none: 4 },
      farmlandShare: 0.4,
      landPriceFactor: 0.85,
      knownFor: ['ragi', 'mango', 'tomato'],
    }),
    p({
      id: 'madurai',
      name: 'Madurai',
      tamilName: 'மதுரை',
      zone: 'southern',
      annualRainMm: 850,
      elevationM: [100, 250],
      soils: { clay_loam: 3, sandy_loam: 2, clay: 2 },
      water: { canal: 4, well: 3, none: 2 },
      farmlandShare: 0.45,
      landPriceFactor: 1.2,
      knownFor: ['rice', 'jasmine', 'banana'],
    }),
    p({
      id: 'nagappattinam',
      name: 'Nagapattinam',
      tamilName: 'நாகப்பட்டினம்',
      zone: 'cauvery_delta',
      annualRainMm: 1350,
      elevationM: [1, 15],
      soils: { clay: 4, clay_loam: 3, sandy: 1 },
      water: { canal: 6, river: 2, well: 1 },
      farmlandShare: 0.65,
      landPriceFactor: 0.95,
      knownFor: ['rice', 'black gram'],
    }),
    p({
      id: 'namakkal',
      name: 'Namakkal',
      tamilName: 'நாமக்கல்',
      zone: 'north_western',
      annualRainMm: 750,
      elevationM: [150, 450],
      soils: { sandy_loam: 3, clay_loam: 2, loam: 2 },
      water: { well: 5, river: 1, none: 3 },
      farmlandShare: 0.5,
      landPriceFactor: 0.95,
      knownFor: ['maize', 'tapioca', 'sugarcane'],
    }),
    p({
      id: 'perambalur',
      name: 'Perambalur',
      tamilName: 'பெரம்பலூர்',
      zone: 'cauvery_delta',
      annualRainMm: 900,
      elevationM: [80, 200],
      soils: { clay: 3, sandy_loam: 2, clay_loam: 2 },
      water: { well: 4, none: 4, canal: 1 },
      farmlandShare: 0.55,
      landPriceFactor: 0.8,
      knownFor: ['maize', 'cotton', 'onion'],
    }),
    p({
      id: 'pudukkottai',
      name: 'Pudukkottai',
      tamilName: 'புதுக்கோட்டை',
      zone: 'cauvery_delta',
      annualRainMm: 900,
      elevationM: [20, 120],
      soils: { sandy_loam: 3, laterite: 2, clay_loam: 2 },
      water: { canal: 4, well: 3, none: 3 },
      farmlandShare: 0.45,
      landPriceFactor: 0.8,
      knownFor: ['rice', 'groundnut', 'cashew'],
    }),
    p({
      id: 'ramanathapuram',
      name: 'Ramanathapuram',
      tamilName: 'இராமநாதபுரம்',
      zone: 'southern',
      annualRainMm: 820,
      elevationM: [2, 50],
      soils: { sandy: 3, clay_loam: 2, clay: 2 },
      water: { canal: 3, none: 5, well: 1 },
      farmlandShare: 0.45,
      landPriceFactor: 0.6,
      knownFor: ['chilli', 'rice', 'cotton'],
    }),
    p({
      id: 'salem',
      name: 'Salem',
      tamilName: 'சேலம்',
      zone: 'north_western',
      annualRainMm: 1000,
      elevationM: [250, 600],
      soils: { sandy_loam: 3, loam: 2, laterite: 1, clay_loam: 1 },
      water: { well: 5, river: 1, none: 3 },
      farmlandShare: 0.45,
      landPriceFactor: 1,
      knownFor: ['tapioca', 'maize', 'mango'],
    }),
    p({
      id: 'sivaganga',
      name: 'Sivaganga',
      tamilName: 'சிவகங்கை',
      zone: 'southern',
      annualRainMm: 900,
      elevationM: [30, 120],
      soils: { sandy_loam: 3, laterite: 2, clay_loam: 2 },
      water: { canal: 4, none: 4, well: 1 },
      farmlandShare: 0.4,
      landPriceFactor: 0.65,
      knownFor: ['rice', 'groundnut'],
    }),
    p({
      id: 'thanjavur',
      name: 'Thanjavur',
      tamilName: 'தஞ்சாவூர்',
      zone: 'cauvery_delta',
      annualRainMm: 1100,
      elevationM: [5, 60],
      soils: { clay: 4, clay_loam: 3, sandy_loam: 1 },
      water: { canal: 6, river: 3, well: 2 },
      farmlandShare: 0.7,
      landPriceFactor: 1.3,
      knownFor: ['rice (rice bowl of TN)', 'sugarcane', 'black gram'],
    }),
    p({
      id: 'the-nilgiris',
      name: 'The Nilgiris',
      tamilName: 'நீலகிரி',
      zone: 'hilly',
      annualRainMm: 1700,
      elevationM: [900, 2200],
      soils: { laterite: 4, loam: 2 },
      water: { river: 2, well: 1, none: 3 },
      farmlandShare: 0.3,
      landPriceFactor: 1.6,
      knownFor: ['tea', 'potato', 'carrot'],
    }),
    p({
      id: 'theni',
      name: 'Theni',
      tamilName: 'தேனி',
      zone: 'western',
      annualRainMm: 830,
      elevationM: [250, 500],
      soils: { clay_loam: 3, sandy_loam: 2, loam: 2 },
      water: { canal: 3, river: 2, well: 3 },
      farmlandShare: 0.4,
      landPriceFactor: 1,
      knownFor: ['banana', 'grapes', 'cardamom'],
    }),
    p({
      id: 'thiruvallur',
      name: 'Thiruvallur',
      tamilName: 'திருவள்ளூர்',
      zone: 'north_eastern',
      annualRainMm: 1150,
      elevationM: [5, 80],
      soils: { clay_loam: 3, sandy_loam: 3, sandy: 1 },
      water: { canal: 4, well: 4, none: 1 },
      farmlandShare: 0.45,
      landPriceFactor: 1.8,
      knownFor: ['rice', 'groundnut', 'vegetables'],
    }),
    p({
      id: 'thiruvarur',
      name: 'Thiruvarur',
      tamilName: 'திருவாரூர்',
      zone: 'cauvery_delta',
      annualRainMm: 1200,
      elevationM: [2, 30],
      soils: { clay: 4, clay_loam: 3 },
      water: { canal: 7, river: 2, well: 1 },
      farmlandShare: 0.75,
      landPriceFactor: 1.1,
      knownFor: ['rice', 'black gram', 'green gram'],
    }),
    p({
      id: 'thoothukkudi',
      name: 'Thoothukkudi',
      tamilName: 'தூத்துக்குடி',
      zone: 'southern',
      annualRainMm: 660,
      elevationM: [5, 120],
      soils: { clay: 3, sandy: 2, sandy_loam: 2 },
      water: { canal: 2, none: 5, well: 2 },
      farmlandShare: 0.45,
      landPriceFactor: 0.7,
      knownFor: ['cotton', 'chilli', 'banana'],
    }),
    p({
      id: 'tiruchirappalli',
      name: 'Tiruchirappalli',
      tamilName: 'திருச்சிராப்பள்ளி',
      zone: 'cauvery_delta',
      annualRainMm: 840,
      elevationM: [70, 200],
      soils: { clay_loam: 3, sandy_loam: 2, clay: 2 },
      water: { river: 3, canal: 3, well: 3, none: 2 },
      farmlandShare: 0.5,
      landPriceFactor: 1.15,
      knownFor: ['rice', 'banana', 'sugarcane'],
    }),
    p({
      id: 'tirunelveli',
      name: 'Tirunelveli',
      tamilName: 'திருநெல்வேலி',
      zone: 'southern',
      annualRainMm: 750,
      elevationM: [20, 250],
      soils: { clay_loam: 3, sandy_loam: 2, laterite: 1, clay: 1 },
      water: { river: 2, canal: 4, none: 3 },
      farmlandShare: 0.4,
      landPriceFactor: 0.85,
      knownFor: ['rice', 'banana', 'chilli'],
    }),
    p({
      id: 'tiruppur',
      name: 'Tiruppur',
      tamilName: 'திருப்பூர்',
      zone: 'western',
      annualRainMm: 620,
      elevationM: [250, 450],
      soils: { clay: 3, sandy_loam: 3, loam: 1 },
      water: { well: 5, canal: 2, none: 3 },
      farmlandShare: 0.5,
      landPriceFactor: 1.1,
      knownFor: ['maize', 'coconut', 'cotton'],
    }),
    p({
      id: 'tiruvannamalai',
      name: 'Tiruvannamalai',
      tamilName: 'திருவண்ணாமலை',
      zone: 'north_eastern',
      annualRainMm: 1050,
      elevationM: [100, 300],
      soils: { sandy_loam: 4, clay_loam: 2, loam: 1 },
      water: { canal: 3, well: 4, none: 2 },
      farmlandShare: 0.5,
      landPriceFactor: 0.9,
      knownFor: ['rice', 'groundnut', 'sugarcane'],
    }),
    p({
      id: 'vellore',
      name: 'Vellore',
      tamilName: 'வேலூர்',
      zone: 'north_eastern',
      annualRainMm: 950,
      elevationM: [150, 450],
      soils: { sandy_loam: 4, loam: 2, laterite: 1 },
      water: { well: 5, canal: 2, none: 3 },
      farmlandShare: 0.4,
      landPriceFactor: 1,
      knownFor: ['groundnut', 'sugarcane', 'mango'],
    }),
    p({
      id: 'viluppuram',
      name: 'Viluppuram',
      tamilName: 'விழுப்புரம்',
      zone: 'north_eastern',
      annualRainMm: 1050,
      elevationM: [20, 200],
      soils: { sandy_loam: 3, clay_loam: 3, sandy: 1 },
      water: { canal: 3, well: 5, none: 2 },
      farmlandShare: 0.55,
      landPriceFactor: 0.9,
      knownFor: ['sugarcane', 'rice', 'groundnut'],
    }),
    p({
      id: 'virudunagar',
      name: 'Virudhunagar',
      tamilName: 'விருதுநகர்',
      zone: 'southern',
      annualRainMm: 800,
      elevationM: [60, 250],
      soils: { clay: 4, sandy_loam: 2 },
      water: { canal: 2, none: 5, well: 2 },
      farmlandShare: 0.45,
      landPriceFactor: 0.7,
      knownFor: ['cotton', 'chilli', 'pulses'],
    }),
  ].map((d) => [d.id, d]),
);

const climateCache = new Map<string, RegionClimate>();

/** Monthly climate normals for a district (zone shape scaled to the district's annual rainfall). */
export function districtClimate(districtId: string): RegionClimate {
  const cached = climateCache.get(districtId);
  if (cached) return cached;
  const district = TN_DISTRICTS[districtId];
  if (!district) throw new RangeError(`unknown district ${districtId}`);
  const zone = ZONE_PROFILES[district.zone];
  const shapeTotal = zone.rainShape.reduce((a, b) => a + b, 0);
  const climate: RegionClimate = {
    monthlyRainMm: zone.rainShape.map(
      (v) => Math.round((v / shapeTotal) * district.annualRainMm * 10) / 10,
    ),
    monthlyMeanTempC: zone.monthlyMeanTempC,
    lapseRateCPerKm: 6.5,
    referenceElevationM: zone.referenceElevationM,
  };
  climateCache.set(districtId, climate);
  return climate;
}

/** Climate for a piece of land: its district's climate, else the given fallback. */
export function climateForEnv(
  env: { districtId?: string },
  fallback: RegionClimate,
): RegionClimate {
  return env.districtId && TN_DISTRICTS[env.districtId]
    ? districtClimate(env.districtId)
    : fallback;
}

/** Statewide average climate (mean of all non-urban districts), used for region-level summaries. */
export function stateClimate(): RegionClimate {
  const ids = Object.keys(TN_DISTRICTS).filter((id) => id !== 'chennai');
  const rain = Array.from({ length: 12 }, () => 0);
  const temp = Array.from({ length: 12 }, () => 0);
  for (const id of ids) {
    const c = districtClimate(id);
    for (let m = 0; m < 12; m++) {
      rain[m]! += c.monthlyRainMm[m]! / ids.length;
      temp[m]! += c.monthlyMeanTempC[m]! / ids.length;
    }
  }
  return {
    monthlyRainMm: rain.map((v) => Math.round(v * 10) / 10),
    monthlyMeanTempC: temp.map((v) => Math.round(v * 10) / 10),
    lapseRateCPerKm: 6.5,
    referenceElevationM: 150,
  };
}

/**
 * Tamil Nadu cropping-season name for a calendar month (1..12): Kuruvai (Jun–Aug),
 * Samba/Thaladi (Sep–Nov), Navarai (Dec–Feb), Kodai summer season (Mar–May).
 */
export function tamilSeasonOfMonth(month: number): { id: string; name: string; tamil: string } {
  if (month >= 6 && month <= 8) return { id: 'kuruvai', name: 'Kuruvai', tamil: 'குறுவை' };
  if (month >= 9 && month <= 11) return { id: 'samba', name: 'Samba / Thaladi', tamil: 'சம்பா' };
  if (month === 12 || month <= 2) return { id: 'navarai', name: 'Navarai', tamil: 'நவரை' };
  return { id: 'kodai', name: 'Kodai (summer)', tamil: 'கோடை' };
}

/** Deterministic daily weather for one district (pure in regionSeed, districtId, day). */
export function districtWeatherOn(
  regionSeed: number,
  districtId: string,
  day: GameDay,
): DailyWeather {
  return generateWeather(
    hashSeed(regionSeed, 'district', districtId),
    day,
    districtClimate(districtId),
  );
}
