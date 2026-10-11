/**
 * Company-scoped (private) queries. Every function asserts the caller is a member first.
 */
import type {
  AwaySummaryResponse,
  CompanyOverviewResponse,
  InventoryResponse,
  LedgerResponse,
  LoansResponse,
  MachineryResponse,
  NotificationsResponse,
  PlotsResponse,
} from '@bh/contracts';
import {
  DISTRESS_GRACE_DAYS,
  formatInr,
  getCrop,
  landTaxPaise,
  MACHINERY,
  MACHINERY_TYPES,
  toGameDate,
  type ItemId,
  type MachineryType,
  type ParcelEnvironment,
} from '@bh/domain';
import type { AuthContext } from '../auth/sessions';
import type { CoreDeps } from '../commands/types';
import { BASE_STORAGE_CAPACITY_KG, getCompany, machineryEffectsFor } from '../companies/company';
import { computeBalanceSheet, loanOfferFor } from '../companies/valuation';
import type { Queryable } from '../db/pool';
import { withTransaction } from '../db/tx';
import { DomainError } from '../errors';
import { ACCOUNT_LABELS, type CompanyAccount } from '../ledger/ledger';
import { getCurrentGameDay } from '../world/clock';
import { listPlots } from '../world/parcels';
import { assertCompanyAccess, toPlotDto } from './common';

export const PNL_PERIOD_DAYS = 30;
const UPCOMING_HORIZON_DAYS = 60;

const REVENUE_ACCOUNTS: CompanyAccount[] = ['revenue_sales', 'revenue_other', 'gain_loss_assets'];
const EXPENSE_ACCOUNTS: CompanyAccount[] = [
  'cogs',
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
];

type Upcoming = CompanyOverviewResponse['upcoming'][number];

export async function getCompanyOverview(
  deps: CoreDeps,
  auth: AuthContext,
  companyId: string,
): Promise<CompanyOverviewResponse> {
  assertCompanyAccess(auth, companyId);
  // One consistent snapshot across the many reads below.
  return withTransaction(
    deps.pool,
    async (db) => {
      const company = await getCompany(db, companyId);
      const day = await getCurrentGameDay(db, company.regionId);
      const sheet = await computeBalanceSheet(db, company.regionId, companyId);
      const [pnl, cashSeries, counts, upcoming] = [
        await profitAndLoss(db, companyId, day),
        await cashSeriesFor(db, companyId, day, company.foundedDay),
        await countsFor(db, companyId),
        await upcomingFor(db, companyId, day),
      ];
      const graceDaysRemaining =
        company.status === 'distressed' && company.distressSinceDay !== null
          ? Math.max(0, company.distressSinceDay + DISTRESS_GRACE_DAYS - day)
          : null;
      return {
        company: {
          id: company.id,
          name: company.name,
          kind: company.kind,
          status: company.status,
          cashPaise: company.cashPaise,
          aiPersonality: company.aiPersonality,
          escrowPaise: company.escrowPaise,
          distressSinceDay: company.distressSinceDay,
          graceDaysRemaining,
          bankruptcies: company.bankruptcies,
          foundedDay: company.foundedDay,
        },
        balanceSheet: {
          cashPaise: sheet.cashPaise,
          escrowPaise: sheet.escrowPaise,
          inventoryValuePaise: sheet.inventoryValuePaise,
          landValuePaise: sheet.landValuePaise,
          machineryBookValuePaise: sheet.machineryBookValuePaise,
          totalAssetsPaise: sheet.totalAssetsPaise,
          loanOutstandingPaise: sheet.loanOutstandingPaise,
          totalLiabilitiesPaise: sheet.totalLiabilitiesPaise,
          equityPaise: sheet.equityPaise,
        },
        profitAndLoss: pnl,
        cashSeries,
        counts,
        upcoming,
        valuationPaise: sheet.valuationPaise,
      };
    },
    { isolation: 'REPEATABLE READ' },
  );
}

/**
 * P&L over the trailing period from ledger postings. Lines are signed by their contribution to
 * net profit (revenue positive, expenses negative). COGS can be negative in a period with
 * harvests but no sales: production costs are capitalised into inventory at harvest.
 */
async function profitAndLoss(
  db: Queryable,
  companyId: string,
  day: number,
): Promise<CompanyOverviewResponse['profitAndLoss']> {
  const { rows } = await db.query<{ account_code: CompanyAccount; total: number }>(
    `SELECT account_code, SUM(amount_paise)::bigint AS total FROM ledger_entries
     WHERE company_id = $1 AND game_day > $2 AND account_code = ANY($3::text[])
     GROUP BY account_code`,
    [companyId, day - PNL_PERIOD_DAYS, [...REVENUE_ACCOUNTS, ...EXPENSE_ACCOUNTS]],
  );
  const totals = new Map(rows.map((r) => [r.account_code, Number(r.total)]));
  let revenue = 0;
  let expenses = 0;
  const lines: CompanyOverviewResponse['profitAndLoss']['lines'] = [];
  for (const code of [...REVENUE_ACCOUNTS, ...EXPENSE_ACCOUNTS]) {
    const total = totals.get(code) ?? 0;
    if (total === 0) continue;
    if (REVENUE_ACCOUNTS.includes(code)) revenue += -total;
    else expenses += total;
    lines.push({ accountCode: code, label: ACCOUNT_LABELS[code], amountPaise: -total });
  }
  return {
    periodDays: PNL_PERIOD_DAYS,
    revenuePaise: revenue,
    expensesPaise: expenses,
    netPaise: revenue - expenses,
    lines,
  };
}

async function cashSeriesFor(
  db: Queryable,
  companyId: string,
  day: number,
  foundedDay: number,
): Promise<CompanyOverviewResponse['cashSeries']> {
  const from = Math.max(foundedDay, day - PNL_PERIOD_DAYS + 1);
  const opening = await db.query<{ total: number }>(
    `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS total FROM ledger_entries
     WHERE company_id = $1 AND account_code = 'cash' AND game_day < $2`,
    [companyId, from],
  );
  const daily = await db.query<{ game_day: number; total: number }>(
    `SELECT game_day, SUM(amount_paise)::bigint AS total FROM ledger_entries
     WHERE company_id = $1 AND account_code = 'cash' AND game_day >= $2
     GROUP BY game_day`,
    [companyId, from],
  );
  const byDay = new Map(daily.rows.map((r) => [r.game_day, Number(r.total)]));
  let balance = Number(opening.rows[0]?.total ?? 0);
  const series: CompanyOverviewResponse['cashSeries'] = [];
  for (let d = from; d <= day; d++) {
    balance += byDay.get(d) ?? 0;
    series.push({ day: d, cashPaise: balance });
  }
  return series;
}

async function countsFor(
  db: Queryable,
  companyId: string,
): Promise<CompanyOverviewResponse['counts']> {
  const { rows } = await db.query<{
    parcels_owned: number;
    parcels_leased: number;
    plots_growing: number;
    plots_ready: number;
    open_listings: number;
    open_contracts: number;
    unread: number;
  }>(
    `SELECT
       (SELECT COUNT(*) FROM land_parcels WHERE owner_company_id = $1)::int AS parcels_owned,
       (SELECT COUNT(*) FROM land_leases WHERE lessee_company_id = $1 AND status = 'active')::int AS parcels_leased,
       (SELECT COUNT(*) FROM crop_plots WHERE company_id = $1 AND status = 'growing')::int AS plots_growing,
       (SELECT COUNT(*) FROM crop_plots WHERE company_id = $1 AND status = 'ready')::int AS plots_ready,
       (SELECT COUNT(*) FROM market_listings WHERE seller_company_id = $1 AND status = 'open')::int AS open_listings,
       (SELECT COUNT(*) FROM contracts WHERE (buyer_company_id = $1 OR seller_company_id = $1)
          AND status IN ('open', 'accepted'))::int AS open_contracts,
       (SELECT COUNT(*) FROM notifications WHERE company_id = $1 AND read_at IS NULL)::int AS unread`,
    [companyId],
  );
  const r = rows[0]!;
  return {
    parcelsOwned: r.parcels_owned,
    parcelsLeased: r.parcels_leased,
    plotsGrowing: r.plots_growing,
    plotsReady: r.plots_ready,
    openListings: r.open_listings,
    openContracts: r.open_contracts,
    unreadNotifications: r.unread,
  };
}

async function upcomingFor(db: Queryable, companyId: string, day: number): Promise<Upcoming[]> {
  const horizon = day + UPCOMING_HORIZON_DAYS;
  const out: Upcoming[] = [];

  const loans = await db.query<{
    id: string;
    next_due_day: number;
    emi_paise: number;
    outstanding_paise: number;
  }>(
    `SELECT id, next_due_day, emi_paise, outstanding_paise FROM loans
     WHERE company_id = $1 AND status = 'active' AND next_due_day <= $2`,
    [companyId, horizon],
  );
  for (const l of loans.rows) {
    out.push({
      day: l.next_due_day,
      kind: 'loan_due',
      label: `Loan instalment of ${formatInr(Math.min(l.emi_paise, l.outstanding_paise))}`,
      amountPaise: Math.min(l.emi_paise, l.outstanding_paise),
      entityId: l.id,
    });
  }

  const leases = await db.query<{ id: string; parcel_id: string; end_day: number }>(
    `SELECT id, parcel_id, end_day FROM land_leases
     WHERE lessee_company_id = $1 AND status = 'active' AND end_day <= $2`,
    [companyId, horizon],
  );
  for (const l of leases.rows) {
    out.push({
      day: l.end_day,
      kind: 'lease_end',
      label: `Lease on ${l.parcel_id} ends`,
      amountPaise: null,
      entityId: l.parcel_id,
    });
  }

  const contracts = await db.query<{
    id: string;
    item_id: ItemId;
    quantity_kg: number;
    delivery_by_day: number;
    total_paise: number;
    role: 'buyer' | 'seller';
    status: string;
  }>(
    `SELECT id, item_id, quantity_kg, delivery_by_day, total_paise, status,
            CASE WHEN seller_company_id = $1 THEN 'seller' ELSE 'buyer' END AS role
     FROM contracts
     WHERE (buyer_company_id = $1 OR seller_company_id = $1) AND status IN ('open', 'accepted')
       AND delivery_by_day <= $2`,
    [companyId, horizon],
  );
  for (const c of contracts.rows) {
    const name = getCrop(c.item_id).name;
    out.push({
      day: c.delivery_by_day,
      kind: 'contract_deadline',
      label:
        c.role === 'seller'
          ? `Deliver ${c.quantity_kg.toLocaleString('en-IN')} kg ${name}`
          : c.status === 'open'
            ? `Your ${name} contract expires if not accepted`
            : `${name} delivery due to you`,
      amountPaise: c.total_paise,
      entityId: c.id,
    });
  }

  const plots = await listPlots(db, companyId, { liveOnly: true });
  for (const p of plots) {
    if (p.status !== 'ready') continue;
    const crop = getCrop(p.cropId);
    const readyDay = day - (p.state.daysSinceReady ?? 0);
    out.push({
      day: readyDay + crop.harvestWindowDays,
      kind: 'harvest_deadline',
      label: `Harvest ${crop.name} on ${p.parcelId} before losses start`,
      amountPaise: null,
      entityId: p.id,
    });
  }

  const land = await db.query<{ ha: number }>(
    `SELECT COALESCE(SUM(area_ha), 0)::float8 AS ha FROM land_parcels
     WHERE owner_company_id = $1
        OR id IN (SELECT parcel_id FROM land_leases WHERE lessee_company_id = $1 AND status = 'active')`,
    [companyId],
  );
  const ha = Number(land.rows[0]?.ha ?? 0);
  if (ha > 0) {
    let next = day + 1;
    while (toGameDate(next).dayOfMonth !== 1) next++;
    out.push({
      day: next,
      kind: 'land_tax',
      label: 'Monthly land tax',
      amountPaise: landTaxPaise(ha),
      entityId: null,
    });
  }
  return out.sort((a, b) => a.day - b.day).slice(0, 12);
}

export async function getCompanyLedger(
  deps: CoreDeps,
  auth: AuthContext,
  companyId: string,
  q: { cursor?: string; limit: number; accountCode?: string },
): Promise<LedgerResponse> {
  assertCompanyAccess(auth, companyId);
  if (q.cursor !== undefined && !/^\d{1,18}$/.test(q.cursor)) {
    throw new DomainError('VALIDATION_FAILED', 'Invalid cursor');
  }
  const { rows } = await deps.pool.query<{
    id: string;
    transaction_id: string;
    kind: string;
    description: string;
    account_code: string;
    amount_paise: number;
    game_day: number;
    created_at: Date;
  }>(
    `SELECT e.id::text AS id, e.transaction_id, t.kind, t.description, e.account_code, e.amount_paise,
            e.game_day, t.created_at
     FROM ledger_entries e JOIN ledger_transactions t ON t.id = e.transaction_id
     WHERE e.company_id = $1 AND ($2::bigint IS NULL OR e.id < $2::bigint)
       AND ($3::text IS NULL OR e.account_code = $3)
     ORDER BY e.id DESC LIMIT $4`,
    [companyId, q.cursor ?? null, q.accountCode ?? null, q.limit + 1],
  );
  const page = rows.slice(0, q.limit);
  return {
    entries: page.map((r) => ({
      id: r.id,
      transactionId: r.transaction_id,
      kind: r.kind,
      description: r.description,
      accountCode: r.account_code,
      amountPaise: r.amount_paise,
      gameDay: r.game_day,
      createdAt: r.created_at.toISOString(),
    })),
    nextCursor: rows.length > q.limit ? (page[page.length - 1]?.id ?? null) : null,
  };
}

export async function getCompanyInventory(
  deps: CoreDeps,
  auth: AuthContext,
  companyId: string,
): Promise<InventoryResponse> {
  assertCompanyAccess(auth, companyId);
  const { rows } = await deps.pool.query<{
    id: string;
    item_id: ItemId;
    quantity_kg: number;
    reserved_kg: number;
    quality: number;
    cost_basis_paise: number;
    produced_day: number;
    expires_day: number;
    source: 'harvest' | 'trade' | 'contract';
  }>(
    `SELECT id, item_id, quantity_kg, reserved_kg, quality, cost_basis_paise, produced_day, expires_day, source
     FROM inventory_lots WHERE company_id = $1 AND quantity_kg > 0
     ORDER BY item_id, expires_day, id`,
    [companyId],
  );
  const totals = new Map<ItemId, { quantityKg: number; availableKg: number }>();
  for (const r of rows) {
    const t = totals.get(r.item_id) ?? { quantityKg: 0, availableKg: 0 };
    t.quantityKg += r.quantity_kg;
    t.availableKg += r.quantity_kg - r.reserved_kg;
    totals.set(r.item_id, t);
  }
  const effects = await machineryEffectsFor(deps.pool, companyId);
  return {
    lots: rows.map((r) => ({
      id: r.id,
      itemId: r.item_id,
      quantityKg: r.quantity_kg,
      reservedKg: r.reserved_kg,
      availableKg: r.quantity_kg - r.reserved_kg,
      quality: r.quality,
      costBasisPaise: r.cost_basis_paise,
      producedDay: r.produced_day,
      expiresDay: r.expires_day,
      source: r.source,
    })),
    totals: [...totals].map(([itemId, t]) => ({ itemId, ...t })),
    storageCapacityKg:
      BASE_STORAGE_CAPACITY_KG + Math.max(0, Math.round(effects.storageCapacityKg)),
  };
}

export async function getCompanyPlots(
  deps: CoreDeps,
  auth: AuthContext,
  companyId: string,
): Promise<PlotsResponse> {
  assertCompanyAccess(auth, companyId);
  const company = await getCompany(deps.pool, companyId);
  const day = await getCurrentGameDay(deps.pool, company.regionId);
  const plots = await listPlots(deps.pool, companyId, { limit: 100 });
  const envs = await deps.pool.query<{ id: string; env: ParcelEnvironment }>(
    'SELECT id, env FROM land_parcels WHERE id = ANY($1::text[])',
    [[...new Set(plots.map((p) => p.parcelId))]],
  );
  const envBy = new Map(envs.rows.map((r) => [r.id, r.env]));
  const effects = await machineryEffectsFor(deps.pool, companyId);
  return {
    plots: plots.flatMap((p) => {
      const env = envBy.get(p.parcelId);
      return env ? [toPlotDto(p, day, env, effects.irrigationCostMultiplier)] : [];
    }),
  };
}

export async function getCompanyLoans(
  deps: CoreDeps,
  auth: AuthContext,
  companyId: string,
): Promise<LoansResponse> {
  assertCompanyAccess(auth, companyId);
  const company = await getCompany(deps.pool, companyId);
  const { rows } = await deps.pool.query<{
    id: string;
    principal_paise: number;
    annual_rate_bps: number;
    term_months: number;
    emi_paise: number;
    outstanding_paise: number;
    instalments_paid: number;
    missed_payments: number;
    start_day: number;
    next_due_day: number;
    status: 'active' | 'repaid' | 'written_off';
  }>(
    `SELECT id, principal_paise, annual_rate_bps, term_months, emi_paise, outstanding_paise,
            instalments_paid, missed_payments, start_day, next_due_day, status
     FROM loans WHERE company_id = $1
     ORDER BY (status = 'active') DESC, start_day DESC, id LIMIT 100`,
    [companyId],
  );
  const offer = loanOfferFor(await computeBalanceSheet(deps.pool, company.regionId, companyId));
  return {
    loans: rows.map((r) => ({
      id: r.id,
      principalPaise: r.principal_paise,
      annualRateBps: r.annual_rate_bps,
      termMonths: r.term_months,
      emiPaise: r.emi_paise,
      outstandingPaise: r.outstanding_paise,
      instalmentsPaid: r.instalments_paid,
      missedPayments: r.missed_payments,
      startDay: r.start_day,
      nextDueDay: r.next_due_day,
      status: r.status,
    })),
    offer,
  };
}

export async function getCompanyMachinery(
  deps: CoreDeps,
  auth: AuthContext,
  companyId: string,
): Promise<MachineryResponse> {
  assertCompanyAccess(auth, companyId);
  const { rows } = await deps.pool.query<{
    id: string;
    type: MachineryType;
    purchase_price_paise: number;
    book_value_paise: number;
    purchased_day: number;
  }>(
    `SELECT id, type, purchase_price_paise, book_value_paise, purchased_day FROM machinery_assets
     WHERE company_id = $1 AND status = 'active' ORDER BY purchased_day, id`,
    [companyId],
  );
  return {
    owned: rows.map((r) => ({
      id: r.id,
      type: r.type,
      name: MACHINERY[r.type].name,
      purchasePricePaise: r.purchase_price_paise,
      bookValuePaise: r.book_value_paise,
      purchasedDay: r.purchased_day,
    })),
    catalog: MACHINERY_TYPES.map((t) => {
      const m = MACHINERY[t];
      return {
        type: t,
        name: m.name,
        pricePaise: m.pricePaise,
        maintenancePaisePerDay: m.maintenancePaisePerDay,
        description: m.description,
      };
    }),
  };
}

export async function getCompanyNotifications(
  deps: CoreDeps,
  auth: AuthContext,
  companyId: string,
  q: { unreadOnly: boolean; limit: number },
): Promise<NotificationsResponse> {
  assertCompanyAccess(auth, companyId);
  const [list, unread] = await Promise.all([
    deps.pool.query<{
      id: string;
      type: string;
      severity: 'info' | 'success' | 'warning' | 'danger';
      title: string;
      body: string;
      entity_type: string | null;
      entity_id: string | null;
      game_day: number;
      created_at: Date;
      read_at: Date | null;
    }>(
      `SELECT id, type, severity, title, body, entity_type, entity_id, game_day, created_at, read_at
       FROM notifications WHERE company_id = $1 AND (NOT $2::boolean OR read_at IS NULL)
       ORDER BY created_at DESC, id DESC LIMIT $3`,
      [companyId, q.unreadOnly, q.limit],
    ),
    deps.pool.query<{ n: number }>(
      'SELECT COUNT(*)::int AS n FROM notifications WHERE company_id = $1 AND read_at IS NULL',
      [companyId],
    ),
  ]);
  return {
    notifications: list.rows.map((r) => ({
      id: r.id,
      type: r.type,
      severity: r.severity,
      title: r.title,
      body: r.body,
      entityType: r.entity_type,
      entityId: r.entity_id,
      gameDay: r.game_day,
      createdAt: r.created_at.toISOString(),
      read: r.read_at !== null,
    })),
    unreadCount: unread.rows[0]?.n ?? 0,
  };
}

/**
 * "While you were away": cash movement, trades and notifications after `since` (a game day;
 * defaults to the company's last active day).
 */
export async function getAwaySummary(
  deps: CoreDeps,
  auth: AuthContext,
  companyId: string,
  q: { since?: number } = {},
): Promise<AwaySummaryResponse> {
  assertCompanyAccess(auth, companyId);
  const company = await getCompany(deps.pool, companyId);
  const day = await getCurrentGameDay(deps.pool, company.regionId);
  const fromDay = Math.min(
    day,
    Math.max(0, q.since ?? company.lastActiveDay ?? company.foundedDay),
  );

  const [cash, sales, purchases, notes] = await Promise.all([
    deps.pool.query<{ total: number }>(
      `SELECT COALESCE(SUM(amount_paise), 0)::bigint AS total FROM ledger_entries
       WHERE company_id = $1 AND account_code = 'cash' AND game_day > $2`,
      [companyId, fromDay],
    ),
    deps.pool.query<{ n: number; kg: number; gross: number }>(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(quantity_kg), 0)::bigint AS kg,
              COALESCE(SUM(gross_paise), 0)::bigint AS gross
       FROM trades WHERE seller_company_id = $1 AND game_day > $2`,
      [companyId, fromDay],
    ),
    deps.pool.query<{ n: number; kg: number; gross: number }>(
      `SELECT COUNT(*)::int AS n, COALESCE(SUM(quantity_kg), 0)::bigint AS kg,
              COALESCE(SUM(gross_paise), 0)::bigint AS gross
       FROM trades WHERE buyer_company_id = $1 AND game_day > $2`,
      [companyId, fromDay],
    ),
    deps.pool.query<{
      severity: 'info' | 'success' | 'warning' | 'danger';
      title: string;
      n: number;
    }>(
      `SELECT severity, title, COUNT(*)::int AS n, MAX(created_at) AS latest FROM notifications
       WHERE company_id = $1 AND game_day > $2
       GROUP BY severity, title ORDER BY MAX(created_at) DESC LIMIT 15`,
      [companyId, fromDay],
    ),
  ]);

  const highlights: AwaySummaryResponse['highlights'] = [];
  const s = sales.rows[0];
  if (s && s.n > 0) {
    highlights.push({
      severity: 'success',
      text: `Sold ${Number(s.kg).toLocaleString('en-IN')} kg in ${s.n} sale${s.n === 1 ? '' : 's'} for ${formatInr(Number(s.gross))}`,
    });
  }
  const p = purchases.rows[0];
  if (p && p.n > 0) {
    highlights.push({
      severity: 'info',
      text: `Bought ${Number(p.kg).toLocaleString('en-IN')} kg from other companies for ${formatInr(Number(p.gross))}`,
    });
  }
  for (const n of notes.rows) {
    highlights.push({ severity: n.severity, text: n.n > 1 ? `${n.title} (×${n.n})` : n.title });
  }
  return {
    fromDay,
    toDay: day,
    cashChangePaise: Number(cash.rows[0]?.total ?? 0),
    highlights,
  };
}
