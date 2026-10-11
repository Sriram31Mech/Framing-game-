import { assertPaise } from '@bh/domain';
import type { DbClient } from '../db/pool';
import { insufficientFunds } from '../errors';

/** Per-company ledger accounts. Positive amount = debit, negative = credit. */
export const COMPANY_ACCOUNTS = [
  'cash',
  'escrow',
  'inventory',
  'land',
  'machinery',
  'loan_payable',
  'equity',
  'revenue_sales',
  'revenue_other',
  'expense_seed',
  'expense_labor',
  'expense_inputs',
  'expense_irrigation',
  'expense_transport',
  'expense_fees',
  'expense_rent',
  'expense_interest',
  'expense_tax',
  'expense_maintenance',
  'expense_depreciation',
  'expense_spoilage',
  'cogs',
  'gain_loss_assets',
] as const;
export type CompanyAccount = (typeof COMPANY_ACCOUNTS)[number];

/** World-side counterparties (company_id NULL): money sources and sinks. */
export const WORLD_ACCOUNTS = [
  'world_treasury',
  'world_market',
  'world_suppliers',
  'world_bank',
] as const;
export type WorldAccount = (typeof WORLD_ACCOUNTS)[number];

export const ACCOUNT_LABELS: Record<CompanyAccount, string> = {
  cash: 'Cash',
  escrow: 'Funds in escrow',
  inventory: 'Inventory',
  land: 'Land',
  machinery: 'Machinery',
  loan_payable: 'Loans payable',
  equity: 'Owner equity',
  revenue_sales: 'Sales revenue',
  revenue_other: 'Other income',
  expense_seed: 'Seed',
  expense_labor: 'Labour',
  expense_inputs: 'Fertiliser & pest control',
  expense_irrigation: 'Irrigation',
  expense_transport: 'Transport',
  expense_fees: 'Market & trade fees',
  expense_rent: 'Land lease rent',
  expense_interest: 'Loan interest',
  expense_tax: 'Taxes',
  expense_maintenance: 'Maintenance',
  expense_depreciation: 'Depreciation',
  expense_spoilage: 'Spoilage & write-offs',
  cogs: 'Cost of goods sold',
  gain_loss_assets: 'Gain/loss on asset sales',
};

export type LedgerEntryInput =
  | { companyId: string; account: CompanyAccount; amountPaise: number }
  | { companyId: null; account: WorldAccount; amountPaise: number };

export interface LedgerTransactionInput {
  regionId: string;
  kind: string;
  description: string;
  gameDay: number;
  refType?: string;
  refId?: string;
  entries: LedgerEntryInput[];
  /**
   * Commands must never push cash below zero (default false => throws INSUFFICIENT_FUNDS).
   * Only scheduled obligations in the daily tick (loan EMIs, tax, irrigation) may set this.
   */
  allowNegativeCash?: boolean;
}

/**
 * Post a balanced double-entry transaction and keep the denormalised `companies.cash_paise` and
 * `companies.escrow_paise` in step — in the SAME database transaction as the caller's state change.
 * Callers must already hold `SELECT ... FOR UPDATE` on affected company rows (use lockCompanies()).
 * Returns the ledger transaction id.
 */
export async function postLedger(client: DbClient, tx: LedgerTransactionInput): Promise<string> {
  const entries = tx.entries.filter((e) => e.amountPaise !== 0);
  if (entries.length < 2)
    throw new Error(`ledger transaction ${tx.kind} needs at least two non-zero entries`);
  let sum = 0;
  for (const e of entries) {
    assertPaise(e.amountPaise, `${tx.kind}.${e.account}`);
    sum += e.amountPaise;
  }
  if (sum !== 0) throw new Error(`ledger transaction ${tx.kind} is unbalanced by ${sum}`);

  // Aggregate cash/escrow deltas per company.
  const cashDelta = new Map<string, number>();
  const escrowDelta = new Map<string, number>();
  for (const e of entries) {
    if (e.companyId === null) continue;
    if (e.account === 'cash')
      cashDelta.set(e.companyId, (cashDelta.get(e.companyId) ?? 0) + e.amountPaise);
    if (e.account === 'escrow')
      escrowDelta.set(e.companyId, (escrowDelta.get(e.companyId) ?? 0) + e.amountPaise);
  }

  for (const [companyId, delta] of cashDelta) {
    const { rows } = await client.query<{ cash_paise: number }>(
      'UPDATE companies SET cash_paise = cash_paise + $2 WHERE id = $1 RETURNING cash_paise',
      [companyId, delta],
    );
    const row = rows[0];
    if (!row) throw new Error(`company ${companyId} not found while posting ledger`);
    if (row.cash_paise < 0 && delta < 0 && !tx.allowNegativeCash) {
      throw insufficientFunds(-delta, row.cash_paise - delta);
    }
  }
  for (const [companyId, delta] of escrowDelta) {
    // CHECK (escrow_paise >= 0) guards against over-release.
    await client.query('UPDATE companies SET escrow_paise = escrow_paise + $2 WHERE id = $1', [
      companyId,
      delta,
    ]);
  }

  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO ledger_transactions (region_id, kind, description, game_day, ref_type, ref_id)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
    [tx.regionId, tx.kind, tx.description, tx.gameDay, tx.refType ?? null, tx.refId ?? null],
  );
  const txId = rows[0]!.id;

  const values: unknown[] = [];
  const placeholders = entries.map((e, i) => {
    values.push(txId, e.companyId, e.account, e.amountPaise, tx.gameDay);
    const b = i * 5;
    return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5})`;
  });
  await client.query(
    `INSERT INTO ledger_entries (transaction_id, company_id, account_code, amount_paise, game_day)
     VALUES ${placeholders.join(', ')}`,
    values,
  );
  return txId;
}

/**
 * Lock company rows in a deterministic order (by id) to avoid deadlocks between two-party
 * transactions. Returns the locked rows keyed by id.
 */
export async function lockCompanies(
  client: DbClient,
  companyIds: string[],
): Promise<
  Map<
    string,
    { id: string; cash_paise: number; escrow_paise: number; status: string; region_id: string }
  >
> {
  const ids = [...new Set(companyIds)].sort();
  const { rows } = await client.query<{
    id: string;
    cash_paise: number;
    escrow_paise: number;
    status: string;
    region_id: string;
  }>(
    'SELECT id, cash_paise, escrow_paise, status, region_id FROM companies WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [ids],
  );
  return new Map(rows.map((r) => [r.id, r]));
}

/** Reconciliation: companies whose denormalised cash/escrow differ from the ledger. Should be empty. */
export async function findLedgerMismatches(
  client: Pick<DbClient, 'query'>,
): Promise<{ companyId: string; account: string; denormalised: number; ledger: number }[]> {
  const { rows } = await client.query<{
    company_id: string;
    account: string;
    denormalised: number;
    ledger: number;
  }>(`
    WITH sums AS (
      SELECT company_id, account_code, SUM(amount_paise)::bigint AS total
      FROM ledger_entries WHERE company_id IS NOT NULL AND account_code IN ('cash', 'escrow')
      GROUP BY company_id, account_code
    )
    SELECT c.id AS company_id, a.account, a.denormalised, COALESCE(s.total, 0)::bigint AS ledger
    FROM companies c
    CROSS JOIN LATERAL (VALUES ('cash', c.cash_paise), ('escrow', c.escrow_paise)) AS a(account, denormalised)
    LEFT JOIN sums s ON s.company_id = c.id AND s.account_code = a.account
    WHERE a.denormalised <> COALESCE(s.total, 0)`);
  return rows.map((r) => ({
    companyId: r.company_id,
    account: r.account,
    denormalised: Number(r.denormalised),
    ledger: Number(r.ledger),
  }));
}
