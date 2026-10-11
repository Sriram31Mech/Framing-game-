import type { CoreDeps } from '../commands/types';
import { findLedgerMismatches } from '../ledger/ledger';
import { getWorldClock } from '../world/clock';

export interface ReconciliationIssue {
  kind:
    | 'ledger_mismatch'
    | 'unbalanced_transaction'
    | 'negative_inventory'
    | 'reservation_mismatch'
    | 'escrow_mismatch'
    | 'parcel_state'
    | 'plot_rights'
    | 'clock_checkpoint';
  entityType: string;
  entityId: string;
  detail: string;
}

export interface ReconciliationReport {
  regionId: string;
  gameDay: number;
  checkedAt: string;
  durationMs: number;
  ledgerMismatches: { companyId: string; account: string; denormalised: number; ledger: number }[];
  issues: ReconciliationIssue[];
  /** Count per issue kind (all kinds present, zero when clean). */
  counts: Record<ReconciliationIssue['kind'], number>;
  ok: boolean;
}

/**
 * Read-only audit of economic invariants for one region. Never "fixes" anything (least of all
 * money): problems are reported, logged and exported as metrics for a human to investigate.
 * Checks: denormalised cash/escrow vs ledger, unbalanced ledger transactions, inventory
 * quantities/reservations vs open listings, company escrow vs live contracts, parcel
 * status/owner/lease consistency, live plots on land the company holds no rights to, and the
 * world clock vs the last simulation checkpoint.
 */
export async function runReconciliation(
  deps: CoreDeps,
  regionId: string,
): Promise<ReconciliationReport> {
  const t0 = performance.now();
  const db = deps.pool;
  const clock = await getWorldClock(db, regionId);
  const issues: ReconciliationIssue[] = [];

  const { rows: companyRows } = await db.query<{ id: string }>(
    'SELECT id FROM companies WHERE region_id = $1',
    [regionId],
  );
  const regionCompanies = new Set(companyRows.map((r) => r.id));
  const ledgerMismatches = (await findLedgerMismatches(db)).filter((m) =>
    regionCompanies.has(m.companyId),
  );
  for (const m of ledgerMismatches) {
    issues.push({
      kind: 'ledger_mismatch',
      entityType: 'company',
      entityId: m.companyId,
      detail: `${m.account}: denormalised ${m.denormalised} vs ledger ${m.ledger}`,
    });
  }

  const { rows: unbalanced } = await db.query<{ transaction_id: string; total: number }>(
    `SELECT e.transaction_id, SUM(e.amount_paise)::bigint AS total
     FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
     WHERE t.region_id = $1
     GROUP BY e.transaction_id HAVING SUM(e.amount_paise) <> 0`,
    [regionId],
  );
  for (const u of unbalanced) {
    issues.push({
      kind: 'unbalanced_transaction',
      entityType: 'ledger_transaction',
      entityId: u.transaction_id,
      detail: `entries sum to ${u.total}`,
    });
  }

  const { rows: badLots } = await db.query<{
    id: string;
    quantity_kg: number;
    reserved_kg: number;
    cost_basis_paise: number;
  }>(
    `SELECT l.id, l.quantity_kg, l.reserved_kg, l.cost_basis_paise
     FROM inventory_lots l JOIN companies c ON c.id = l.company_id
     WHERE c.region_id = $1
       AND (l.quantity_kg < 0 OR l.reserved_kg < 0 OR l.reserved_kg > l.quantity_kg
            OR l.cost_basis_paise < 0 OR (l.quantity_kg = 0 AND l.cost_basis_paise <> 0))`,
    [regionId],
  );
  for (const l of badLots) {
    issues.push({
      kind: 'negative_inventory',
      entityType: 'inventory_lot',
      entityId: l.id,
      detail: `quantity ${l.quantity_kg}, reserved ${l.reserved_kg}, cost basis ${l.cost_basis_paise}`,
    });
  }

  // Every reserved kg must be backed by an open listing on that lot (contracts don't reserve).
  const { rows: reservations } = await db.query<{
    id: string;
    reserved_kg: number;
    listed_kg: number;
  }>(
    `SELECT l.id, l.reserved_kg, COALESCE(SUM(ml.remaining_kg) FILTER (WHERE ml.status = 'open'), 0)::bigint AS listed_kg
     FROM inventory_lots l
     JOIN companies c ON c.id = l.company_id
     LEFT JOIN market_listings ml ON ml.lot_id = l.id
     WHERE c.region_id = $1
     GROUP BY l.id, l.reserved_kg
     HAVING l.reserved_kg <> COALESCE(SUM(ml.remaining_kg) FILTER (WHERE ml.status = 'open'), 0)`,
    [regionId],
  );
  for (const r of reservations) {
    issues.push({
      kind: 'reservation_mismatch',
      entityType: 'inventory_lot',
      entityId: r.id,
      detail: `reserved ${r.reserved_kg} kg but open listings hold ${r.listed_kg} kg`,
    });
  }

  const { rows: escrow } = await db.query<{ id: string; escrow_paise: number; held: number }>(
    `SELECT c.id, c.escrow_paise,
            COALESCE((SELECT SUM(k.escrow_paise) FROM contracts k
                      WHERE k.buyer_company_id = c.id AND k.status IN ('open', 'accepted')), 0)::bigint AS held
     FROM companies c WHERE c.region_id = $1`,
    [regionId],
  );
  for (const e of escrow) {
    if (Number(e.held) !== e.escrow_paise) {
      issues.push({
        kind: 'escrow_mismatch',
        entityType: 'company',
        entityId: e.id,
        detail: `company escrow ${e.escrow_paise} vs live contracts ${e.held}`,
      });
    }
  }

  const { rows: parcels } = await db.query<{
    id: string;
    status: string;
    owner_company_id: string | null;
    list_price_paise: number | null;
    active_leases: number;
  }>(
    `SELECT p.id, p.status, p.owner_company_id, p.list_price_paise,
            (SELECT COUNT(*) FROM land_leases l WHERE l.parcel_id = p.id AND l.status = 'active')::int AS active_leases
     FROM land_parcels p WHERE p.region_id = $1 ORDER BY p.id`,
    [regionId],
  );
  for (const p of parcels) {
    const problem = parcelProblem(p);
    if (problem) {
      issues.push({ kind: 'parcel_state', entityType: 'parcel', entityId: p.id, detail: problem });
    }
  }

  const { rows: plots } = await db.query<{ id: string; parcel_id: string; company_id: string }>(
    `SELECT cp.id, cp.parcel_id, cp.company_id
     FROM crop_plots cp JOIN land_parcels p ON p.id = cp.parcel_id
     WHERE p.region_id = $1 AND cp.status IN ('growing', 'ready', 'failed')
       AND NOT (p.owner_company_id IS NOT DISTINCT FROM cp.company_id)
       AND NOT EXISTS (SELECT 1 FROM land_leases l
                       WHERE l.parcel_id = p.id AND l.status = 'active' AND l.lessee_company_id = cp.company_id)`,
    [regionId],
  );
  for (const p of plots) {
    issues.push({
      kind: 'plot_rights',
      entityType: 'crop_plot',
      entityId: p.id,
      detail: `live plot on ${p.parcel_id} but company ${p.company_id} neither owns nor leases it`,
    });
  }

  const { rows: cp } = await db.query<{ max_day: number | null }>(
    'SELECT MAX(game_day) AS max_day FROM simulation_checkpoints WHERE region_id = $1',
    [regionId],
  );
  const maxCheckpoint = cp[0]?.max_day ?? null;
  if (maxCheckpoint !== null && maxCheckpoint !== clock.gameDay) {
    issues.push({
      kind: 'clock_checkpoint',
      entityType: 'region',
      entityId: regionId,
      detail: `clock at day ${clock.gameDay} but last checkpoint is day ${maxCheckpoint}`,
    });
  }

  const counts: ReconciliationReport['counts'] = {
    ledger_mismatch: 0,
    unbalanced_transaction: 0,
    negative_inventory: 0,
    reservation_mismatch: 0,
    escrow_mismatch: 0,
    parcel_state: 0,
    plot_rights: 0,
    clock_checkpoint: 0,
  };
  for (const i of issues) counts[i.kind]++;

  const report: ReconciliationReport = {
    regionId,
    gameDay: clock.gameDay,
    checkedAt: new Date().toISOString(),
    durationMs: Math.round(performance.now() - t0),
    ledgerMismatches,
    issues,
    counts,
    ok: issues.length === 0,
  };
  if (report.ok) {
    deps.logger.info({ regionId, gameDay: clock.gameDay }, 'reconciliation clean');
  } else {
    deps.logger.error(
      { regionId, gameDay: clock.gameDay, counts, issues: issues.slice(0, 50) },
      'reconciliation found problems',
    );
  }
  return report;
}

/** Valid (status, owner, lease) combinations for a parcel; returns a description when invalid. */
export function parcelProblem(p: {
  status: string;
  owner_company_id: string | null;
  list_price_paise: number | null;
  active_leases: number;
}): string | null {
  if (p.active_leases > 1) return `${p.active_leases} active leases`;
  switch (p.status) {
    case 'owned':
      if (!p.owner_company_id) return 'owned without an owner';
      if (p.active_leases > 0) return 'owned but has an active lease';
      return null;
    case 'for_sale':
      if (p.active_leases > 0) return 'for sale while leased';
      if (p.owner_company_id && p.list_price_paise === null)
        return 'listed by owner without a price';
      return null;
    case 'leased':
      if (p.active_leases !== 1) return 'leased without an active lease';
      return null;
    case 'reserved':
      if (p.active_leases > 0) return 'reserved but leased';
      return null;
    default:
      return `unknown status ${p.status}`;
  }
}
