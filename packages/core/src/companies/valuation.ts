/**
 * Balance sheet and valuation, computed from live state (not the ledger): land at state base
 * price, machinery at book value, inventory at a conservative current market price.
 * Shared by the company overview, the leaderboard and the loan offer.
 */
import {
  BASE_LOAN_RATE_BPS,
  companyValuationPaise,
  inventoryValuePaise,
  loanRateBps,
  MAX_LOAN_TERM_MONTHS,
  maxBorrowablePaise,
  type ItemId,
} from '@bh/domain';
import type { Queryable } from '../db/pool';
import { notFound } from '../errors';
import { conservativePrices } from '../world/region';

export interface BalanceSheet {
  cashPaise: number;
  escrowPaise: number;
  inventoryValuePaise: number;
  landValuePaise: number;
  machineryBookValuePaise: number;
  totalAssetsPaise: number;
  loanOutstandingPaise: number;
  totalLiabilitiesPaise: number;
  equityPaise: number;
  valuationPaise: number;
  landHa: number;
  bankruptcies: number;
}

/** Inventory valuation for a set of lots at the given price map. */
export function valueLots(
  lots: { itemId: ItemId; quantityKg: number; quality: number }[],
  prices: Map<ItemId, number>,
): number {
  let total = 0;
  for (const lot of lots) {
    const price = prices.get(lot.itemId);
    if (!price || lot.quantityKg <= 0) continue;
    total += inventoryValuePaise(lot.itemId, lot.quantityKg, lot.quality, price);
  }
  return total;
}

/**
 * Balance sheets for one company or every company in a region (single round of queries).
 */
export async function computeBalanceSheets(
  db: Queryable,
  regionId: string,
  companyId?: string,
): Promise<Map<string, BalanceSheet>> {
  const only = companyId ?? null;
  // Sequential on purpose: `db` may be a single transaction client (no concurrent queries).
  const companies = await db.query<{
    id: string;
    cash_paise: number;
    escrow_paise: number;
    bankruptcies: number;
  }>(
    `SELECT id, cash_paise, escrow_paise, bankruptcies FROM companies
       WHERE region_id = $1 AND ($2::uuid IS NULL OR id = $2)`,
    [regionId, only],
  );
  const lots = await db.query<{
    company_id: string;
    item_id: ItemId;
    quantity_kg: number;
    quality: number;
  }>(
    `SELECT l.company_id, l.item_id, l.quantity_kg, l.quality FROM inventory_lots l
       JOIN companies c ON c.id = l.company_id
       WHERE c.region_id = $1 AND ($2::uuid IS NULL OR l.company_id = $2) AND l.quantity_kg > 0`,
    [regionId, only],
  );
  const land = await db.query<{ company_id: string; value: number; ha: number }>(
    `SELECT owner_company_id AS company_id, SUM(base_price_paise)::bigint AS value,
              SUM(area_ha)::float8 AS ha
       FROM land_parcels
       WHERE region_id = $1 AND owner_company_id IS NOT NULL AND ($2::uuid IS NULL OR owner_company_id = $2)
       GROUP BY owner_company_id`,
    [regionId, only],
  );
  const machinery = await db.query<{ company_id: string; value: number }>(
    `SELECT m.company_id, SUM(m.book_value_paise)::bigint AS value FROM machinery_assets m
       JOIN companies c ON c.id = m.company_id
       WHERE c.region_id = $1 AND ($2::uuid IS NULL OR m.company_id = $2) AND m.status = 'active'
       GROUP BY m.company_id`,
    [regionId, only],
  );
  const loans = await db.query<{ company_id: string; value: number }>(
    `SELECT l.company_id, SUM(l.outstanding_paise)::bigint AS value FROM loans l
       JOIN companies c ON c.id = l.company_id
       WHERE c.region_id = $1 AND ($2::uuid IS NULL OR l.company_id = $2) AND l.status = 'active'
       GROUP BY l.company_id`,
    [regionId, only],
  );
  const prices = await conservativePrices(db, regionId);

  const lotsByCompany = new Map<
    string,
    { itemId: ItemId; quantityKg: number; quality: number }[]
  >();
  for (const l of lots.rows) {
    const list = lotsByCompany.get(l.company_id) ?? [];
    list.push({ itemId: l.item_id, quantityKg: l.quantity_kg, quality: l.quality });
    lotsByCompany.set(l.company_id, list);
  }
  const landBy = new Map(land.rows.map((r) => [r.company_id, r]));
  const machBy = new Map(machinery.rows.map((r) => [r.company_id, Number(r.value)]));
  const loanBy = new Map(loans.rows.map((r) => [r.company_id, Number(r.value)]));

  const out = new Map<string, BalanceSheet>();
  for (const c of companies.rows) {
    const inventory = valueLots(lotsByCompany.get(c.id) ?? [], prices);
    const landRow = landBy.get(c.id);
    const landValue = landRow ? Number(landRow.value) : 0;
    const machineryValue = machBy.get(c.id) ?? 0;
    const loanOutstanding = loanBy.get(c.id) ?? 0;
    const totalAssets = c.cash_paise + c.escrow_paise + inventory + landValue + machineryValue;
    const valuation = companyValuationPaise({
      cashPaise: c.cash_paise,
      escrowPaise: c.escrow_paise,
      inventoryValuePaise: inventory,
      landValuePaise: landValue,
      machineryBookValuePaise: machineryValue,
      loanOutstandingPaise: loanOutstanding,
    });
    out.set(c.id, {
      cashPaise: c.cash_paise,
      escrowPaise: c.escrow_paise,
      inventoryValuePaise: inventory,
      landValuePaise: landValue,
      machineryBookValuePaise: machineryValue,
      totalAssetsPaise: totalAssets,
      loanOutstandingPaise: loanOutstanding,
      totalLiabilitiesPaise: loanOutstanding,
      equityPaise: totalAssets - loanOutstanding,
      valuationPaise: valuation,
      landHa: landRow ? Math.round(Number(landRow.ha) * 1000) / 1000 : 0,
      bankruptcies: c.bankruptcies,
    });
  }
  return out;
}

export async function computeBalanceSheet(
  db: Queryable,
  regionId: string,
  companyId: string,
): Promise<BalanceSheet> {
  const sheet = (await computeBalanceSheets(db, regionId, companyId)).get(companyId);
  if (!sheet) throw notFound('Company', companyId);
  return sheet;
}

export interface LoanOffer {
  maxPrincipalPaise: number;
  annualRateBps: number;
  maxTermMonths: number;
}

/** What the bank offers a company right now (rate depends on leverage and past bankruptcies). */
export function loanOfferFor(sheet: BalanceSheet): LoanOffer {
  const leverage =
    sheet.totalAssetsPaise > 0 ? sheet.totalLiabilitiesPaise / sheet.totalAssetsPaise : 1;
  const rate = loanRateBps({ leverage, bankruptcies: sheet.bankruptcies });
  return {
    maxPrincipalPaise: Math.max(
      0,
      maxBorrowablePaise({
        netAssetsPaise: sheet.equityPaise,
        loanOutstandingPaise: sheet.loanOutstandingPaise,
      }),
    ),
    annualRateBps: Number.isFinite(rate) ? rate : BASE_LOAN_RATE_BPS,
    maxTermMonths: MAX_LOAN_TERM_MONTHS,
  };
}
