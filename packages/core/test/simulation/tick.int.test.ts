import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CoreDeps } from '../../src/commands/types';
import { catchUp } from '../../src/simulation/catchup';
import { runReconciliation } from '../../src/simulation/reconcile';
import { advanceDay } from '../../src/simulation/tick';
import { assertInvariants, createHuman, gameDay, REGION, setupWorld } from './helpers';

describe('advanceDay: idempotency and concurrency', () => {
  let deps: CoreDeps;

  beforeAll(async () => {
    deps = await setupWorld();
    await createHuman(deps, 'Tick Farms');
  });
  afterAll(async () => {
    await deps.pool.end();
  });

  it('five concurrent calls advance exactly one day', async () => {
    const before = await gameDay(deps);
    const results = await Promise.all(Array.from({ length: 5 }, () => advanceDay(deps, REGION)));
    expect(results.filter((r) => !r.skipped)).toHaveLength(1);
    expect(results.filter((r) => r.skipped)).toHaveLength(4);
    expect(await gameDay(deps)).toBe(before + 1);
    const { rows } = await deps.pool.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM simulation_checkpoints WHERE region_id = $1 AND game_day = $2',
      [REGION, before + 1],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it('re-running an already processed day is a no-op', async () => {
    const day = await gameDay(deps);
    const first = await advanceDay(deps, REGION, { expectedDay: day });
    expect(first.skipped).toBe(false);
    expect(first.processedDay).toBe(day);
    const { rows: ledgerBefore } = await deps.pool.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM ledger_entries',
    );
    const again = await advanceDay(deps, REGION, { expectedDay: day });
    expect(again.skipped).toBe(true);
    expect(again.skipReason).toBe('already_processed');
    expect(await gameDay(deps)).toBe(day + 1);
    const { rows: ledgerAfter } = await deps.pool.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM ledger_entries',
    );
    expect(ledgerAfter[0]!.n).toBe(ledgerBefore[0]!.n);
  });

  it('a day aborted before commit leaves no trace', async () => {
    const day = await gameDay(deps);
    await expect(advanceDay(deps, REGION, { failBeforeCommit: true })).rejects.toThrow(
      /fault injection/,
    );
    expect(await gameDay(deps)).toBe(day);
    const { rows } = await deps.pool.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM simulation_checkpoints WHERE region_id = $1 AND game_day = $2',
      [REGION, day + 1],
    );
    expect(rows[0]!.n).toBe(0);
    const ok = await advanceDay(deps, REGION);
    expect(ok.skipped).toBe(false);
  });

  it('records weather, market snapshots and public events for each day', async () => {
    const day = await gameDay(deps);
    const r = await advanceDay(deps, REGION);
    expect(r.stats.marketItemsUpdated).toBeGreaterThan(0);
    const weather = await deps.pool.query(
      'SELECT game_day FROM weather_records WHERE region_id = $1 AND game_day IN ($2, $3)',
      [REGION, day, day + 1],
    );
    expect(weather.rowCount).toBe(2);
    const snaps = await deps.pool.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM market_price_snapshots WHERE game_day = $1',
      [day],
    );
    expect(snaps.rows[0]!.n).toBe(r.stats.marketItemsUpdated);
    const events = await deps.pool.query<{ type: string; payload: { gameDay: number } }>(
      `SELECT type, payload FROM domain_events WHERE company_id IS NULL AND game_day = $1
       AND type = 'world.time_updated'`,
      [day + 1],
    );
    expect(events.rows).toHaveLength(1);
    expect(events.rows[0]!.payload.gameDay).toBe(day + 1);
    const priceEvents = await deps.pool.query(
      `SELECT 1 FROM domain_events WHERE type = 'market.price_updated' AND game_day = $1`,
      [day],
    );
    expect(priceEvents.rowCount).toBeGreaterThan(0);
  });

  it('catchUp respects the wall clock, batch size and pause flag', async () => {
    const start = await gameDay(deps);
    // Put the epoch so that the target is exactly start + 7.
    await deps.pool.query(
      `UPDATE world_clock SET epoch_at = now() - make_interval(secs => real_seconds_per_game_day * ($2::int + 7) + 1)
       WHERE region_id = $1`,
      [REGION, start],
    );
    const first = await catchUp(deps, REGION, { maxDays: 3 });
    expect(first).toMatchObject({ daysAdvanced: 3, gameDay: start + 3, paused: false });
    const rest = await catchUp(deps, REGION, { maxDays: 100 });
    expect(rest.daysAdvanced).toBe(4);
    expect(rest.gameDay).toBe(start + 7);
    expect(rest.targetDay).toBe(start + 7);
    const idle = await catchUp(deps, REGION);
    expect(idle.daysAdvanced).toBe(0);

    await deps.pool.query('UPDATE world_clock SET paused = true WHERE region_id = $1', [REGION]);
    const paused = await catchUp(deps, REGION, { now: new Date(Date.now() + 86_400_000) });
    expect(paused).toMatchObject({ daysAdvanced: 0, paused: true });
    await deps.pool.query('UPDATE world_clock SET paused = false WHERE region_id = $1', [REGION]);
  });

  it('keeps the books reconciled', async () => {
    await assertInvariants(deps.pool);
    const report = await runReconciliation(deps, REGION);
    expect(report.issues).toEqual([]);
    expect(report.ok).toBe(true);
  });
});
