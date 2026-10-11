/**
 * Backend integration-test helpers (real Postgres via TEST_DATABASE_URL).
 */
import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { getCrop, type CropPlotState } from '@bh/domain';
import { createTestDeps } from '../helpers/db';
import type { AppConfig } from '../../src/config';
import type { Actor, CommandOutcome, CoreDeps, GameCommand } from '../../src/commands/types';
import { executeCommand } from '../../src/commands/execute';
import { bootstrapWorld } from '../../src/world/bootstrap';
import { createCompany } from '../../src/companies/create';
import { findLedgerMismatches, postLedger } from '../../src/ledger/ledger';
import type { AuthContext } from '../../src/auth/sessions';

export const REGION = 'hemavati';

/** Fresh migrated DB + bootstrapped world. */
export async function setupWorld(overrides: Partial<AppConfig> = {}): Promise<CoreDeps> {
  const deps = await createTestDeps({ aiCompanyCount: 0, ...overrides });
  await bootstrapWorld(deps, { regionId: REGION });
  return deps;
}

export interface Player {
  accountId: string;
  companyId: string;
  actor: Actor;
  auth: AuthContext;
  starterParcelId: string | null;
}

let counter = 0;

/** Create a human account and found a company for it. */
export async function newPlayer(deps: CoreDeps, name?: string): Promise<Player> {
  counter++;
  const username = `player_${counter}_${randomUUID().slice(0, 6)}`;
  const { rows } = await deps.pool.query<{ id: string }>(
    `INSERT INTO accounts (username, display_name, kind) VALUES ($1, $1, 'human') RETURNING id`,
    [username],
  );
  const accountId = rows[0]!.id;
  const { companyId, starterParcelId } = await createCompany(deps, {
    accountId,
    name: name ?? `Farm ${counter} ${randomUUID().slice(0, 4)}`,
    kind: 'human',
    regionId: REGION,
  });
  return {
    accountId,
    companyId,
    starterParcelId,
    actor: { companyId, accountId, kind: 'human', regionId: REGION },
    auth: {
      sessionId: randomUUID(),
      accountId,
      accountKind: 'human',
      companyId,
      regionId: REGION,
    },
  };
}

export function run(
  deps: CoreDeps,
  player: Player,
  command: GameCommand,
  key: string = `test-${randomUUID()}`,
): Promise<CommandOutcome> {
  return executeCommand(deps, player.actor, command, { idempotencyKey: key });
}

/** Assert success and return the result (typed by the caller). */
export function ok<T>(outcome: CommandOutcome): T {
  if (!outcome.ok) {
    throw new Error(`expected success, got ${outcome.error.code}: ${outcome.error.message}`);
  }
  return outcome.result as T;
}

export function expectError(outcome: CommandOutcome, code: string): void {
  expect(outcome.ok).toBe(false);
  if (!outcome.ok) expect(outcome.error.code).toBe(code);
}

export async function expectLedgerReconciles(deps: CoreDeps): Promise<void> {
  expect(await findLedgerMismatches(deps.pool)).toEqual([]);
  const { rows } = await deps.pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM (
       SELECT transaction_id FROM ledger_entries GROUP BY transaction_id HAVING SUM(amount_paise) <> 0
     ) x`,
  );
  expect(rows[0]!.n).toBe(0);
  const neg = await deps.pool.query(
    'SELECT id FROM inventory_lots WHERE quantity_kg < 0 OR reserved_kg < 0 OR reserved_kg > quantity_kg',
  );
  expect(neg.rowCount).toBe(0);
}

export async function cashOf(deps: CoreDeps, companyId: string): Promise<number> {
  const { rows } = await deps.pool.query<{ cash_paise: number }>(
    'SELECT cash_paise FROM companies WHERE id = $1',
    [companyId],
  );
  return rows[0]!.cash_paise;
}

export async function setDay(deps: CoreDeps, day: number): Promise<void> {
  await deps.pool.query('UPDATE world_clock SET game_day = $2 WHERE region_id = $1', [REGION, day]);
}

export async function setCash(deps: CoreDeps, companyId: string, cashPaise: number): Promise<void> {
  // Keep the ledger consistent: post the adjustment as a treasury grant/withdrawal.
  const delta = cashPaise - (await cashOf(deps, companyId));
  if (delta === 0) return;
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    await postLedger(client, {
      regionId: REGION,
      kind: 'test_adjustment',
      description: 'test cash adjustment',
      gameDay: 0,
      allowNegativeCash: true,
      entries: [
        { companyId, account: 'cash', amountPaise: delta },
        { companyId: null, account: 'world_treasury', amountPaise: -delta },
      ],
    });
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Force a plot to maturity (status 'ready') the way the daily tick would. */
export async function forceReady(deps: CoreDeps, plotId: string): Promise<void> {
  const { rows } = await deps.pool.query<{ state: CropPlotState }>(
    'SELECT state FROM crop_plots WHERE id = $1',
    [plotId],
  );
  const state = rows[0]!.state;
  const crop = getCrop(state.cropId);
  const ready: CropPlotState = {
    ...state,
    stageIndex: crop.stages.length,
    stageDay: 0,
    daysSinceReady: 0,
    status: 'ready',
    health: Math.max(state.health, 0.8),
  };
  await deps.pool.query(
    `UPDATE crop_plots SET status = 'ready', state = $2, version = version + 1 WHERE id = $1`,
    [plotId, JSON.stringify(ready)],
  );
}

/** Put produce directly into a company's inventory (bypassing farming), ledger-consistent. */
export async function grantLot(
  deps: CoreDeps,
  companyId: string,
  lot: { itemId: string; quantityKg: number; quality: number; expiresDay?: number },
): Promise<string> {
  const { rows } = await deps.pool.query<{ id: string }>(
    `INSERT INTO inventory_lots (company_id, item_id, quantity_kg, quality, cost_basis_paise, source, produced_day, expires_day)
     VALUES ($1, $2, $3, $4, 0, 'harvest', 0, $5) RETURNING id`,
    [companyId, lot.itemId, lot.quantityKg, lot.quality, lot.expiresDay ?? 300],
  );
  return rows[0]!.id;
}

/** An available state parcel (not reserved/starter), cheapest first. */
export async function freeParcel(
  deps: CoreDeps,
  skip: string[] = [],
): Promise<{ id: string; version: number; price: number; rent: number; areaHa: number }> {
  const { rows } = await deps.pool.query<{
    id: string;
    version: number;
    list_price_paise: number;
    lease_rent_paise: number;
    area_ha: number;
  }>(
    `SELECT id, version, list_price_paise, lease_rent_paise, area_ha FROM land_parcels
     WHERE status = 'for_sale' AND owner_company_id IS NULL AND NOT (id = ANY($1::text[]))
     ORDER BY list_price_paise ASC, id LIMIT 1`,
    [skip],
  );
  const r = rows[0]!;
  return {
    id: r.id,
    version: r.version,
    price: r.list_price_paise,
    rent: r.lease_rent_paise,
    areaHa: r.area_ha,
  };
}
