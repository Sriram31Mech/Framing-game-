/**
 * Player-to-player listings. docs/IMPLEMENTATION.md §4 "P2P listings".
 * The seller reserves stock from one lot; buyers pay unit × qty; the seller receives that minus
 * P2P_TRADE_FEE_BPS (a money sink); the buyer receives a new lot with the same quality/expiry.
 */
import {
  applyBps,
  formatInr,
  getCrop,
  P2P_TRADE_FEE_BPS,
  p2pPriceBand,
  type ItemId,
} from '@bh/domain';
import { statewidePricePaise } from '../world/region';
import {
  conflict,
  DomainError,
  forbidden,
  insufficientStock,
  notFound,
  priceChanged,
  ruleViolation,
} from '../errors';
import { emitEvent, notify } from '../events/events';
import { postLedger } from '../ledger/ledger';
import { lockParties, safeMul, type CommandContext } from './context';
import {
  applyTakes,
  availableKg,
  costShare,
  insertLot,
  lockAvailableLots,
  lockLot,
  type LotRow,
} from './inventory';
import type { GameCommand } from './types';

type Cmd<T extends GameCommand['type']> = Extract<GameCommand, { type: T }>;

/** Anti-spam cap on simultaneously open listings per company. */
export const MAX_OPEN_LISTINGS_PER_COMPANY = 20;

/** Throws RULE_VIOLATION unless the unit price lies in the P2P band around the statewide price. */
export async function assertP2pPrice(
  ctx: CommandContext,
  itemId: ItemId,
  unitPricePaise: number,
): Promise<void> {
  const best = await statewidePricePaise(ctx.client, ctx.regionId, itemId);
  const [floor, ceiling] = p2pPriceBand(best);
  if (unitPricePaise < floor || unitPricePaise > ceiling) {
    throw ruleViolation('Price is outside the allowed range for this item', {
      minUnitPricePaise: floor,
      maxUnitPricePaise: ceiling,
      statewidePricePaise: best,
    });
  }
}

interface ListingRow {
  id: string;
  seller_company_id: string;
  item_id: ItemId;
  lot_id: string;
  quality: number;
  quantity_kg: number;
  remaining_kg: number;
  unit_price_paise: number;
  status: 'open' | 'filled' | 'cancelled' | 'expired';
  expires_day: number;
  version: number;
}

async function lockListing(ctx: CommandContext, listingId: string): Promise<ListingRow> {
  const { rows } = await ctx.client.query<ListingRow>(
    `SELECT id, seller_company_id, item_id, lot_id, quality, quantity_kg, remaining_kg, unit_price_paise,
            status, expires_day, version
     FROM market_listings WHERE id = $1 AND region_id = $2 FOR UPDATE`,
    [listingId, ctx.regionId],
  );
  const r = rows[0];
  if (!r) throw notFound('Listing', listingId);
  return r;
}

async function emitListingUpdated(
  ctx: CommandContext,
  listing: { id: string },
  status: string,
  remainingKg: number,
): Promise<void> {
  await emitEvent(ctx.client, {
    regionId: ctx.regionId,
    type: 'listing.updated',
    gameDay: ctx.day,
    companyId: null,
    actorCompanyId: ctx.actor.companyId,
    entityType: 'listing',
    entityId: listing.id,
    payload: { listingId: listing.id, status, remainingKg },
  });
}

export async function createListing(ctx: CommandContext, cmd: Cmd<'create_listing'>) {
  const me = ctx.actor.companyId;
  await assertP2pPrice(ctx, cmd.itemId, cmd.unitPricePaise);
  safeMul(cmd.unitPricePaise, cmd.quantityKg, 'Listing value');
  await lockParties(ctx);

  const open = await ctx.client.query<{ n: number }>(
    `SELECT COUNT(*)::int AS n FROM market_listings WHERE seller_company_id = $1 AND status = 'open'`,
    [me],
  );
  if ((open.rows[0]?.n ?? 0) >= MAX_OPEN_LISTINGS_PER_COMPANY) {
    throw new DomainError(
      'LIMIT_EXCEEDED',
      `At most ${MAX_OPEN_LISTINGS_PER_COMPANY} open listings`,
    );
  }

  let lot: LotRow | null;
  if (cmd.lotId) {
    lot = await lockLot(ctx, cmd.lotId);
    if (!lot || lot.companyId !== me) throw notFound('Inventory lot', cmd.lotId);
    if (lot.itemId !== cmd.itemId) throw ruleViolation('That lot holds a different item');
    if (lot.expiresDay < ctx.day) throw ruleViolation('That lot has spoiled');
    if (availableKg(lot) < cmd.quantityKg)
      throw insufficientStock(cmd.quantityKg, availableKg(lot));
  } else {
    const lots = await lockAvailableLots(ctx, me, cmd.itemId, 'listing');
    lot = lots.find((l) => availableKg(l) >= cmd.quantityKg) ?? null;
    if (!lot) {
      const best = lots.reduce((m, l) => Math.max(m, availableKg(l)), 0);
      throw new DomainError(
        'INSUFFICIENT_STOCK',
        'No single lot has enough available stock for this listing',
        { requiredKg: cmd.quantityKg, largestLotAvailableKg: best },
      );
    }
  }

  await ctx.client.query(
    'UPDATE inventory_lots SET reserved_kg = reserved_kg + $2, version = version + 1 WHERE id = $1',
    [lot.id, cmd.quantityKg],
  );
  // A listing never outlives its produce.
  const expiresDay = Math.min(ctx.day + cmd.durationDays, lot.expiresDay);
  const { rows } = await ctx.client.query<{ id: string; version: number }>(
    `INSERT INTO market_listings (region_id, seller_company_id, item_id, lot_id, quality, quantity_kg,
       remaining_kg, unit_price_paise, status, created_day, expires_day)
     VALUES ($1, $2, $3, $4, $5, $6, $6, $7, 'open', $8, $9) RETURNING id, version`,
    [
      ctx.regionId,
      me,
      cmd.itemId,
      lot.id,
      lot.quality,
      cmd.quantityKg,
      cmd.unitPricePaise,
      ctx.day,
      expiresDay,
    ],
  );
  const listingId = rows[0]!.id;
  await emitListingUpdated(ctx, { id: listingId }, 'open', cmd.quantityKg);
  return {
    listingId,
    lotId: lot.id,
    itemId: cmd.itemId,
    quality: lot.quality,
    quantityKg: cmd.quantityKg,
    unitPricePaise: cmd.unitPricePaise,
    expiresDay,
    version: rows[0]!.version,
  };
}

export async function buyListing(ctx: CommandContext, cmd: Cmd<'buy_listing'>) {
  const me = ctx.actor.companyId;
  // Concurrent buyers serialise on the listing row; the loser sees the reduced remaining_kg.
  const listing = await lockListing(ctx, cmd.listingId);
  if (listing.status !== 'open' || listing.expires_day < ctx.day) {
    throw conflict('This listing is no longer available');
  }
  if (listing.seller_company_id === me) throw ruleViolation('You cannot buy your own listing');
  if (listing.unit_price_paise !== cmd.expectedUnitPricePaise) {
    throw priceChanged(cmd.expectedUnitPricePaise, listing.unit_price_paise);
  }
  if (cmd.quantityKg > listing.remaining_kg) {
    throw insufficientStock(cmd.quantityKg, listing.remaining_kg);
  }

  const seller = listing.seller_company_id;
  await lockParties(ctx, [seller]);
  const lot = await lockLot(ctx, listing.lot_id);
  if (!lot || lot.reservedKg < cmd.quantityKg || lot.quantityKg < cmd.quantityKg) {
    // Should be impossible (reservation invariant); refuse rather than create stock.
    throw conflict('The listed stock is no longer available');
  }

  const gross = safeMul(listing.unit_price_paise, cmd.quantityKg, 'Purchase total');
  const fee = applyBps(gross, P2P_TRADE_FEE_BPS);
  const take = { lot, kg: cmd.quantityKg, costPaise: costShare(lot, cmd.quantityKg) };
  await applyTakes(ctx, [take], { fromReserved: true });

  const remaining = listing.remaining_kg - cmd.quantityKg;
  const status = remaining === 0 ? 'filled' : 'open';
  await ctx.client.query(
    'UPDATE market_listings SET remaining_kg = $2, status = $3, version = version + 1 WHERE id = $1',
    [listing.id, remaining, status],
  );

  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO trades (region_id, kind, listing_id, buyer_company_id, seller_company_id, item_id,
       quantity_kg, quality, unit_price_paise, gross_paise, fee_paise, game_day)
     VALUES ($1, 'listing', $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
    [
      ctx.regionId,
      listing.id,
      me,
      seller,
      listing.item_id,
      cmd.quantityKg,
      lot.quality,
      listing.unit_price_paise,
      gross,
      fee,
      ctx.day,
    ],
  );
  const tradeId = rows[0]!.id;
  const newLotId = await insertLot(ctx, {
    companyId: me,
    itemId: listing.item_id,
    quantityKg: cmd.quantityKg,
    quality: lot.quality,
    costBasisPaise: gross,
    source: 'trade',
    sourceRef: tradeId,
    producedDay: lot.producedDay,
    expiresDay: lot.expiresDay,
  });

  await postLedger(ctx.client, {
    regionId: ctx.regionId,
    kind: 'p2p_trade',
    description: `P2P purchase of ${cmd.quantityKg} kg ${listing.item_id}`,
    gameDay: ctx.day,
    refType: 'trade',
    refId: tradeId,
    entries: [
      // buyer: produce taken into inventory at cost
      { companyId: me, account: 'inventory', amountPaise: gross },
      { companyId: me, account: 'cash', amountPaise: -gross },
      // seller: revenue less the trade fee; stock relieved at cost
      { companyId: seller, account: 'cash', amountPaise: gross - fee },
      { companyId: seller, account: 'expense_fees', amountPaise: fee },
      { companyId: seller, account: 'revenue_sales', amountPaise: -gross },
      { companyId: seller, account: 'cogs', amountPaise: take.costPaise },
      { companyId: seller, account: 'inventory', amountPaise: -take.costPaise },
    ],
  });

  await emitListingUpdated(ctx, listing, status, remaining);
  for (const [companyId, role, total] of [
    [me, 'buyer', gross],
    [seller, 'seller', gross - fee],
  ] as const) {
    await emitEvent(ctx.client, {
      regionId: ctx.regionId,
      type: 'trade.completed',
      gameDay: ctx.day,
      companyId,
      actorCompanyId: me,
      entityType: 'trade',
      entityId: tradeId,
      payload: {
        tradeId,
        itemId: listing.item_id,
        quantityKg: cmd.quantityKg,
        totalPaise: total,
        role,
      },
    });
  }
  const crop = getCrop(listing.item_id);
  await notify(ctx.client, {
    regionId: ctx.regionId,
    companyId: seller,
    type: 'listing_sold',
    severity: 'success',
    title: `${crop.name} listing sold`,
    body: `${cmd.quantityKg.toLocaleString('en-IN')} kg of your ${crop.name} sold for ${formatInr(gross)} (you received ${formatInr(gross - fee)} after fees).${remaining === 0 ? ' The listing is now filled.' : ''}`,
    gameDay: ctx.day,
    entityType: 'listing',
    entityId: listing.id,
  });
  return {
    tradeId,
    listingId: listing.id,
    lotId: newLotId,
    itemId: listing.item_id,
    quantityKg: cmd.quantityKg,
    quality: lot.quality,
    unitPricePaise: listing.unit_price_paise,
    totalPaise: gross,
    remainingKg: remaining,
  };
}

export async function cancelListing(ctx: CommandContext, cmd: Cmd<'cancel_listing'>) {
  const listing = await lockListing(ctx, cmd.listingId);
  if (listing.seller_company_id !== ctx.actor.companyId)
    throw forbidden('This is not your listing');
  if (listing.status !== 'open') throw conflict('This listing is no longer open');
  await lockParties(ctx);
  await ctx.client.query(
    `UPDATE inventory_lots SET reserved_kg = GREATEST(reserved_kg - $2, 0), version = version + 1 WHERE id = $1`,
    [listing.lot_id, listing.remaining_kg],
  );
  const { rows } = await ctx.client.query<{ version: number }>(
    `UPDATE market_listings SET status = 'cancelled', version = version + 1 WHERE id = $1 RETURNING version`,
    [listing.id],
  );
  await emitListingUpdated(ctx, listing, 'cancelled', listing.remaining_kg);
  return { listingId: listing.id, releasedKg: listing.remaining_kg, version: rows[0]!.version };
}
