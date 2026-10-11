/**
 * AI companies participate in the same economy as players, through executeCommand only.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runAiCompanies, type AiRunResult } from '../../src/ai/runner';
import { buildAiWorldView } from '../../src/ai/view';
import type { CoreDeps } from '../../src/commands/types';
import { runReconciliation } from '../../src/simulation/reconcile';
import { advanceDay } from '../../src/simulation/tick';
import { assertInvariants, gameDay, REGION, setupWorld } from './helpers';

const DAYS = 400;

describe('AI companies in the shared economy', () => {
  let deps: CoreDeps;
  let aiIds: string[];
  const totals = { companies: 0, commands: 0, failures: 0, dropped: 0 };
  const byType: Record<string, number> = {};

  beforeAll(async () => {
    deps = await setupWorld({ aiCompanyCount: 2 });
    const { rows } = await deps.pool.query<{ id: string }>(
      `SELECT id FROM companies WHERE region_id = $1 AND kind = 'ai' ORDER BY id`,
      [REGION],
    );
    aiIds = rows.map((r) => r.id);
    // AI companies start with AI_STARTING_CASH_PAISE, so the real policy can buy full-size parcels.
  });
  afterAll(async () => {
    await deps.pool.end();
  });

  it('builds a world view from committed state', async () => {
    const view = await buildAiWorldView(deps.pool, aiIds[0]!, await gameDay(deps));
    expect(view.companyId).toBe(aiIds[0]);
    expect(view.cashPaise).toBeGreaterThan(0);
    expect(view.ownedParcels.length).toBeGreaterThan(0);
    expect(view.parcelsForSale.length).toBeGreaterThan(0);
    expect(view.markets.length).toBeGreaterThan(0);
    for (const m of view.markets) {
      expect(m.distanceKm).toBeGreaterThan(0);
      expect(Object.values(m.prices).every((p) => p > 0)).toBe(true);
    }
  });

  it(`runs ${DAYS} days: AI buys land, plants, harvests and sells, books reconcile`, async () => {
    expect(aiIds).toHaveLength(2);
    const add = (r: AiRunResult) => {
      totals.companies += r.companies;
      totals.commands += r.commands;
      totals.failures += r.failures;
      totals.dropped += r.dropped;
      for (const [k, v] of Object.entries(r.byType)) byType[k] = (byType[k] ?? 0) + v;
    };
    for (let i = 0; i < DAYS; i++) {
      await advanceDay(deps, REGION);
      add(await runAiCompanies(deps, REGION, await gameDay(deps)));
      if (i % 50 === 49) await assertInvariants(deps.pool);
    }
    expect(totals.commands).toBeGreaterThan(0);

    const ai = aiIds;
    const count = async (sql: string) =>
      (await deps.pool.query<{ n: number }>(sql, [ai])).rows[0]!.n;
    expect(
      await count(`SELECT COUNT(*)::int AS n FROM crop_plots WHERE company_id = ANY($1::uuid[])`),
    ).toBeGreaterThan(0);
    expect(
      await count(
        `SELECT COUNT(*)::int AS n FROM crop_plots WHERE company_id = ANY($1::uuid[]) AND status = 'harvested'`,
      ),
    ).toBeGreaterThan(0);
    expect(
      await count(
        `SELECT COUNT(*)::int AS n FROM trades WHERE seller_company_id = ANY($1::uuid[])`,
      ),
    ).toBeGreaterThan(0);
    expect(
      await count(
        `SELECT COUNT(*)::int AS n FROM land_ownership_history
         WHERE to_company_id = ANY($1::uuid[]) AND reason = 'purchase'`,
      ),
    ).toBeGreaterThan(0);

    await assertInvariants(deps.pool);
    const report = await runReconciliation(deps, REGION);
    expect(report.issues).toEqual([]);
  }, 900_000);

  it('rerunning the AI for the same day is a no-op', async () => {
    const day = await gameDay(deps);
    const keys = async () =>
      (await deps.pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM idempotency_keys'))
        .rows[0]!.n;
    const ledger = async () =>
      (await deps.pool.query<{ n: number }>('SELECT COUNT(*)::int AS n FROM ledger_entries'))
        .rows[0]!.n;
    // Make sure the AI acted today (it may have decided nothing on the last loop day).
    await advanceDay(deps, REGION);
    const first = await runAiCompanies(deps, REGION, day + 1);
    const k = await keys();
    const l = await ledger();
    const again = await runAiCompanies(deps, REGION, day + 1);
    expect(again.commands).toBe(0);
    expect(again.failures).toBe(0);
    if (first.commands > 0) expect(again.skipped).toBeGreaterThan(0);
    expect(await keys()).toBe(k);
    expect(await ledger()).toBe(l);
  });
});
