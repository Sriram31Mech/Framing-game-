/**
 * Land commands: purchase, lease, list, delist, sell back to the state.
 * docs/IMPLEMENTATION.md §4 "Land" and "Purchase concurrency"; DESIGN.md §5 "Land purchase".
 */
import {
  formatInr,
  LAND_SELL_TO_STATE_FRACTION,
  mulPaise,
  P2P_PRICE_CEILING_MULTIPLIER,
  P2P_PRICE_FLOOR_MULTIPLIER,
  SEASON_LENGTH_DAYS,
} from '@bh/domain';
import { conflict, DomainError, forbidden, priceChanged, ruleViolation } from '../errors';
import { emitEvent, notify } from '../events/events';
import { postLedger, type LedgerEntryInput } from '../ledger/ledger';
import { getActiveLease, getLivePlotForParcel, getParcel, type ParcelRow } from '../world/parcels';
import { assertVersion, lockParties, safeMul, type CommandContext } from './context';
import type { GameCommand } from './types';

type Cmd<T extends GameCommand['type']> = Extract<GameCommand, { type: T }>;

/** Asking price of a parcel that is for sale (state parcels: base price; owners: list price). */
export function askingPricePaise(parcel: ParcelRow): number {
  return parcel.listPricePaise ?? parcel.basePricePaise;
}

/** Sale price when an owner sells back to the state. */
export function stateBuybackPricePaise(parcel: ParcelRow): number {
  return mulPaise(parcel.basePricePaise, LAND_SELL_TO_STATE_FRACTION);
}

/** Allowed owner list-price range (anti-laundering band around the state base price). */
export function parcelListPriceBand(parcel: ParcelRow): [number, number] {
  return [
    mulPaise(parcel.basePricePaise, P2P_PRICE_FLOOR_MULTIPLIER),
    mulPaise(parcel.basePricePaise, P2P_PRICE_CEILING_MULTIPLIER),
  ];
}

/** Carrying value of a parcel in the owner's `land` ledger account (its acquisition price). */
async function landBookValue(
  ctx: CommandContext,
  parcelId: string,
  ownerId: string,
): Promise<number> {
  const { rows } = await ctx.client.query<{ price_paise: number }>(
    `SELECT price_paise FROM land_ownership_history
     WHERE parcel_id = $1 AND to_company_id = $2 ORDER BY id DESC LIMIT 1`,
    [parcelId, ownerId],
  );
  return rows[0]?.price_paise ?? 0;
}

/** Ledger lines for a company disposing of land: cash in, land out at book, gain/loss. */
function disposalEntries(companyId: string, proceeds: number, book: number): LedgerEntryInput[] {
  return [
    { companyId, account: 'cash', amountPaise: proceeds },
    { companyId, account: 'land', amountPaise: -book },
    { companyId, account: 'gain_loss_assets', amountPaise: book - proceeds },
  ];
}

async function assertNoLiveCrop(ctx: CommandContext, parcelId: string): Promise<void> {
  if (await getLivePlotForParcel(ctx.client, parcelId)) {
    throw ruleViolation('A crop is on this parcel; harvest or clear it first');
  }
}

async function assertNoActiveLease(ctx: CommandContext, parcelId: string): Promise<void> {
  if (await getActiveLease(ctx.client, parcelId)) {
    throw ruleViolation('This parcel is under an active lease');
  }
}

async function publishOwnership(
  ctx: CommandContext,
  parcel: ParcelRow,
  patch: {
    ownerCompanyId: string | null;
    status: string;
    listPricePaise: number | null;
  },
): Promise<void> {
  await emitEvent(ctx.client, {
    regionId: ctx.regionId,
    type: 'parcel.ownership_changed',
    gameDay: ctx.day,
    companyId: null,
    actorCompanyId: ctx.actor.companyId,
    entityType: 'parcel',
    entityId: parcel.id,
    payload: { parcelId: parcel.id, ...patch },
  });
}

export async function purchaseParcel(ctx: CommandContext, cmd: Cmd<'purchase_parcel'>) {
  const me = ctx.actor.companyId;
  const parcel = await getParcel(ctx.client, ctx.regionId, cmd.parcelId, { forUpdate: true });
  // The loser of a concurrent purchase waits on the row lock above, then fails here.
  assertVersion('Parcel', cmd.expectedVersion, parcel.version);
  if (parcel.status !== 'for_sale') throw conflict('This parcel is not for sale');
  if (parcel.ownerCompanyId === me) throw ruleViolation('You already own this parcel');
  const price = askingPricePaise(parcel);
  if (price !== cmd.expectedPricePaise) throw priceChanged(cmd.expectedPricePaise, price);
  await assertNoLiveCrop(ctx, parcel.id);
  await assertNoActiveLease(ctx, parcel.id);

  const seller = parcel.ownerCompanyId;
  await lockParties(ctx, [seller]);

  const entries: LedgerEntryInput[] = [
    { companyId: me, account: 'land', amountPaise: price },
    { companyId: me, account: 'cash', amountPaise: -price },
  ];
  if (seller) {
    entries.push(...disposalEntries(seller, price, await landBookValue(ctx, parcel.id, seller)));
  }
  await postLedger(ctx.client, {
    regionId: ctx.regionId,
    kind: 'land_purchase',
    description: `Purchase of parcel ${parcel.id}`,
    gameDay: ctx.day,
    refType: 'parcel',
    refId: parcel.id,
    entries,
  });

  const { rows } = await ctx.client.query<{ version: number }>(
    `UPDATE land_parcels SET owner_company_id = $2, status = 'owned', list_price_paise = NULL,
       version = version + 1, updated_at = now()
     WHERE id = $1 RETURNING version`,
    [parcel.id, me],
  );
  await ctx.client.query(
    `INSERT INTO land_ownership_history (parcel_id, from_company_id, to_company_id, price_paise, reason, game_day)
     VALUES ($1, $2, $3, $4, 'purchase', $5)`,
    [parcel.id, seller, me, price, ctx.day],
  );
  await publishOwnership(ctx, parcel, {
    ownerCompanyId: me,
    status: 'owned',
    listPricePaise: null,
  });
  if (seller) {
    await notify(ctx.client, {
      regionId: ctx.regionId,
      companyId: seller,
      type: 'parcel_sold',
      severity: 'success',
      title: `Parcel ${parcel.id} sold`,
      body: `Your parcel ${parcel.id} (${parcel.areaHa} ha) was bought for ${formatInr(price)}.`,
      gameDay: ctx.day,
      entityType: 'parcel',
      entityId: parcel.id,
    });
  }
  return { parcelId: parcel.id, pricePaise: price, version: rows[0]!.version };
}

export async function leaseParcel(ctx: CommandContext, cmd: Cmd<'lease_parcel'>) {
  const me = ctx.actor.companyId;
  const parcel = await getParcel(ctx.client, ctx.regionId, cmd.parcelId, { forUpdate: true });
  assertVersion('Parcel', cmd.expectedVersion, parcel.version);
  if (parcel.ownerCompanyId !== null || parcel.status !== 'for_sale') {
    throw conflict('Only state land that is available can be leased');
  }
  if (!Number.isInteger(cmd.seasons) || cmd.seasons < 1 || cmd.seasons > 3) {
    throw new DomainError('VALIDATION_FAILED', 'Leases run for 1 to 3 seasons');
  }
  const rent = safeMul(parcel.leaseRentPaise, cmd.seasons, 'Rent');
  if (rent !== cmd.expectedRentPaise) throw priceChanged(cmd.expectedRentPaise, rent);
  await assertNoLiveCrop(ctx, parcel.id);
  await assertNoActiveLease(ctx, parcel.id);
  await lockParties(ctx);

  const endDay = ctx.day + SEASON_LENGTH_DAYS * cmd.seasons;
  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO land_leases (parcel_id, lessor_company_id, lessee_company_id, start_day, end_day, rent_paise, status)
     VALUES ($1, NULL, $2, $3, $4, $5, 'active') RETURNING id`,
    [parcel.id, me, ctx.day, endDay, rent],
  );
  const leaseId = rows[0]!.id;
  await postLedger(ctx.client, {
    regionId: ctx.regionId,
    kind: 'lease_rent',
    description: `Lease of parcel ${parcel.id} for ${cmd.seasons} season(s)`,
    gameDay: ctx.day,
    refType: 'lease',
    refId: leaseId,
    entries: [
      { companyId: me, account: 'expense_rent', amountPaise: rent },
      { companyId: me, account: 'cash', amountPaise: -rent },
    ],
  });
  const updated = await ctx.client.query<{ version: number }>(
    `UPDATE land_parcels SET status = 'leased', list_price_paise = NULL, version = version + 1, updated_at = now()
     WHERE id = $1 RETURNING version`,
    [parcel.id],
  );
  await publishOwnership(ctx, parcel, {
    ownerCompanyId: null,
    status: 'leased',
    listPricePaise: null,
  });
  return {
    parcelId: parcel.id,
    leaseId,
    startDay: ctx.day,
    endDay,
    rentPaise: rent,
    version: updated.rows[0]!.version,
  };
}

async function loadOwnedParcel(ctx: CommandContext, parcelId: string): Promise<ParcelRow> {
  const parcel = await getParcel(ctx.client, ctx.regionId, parcelId, { forUpdate: true });
  if (parcel.ownerCompanyId !== ctx.actor.companyId) throw forbidden('You do not own this parcel');
  return parcel;
}

export async function listParcel(ctx: CommandContext, cmd: Cmd<'list_parcel'>) {
  const parcel = await loadOwnedParcel(ctx, cmd.parcelId);
  if (parcel.status !== 'owned' && parcel.status !== 'for_sale') {
    throw ruleViolation('This parcel cannot be listed right now');
  }
  const [floor, ceiling] = parcelListPriceBand(parcel);
  if (cmd.pricePaise < floor || cmd.pricePaise > ceiling) {
    throw ruleViolation('List price must be within the allowed range for this parcel', {
      minPricePaise: floor,
      maxPricePaise: ceiling,
    });
  }
  await assertNoLiveCrop(ctx, parcel.id);
  await assertNoActiveLease(ctx, parcel.id);
  await lockParties(ctx);
  const { rows } = await ctx.client.query<{ version: number }>(
    `UPDATE land_parcels SET status = 'for_sale', list_price_paise = $2, version = version + 1, updated_at = now()
     WHERE id = $1 RETURNING version`,
    [parcel.id, cmd.pricePaise],
  );
  await emitParcelUpdated(ctx, parcel.id);
  return { parcelId: parcel.id, listPricePaise: cmd.pricePaise, version: rows[0]!.version };
}

export async function delistParcel(ctx: CommandContext, cmd: Cmd<'delist_parcel'>) {
  const parcel = await loadOwnedParcel(ctx, cmd.parcelId);
  if (parcel.status !== 'for_sale') throw ruleViolation('This parcel is not listed for sale');
  await lockParties(ctx);
  const { rows } = await ctx.client.query<{ version: number }>(
    `UPDATE land_parcels SET status = 'owned', list_price_paise = NULL, version = version + 1, updated_at = now()
     WHERE id = $1 RETURNING version`,
    [parcel.id],
  );
  await emitParcelUpdated(ctx, parcel.id);
  return { parcelId: parcel.id, version: rows[0]!.version };
}

export async function sellParcelToState(ctx: CommandContext, cmd: Cmd<'sell_parcel_to_state'>) {
  const me = ctx.actor.companyId;
  const parcel = await loadOwnedParcel(ctx, cmd.parcelId);
  assertVersion('Parcel', cmd.expectedVersion, parcel.version);
  if (parcel.status !== 'owned' && parcel.status !== 'for_sale') {
    throw ruleViolation('This parcel cannot be sold right now');
  }
  const price = stateBuybackPricePaise(parcel);
  if (price !== cmd.expectedPricePaise) throw priceChanged(cmd.expectedPricePaise, price);
  await assertNoLiveCrop(ctx, parcel.id);
  await assertNoActiveLease(ctx, parcel.id);
  await lockParties(ctx);

  await postLedger(ctx.client, {
    regionId: ctx.regionId,
    kind: 'land_sale_to_state',
    description: `Sale of parcel ${parcel.id} to the state`,
    gameDay: ctx.day,
    refType: 'parcel',
    refId: parcel.id,
    entries: disposalEntries(me, price, await landBookValue(ctx, parcel.id, me)),
  });
  const { rows } = await ctx.client.query<{ version: number }>(
    `UPDATE land_parcels SET owner_company_id = NULL, status = 'for_sale', list_price_paise = base_price_paise,
       version = version + 1, updated_at = now()
     WHERE id = $1 RETURNING version`,
    [parcel.id],
  );
  await ctx.client.query(
    `INSERT INTO land_ownership_history (parcel_id, from_company_id, to_company_id, price_paise, reason, game_day)
     VALUES ($1, $2, NULL, $3, 'sale_to_state', $4)`,
    [parcel.id, me, price, ctx.day],
  );
  await publishOwnership(ctx, parcel, {
    ownerCompanyId: null,
    status: 'for_sale',
    listPricePaise: parcel.basePricePaise,
  });
  return { parcelId: parcel.id, pricePaise: price, version: rows[0]!.version };
}

export async function emitParcelUpdated(ctx: CommandContext, parcelId: string): Promise<void> {
  await emitEvent(ctx.client, {
    regionId: ctx.regionId,
    type: 'parcel.updated',
    gameDay: ctx.day,
    companyId: null,
    actorCompanyId: ctx.actor.companyId,
    entityType: 'parcel',
    entityId: parcelId,
    payload: { parcelId },
  });
}
