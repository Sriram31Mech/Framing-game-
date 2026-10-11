/**
 * Crop lifecycle through daily ticks: plant → ready (event + notification exactly once) →
 * overripe → failed; irrigation costs; harvest → lot → spoilage write-off at cost.
 */
import { cropDurationDays, getCrop, OVERRIPE_FAIL_DAYS, type CropId } from '@bh/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CoreDeps } from '../../src/commands/types';
import {
  assertInvariants,
  createHuman,
  execOk,
  gameDay,
  ledgerBalance,
  plantBest,
  setupWorld,
  starterParcel,
  tickDays,
} from './helpers';

async function plotRow(deps: CoreDeps, plotId: string) {
  const { rows } = await deps.pool.query<{
    status: string;
    cost_basis_paise: number;
    last_tick_day: number;
  }>('SELECT status, cost_basis_paise, last_tick_day FROM crop_plots WHERE id = $1', [plotId]);
  return rows[0]!;
}

async function count(deps: CoreDeps, sql: string, params: unknown[]): Promise<number> {
  const { rows } = await deps.pool.query<{ n: number }>(sql, params);
  return rows[0]!.n;
}

/** Shortest-duration crop first (keeps the test quick). */
const quickest = (crops: CropId[]) =>
  [...crops].sort((a, b) => cropDurationDays(getCrop(a)) - cropDurationDays(getCrop(b)))[0]!;

describe('crop lifecycle through ticks', () => {
  let deps: CoreDeps;
  let grower: string;
  let neglecter: string;
  let harvestPlot: { plotId: string; cropId: CropId };
  let failPlot: { plotId: string; cropId: CropId };

  beforeAll(async () => {
    deps = await setupWorld();
    grower = await createHuman(deps, 'Harvest Ready Farms');
    neglecter = await createHuman(deps, 'Neglect Agro');
    harvestPlot = await plantBest(deps, grower, (await starterParcel(deps, grower)).id, {
      pick: quickest,
    });
    failPlot = await plantBest(deps, neglecter, (await starterParcel(deps, neglecter)).id, {
      pick: quickest,
    });
  });
  afterAll(async () => {
    await deps.pool.end();
  });

  it('a plot planted today starts growing with the next tick', async () => {
    const day = await gameDay(deps);
    expect((await plotRow(deps, harvestPlot.plotId)).last_tick_day).toBe(day);
    await tickDays(deps, 1);
    expect((await plotRow(deps, harvestPlot.plotId)).last_tick_day).toBe(day);
    await tickDays(deps, 1);
    expect((await plotRow(deps, harvestPlot.plotId)).last_tick_day).toBe(day + 1);
  });

  it('becomes ready and notifies exactly once', async () => {
    const crop = getCrop(harvestPlot.cropId);
    for (let i = 0; i < cropDurationDays(crop) + 10; i++) {
      if ((await plotRow(deps, harvestPlot.plotId)).status !== 'growing') break;
      await tickDays(deps, 1);
    }
    expect((await plotRow(deps, harvestPlot.plotId)).status).toBe('ready');
    await tickDays(deps, 3);
    expect(
      await count(
        deps,
        `SELECT COUNT(*)::int AS n FROM domain_events WHERE type = 'crop.harvest_ready' AND entity_id = $1`,
        [harvestPlot.plotId],
      ),
    ).toBe(1);
    expect(
      await count(
        deps,
        `SELECT COUNT(*)::int AS n FROM notifications WHERE type = 'crop_ready' AND entity_id = $1`,
        [harvestPlot.plotId],
      ),
    ).toBe(1);
    expect(
      await count(
        deps,
        `SELECT COUNT(*)::int AS n FROM domain_events WHERE type = 'crop.stage_changed' AND entity_id = $1`,
        [harvestPlot.plotId],
      ),
    ).toBeGreaterThan(0);
  });

  it('charges irrigation daily into expenses and the plot cost basis', async () => {
    const parcel = await starterParcel(deps, grower);
    if (parcel.env.waterAccess === 'none') return; // not irrigated: nothing to charge
    const irrigation = await ledgerBalance(deps, grower, 'expense_irrigation');
    expect(irrigation).toBeGreaterThan(0);
    const planting =
      (await ledgerBalance(deps, grower, 'expense_seed')) +
      (await ledgerBalance(deps, grower, 'expense_labor')) +
      (await ledgerBalance(deps, grower, 'expense_inputs'));
    expect((await plotRow(deps, harvestPlot.plotId)).cost_basis_paise).toBe(planting + irrigation);
  });

  it('harvest creates a lot that spoils at its expiry and is written off at cost', async () => {
    const res = await execOk<{ lotId: string; quantityKg: number; costBasisPaise: number }>(
      deps,
      grower,
      { type: 'harvest', plotId: harvestPlot.plotId },
    );
    expect(res.quantityKg).toBeGreaterThan(0);
    const inventoryBefore = await ledgerBalance(deps, grower, 'inventory');
    expect(inventoryBefore).toBe(res.costBasisPaise);

    const { rows } = await deps.pool.query<{ expires_day: number }>(
      'SELECT expires_day FROM inventory_lots WHERE id = $1',
      [res.lotId],
    );
    const expires = rows[0]!.expires_day;
    // Still sellable on its expiry day; gone after that day's tick.
    await tickDays(deps, expires - (await gameDay(deps)));
    expect(await gameDay(deps)).toBe(expires);
    const { rows: alive } = await deps.pool.query<{ quantity_kg: number }>(
      'SELECT quantity_kg FROM inventory_lots WHERE id = $1',
      [res.lotId],
    );
    expect(alive[0]!.quantity_kg).toBe(res.quantityKg);
    await tickDays(deps, 1);
    const { rows: spoiled } = await deps.pool.query<{
      quantity_kg: number;
      cost_basis_paise: number;
    }>('SELECT quantity_kg, cost_basis_paise FROM inventory_lots WHERE id = $1', [res.lotId]);
    expect(spoiled[0]).toEqual({ quantity_kg: 0, cost_basis_paise: 0 });
    expect(await ledgerBalance(deps, grower, 'inventory')).toBe(0);
    expect(await ledgerBalance(deps, grower, 'expense_spoilage')).toBe(res.costBasisPaise);
    expect(
      await count(
        deps,
        `SELECT COUNT(*)::int AS n FROM notifications WHERE type = 'inventory_spoiled' AND entity_id = $1`,
        [res.lotId],
      ),
    ).toBe(1);
  });

  it('an unharvested crop goes overripe and then fails, each notified once', async () => {
    const crop = getCrop(failPlot.cropId);
    for (let i = 0; i < crop.harvestWindowDays + OVERRIPE_FAIL_DAYS + 5; i++) {
      if ((await plotRow(deps, failPlot.plotId)).status === 'failed') break;
      await tickDays(deps, 1);
    }
    expect((await plotRow(deps, failPlot.plotId)).status).toBe('failed');
    await tickDays(deps, 5);
    for (const [table, type] of [
      ['domain_events', 'crop.failed'],
      ['notifications', 'crop_failed'],
      ['notifications', 'crop_ready'],
    ] as const) {
      expect(
        await count(
          deps,
          `SELECT COUNT(*)::int AS n FROM ${table} WHERE type = $1 AND entity_id = $2`,
          [type, failPlot.plotId],
        ),
      ).toBe(1);
    }
    expect(
      await count(
        deps,
        `SELECT COUNT(*)::int AS n FROM notifications WHERE type = 'crop_overripe' AND entity_id = $1`,
        [failPlot.plotId],
      ),
    ).toBeLessThanOrEqual(1);
    // Failed plots are no longer advanced.
    const last = (await plotRow(deps, failPlot.plotId)).last_tick_day;
    await tickDays(deps, 2);
    expect((await plotRow(deps, failPlot.plotId)).last_tick_day).toBe(last);
    await assertInvariants(deps.pool);
  });
});
