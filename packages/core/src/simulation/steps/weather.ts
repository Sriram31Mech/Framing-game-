import { generateWeather, type DailyWeather, type RegionClimate } from '@bh/domain';
import type { DbClient } from '../../db/pool';

/**
 * Step 1 — weather. Weather is a pure function of (regionSeed, day, climate), so the record for
 * day D is (re)derived and stored idempotently. The record for D+1 is also written so the new
 * current day always has weather to display (the client shows "today's" weather).
 */
export async function recordWeather(
  client: DbClient,
  regionId: string,
  regionSeed: number,
  climate: RegionClimate,
  day: number,
): Promise<{ today: DailyWeather; tomorrow: DailyWeather }> {
  const today = generateWeather(regionSeed, day, climate);
  const tomorrow = generateWeather(regionSeed, day + 1, climate);
  await client.query(
    `INSERT INTO weather_records (region_id, game_day, rain_mm, temp_c, event)
     VALUES ($1, $2, $3, $4, $5), ($1, $6, $7, $8, $9)
     ON CONFLICT (region_id, game_day) DO NOTHING`,
    [
      regionId,
      today.day,
      today.rainMm,
      today.tempC,
      today.event,
      tomorrow.day,
      tomorrow.rainMm,
      tomorrow.tempC,
      tomorrow.event,
    ],
  );
  return { today, tomorrow };
}
