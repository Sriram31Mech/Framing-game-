import type { CoreDeps } from '../commands/types';
import { getWorldClock, targetGameDay } from '../world/clock';
import { advanceDay } from './tick';
import type { AdvanceDayResult } from './types';

export interface CatchUpOptions {
  /** Wall-clock "now" (default: new Date()). Tests pass a far-future time to force catch-up. */
  now?: Date;
  /** Maximum days to process in this call (default config.maxCatchupDaysPerBatch). */
  maxDays?: number;
  /** Called after each committed day (metrics, logging, test hooks). Errors propagate. */
  onDay?: (result: AdvanceDayResult) => void | Promise<void>;
}

export interface CatchUpResult {
  daysAdvanced: number;
  gameDay: number;
  /** Day the wall clock says the world should be at. */
  targetDay: number;
  paused: boolean;
}

/**
 * Offline catch-up: advance the region oldest-day-first until it reaches the wall-clock target
 * day, processing at most `maxDays` days per call so a long outage is worked off in bounded
 * batches. Each day is its own transaction (advanceDay), so a crash mid-way loses nothing and the
 * next call resumes from the last committed checkpoint. Paused clocks are left alone.
 */
export async function catchUp(
  deps: CoreDeps,
  regionId: string,
  opts: CatchUpOptions = {},
): Promise<CatchUpResult> {
  const now = opts.now ?? new Date();
  const maxDays = Math.max(0, opts.maxDays ?? deps.config.maxCatchupDaysPerBatch);
  const clock = await getWorldClock(deps.pool, regionId);
  const target = targetGameDay(clock, now);
  if (clock.paused) {
    return { daysAdvanced: 0, gameDay: clock.gameDay, targetDay: target, paused: true };
  }

  let gameDay = clock.gameDay;
  let daysAdvanced = 0;
  while (gameDay < target && daysAdvanced < maxDays) {
    const result = await advanceDay(deps, regionId, { expectedDay: gameDay, skipIfPaused: true });
    if (result.skipped) {
      if (result.skipReason === 'paused') {
        return { daysAdvanced, gameDay, targetDay: target, paused: true };
      }
      // Another ticker advanced the clock; re-read and continue from where it is now.
      const fresh = await getWorldClock(deps.pool, regionId);
      if (fresh.paused || fresh.gameDay === gameDay) break;
      gameDay = fresh.gameDay;
      continue;
    }
    gameDay = result.gameDay;
    daysAdvanced++;
    if (opts.onDay) await opts.onDay(result);
  }
  return { daysAdvanced, gameDay, targetDay: target, paused: false };
}
