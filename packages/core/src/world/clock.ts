import type { Queryable } from '../db/pool';
import { notFound } from '../errors';

export interface WorldClockRow {
  regionId: string;
  /** Current game day. Advancing to day D+1 is recorded by a simulation_checkpoints row for D+1. */
  gameDay: number;
  epochAt: Date;
  realSecondsPerGameDay: number;
  rulesetVersion: string;
  paused: boolean;
}

export async function getWorldClock(
  db: Queryable,
  regionId: string,
  opts: { forUpdate?: boolean } = {},
): Promise<WorldClockRow> {
  const { rows } = await db.query<{
    region_id: string;
    game_day: number;
    epoch_at: Date;
    real_seconds_per_game_day: number;
    ruleset_version: string;
    paused: boolean;
  }>(
    `SELECT region_id, game_day, epoch_at, real_seconds_per_game_day, ruleset_version, paused
     FROM world_clock WHERE region_id = $1 ${opts.forUpdate ? 'FOR UPDATE' : ''}`,
    [regionId],
  );
  const r = rows[0];
  if (!r) throw notFound('Region', regionId);
  return {
    regionId: r.region_id,
    gameDay: r.game_day,
    epochAt: r.epoch_at,
    realSecondsPerGameDay: r.real_seconds_per_game_day,
    rulesetVersion: r.ruleset_version,
    paused: r.paused,
  };
}

/** Current game day for stamping commands. */
export async function getCurrentGameDay(db: Queryable, regionId: string): Promise<number> {
  return (await getWorldClock(db, regionId)).gameDay;
}

/** The game day the wall clock says the world should have reached. */
export function targetGameDay(
  clock: Pick<WorldClockRow, 'epochAt' | 'realSecondsPerGameDay'>,
  now: Date,
): number {
  const elapsed = (now.getTime() - clock.epochAt.getTime()) / 1000;
  return Math.max(0, Math.floor(elapsed / clock.realSecondsPerGameDay));
}

/** Wall-clock time at which `gameDay` begins. */
export function wallTimeOfDay(
  clock: Pick<WorldClockRow, 'epochAt' | 'realSecondsPerGameDay'>,
  gameDay: number,
): Date {
  return new Date(clock.epochAt.getTime() + gameDay * clock.realSecondsPerGameDay * 1000);
}
