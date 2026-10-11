import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CoreDeps } from '@bh/core';
import { TEST_DATABASE_URL } from '../../../packages/core/test/helpers/db';
import { gameDay, REGION, setupWorld } from '../../../packages/core/test/simulation/helpers';
import { LeaderLock } from '../src/leader';
import { createWorkerMetrics } from '../src/metrics';
import { SimulationWorker } from '../src/worker';

describe('simulation worker', () => {
  let deps: CoreDeps;

  beforeAll(async () => {
    deps = await setupWorld();
    // Wall clock says the world should be at day 5.
    await deps.pool.query(
      `UPDATE world_clock SET epoch_at = now() - make_interval(secs => real_seconds_per_game_day * 5 + 1)
       WHERE region_id = $1`,
      [REGION],
    );
  });
  afterAll(async () => {
    await deps.pool.end();
  });

  it('only the leader ticks; leadership moves when the leader stops', async () => {
    const make = () =>
      new SimulationWorker(
        deps,
        new LeaderLock(TEST_DATABASE_URL, REGION, deps.logger),
        createWorkerMetrics(),
      );
    const a = make();
    const b = make();
    await a.runOnce();
    await b.runOnce();
    expect(a.status.leader).toBe(true);
    expect(b.status.leader).toBe(false);
    expect(await gameDay(deps)).toBe(5);
    expect(a.status).toMatchObject({ gameDay: 5, targetDay: 5, lagDays: 0 });
    expect(b.status.gameDay).toBe(5);

    await a.stop();
    await b.runOnce();
    expect(b.status.leader).toBe(true);
    await b.stop();
  });

  it('reconciliation reports a clean world', async () => {
    const w = new SimulationWorker(
      deps,
      new LeaderLock(TEST_DATABASE_URL, REGION, deps.logger),
      createWorkerMetrics(),
    );
    const report = await w.reconcile();
    expect(report?.ok).toBe(true);
    await w.stop();
  });
});
