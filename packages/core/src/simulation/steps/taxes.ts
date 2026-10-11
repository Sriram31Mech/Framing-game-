import { DAYS_PER_YEAR, incomeTaxPaise, landTaxPaise } from '@bh/domain';
import { tickNotify } from '../effects';
import { chargeExpense } from '../postings';
import type { TickContext } from '../types';

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;

/**
 * Step 9 — land tax, charged when day D is the 1st of a month, on every hectare a company holds:
 * parcels it owns (unless leased out to someone else, then the lessee pays) and parcels it leases.
 */
export async function chargeLandTax(ctx: TickContext): Promise<void> {
  if (ctx.date.dayOfMonth !== 1) return;
  const { rows } = await ctx.client.query<{ company_id: string; area_ha: number }>(
    `WITH held AS (
       SELECT p.owner_company_id AS company_id, p.area_ha
       FROM land_parcels p
       WHERE p.region_id = $1 AND p.owner_company_id IS NOT NULL
         AND NOT EXISTS (SELECT 1 FROM land_leases l WHERE l.parcel_id = p.id AND l.status = 'active')
       UNION ALL
       SELECT l.lessee_company_id AS company_id, p.area_ha
       FROM land_leases l JOIN land_parcels p ON p.id = l.parcel_id
       WHERE p.region_id = $1 AND l.status = 'active'
     )
     SELECT company_id, SUM(area_ha) AS area_ha FROM held GROUP BY company_id ORDER BY company_id`,
    [ctx.regionId],
  );
  for (const r of rows) {
    const tax = landTaxPaise(Number(r.area_ha), 1);
    if (tax <= 0) continue;
    await chargeExpense(ctx, {
      companyId: r.company_id,
      account: 'expense_tax',
      amountPaise: tax,
      kind: 'land_tax',
      description: `Land tax for ${ctx.date.label.replace(/^\d+ /, '')}`,
      refType: 'company',
      refId: r.company_id,
    });
    ctx.stats.landTaxCharges++;
  }
}

/** Accounts that make up profit and loss (revenue credits are negative, expenses positive). */
const PNL_ACCOUNTS = [
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
];

/**
 * Step 12 — yearly income tax on day-of-year 0 (1 January): INCOME_TAX_BPS of positive net
 * profit over the 360 days ending with day D, read from the ledger. Income tax postings are
 * excluded from the profit base; windows of consecutive years do not overlap.
 */
export async function chargeIncomeTax(ctx: TickContext): Promise<void> {
  if (ctx.date.dayOfYear !== 0) return;
  const { rows } = await ctx.client.query<{ company_id: string; profit: number }>(
    `SELECT e.company_id, (-SUM(e.amount_paise))::bigint AS profit
     FROM ledger_entries e
     JOIN ledger_transactions t ON t.id = e.transaction_id
     JOIN companies c ON c.id = e.company_id
     WHERE c.region_id = $1 AND e.game_day > $2 AND e.game_day <= $3
       AND e.account_code = ANY($4::text[]) AND t.kind <> 'income_tax'
     GROUP BY e.company_id
     ORDER BY e.company_id`,
    [ctx.regionId, ctx.day - DAYS_PER_YEAR, ctx.day, PNL_ACCOUNTS],
  );
  for (const r of rows) {
    const profit = Number(r.profit);
    const tax = incomeTaxPaise(profit);
    if (tax <= 0) continue;
    await chargeExpense(ctx, {
      companyId: r.company_id,
      account: 'expense_tax',
      amountPaise: tax,
      kind: 'income_tax',
      description: `Income tax, year ending ${ctx.date.label}`,
      refType: 'company',
      refId: r.company_id,
    });
    ctx.stats.incomeTaxCharges++;
    await tickNotify(ctx, {
      companyId: r.company_id,
      type: 'income_tax',
      severity: 'info',
      title: 'Annual income tax charged',
      body: `Net profit over the last year was ${rupees(profit)}; income tax of ${rupees(tax)} was charged.`,
      entityType: 'company',
      entityId: r.company_id,
      dedupeKey: `income-tax:${ctx.day}`,
    });
  }
}
