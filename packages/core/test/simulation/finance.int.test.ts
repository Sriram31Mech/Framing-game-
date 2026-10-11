/**
 * Loans, land tax, distress and bankruptcy through the daily tick.
 */
import {
  BANKRUPTCY_RESTART_GRANT_PAISE,
  DISTRESS_GRACE_DAYS,
  getMachinery,
  landTaxPaise,
  splitInstalment,
} from '@bh/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CoreDeps } from '../../src/commands/types';
import { computeBalanceSheet, loanOfferFor } from '../../src/companies/valuation';
import { findLedgerMismatches } from '../../src/ledger/ledger';
import { runReconciliation } from '../../src/simulation/reconcile';
import {
  cashOf,
  createHuman,
  exec,
  execOk,
  gameDay,
  ledgerBalance,
  postLoss,
  REGION,
  setupWorld,
  starterParcel,
  tickDays,
  tickTo,
} from './helpers';

interface LoanRow {
  id: string;
  principal_paise: number;
  annual_rate_bps: number;
  emi_paise: number;
  outstanding_paise: number;
  instalments_paid: number;
  missed_payments: number;
  next_due_day: number;
  status: string;
}

async function loan(deps: CoreDeps, id: string): Promise<LoanRow> {
  const { rows } = await deps.pool.query<LoanRow>(
    `SELECT id, principal_paise, annual_rate_bps, emi_paise, outstanding_paise, instalments_paid,
            missed_payments, next_due_day, status FROM loans WHERE id = $1`,
    [id],
  );
  return rows[0]!;
}

describe('loans, taxes and bankruptcy', () => {
  let deps: CoreDeps;
  let borrower: string;
  let loanId: string;

  beforeAll(async () => {
    deps = await setupWorld();
    borrower = await createHuman(deps, 'Borrowing Farms');
    const offer = loanOfferFor(await computeBalanceSheet(deps.pool, REGION, borrower));
    const res = await execOk<{ loanId: string }>(deps, borrower, {
      type: 'take_loan',
      principalPaise: Math.min(200_000_00, offer.maxPrincipalPaise),
      termMonths: 12,
      expectedRateBps: offer.annualRateBps,
    });
    loanId = res.loanId;
    await execOk(deps, borrower, {
      type: 'buy_machinery',
      machineryType: 'pump_set',
      expectedPricePaise: getMachinery('pump_set').pricePaise,
    });
  });
  afterAll(async () => {
    await deps.pool.end();
  });

  it('charges land tax on the 1st of the month for held hectares', async () => {
    // Day 0 is 1 June.
    expect(await gameDay(deps)).toBe(0);
    await tickDays(deps, 1);
    const parcel = await starterParcel(deps, borrower);
    expect(await ledgerBalance(deps, borrower, 'expense_tax')).toBe(
      landTaxPaise(Number(parcel.area_ha), 1),
    );
    await tickDays(deps, 1);
    expect(await ledgerBalance(deps, borrower, 'expense_tax')).toBe(
      landTaxPaise(Number(parcel.area_ha), 1),
    );
  });

  it('depreciates machinery and charges maintenance daily', async () => {
    const { rows } = await deps.pool.query<{
      book_value_paise: number;
      purchase_price_paise: number;
    }>(
      `SELECT book_value_paise, purchase_price_paise FROM machinery_assets WHERE company_id = $1`,
      [borrower],
    );
    expect(rows[0]!.book_value_paise).toBeLessThan(rows[0]!.purchase_price_paise);
    expect(await ledgerBalance(deps, borrower, 'machinery')).toBe(rows[0]!.book_value_paise);
    expect(await ledgerBalance(deps, borrower, 'expense_depreciation')).toBe(
      rows[0]!.purchase_price_paise - rows[0]!.book_value_paise,
    );
    if (getMachinery('pump_set').maintenancePaisePerDay > 0) {
      expect(await ledgerBalance(deps, borrower, 'expense_maintenance')).toBe(
        getMachinery('pump_set').maintenancePaisePerDay * (await gameDay(deps)),
      );
    }
  });

  it('collects the EMI on its due day, split into interest and principal', async () => {
    const before = await loan(deps, loanId);
    expect(before.instalments_paid).toBe(0);
    await tickTo(deps, before.next_due_day);
    expect((await loan(deps, loanId)).instalments_paid).toBe(0);
    const cashBefore = await cashOf(deps, borrower);
    const interestBefore = await ledgerBalance(deps, borrower, 'expense_interest');
    await tickDays(deps, 1); // processes the due day
    const after = await loan(deps, loanId);
    const split = splitInstalment(
      before.outstanding_paise,
      before.annual_rate_bps,
      before.emi_paise,
    );
    expect(after.instalments_paid).toBe(1);
    expect(after.outstanding_paise).toBe(before.outstanding_paise - split.principalPaise);
    expect(after.next_due_day).toBe(before.next_due_day + 30);
    expect((await ledgerBalance(deps, borrower, 'expense_interest')) - interestBefore).toBe(
      split.interestPaise,
    );
    expect(-(await ledgerBalance(deps, borrower, 'loan_payable'))).toBe(after.outstanding_paise);
    expect(await cashOf(deps, borrower)).toBeLessThanOrEqual(cashBefore - before.emi_paise);
    const { rows } = await deps.pool.query(
      `SELECT 1 FROM notifications WHERE company_id = $1 AND type = 'loan_payment'`,
      [borrower],
    );
    expect(rows).toHaveLength(1);
  });

  it('negative cash → distressed with countdown warnings → bankrupt → liquidated and restarted', async () => {
    const parcel = await starterParcel(deps, borrower);
    await postLoss(deps, borrower, (await cashOf(deps, borrower)) + 1_000_000_00);
    expect(await cashOf(deps, borrower)).toBeLessThan(0);

    await tickDays(deps, 1);
    const { rows: distressed } = await deps.pool.query<{
      status: string;
      distress_since_day: number;
    }>('SELECT status, distress_since_day FROM companies WHERE id = $1', [borrower]);
    expect(distressed[0]!.status).toBe('distressed');

    // Distressed companies may only raise cash, not expand.
    const blocked = await exec(deps, borrower, {
      type: 'buy_machinery',
      machineryType: 'tractor',
      expectedPricePaise: getMachinery('tractor').pricePaise,
    });
    expect(blocked.ok).toBe(false);

    let bankrupt = false;
    for (let i = 0; i < DISTRESS_GRACE_DAYS + 3 && !bankrupt; i++) {
      await tickDays(deps, 1);
      const { rows } = await deps.pool.query<{ bankruptcies: number }>(
        'SELECT bankruptcies FROM companies WHERE id = $1',
        [borrower],
      );
      bankrupt = rows[0]!.bankruptcies === 1;
    }
    expect(bankrupt).toBe(true);

    const { rows: notes } = await deps.pool.query<{ type: string; dedupe_key: string }>(
      `SELECT type, dedupe_key FROM notifications WHERE company_id = $1
       AND type IN ('distress', 'distress_warning', 'bankruptcy') ORDER BY game_day`,
      [borrower],
    );
    expect(notes.filter((n) => n.type === 'distress')).toHaveLength(1);
    const warnings = notes.filter((n) => n.type === 'distress_warning').map((n) => n.dedupe_key);
    expect(warnings.map((k) => Number(k.split(':').pop()))).toEqual([14, 7, 3, 1]);
    expect(notes.filter((n) => n.type === 'bankruptcy')).toHaveLength(1);

    const { rows: company } = await deps.pool.query<{
      status: string;
      distress_since_day: number | null;
      cash_paise: number;
    }>('SELECT status, distress_since_day, cash_paise FROM companies WHERE id = $1', [borrower]);
    expect(company[0]).toMatchObject({ status: 'active', distress_since_day: null });
    expect(company[0]!.cash_paise).toBeGreaterThanOrEqual(BANKRUPTCY_RESTART_GRANT_PAISE);

    const { rows: land } = await deps.pool.query<{
      owner_company_id: string | null;
      status: string;
    }>('SELECT owner_company_id, status FROM land_parcels WHERE id = $1', [parcel.id]);
    expect(land[0]).toEqual({ owner_company_id: null, status: 'for_sale' });
    expect((await loan(deps, loanId)).status).toBe('written_off');
    const { rows: machines } = await deps.pool.query<{ status: string }>(
      'SELECT status FROM machinery_assets WHERE company_id = $1',
      [borrower],
    );
    expect(machines.every((m) => m.status === 'liquidated')).toBe(true);
    for (const account of ['land', 'machinery', 'loan_payable', 'inventory']) {
      expect(await ledgerBalance(deps, borrower, account)).toBe(0);
    }
    expect(await findLedgerMismatches(deps.pool)).toEqual([]);
    const report = await runReconciliation(deps, REGION);
    expect(report.issues).toEqual([]);

    // The restarted company can act again.
    await tickDays(deps, 1);
    const { rows: after } = await deps.pool.query<{ status: string }>(
      'SELECT status FROM companies WHERE id = $1',
      [borrower],
    );
    expect(after[0]!.status).toBe('active');
  });
});
