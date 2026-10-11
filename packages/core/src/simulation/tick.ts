import { toGameDate, type RegionClimate } from '@bh/domain';
import type { CoreDeps } from '../commands/types';
import type { DbClient } from '../db/pool';
import { withTransaction } from '../db/tx';
import { getWorldClock } from '../world/clock';
import { emitCompanyUpdated, tickEvent } from './effects';
import { advanceCrops } from './steps/crops';
import { expireListings, settleContractDeadlines } from './steps/expiry';
import { chargeIrrigation } from './steps/irrigation';
import { processLeases } from './steps/leases';
import { chargeLoanInstalments } from './steps/loans';
import { depreciateAndMaintainMachinery, loadMachineryEffects } from './steps/machinery';
import { updateMarkets } from './steps/markets';
import { evaluateCompanies } from './steps/solvency';
import { spoilExpiredLots } from './steps/spoilage';
import { chargeIncomeTax, chargeLandTax } from './steps/taxes';
import { recordWeather } from './steps/weather';
import {
  emptyStats,
  type AdvanceDayOptions,
  type AdvanceDayResult,
  type TickContext,
} from './types';

/** Advisory-lock class for per-region ticks: pg_advisory_xact_lock(TICK_LOCK_CLASS, hashtext(region)). */
export const TICK_LOCK_CLASS = 72_210_010;

/**
 * Process the end of the current day D for a region and move the clock to D+1 — in ONE database
 * transaction, so a day is applied entirely or not at all.
 *
 * Idempotency/concurrency:
 *  - a per-region transaction-scoped advisory lock serialises tickers;
 *  - the day to process is the clock day observed *before* locking (or `opts.expectedDay`), so
 *    callers that lose the race find the clock moved on and return `skipped` — N concurrent calls
 *    advance exactly one day;
 *  - the simulation_checkpoints(region, D+1) primary key is inserted in the same transaction and
 *    is the final guard: a day can never be applied twice.
 *
 * Step order follows IMPLEMENTATION.md §3. All company rows of the region are locked up front
 * (in id order, like lockCompanies) before any money is posted.
 */
export async function advanceDay(
  deps: CoreDeps,
  regionId: string,
  opts: AdvanceDayOptions = {},
): Promise<AdvanceDayResult> {
  const observedDay = opts.expectedDay ?? (await getWorldClock(deps.pool, regionId)).gameDay;

  return withTransaction(
    deps.pool,
    async (client) => {
      const startedAt = new Date();
      const t0 = performance.now();
      const stats = emptyStats();
      const skipped = (
        gameDay: number,
        skipReason: AdvanceDayResult['skipReason'] = 'already_processed',
      ): AdvanceDayResult => ({
        regionId,
        processedDay: observedDay,
        gameDay,
        skipped: true,
        skipReason,
        durationMs: Math.round(performance.now() - t0),
        stats,
      });

      await client.query('SELECT pg_advisory_xact_lock($1, hashtext($2))', [
        TICK_LOCK_CLASS,
        regionId,
      ]);
      const clock = await getWorldClock(client, regionId, { forUpdate: true });
      if (clock.gameDay !== observedDay) return skipped(clock.gameDay);
      if (opts.skipIfPaused && clock.paused) return skipped(clock.gameDay, 'paused');
      const day = clock.gameDay;

      const inserted = await client.query(
        `INSERT INTO simulation_checkpoints (region_id, game_day, ruleset_version, started_at, duration_ms)
         VALUES ($1, $2, $3, $4, 0)
         ON CONFLICT (region_id, game_day) DO NOTHING`,
        [regionId, day + 1, clock.rulesetVersion, startedAt],
      );
      if (inserted.rowCount !== 1) return skipped(clock.gameDay);

      const { rows: regionRows } = await client.query<{ seed: number; climate: RegionClimate }>(
        'SELECT seed, climate FROM regions WHERE id = $1',
        [regionId],
      );
      const region = regionRows[0];
      if (!region) throw new Error(`region ${regionId} not found`);

      await lockTickRows(client, regionId, day);

      const weather = await recordWeather(client, regionId, region.seed, region.climate, day);
      const ctx: TickContext = {
        deps,
        client,
        regionId,
        regionSeed: region.seed,
        climate: region.climate,
        rulesetVersion: clock.rulesetVersion,
        day,
        date: toGameDate(day),
        weather: weather.today,
        stats,
        touchedCompanies: new Set(),
      };

      const machineryEffects = await loadMachineryEffects(client, regionId);
      const irrigated = await advanceCrops(ctx);
      await chargeIrrigation(ctx, irrigated, machineryEffects);
      await spoilExpiredLots(ctx);
      await updateMarkets(ctx);
      await expireListings(ctx);
      await settleContractDeadlines(ctx);
      await processLeases(ctx);
      await chargeLoanInstalments(ctx);
      await chargeLandTax(ctx);
      await depreciateAndMaintainMachinery(ctx);
      await evaluateCompanies(ctx);
      await chargeIncomeTax(ctx);

      for (const companyId of [...ctx.touchedCompanies].sort()) {
        await emitCompanyUpdated(ctx, companyId);
      }

      const nextDay = day + 1;
      await client.query(
        'UPDATE world_clock SET game_day = $2, updated_at = now() WHERE region_id = $1',
        [regionId, nextDay],
      );
      const nextWeather = weather.tomorrow;
      await tickEvent(ctx, {
        type: 'world.time_updated',
        companyId: null,
        gameDay: nextDay,
        entityType: 'region',
        entityId: regionId,
        payload: {
          gameDay: nextDay,
          date: toGameDate(nextDay),
          weather: {
            rainMm: nextWeather.rainMm,
            tempC: nextWeather.tempC,
            event: nextWeather.event,
          },
        },
      });

      const durationMs = Math.round(performance.now() - t0);
      await client.query(
        `UPDATE simulation_checkpoints SET duration_ms = $3, stats = $4, completed_at = now()
         WHERE region_id = $1 AND game_day = $2`,
        [regionId, nextDay, durationMs, JSON.stringify(stats)],
      );

      if (opts.failBeforeCommit) {
        throw new Error(`fault injection: tick for day ${day} aborted before commit`);
      }

      deps.logger.debug({ regionId, day, durationMs, stats }, 'simulation day processed');
      return {
        regionId,
        processedDay: day,
        gameDay: nextDay,
        skipped: false,
        durationMs,
        stats,
      };
    },
    { retries: 5 },
  );
}

/**
 * Lock everything the tick will mutate, following the command layer's lock order
 * (commands/context.ts): contested entities first, then all company rows in id order; inventory
 * lots are locked later by the steps that touch them (after companies, as commands do). Taking
 * the entity locks up front means a command that already holds one of them finishes first
 * instead of deadlocking against the tick.
 */
async function lockTickRows(client: DbClient, regionId: string, day: number): Promise<void> {
  await client.query(
    `SELECT p.id FROM crop_plots p JOIN land_parcels lp ON lp.id = p.parcel_id
     WHERE lp.region_id = $1 AND p.status IN ('growing', 'ready') ORDER BY p.id FOR UPDATE OF p`,
    [regionId],
  );
  await client.query(
    `SELECT ml.id FROM market_listings ml JOIN inventory_lots l ON l.id = ml.lot_id
     WHERE ml.region_id = $1 AND ml.status = 'open' AND (ml.expires_day <= $2 OR l.expires_day <= $2)
     ORDER BY ml.id FOR UPDATE OF ml`,
    [regionId, day],
  );
  await client.query(
    `SELECT id FROM contracts
     WHERE region_id = $1 AND status IN ('open', 'accepted') AND delivery_by_day <= $2
     ORDER BY id FOR UPDATE`,
    [regionId, day],
  );
  await client.query(
    `SELECT l.id FROM loans l JOIN companies c ON c.id = l.company_id
     WHERE c.region_id = $1 AND l.status = 'active' AND l.next_due_day <= $2
     ORDER BY l.id FOR UPDATE OF l`,
    [regionId, day],
  );
  await client.query(
    `SELECT p.id FROM land_parcels p JOIN land_leases l ON l.parcel_id = p.id
     WHERE p.region_id = $1 AND l.status = 'active' AND l.end_day <= $2
     ORDER BY p.id FOR UPDATE OF p, l`,
    [regionId, day],
  );
  await client.query(
    `SELECT m.id FROM machinery_assets m JOIN companies c ON c.id = m.company_id
     WHERE c.region_id = $1 AND m.status = 'active' ORDER BY m.id FOR UPDATE OF m`,
    [regionId],
  );
  await client.query(
    `SELECT s.market_id FROM market_item_states s JOIN markets m ON m.id = s.market_id
     WHERE m.region_id = $1 ORDER BY s.market_id, s.item_id FOR UPDATE OF s`,
    [regionId],
  );
  await client.query('SELECT id FROM companies WHERE region_id = $1 ORDER BY id FOR UPDATE', [
    regionId,
  ]);
}
