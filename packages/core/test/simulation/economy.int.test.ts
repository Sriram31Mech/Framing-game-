/**
 * Multi-season economy simulation: two in-game years with AI companies and a human player,
 * checking invariants as the world runs (ledger, prices within clamps, stock, ownership) and
 * that a day tick stays fast.
 */
import { getCrop, type ItemId } from '@bh/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAiCompanies } from '../../src/ai/runner';
import type { CoreDeps } from '../../src/commands/types';
import { findLedgerMismatches } from '../../src/ledger/ledger';
import { runReconciliation } from '../../src/simulation/reconcile';
import { advanceDay } from '../../src/simulation/tick';
import {
  assertInvariants,
  createHuman,
  gameDay,
  plantBest,
  REGION,
  setupWorld,
  starterParcel,
} from './helpers';

const YEARS = 2;
const DAYS = 360 * YEARS + 5;

describe('multi-season economy with AI', () => {
  let deps: CoreDeps;
  const durations: number[] = [];

  beforeAll(async () => {
    deps = await setupWorld({ aiCompanyCount: 3 });
    const human = await createHuman(deps, 'Long Run Farms');
    await plantBest(deps, human, (await starterParcel(deps, human)).id);
  });
  afterAll(async () => {
    await deps.pool.end();
  });

  async function checkInvariants(): Promise<void> {
    await assertInvariants(deps.pool);
    expect(await findLedgerMismatches(deps.pool)).toEqual([]);
    const report = await runReconciliation(deps, REGION);
    expect(report.issues).toEqual([]);
    const { rows } = await deps.pool.query<{ item_id: ItemId; price_paise_per_kg: number }>(
      'SELECT item_id, price_paise_per_kg FROM market_item_states',
    );
    for (const r of rows) {
      const base = getCrop(r.item_id).basePricePaisePerKg;
      expect(r.price_paise_per_kg).toBeGreaterThanOrEqual(Math.floor(base * 0.4));
      expect(r.price_paise_per_kg).toBeLessThanOrEqual(Math.ceil(base * 2.5));
    }
    const { rows: parcels } = await deps.pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM land_parcels
       WHERE (status = 'owned' AND owner_company_id IS NULL)
          OR (status = 'leased' AND NOT EXISTS (SELECT 1 FROM land_leases l WHERE l.parcel_id = land_parcels.id AND l.status = 'active'))`,
    );
    expect(parcels[0]!.n).toBe(0);
  }

  it(`runs ${YEARS} years with invariants intact`, async () => {
    for (let i = 0; i < DAYS; i++) {
      const r = await advanceDay(deps, REGION);
      expect(r.skipped).toBe(false);
      durations.push(r.durationMs);
      await runAiCompanies(deps, REGION, r.gameDay);
      if (i % 60 === 59) await checkInvariants();
    }
    await checkInvariants();
    expect(await gameDay(deps)).toBe(DAYS);

    // Yearly income tax ran on 1 January (day-of-year 0) each year.
    const { rows: tax } = await deps.pool.query<{ n: number }>(
      `SELECT COUNT(DISTINCT game_day)::int AS n FROM ledger_transactions WHERE kind = 'income_tax'`,
    );
    expect(tax[0]!.n).toBeLessThanOrEqual(YEARS);

    // The economy actually ran: trades happened and prices moved.
    const { rows: trades } = await deps.pool.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM trades',
    );
    expect(trades[0]!.n).toBeGreaterThan(0);
    const { rows: spread } = await deps.pool.query<{ n: number }>(
      `SELECT COUNT(DISTINCT price_paise_per_kg)::int AS n FROM market_price_snapshots`,
    );
    expect(spread[0]!.n).toBeGreaterThan(10);

    durations.sort((a, b) => a - b);
    const p95 = durations[Math.floor(durations.length * 0.95)]!;
    const max = durations[durations.length - 1]!;
    // Generous bounds for CI; locally a day takes a few tens of ms.
    expect(p95).toBeLessThan(1000);
    expect(max).toBeLessThan(5000);
  }, 1_800_000);
});
