import { DAYS_PER_MONTH, DAYS_PER_YEAR, START_MONTH } from './constants';
import { monthOfDay, seasonOfMonth } from './calendar';
import { rngFor } from './rng';
import type { DailyWeather, GameDay, RegionClimate, WeatherEvent } from './types';

/*
 * Weather is generated per day from (regionSeed, day) alone, so any day can be recomputed
 * independently (offline catch-up, client forecasts, tests).
 *
 * Multi-day events are "episodes" anchored to 7-day weeks: each week rolls whether an episode
 * starts in it (odds depend on the season), and an episode may last 1–3 weeks. A day looks back
 * over the last three weeks to find the episode covering it.
 */

const DAYS_PER_WEEK = 7;
const MAX_EPISODE_WEEKS = 3;

type EpisodeKind = Exclude<WeatherEvent, 'none'>;

/** A multi-day weather event. */
export interface WeatherEpisode {
  kind: EpisodeKind;
  startDay: GameDay;
  lengthDays: number;
  /** Episode-wide intensity in [0, 1). */
  intensity: number;
}

/** Per-season weekly odds of each episode starting, and its length range in weeks. */
const EPISODE_ODDS: Record<
  'monsoon' | 'post_monsoon' | 'winter' | 'summer',
  { kind: EpisodeKind; probability: number; minWeeks: number; maxWeeks: number }[]
> = {
  monsoon: [
    { kind: 'dry_spell', probability: 0.09, minWeeks: 1, maxWeeks: 3 },
    { kind: 'heavy_rain', probability: 0.07, minWeeks: 1, maxWeeks: 1 },
    { kind: 'pest_outbreak', probability: 0.06, minWeeks: 1, maxWeeks: 1 },
  ],
  post_monsoon: [
    { kind: 'heavy_rain', probability: 0.06, minWeeks: 1, maxWeeks: 1 },
    { kind: 'pest_outbreak', probability: 0.06, minWeeks: 1, maxWeeks: 1 },
  ],
  winter: [{ kind: 'pest_outbreak', probability: 0.05, minWeeks: 1, maxWeeks: 1 }],
  summer: [
    { kind: 'heatwave', probability: 0.15, minWeeks: 1, maxWeeks: 2 },
    { kind: 'heavy_rain', probability: 0.03, minWeeks: 1, maxWeeks: 1 },
    { kind: 'pest_outbreak', probability: 0.04, minWeeks: 1, maxWeeks: 1 },
  ],
};

function weatherRegime(month: number): keyof typeof EPISODE_ODDS {
  if (month >= 6 && month <= 9) return 'monsoon';
  if (month === 10 || month === 11) return 'post_monsoon';
  if (seasonOfMonth(month) === 'zaid') return 'summer';
  return 'winter';
}

function episodeStartingInWeek(regionSeed: number, week: number): WeatherEpisode | null {
  const startDay = week * DAYS_PER_WEEK;
  const random = rngFor(regionSeed, 'episode', week);
  const roll = random();
  let cumulative = 0;
  for (const odds of EPISODE_ODDS[weatherRegime(monthOfDay(startDay))]) {
    cumulative += odds.probability;
    if (roll < cumulative) {
      const weeks = odds.minWeeks + Math.floor(random() * (odds.maxWeeks - odds.minWeeks + 1));
      if (odds.kind === 'heavy_rain') {
        // A heavy-rain episode is a 2–3 day burst somewhere inside its week.
        const lengthDays = 2 + Math.floor(random() * 2);
        const offset = Math.floor(random() * (DAYS_PER_WEEK - lengthDays + 1));
        return { kind: odds.kind, startDay: startDay + offset, lengthDays, intensity: random() };
      }
      return { kind: odds.kind, startDay, lengthDays: weeks * DAYS_PER_WEEK, intensity: random() };
    }
  }
  return null;
}

/** The weather episode covering `day`, if any (most recently started wins). */
export function weatherEpisodeOn(regionSeed: number, day: GameDay): WeatherEpisode | null {
  const week = Math.floor(day / DAYS_PER_WEEK);
  for (let back = 0; back < MAX_EPISODE_WEEKS; back++) {
    const episode = episodeStartingInWeek(regionSeed, week - back);
    if (episode && day >= episode.startDay && day < episode.startDay + episode.lengthDays) {
      return episode;
    }
  }
  return null;
}

/** Monthly mean temperature smoothly interpolated between mid-month normals. */
function normalTempC(climate: RegionClimate, day: GameDay): number {
  const dayOfYear =
    (((day + (START_MONTH - 1) * DAYS_PER_MONTH) % DAYS_PER_YEAR) + DAYS_PER_YEAR) % DAYS_PER_YEAR;
  const position = (dayOfYear - DAYS_PER_MONTH / 2) / DAYS_PER_MONTH;
  const index = Math.floor(position);
  const fraction = position - index;
  const a = climate.monthlyMeanTempC[(index + 12) % 12] ?? 0;
  const b = climate.monthlyMeanTempC[(index + 13) % 12] ?? 0;
  const t = (1 - Math.cos(Math.PI * fraction)) / 2;
  return a + (b - a) * t;
}

/** Rain multiplier for ordinary days, compensating for rain added by heavy-rain bursts. */
const ORDINARY_RAIN_SCALE = 0.78;
const MAX_DAILY_RAIN_MM = 160;

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
  const random = rngFor(regionSeed, 'weather', day);
  const month = monthOfDay(day);
  const monthlyRain = climate.monthlyRainMm[month - 1] ?? 0;
  const dailyMean = (monthlyRain / DAYS_PER_MONTH) * ORDINARY_RAIN_SCALE;
  let wetProbability = Math.min(0.82, Math.max(0.03, monthlyRain / (monthlyRain + 60)));
  let rainScale = 1;
  let tempOffset = 0;

  const episode = weatherEpisodeOn(regionSeed, day);
  const event: WeatherEvent = episode?.kind ?? 'none';
  switch (event) {
    case 'dry_spell':
      wetProbability *= 0.12;
      rainScale = 0.5;
      tempOffset = 1 + episode!.intensity;
      break;
    case 'heatwave':
      wetProbability *= 0.3;
      tempOffset = 4.5 + 2 * episode!.intensity;
      break;
    default:
      break;
  }

  const wetRoll = random();
  const amountRoll = random();
  const noise = (random() + random() - 1) * 1.5;

  let rainMm = 0;
  if (event === 'heavy_rain') {
    rainMm = 30 + 45 * episode!.intensity + 20 * amountRoll;
  } else if (wetRoll < wetProbability && dailyMean > 0) {
    const meanWetDayRain = (dailyMean / wetProbability) * rainScale;
    rainMm = Math.min(MAX_DAILY_RAIN_MM, -meanWetDayRain * Math.log(1 - amountRoll));
  }
  rainMm = Math.round(rainMm * 10) / 10;

  const rainCooling = rainMm > 10 ? 1 : 0;
  const tempC =
    Math.round((normalTempC(climate, day) + noise + tempOffset - rainCooling) * 10) / 10;
  return { day, rainMm, tempC, event };
}
