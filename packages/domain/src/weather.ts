import type { DailyWeather, GameDay, RegionClimate } from './types';

/**
 * Deterministic daily weather: a pure function of (regionSeed, day, climate).
 * Rain follows the monthly normal (monsoon-heavy Jun–Sep) with stochastic wet/dry days;
 * multi-day events (dry spells, heatwaves) are derived from the week index so they persist.
 */
export function generateWeather(
  regionSeed: number,
  day: GameDay,
  climate: RegionClimate,
): DailyWeather {
  void regionSeed;
  void day;
  void climate;
  throw new Error('not implemented');
}
