/**
 * Helpers for simulation integration tests (real Postgres; use the dedicated simulation test DB:
 * TEST_DATABASE_URL=postgres://bh:bh_dev_password@localhost:54329/bharat_harvest_test_sim).
 */
import { randomUUID } from 'node:crypto';
import {
  computeAllSuitability,
  DEFAULT_REGION_ID,
  DEFAULT_REGION_SEED,
  getCrop,
  type CropId,
  type ParcelEnvironment,
  type RegionClimate,
} from '@bh/domain';
import { plantingCostBreakdown } from '../../src/commands/farming';
import { executeCommand } from '../../src/commands/execute';
import type { CommandOutcome, CoreDeps, GameCommand } from '../../src/commands/types';
import { createCompany } from '../../src/companies/create';
import type { AppConfig } from '../../src/config';
import type { DbPool } from '../../src/db/pool';
import { findLedgerMismatches, postLedger } from '../../src/ledger/ledger';
import { advanceDay } from '../../src/simulation/tick';
import { bootstrapWorld } from '../../src/world/bootstrap';
import { createTestDeps } from '../helpers/db';

export const REGION = DEFAULT_REGION_ID;

/** Fresh migrated DB + bootstrapped world. AI companies are off unless asked for. */
export async function setupWorld(overrides: Partial<AppConfig> = {}): Promise<CoreDeps> {
  const deps = await createTestDeps({ aiCompanyCount: 0, ...overrides });
  await bootstrapWorld(deps, { regionId: REGION, seed: DEFAULT_REGION_SEED });
  return deps;
}

export async function createHuman(deps: CoreDeps, name: string): Promise<string> {
  const { rows } = await deps.pool.query<{ id: string }>(
    `INSERT INTO accounts (username, display_name, kind) VALUES ($1, $2, 'human') RETURNING id`,
    [`${name.toLowerCase().replace(/[^a-z0-9]/g, '_')}_${randomUUID().slice(0, 8)}`, name],
  );
  const res = await createCompany(deps, {
    accountId: rows[0]!.id,
    name,
    kind: 'human',
    regionId: REGION,
  });
  return res.companyId;
}

export async function exec(
  deps: CoreDeps,
  companyId: string,
  command: GameCommand,
  key: string = `test:${randomUUID()}`,
): Promise<CommandOutcome> {
  return executeCommand(
    deps,
    { companyId, accountId: null, kind: 'human', regionId: REGION },
    command,
    { idempotencyKey: key },
  );
}

/** Execute and assert success; returns the typed result. */
export async function execOk<T = Record<string, unknown>>(
  deps: CoreDeps,
  companyId: string,
  command: GameCommand,
): Promise<T> {
  const out = await exec(deps, companyId, command);
  if (!out.ok) {
    throw new Error(`${command.type} failed: ${out.error.code} ${out.error.message}`);
  }
  return out.result as T;
}

export async function tickDays(deps: CoreDeps, n: number): Promise<void> {
  for (let i = 0; i < n; i++) {
    const r = await advanceDay(deps, REGION);
    if (r.skipped) throw new Error(`tick unexpectedly skipped at day ${r.processedDay}`);
  }
}

/** Advance until the clock reads `day` (no-op if already there). */
export async function tickTo(deps: CoreDeps, day: number): Promise<void> {
  const now = await gameDay(deps);
  if (day < now) throw new Error(`cannot tick back from ${now} to ${day}`);
  await tickDays(deps, day - now);
}

export async function gameDay(deps: CoreDeps): Promise<number> {
  const { rows } = await deps.pool.query<{ game_day: number }>(
    'SELECT game_day FROM world_clock WHERE region_id = $1',
    [REGION],
  );
  return rows[0]!.game_day;
}

export async function cashOf(deps: CoreDeps, companyId: string): Promise<number> {
  const { rows } = await deps.pool.query<{ cash_paise: number }>(
    'SELECT cash_paise FROM companies WHERE id = $1',
    [companyId],
  );
  return rows[0]!.cash_paise;
}

/** Sum of a company's ledger account (debit positive). */
export async function ledgerBalance(
  deps: CoreDeps,
  companyId: string,
  account: string,
): Promise<number> {
  const { rows } = await deps.pool.query<{ total: number }>(
    `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS total FROM ledger_entries
     WHERE company_id = $1 AND account_code = $2`,
    [companyId, account],
  );
  return Number(rows[0]!.total);
}

/** Simulate an external loss (keeps the ledger balanced) to push a company into the red. */
export async function postLoss(deps: CoreDeps, companyId: string, amountPaise: number) {
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
    const day = await gameDay(deps);
    await postLedger(client, {
      regionId: REGION,
      kind: 'test_loss',
      description: 'Test: external loss',
      gameDay: day,
      allowNegativeCash: true,
      entries: [
        { companyId, account: 'expense_fees', amountPaise },
        { companyId, account: 'cash', amountPaise: -amountPaise },
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

/** Capital injection from the state (world_treasury → cash), like starting capital. */
export async function grantCapital(deps: CoreDeps, companyId: string, amountPaise: number) {
  const client = await deps.pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT id FROM companies WHERE id = $1 FOR UPDATE', [companyId]);
    await postLedger(client, {
      regionId: REGION,
      kind: 'test_capital',
      description: 'Test: additional capital',
      gameDay: await gameDay(deps),
      entries: [
        { companyId, account: 'cash', amountPaise },
        { companyId: null, account: 'world_treasury', amountPaise: -amountPaise },
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

/** A parcel the company farms (its starter plot). */
export async function starterParcel(
  deps: CoreDeps,
  companyId: string,
): Promise<{ id: string; area_ha: number; env: { waterAccess: string } }> {
  const { rows } = await deps.pool.query<{
    id: string;
    area_ha: number;
    env: { waterAccess: string };
  }>(`SELECT id, area_ha, env FROM land_parcels WHERE owner_company_id = $1 ORDER BY id LIMIT 1`, [
    companyId,
  ]);
  if (!rows[0]) throw new Error('company has no parcel');
  return rows[0];
}

/** Core economic invariants that must hold after every committed tick. */
export async function assertInvariants(pool: DbPool): Promise<void> {
  const mismatches = await findLedgerMismatches(pool);
  if (mismatches.length > 0) throw new Error(`ledger mismatches: ${JSON.stringify(mismatches)}`);
  const { rows } = await pool.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM inventory_lots WHERE quantity_kg < 0 OR reserved_kg < 0 OR reserved_kg > quantity_kg`,
  );
  if (rows[0]!.n > 0) throw new Error(`${rows[0]!.n} lots with invalid stock`);
}

// ---------------------------------------------------------------------------
// Fork points: copy every table into a side schema and restore it later, so the same starting
// state (same UUIDs → same RNG streams) can be advanced in two different ways and compared.

const FORK_SCHEMA = 'sim_fork';

async function publicTables(pool: DbPool): Promise<string[]> {
  const { rows } = await pool.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename <> 'spatial_ref_sys'
     ORDER BY tablename`,
  );
  return rows.map((r) => r.tablename);
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

export async function saveForkPoint(pool: DbPool): Promise<void> {
  await pool.query(`DROP SCHEMA IF EXISTS ${FORK_SCHEMA} CASCADE`);
  await pool.query(`CREATE SCHEMA ${FORK_SCHEMA}`);
  for (const t of await publicTables(pool)) {
    await pool.query(`CREATE TABLE ${FORK_SCHEMA}.${ident(t)} AS SELECT * FROM public.${ident(t)}`);
  }
}

/** Restore the saved fork point (requires a superuser test role: triggers are bypassed). */
export async function restoreForkPoint(pool: DbPool): Promise<void> {
  const tables = await publicTables(pool);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`TRUNCATE ${tables.map((t) => `public.${ident(t)}`).join(', ')} CASCADE`);
    await client.query(`SET LOCAL session_replication_role = replica`);
    for (const t of tables) {
      await client.query(`INSERT INTO public.${ident(t)} SELECT * FROM ${FORK_SCHEMA}.${ident(t)}`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Deterministic snapshot of the simulated world (no timestamps or sequence ids), for comparing
 * two runs that started from the same fork point.
 */
export async function worldSnapshot(pool: DbPool): Promise<Record<string, unknown>> {
  const q = async (sql: string) => (await pool.query(sql)).rows;
  return {
    clock: await q('SELECT region_id, game_day FROM world_clock ORDER BY region_id'),
    checkpoints: await q(
      'SELECT region_id, game_day, stats FROM simulation_checkpoints ORDER BY region_id, game_day',
    ),
    weather: await q('SELECT * FROM weather_records ORDER BY region_id, game_day'),
    companies: await q(
      `SELECT id, cash_paise, escrow_paise, status, distress_since_day, bankruptcies, version
       FROM companies ORDER BY id`,
    ),
    parcels: await q(
      'SELECT id, owner_company_id, status, list_price_paise, version FROM land_parcels ORDER BY id',
    ),
    leases: await q('SELECT id, status FROM land_leases ORDER BY id'),
    plots: await q(
      `SELECT id, status, state, last_tick_day, cost_basis_paise, version FROM crop_plots ORDER BY id`,
    ),
    lots: await q(
      'SELECT id, quantity_kg, reserved_kg, cost_basis_paise, expires_day FROM inventory_lots ORDER BY id',
    ),
    market: await q(
      `SELECT market_id, item_id, price_paise_per_kg, supply_pressure_kg, demand_kg_per_day, updated_day
       FROM market_item_states ORDER BY market_id, item_id`,
    ),
    snapshots: await q(
      'SELECT * FROM market_price_snapshots ORDER BY market_id, item_id, game_day',
    ),
    loans: await q(
      'SELECT id, outstanding_paise, instalments_paid, missed_payments, next_due_day, status FROM loans ORDER BY id',
    ),
    ledger: await q(
      `SELECT company_id, account_code, game_day, SUM(amount_paise)::bigint AS total, COUNT(*)::int AS n
       FROM ledger_entries GROUP BY company_id, account_code, game_day
       ORDER BY company_id, account_code, game_day`,
    ),
    notifications: await q(
      `SELECT company_id, type, dedupe_key, game_day, title FROM notifications
       ORDER BY company_id, game_day, type, dedupe_key`,
    ),
    events: await q(
      // Rows created during the run (notifications) get random ids; compare their content.
      `SELECT type, company_id, game_day,
              CASE WHEN type = 'notification.created' THEN NULL ELSE entity_id END AS entity_id,
              payload - 'createdAt' - 'id' AS payload
       FROM domain_events
       ORDER BY game_day, type, company_id NULLS FIRST, 4, (payload - 'createdAt' - 'id')::text`,
    ),
  };
}

/** Plant the best sowable crop on a parcel the company farms (irrigated when possible). */
export async function plantBest(
  deps: CoreDeps,
  companyId: string,
  parcelId: string,
  opts: { pick?: (crops: CropId[]) => CropId } = {},
): Promise<{ plotId: string; cropId: CropId }> {
  const { rows } = await deps.pool.query<{ env: ParcelEnvironment; area_ha: number }>(
    'SELECT env, area_ha FROM land_parcels WHERE id = $1',
    [parcelId],
  );
  const { rows: region } = await deps.pool.query<{ climate: RegionClimate }>(
    'SELECT climate FROM regions WHERE id = $1',
    [REGION],
  );
  const parcel = rows[0]!;
  const day = await gameDay(deps);
  const irrigate = parcel.env.waterAccess !== 'none';
  const sowable = computeAllSuitability(parcel.env, region[0]!.climate, {
    sowingDay: day,
    irrigated: irrigate,
  })
    .filter((s) => s.sowingOpen && s.score > 0)
    .map((s) => s.cropId);
  if (sowable.length === 0) throw new Error(`nothing can be sown on ${parcelId} on day ${day}`);
  const cropId = opts.pick ? opts.pick(sowable) : sowable[0]!;
  const cost = plantingCostBreakdown(getCrop(cropId), Number(parcel.area_ha), true, 1);
  const res = await execOk<{ plotId: string }>(deps, companyId, {
    type: 'plant',
    parcelId,
    cropId,
    irrigate,
    fertilize: true,
    expectedCostPaise: cost.totalPaise,
  });
  return { plotId: res.plotId, cropId };
}
