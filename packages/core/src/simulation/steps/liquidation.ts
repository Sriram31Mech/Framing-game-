import {
  applyMarketSale,
  BANKRUPTCY_RESTART_GRANT_PAISE,
  getCrop,
  LIQUIDATION_RECOVERY,
  mulPaise,
  quoteMarketSale,
  type ItemId,
  type MarketDefinition,
  type MarketItemState,
} from '@bh/domain';
import { tickEvent, tickNotify, tickPost } from '../effects';
import { accountBalance } from '../postings';
import type { TickContext } from '../types';
import { closeContract, defaultContract, type ContractRow } from './expiry';
import { forfeitLivePlots } from './leases';

const rupees = (paise: number) => `₹${(paise / 100).toLocaleString('en-IN')}`;

export interface LiquidationSummary {
  landRecoveredPaise: number;
  machineryRecoveredPaise: number;
  inventorySoldPaise: number;
  loansWrittenOffPaise: number;
  deficitCoveredPaise: number;
  grantPaise: number;
}

/**
 * Bankruptcy liquidation (IMPLEMENTATION.md §3), all in the tick's transaction:
 *  1. open listings cancelled (reservations released); open buy-contracts cancelled (escrow
 *     refunded); accepted contracts the company must deliver are defaulted (refund + penalty);
 *  2. leased land handed back, owned land returned to the state for LIQUIDATION_RECOVERY × base
 *     price (live crops forfeited);
 *  3. machinery sold at book × LIQUIDATION_RECOVERY;
 *  4. all inventory sold to the best-paying mandi (fees apply, moves the market);
 *  5. loans repaid from any positive cash, the rest written off;
 *  6. the state covers any remaining cash deficit and pays BANKRUPTCY_RESTART_GRANT_PAISE;
 *     the company restarts 'active' with bankruptcies + 1.
 * Asset disposals take the asset's full ledger balance off the books; the difference to the
 * recovered cash is booked to gain_loss_assets.
 */
export async function liquidateCompany(
  ctx: TickContext,
  companyId: string,
): Promise<LiquidationSummary> {
  const c = ctx.client;

  // 1a. Cancel open listings and release reservations.
  const { rows: listings } = await c.query<{ id: string; lot_id: string; remaining_kg: number }>(
    `UPDATE market_listings SET status = 'cancelled', version = version + 1
     WHERE seller_company_id = $1 AND status = 'open'
     RETURNING id, lot_id, remaining_kg`,
    [companyId],
  );
  listings.sort((a, b) => a.id.localeCompare(b.id));
  for (const l of listings) {
    await c.query(
      `UPDATE inventory_lots SET reserved_kg = GREATEST(reserved_kg - $2, 0), version = version + 1
       WHERE id = $1`,
      [l.lot_id, l.remaining_kg],
    );
    await tickEvent(ctx, {
      type: 'listing.updated',
      companyId: null,
      entityType: 'listing',
      entityId: l.id,
      payload: { listingId: l.id, status: 'cancelled', remainingKg: l.remaining_kg },
    });
  }

  // 1b. Contracts.
  const { rows: contracts } = await c.query<ContractRow>(
    `SELECT id, buyer_company_id, seller_company_id, item_id, quantity_kg, total_paise, escrow_paise, status
     FROM contracts
     WHERE region_id = $1 AND status IN ('open', 'accepted')
       AND ((status = 'open' AND buyer_company_id = $2) OR (status = 'accepted' AND seller_company_id = $2))
     ORDER BY id FOR UPDATE`,
    [ctx.regionId, companyId],
  );
  for (const k of contracts) {
    if (k.status === 'open') await closeContract(ctx, k, 'cancelled');
    else await defaultContract(ctx, k);
  }

  // 2a. Leases held by the company are terminated; land goes back to the lessor.
  const { rows: leases } = await c.query<{
    id: string;
    parcel_id: string;
    lessor_company_id: string | null;
  }>(
    `SELECT id, parcel_id, lessor_company_id FROM land_leases
     WHERE lessee_company_id = $1 AND status = 'active' ORDER BY id FOR UPDATE`,
    [companyId],
  );
  for (const lease of leases) {
    await forfeitLivePlots(ctx, [lease.parcel_id], 'the company was liquidated');
    await c.query(`UPDATE land_leases SET status = 'terminated' WHERE id = $1`, [lease.id]);
    const status = lease.lessor_company_id === null ? 'for_sale' : 'owned';
    const { rows: parcelRows } = await c.query<{ list_price_paise: number | null }>(
      `UPDATE land_parcels SET status = $2, owner_company_id = $3,
              list_price_paise = CASE WHEN $3::uuid IS NULL THEN base_price_paise ELSE NULL END,
              version = version + 1, updated_at = now()
       WHERE id = $1
       RETURNING list_price_paise`,
      [lease.parcel_id, status, lease.lessor_company_id],
    );
    await tickEvent(ctx, {
      type: 'parcel.ownership_changed',
      companyId: null,
      entityType: 'parcel',
      entityId: lease.parcel_id,
      payload: {
        parcelId: lease.parcel_id,
        ownerCompanyId: lease.lessor_company_id,
        status,
        listPricePaise: parcelRows[0]?.list_price_paise ?? null,
      },
    });
  }

  // 2b. Owned land returns to the state.
  const { rows: parcels } = await c.query<{ id: string; base_price_paise: number }>(
    `SELECT id, base_price_paise FROM land_parcels WHERE owner_company_id = $1 ORDER BY id FOR UPDATE`,
    [companyId],
  );
  let landRecovered = 0;
  if (parcels.length > 0) {
    const ids = parcels.map((p) => p.id);
    await forfeitLivePlots(ctx, ids, 'the company was liquidated');
    // Any lease the company granted on its land ends with the sale.
    await c.query(
      `UPDATE land_leases SET status = 'terminated' WHERE parcel_id = ANY($1::text[]) AND status = 'active'`,
      [ids],
    );
    for (const p of parcels) {
      const recovered = mulPaise(p.base_price_paise, LIQUIDATION_RECOVERY);
      landRecovered += recovered;
      await c.query(
        `UPDATE land_parcels SET status = 'for_sale', owner_company_id = NULL,
                list_price_paise = base_price_paise, version = version + 1, updated_at = now()
         WHERE id = $1`,
        [p.id],
      );
      await c.query(
        `INSERT INTO land_ownership_history (parcel_id, from_company_id, to_company_id, price_paise, reason, game_day)
         VALUES ($1, $2, NULL, $3, 'liquidation', $4)`,
        [p.id, companyId, recovered, ctx.day],
      );
      await tickEvent(ctx, {
        type: 'parcel.ownership_changed',
        companyId: null,
        entityType: 'parcel',
        entityId: p.id,
        payload: {
          parcelId: p.id,
          ownerCompanyId: null,
          status: 'for_sale',
          listPricePaise: p.base_price_paise,
        },
      });
    }
  }
  await disposeAssetAccount(ctx, companyId, 'land', landRecovered, 'Land returned to the state');

  // 3. Machinery.
  const { rows: assets } = await c.query<{ id: string; book_value_paise: number }>(
    `UPDATE machinery_assets SET status = 'liquidated', version = version + 1
     WHERE company_id = $1 AND status = 'active'
     RETURNING id, book_value_paise`,
    [companyId],
  );
  const machineryRecovered = assets.reduce(
    (sum, a) => sum + mulPaise(a.book_value_paise, LIQUIDATION_RECOVERY),
    0,
  );
  await disposeAssetAccount(
    ctx,
    companyId,
    'machinery',
    machineryRecovered,
    'Machinery sold in liquidation',
  );

  // 4. Inventory sold to the mandi.
  const inventorySold = await sellAllInventory(ctx, companyId);

  // 5. Loans: repay from positive cash, write off the rest.
  const { rows: loans } = await c.query<{ id: string; outstanding_paise: number }>(
    `SELECT id, outstanding_paise FROM loans WHERE company_id = $1 AND status = 'active'
     ORDER BY id FOR UPDATE`,
    [companyId],
  );
  let writtenOff = 0;
  for (const loan of loans) {
    const cash = await currentCash(ctx, companyId);
    const repay = Math.min(Math.max(cash, 0), loan.outstanding_paise);
    const rest = loan.outstanding_paise - repay;
    writtenOff += rest;
    if (loan.outstanding_paise > 0) {
      await tickPost(ctx, {
        kind: 'loan_liquidation',
        description: 'Loan settled in liquidation',
        refType: 'loan',
        refId: loan.id,
        entries: [
          { companyId, account: 'loan_payable', amountPaise: loan.outstanding_paise },
          { companyId, account: 'cash', amountPaise: -repay },
          { companyId, account: 'gain_loss_assets', amountPaise: -rest },
        ],
      });
    }
    await c.query(
      `UPDATE loans SET status = 'written_off', outstanding_paise = 0, version = version + 1 WHERE id = $1`,
      [loan.id],
    );
    await tickEvent(ctx, {
      type: 'loan.updated',
      companyId,
      entityType: 'loan',
      entityId: loan.id,
      payload: { loanId: loan.id, status: 'written_off', outstandingPaise: 0 },
    });
  }

  // 6. Deficit covered by the state + restart grant.
  const cashAfter = await currentCash(ctx, companyId);
  const deficit = Math.max(0, -cashAfter);
  const grant = BANKRUPTCY_RESTART_GRANT_PAISE;
  await tickPost(ctx, {
    kind: 'bankruptcy_restart',
    description: 'Bankruptcy settlement: deficit written off and restart grant',
    refType: 'company',
    refId: companyId,
    entries: [
      { companyId, account: 'cash', amountPaise: deficit + grant },
      { companyId: null, account: 'world_treasury', amountPaise: -(deficit + grant) },
    ],
  });
  await c.query(
    `UPDATE companies SET status = 'active', distress_since_day = NULL, bankruptcies = bankruptcies + 1,
            version = version + 1
     WHERE id = $1`,
    [companyId],
  );

  const summary: LiquidationSummary = {
    landRecoveredPaise: landRecovered,
    machineryRecoveredPaise: machineryRecovered,
    inventorySoldPaise: inventorySold,
    loansWrittenOffPaise: writtenOff,
    deficitCoveredPaise: deficit,
    grantPaise: grant,
  };
  await tickNotify(ctx, {
    companyId,
    type: 'bankruptcy',
    severity: 'danger',
    title: 'Company declared bankrupt',
    body:
      `Your cash stayed negative past the grace period. Assets were liquidated (land ${rupees(landRecovered)}, ` +
      `machinery ${rupees(machineryRecovered)}, produce ${rupees(inventorySold)}), ${rupees(writtenOff)} of loans and ` +
      `a ${rupees(deficit)} deficit were written off. You restart with a ${rupees(grant)} grant.`,
    entityType: 'company',
    entityId: companyId,
    dedupeKey: `bankruptcy:${ctx.day}`,
  });
  return summary;
}

async function currentCash(ctx: TickContext, companyId: string): Promise<number> {
  const { rows } = await ctx.client.query<{ cash_paise: number }>(
    'SELECT cash_paise FROM companies WHERE id = $1',
    [companyId],
  );
  return rows[0]?.cash_paise ?? 0;
}

/** Take an asset account's whole balance off the books for `recoveredPaise` cash. */
async function disposeAssetAccount(
  ctx: TickContext,
  companyId: string,
  account: 'land' | 'machinery',
  recoveredPaise: number,
  description: string,
): Promise<void> {
  const book = await accountBalance(ctx, companyId, account);
  if (book === 0 && recoveredPaise === 0) return;
  await tickPost(ctx, {
    kind: `liquidation_${account}`,
    description,
    refType: 'company',
    refId: companyId,
    entries: [
      { companyId, account: 'cash', amountPaise: recoveredPaise },
      { companyId, account, amountPaise: -book },
      { companyId, account: 'gain_loss_assets', amountPaise: book - recoveredPaise },
    ],
  });
}

interface MarketRow {
  market_id: string;
  item_id: ItemId;
  price_paise_per_kg: number;
  supply_pressure_kg: number;
  demand_kg_per_day: number;
  definition: MarketDefinition;
}

/** Sell every remaining lot to whichever mandi pays the most (no transport: the liquidator collects). */
async function sellAllInventory(ctx: TickContext, companyId: string): Promise<number> {
  const c = ctx.client;
  const { rows: lots } = await c.query<{
    id: string;
    item_id: ItemId;
    quantity_kg: number;
    quality: number;
    cost_basis_paise: number;
  }>(
    `SELECT id, item_id, quantity_kg, quality, cost_basis_paise FROM inventory_lots
     WHERE company_id = $1 AND quantity_kg > 0 ORDER BY id FOR UPDATE`,
    [companyId],
  );
  if (lots.length === 0) return 0;
  const { rows: markets } = await c.query<MarketRow>(
    `SELECT s.market_id, s.item_id, s.price_paise_per_kg, s.supply_pressure_kg, s.demand_kg_per_day, m.definition
     FROM market_item_states s JOIN markets m ON m.id = s.market_id
     WHERE m.region_id = $1 ORDER BY s.market_id, s.item_id FOR UPDATE OF s`,
    [ctx.regionId],
  );
  const states = new Map<string, { def: MarketDefinition; state: MarketItemState }>();
  for (const m of markets) {
    states.set(`${m.market_id}|${m.item_id}`, {
      def: m.definition,
      state: {
        itemId: m.item_id,
        pricePaisePerKg: m.price_paise_per_kg,
        supplyPressureKg: m.supply_pressure_kg,
        demandKgPerDay: m.demand_kg_per_day,
      },
    });
  }

  let totalNet = 0;
  for (const lot of lots) {
    let best: {
      key: string;
      marketId: string;
      quote: ReturnType<typeof quoteMarketSale>;
    } | null = null;
    for (const [key, s] of states) {
      if (s.state.itemId !== lot.item_id) continue;
      const quote = quoteMarketSale(s.state, s.def, lot.quantity_kg, lot.quality);
      if (!best || quote.netPaise > best.quote.netPaise) {
        best = { key, marketId: s.def.id, quote };
      }
    }
    await c.query(
      `UPDATE inventory_lots SET quantity_kg = 0, reserved_kg = 0, cost_basis_paise = 0,
              version = version + 1
       WHERE id = $1`,
      [lot.id],
    );
    const sold = best !== null && best.quote.unitPricePaise > 0 && best.quote.grossPaise > 0;
    if (sold && best) {
      const entry = states.get(best.key)!;
      entry.state = applyMarketSale(entry.state, lot.quantity_kg);
      await c.query(
        `UPDATE market_item_states SET price_paise_per_kg = $3, supply_pressure_kg = $4,
                demand_kg_per_day = $5, version = version + 1
         WHERE market_id = $1 AND item_id = $2`,
        [
          best.marketId,
          lot.item_id,
          Math.max(1, Math.round(entry.state.pricePaisePerKg)),
          Math.max(0, Math.round(entry.state.supplyPressureKg)),
          Math.max(0, Math.round(entry.state.demandKgPerDay)),
        ],
      );
      const { rows: trade } = await c.query<{ id: string }>(
        `INSERT INTO trades (region_id, kind, market_id, buyer_company_id, seller_company_id, item_id,
                             quantity_kg, quality, unit_price_paise, gross_paise, fee_paise, transport_paise, game_day)
         VALUES ($1, 'market_sale', $2, NULL, $3, $4, $5, $6, $7, $8, $9, 0, $10) RETURNING id`,
        [
          ctx.regionId,
          best.marketId,
          companyId,
          lot.item_id,
          lot.quantity_kg,
          lot.quality,
          best.quote.unitPricePaise,
          best.quote.grossPaise,
          best.quote.feePaise,
          ctx.day,
        ],
      );
      totalNet += best.quote.netPaise;
      await tickPost(ctx, {
        kind: 'liquidation_inventory_sale',
        description: `${getCrop(lot.item_id).name} sold in liquidation`,
        refType: 'trade',
        refId: trade[0]!.id,
        allowNegativeCash: true,
        entries: [
          { companyId, account: 'cash', amountPaise: best.quote.netPaise },
          { companyId, account: 'expense_fees', amountPaise: best.quote.feePaise },
          { companyId, account: 'revenue_sales', amountPaise: -best.quote.grossPaise },
          { companyId, account: 'cogs', amountPaise: lot.cost_basis_paise },
          { companyId, account: 'inventory', amountPaise: -lot.cost_basis_paise },
        ],
      });
    } else if (lot.cost_basis_paise > 0) {
      await tickPost(ctx, {
        kind: 'spoilage',
        description: 'Unsaleable produce written off in liquidation',
        refType: 'inventory_lot',
        refId: lot.id,
        entries: [
          { companyId, account: 'expense_spoilage', amountPaise: lot.cost_basis_paise },
          { companyId, account: 'inventory', amountPaise: -lot.cost_basis_paise },
        ],
      });
    }
  }
  return totalNet;
}
