import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { generateRegion, NO_STARTER_PLOT_BONUS_PAISE, STARTING_CASH_PAISE } from '@bh/domain';
import type { CoreDeps } from '../../src/commands/types';
import { bootstrapWorld } from '../../src/world/bootstrap';
import { createCompany } from '../../src/companies/create';
import { createTestDeps } from '../helpers/db';
import { cashOf, expectLedgerReconciles, newPlayer, REGION } from './helpers';

let deps: CoreDeps;

beforeAll(async () => {
  deps = await createTestDeps({ aiCompanyCount: 3 });
});
afterAll(async () => {
  await deps.pool.end();
});

describe('bootstrapWorld', () => {
  it('creates the region, parcels with geometry, markets, clock and AI companies', async () => {
    const res = await bootstrapWorld(deps, { regionId: REGION });
    expect(res.created).toBe(true);
    expect(res.aiCompaniesCreated).toBe(3);
    const region = generateRegion(undefined, REGION);

    const parcels = await deps.pool.query<{ n: number; valid: number; reserved: number }>(
      `SELECT COUNT(*)::int AS n, COUNT(*) FILTER (WHERE ST_IsValid(geom))::int AS valid,
              COUNT(*) FILTER (WHERE status = 'reserved')::int AS reserved
       FROM land_parcels WHERE region_id = $1`,
      [REGION],
    );
    expect(parcels.rows[0]!.n).toBe(region.parcels.length);
    expect(parcels.rows[0]!.valid).toBe(region.parcels.length);
    // 3 AI companies each took a starter plot.
    const starters = region.parcels.filter((p) => p.isStarterPlot).length;
    expect(parcels.rows[0]!.reserved).toBe(starters - 3);

    const states = await deps.pool.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM market_item_states',
    );
    expect(states.rows[0]!.n).toBe(region.markets.length * 6);
    const clock = await deps.pool.query('SELECT game_day FROM world_clock WHERE region_id = $1', [
      REGION,
    ]);
    expect(clock.rows[0]).toEqual({ game_day: 0 });
    const ai = await deps.pool.query<{ ai_personality: string; kind: string }>(
      `SELECT c.ai_personality, a.kind FROM companies c
       JOIN company_memberships m ON m.company_id = c.id JOIN accounts a ON a.id = m.account_id
       WHERE c.kind = 'ai' ORDER BY c.name`,
    );
    expect(ai.rows.map((r) => r.kind)).toEqual(['ai', 'ai', 'ai']);
    expect(new Set(ai.rows.map((r) => r.ai_personality))).toEqual(
      new Set(['cautious', 'expansionist', 'trader']),
    );
    await expectLedgerReconciles(deps);
  });

  it('is idempotent', async () => {
    const before = await deps.pool.query<{ p: number; c: number; l: number }>(
      `SELECT (SELECT COUNT(*) FROM land_parcels)::int AS p, (SELECT COUNT(*) FROM companies)::int AS c,
              (SELECT COUNT(*) FROM ledger_entries)::int AS l`,
    );
    const res = await bootstrapWorld(deps, { regionId: REGION });
    expect(res).toMatchObject({ created: false, aiCompaniesCreated: 0 });
    const after = await deps.pool.query(
      `SELECT (SELECT COUNT(*) FROM land_parcels)::int AS p, (SELECT COUNT(*) FROM companies)::int AS c,
              (SELECT COUNT(*) FROM ledger_entries)::int AS l`,
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});

describe('createCompany', () => {
  it('grants starting cash, a starter plot, a welcome notification; ledger reconciles', async () => {
    const p = await newPlayer(deps, 'Ganga Farms');
    expect(p.starterParcelId).not.toBeNull();
    expect(await cashOf(deps, p.companyId)).toBe(STARTING_CASH_PAISE);
    const parcel = await deps.pool.query(
      'SELECT owner_company_id, status FROM land_parcels WHERE id = $1',
      [p.starterParcelId],
    );
    expect(parcel.rows[0]).toEqual({ owner_company_id: p.companyId, status: 'owned' });
    const hist = await deps.pool.query(
      `SELECT reason, price_paise FROM land_ownership_history WHERE parcel_id = $1`,
      [p.starterParcelId],
    );
    expect(hist.rows).toEqual([{ reason: 'starter_grant', price_paise: 0 }]);
    const notes = await deps.pool.query('SELECT type FROM notifications WHERE company_id = $1', [
      p.companyId,
    ]);
    expect(notes.rows).toEqual([{ type: 'welcome' }]);
    await expectLedgerReconciles(deps);
  });

  it('enforces one company per account, idempotent retry, and unique names', async () => {
    const p = await newPlayer(deps, 'Tunga Agro');
    const again = await createCompany(deps, {
      accountId: p.accountId,
      name: 'tunga agro',
      kind: 'human',
      regionId: REGION,
    });
    expect(again).toMatchObject({ companyId: p.companyId, existing: true });
    await expect(
      createCompany(deps, {
        accountId: p.accountId,
        name: 'Other',
        kind: 'human',
        regionId: REGION,
      }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });
    await expect(newPlayer(deps, 'TUNGA AGRO')).rejects.toMatchObject({ code: 'CONFLICT' });
  });

  it('pays the bonus when starter plots run out and enforces region capacity', async () => {
    await deps.pool.query(
      `UPDATE land_parcels SET status = 'for_sale', list_price_paise = base_price_paise WHERE status = 'reserved'`,
    );
    const p = await newPlayer(deps);
    expect(p.starterParcelId).toBeNull();
    expect(await cashOf(deps, p.companyId)).toBe(STARTING_CASH_PAISE + NO_STARTER_PLOT_BONUS_PAISE);

    const { rows } = await deps.pool.query<{ n: number }>(
      `SELECT COUNT(*)::int AS n FROM companies WHERE kind = 'human'`,
    );
    await deps.pool.query('UPDATE regions SET max_human_companies = $1', [rows[0]!.n]);
    await expect(newPlayer(deps)).rejects.toMatchObject({ code: 'LIMIT_EXCEEDED' });
    await deps.pool.query('UPDATE regions SET max_human_companies = 24');
    await expectLedgerReconciles(deps);
  });
});
