import { hashSeed, hashToUnit } from './rng';

/*
 * Terrain model (all distances in metres, map centred on the origin, y grows south):
 *
 *   upland(x, y)  = plateau level tilting down to the east, extra hills to the west
 *                   (Malnad ghats side), plus 3-octave value-noise fbm.
 *   river valley  = a flat-bottomed valley that blends the upland down to a floodplain that
 *                   sits a few metres above the river level, which falls gently north → south.
 *
 * The river centreline is `riverCenterX(seed, y)`; region generation uses the same function,
 * so parcel elevations, the client mesh and the river polyline always agree.
 */

/** Plateau level at the map centre before noise, m. */
const PLATEAU_BASE_M = 952;
/** Regional fall from west to east, m per m (1.8%). */
const REGIONAL_TILT = 0.018;
/** Extra hill height concentrated on the western third of the map, m. */
const WEST_HILLS_M = 40;
/** River surface level at the map centre, m, and its north→south gradient. */
const RIVER_LEVEL_M = 918;
const RIVER_GRADIENT = 0.006;
/** Half-width of the flat floodplain and outer edge of the valley walls, m. */
const FLOODPLAIN_HALF_WIDTH_M = 260;
const VALLEY_HALF_WIDTH_M = 1350;
/** Maximum depth the valley is carved below the surrounding upland, m. */
const MAX_VALLEY_DEPTH_M = 30;
/** Width of the river channel, m. */
export const RIVER_WIDTH_M = 32;

const NOISE_OCTAVES: { cellM: number; amplitudeM: number }[] = [
  { cellM: 1300, amplitudeM: 18 },
  { cellM: 620, amplitudeM: 6 },
  { cellM: 290, amplitudeM: 2 },
];

interface RiverShape {
  baseX: number;
  phase1: number;
  phase2: number;
}

const riverShapeCache = new Map<number, RiverShape>();

function riverShape(seed: number): RiverShape {
  let shape = riverShapeCache.get(seed);
  if (!shape) {
    const h = hashSeed(seed, 'river');
    shape = {
      baseX: -160 + hashToUnit(h, 1, 0) * 120,
      phase1: hashToUnit(h, 2, 0) * Math.PI * 2,
      phase2: hashToUnit(h, 3, 0) * Math.PI * 2,
    };
    if (riverShapeCache.size > 64) riverShapeCache.clear();
    riverShapeCache.set(seed, shape);
  }
  return shape;
}

const MEANDER_1 = { amplitudeM: 300, wavelengthM: 2700 };
const MEANDER_2 = { amplitudeM: 90, wavelengthM: 950 };

/** x coordinate of the river centreline at latitude y (the river runs roughly north → south). */
export function riverCenterX(seed: number, y: number): number {
  const s = riverShape(seed);
  return (
    s.baseX +
    MEANDER_1.amplitudeM * Math.sin((2 * Math.PI * y) / MEANDER_1.wavelengthM + s.phase1) +
    MEANDER_2.amplitudeM * Math.sin((2 * Math.PI * y) / MEANDER_2.wavelengthM + s.phase2)
  );
}

/** d(riverCenterX)/dy, used to turn horizontal offsets into perpendicular distances. */
function riverCenterSlope(seed: number, y: number): number {
  const s = riverShape(seed);
  const k1 = (2 * Math.PI) / MEANDER_1.wavelengthM;
  const k2 = (2 * Math.PI) / MEANDER_2.wavelengthM;
  return (
    MEANDER_1.amplitudeM * k1 * Math.cos(k1 * y + s.phase1) +
    MEANDER_2.amplitudeM * k2 * Math.cos(k2 * y + s.phase2)
  );
}

/** Approximate perpendicular distance from (x, y) to the river centreline, m. */
export function riverDistanceM(seed: number, x: number, y: number): number {
  const dx = x - riverCenterX(seed, y);
  const slope = riverCenterSlope(seed, y);
  return Math.abs(dx) / Math.sqrt(1 + slope * slope);
}

/** River surface elevation at latitude y, m. */
export function riverLevelM(y: number): number {
  return RIVER_LEVEL_M - RIVER_GRADIENT * y;
}

function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = Math.min(1, Math.max(0, (value - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

/** Smooth value noise in [-1, 1] on a square lattice with quintic interpolation. */
function valueNoise(seed: number, x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = fx * fx * fx * (fx * (fx * 6 - 15) + 10);
  const uy = fy * fy * fy * (fy * (fy * 6 - 15) + 10);
  const v00 = hashToUnit(seed, ix, iy);
  const v10 = hashToUnit(seed, ix + 1, iy);
  const v01 = hashToUnit(seed, ix, iy + 1);
  const v11 = hashToUnit(seed, ix + 1, iy + 1);
  const top = v00 + (v10 - v00) * ux;
  const bottom = v01 + (v11 - v01) * ux;
  return (top + (bottom - top) * uy) * 2 - 1;
}

/** Fractal value noise in roughly [-1, 1], wavelength `cellM`, for other spatial fields (soils, wells). */
export function fieldNoise(seed: number, x: number, y: number, cellM: number): number {
  return (
    (valueNoise(seed, x / cellM, y / cellM) * 2 +
      valueNoise(seed ^ 0x5bd1e995, (x / cellM) * 2.03, (y / cellM) * 2.03)) /
    3
  );
}

function uplandHeightM(seed: number, x: number, y: number): number {
  let height = PLATEAU_BASE_M - REGIONAL_TILT * x + WEST_HILLS_M * smoothstep(-100, -2200, x);
  NOISE_OCTAVES.forEach((octave, index) => {
    const octaveSeed = (seed * 31 + index * 0x9e37) | 0;
    height += octave.amplitudeM * valueNoise(octaveSeed, x / octave.cellM, y / octave.cellM);
  });
  return height;
}

/**
 * Deterministic terrain height field shared by server (parcel elevation) and client (mesh).
 * Returns metres above sea level at map position (x, y). Smooth (value noise / fbm), with the
 * river valley carved lower and gentle hills rising toward the west (Malnad ghats side).
 */
export function terrainHeightM(seed: number, x: number, y: number): number {
  const distance = riverDistanceM(seed, x, y);
  const upland = uplandHeightM(seed, x, y);
  // Floodplain rises gently away from the river so it drains toward the channel.
  const floodplain = riverLevelM(y) + 2.5 + 0.006 * distance;
  const valleyWeight = 1 - smoothstep(FLOODPLAIN_HALF_WIDTH_M, VALLEY_HALF_WIDTH_M, distance);
  const valleyFloor = Math.min(upland, Math.max(floodplain, upland - MAX_VALLEY_DEPTH_M));
  let height = upland + (valleyFloor - upland) * valleyWeight;
  // River channel: a shallow trough under the water surface.
  height -= 4 * (1 - smoothstep(RIVER_WIDTH_M * 0.3, RIVER_WIDTH_M, distance));
  return height;
}

/** Slope percentage at (x, y) estimated by central finite differences over ±10 m. */
export function terrainSlopePct(seed: number, x: number, y: number): number {
  const step = 10;
  const dzdx = (terrainHeightM(seed, x + step, y) - terrainHeightM(seed, x - step, y)) / (2 * step);
  const dzdy = (terrainHeightM(seed, x, y + step) - terrainHeightM(seed, x, y - step)) / (2 * step);
  return Math.hypot(dzdx, dzdy) * 100;
}
