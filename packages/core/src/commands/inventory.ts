/**
 * Inventory lot primitives for command handlers. Quantities are integer kg; a lot's
 * `cost_basis_paise` is the carrying cost of its remaining quantity and is mirrored by the
 * company's `inventory` ledger account (harvest capitalises, sales/spoilage relieve).
 * Stock never goes negative: every consumption runs on rows locked FOR UPDATE and checks
 * availability (quantity − reserved) first; the DB CHECKs are the last line of defence.
 */
import type { ItemId } from '@bh/domain';
import { insufficientStock } from '../errors';
import type { CommandContext } from './context';

export interface LotRow {
  id: string;
  companyId: string;
  itemId: ItemId;
  quantityKg: number;
  reservedKg: number;
  quality: number;
  costBasisPaise: number;
  source: 'harvest' | 'trade' | 'contract';
  producedDay: number;
  expiresDay: number;
  version: number;
}

interface LotDbRow {
  id: string;
  company_id: string;
  item_id: ItemId;
  quantity_kg: number;
  reserved_kg: number;
  quality: number;
  cost_basis_paise: number;
  source: LotRow['source'];
  produced_day: number;
  expires_day: number;
  version: number;
}

export const LOT_COLUMNS = `l.id, l.company_id, l.item_id, l.quantity_kg, l.reserved_kg, l.quality,
  l.cost_basis_paise, l.source, l.produced_day, l.expires_day, l.version`;

export function mapLot(r: LotDbRow): LotRow {
  return {
    id: r.id,
    companyId: r.company_id,
    itemId: r.item_id,
    quantityKg: r.quantity_kg,
    reservedKg: r.reserved_kg,
    quality: r.quality,
    costBasisPaise: r.cost_basis_paise,
    source: r.source,
    producedDay: r.produced_day,
    expiresDay: r.expires_day,
    version: r.version,
  };
}

export type LotOrder = 'market' | 'contract' | 'listing';

/**
 * Lock a company's unspoiled lots of an item that have unreserved stock, in consumption order:
 * - market: lowest quality first, then FIFO (oldest produce first)
 * - contract: only quality >= minQuality, lowest qualifying quality first, then FIFO
 * - listing: best quality first (seller's choice when no lot is specified)
 */
export async function lockAvailableLots(
  ctx: CommandContext,
  companyId: string,
  itemId: ItemId,
  order: LotOrder,
  minQuality = 0,
): Promise<LotRow[]> {
  const orderBy =
    order === 'listing'
      ? 'l.quality DESC, l.produced_day ASC, l.id ASC'
      : 'l.quality ASC, l.produced_day ASC, l.id ASC';
  const { rows } = await ctx.client.query<LotDbRow>(
    `SELECT ${LOT_COLUMNS} FROM inventory_lots l
     WHERE l.company_id = $1 AND l.item_id = $2 AND l.quantity_kg > l.reserved_kg
       AND l.expires_day >= $3 AND l.quality >= $4
     ORDER BY ${orderBy}
     FOR UPDATE`,
    [companyId, itemId, ctx.day, minQuality],
  );
  return rows.map(mapLot);
}

export async function lockLot(ctx: CommandContext, lotId: string): Promise<LotRow | null> {
  const { rows } = await ctx.client.query<LotDbRow>(
    `SELECT ${LOT_COLUMNS} FROM inventory_lots l WHERE l.id = $1 FOR UPDATE`,
    [lotId],
  );
  const r = rows[0];
  return r ? mapLot(r) : null;
}

export const availableKg = (lot: LotRow): number => lot.quantityKg - lot.reservedKg;

export interface LotTake {
  lot: LotRow;
  kg: number;
  /** Cost basis relieved with this quantity. */
  costPaise: number;
}

/** Cost basis attributable to `kg` of a lot (all of it when the lot is emptied). */
export function costShare(lot: LotRow, kg: number): number {
  if (kg >= lot.quantityKg) return lot.costBasisPaise;
  return Math.round((lot.costBasisPaise * kg) / lot.quantityKg);
}

/** Plan consumption of `kg` from unreserved stock across the given lots (in order). */
export function planTakes(lots: LotRow[], kg: number): LotTake[] {
  const total = lots.reduce((s, l) => s + availableKg(l), 0);
  if (total < kg) throw insufficientStock(kg, total);
  const takes: LotTake[] = [];
  let remaining = kg;
  for (const lot of lots) {
    if (remaining === 0) break;
    const take = Math.min(availableKg(lot), remaining);
    if (take <= 0) continue;
    takes.push({ lot, kg: take, costPaise: costShare(lot, take) });
    remaining -= take;
  }
  return takes;
}

/**
 * Remove taken stock from lots. `fromReserved` consumes reserved stock (listing fills)
 * instead of unreserved stock.
 */
export async function applyTakes(
  ctx: CommandContext,
  takes: LotTake[],
  opts: { fromReserved?: boolean } = {},
): Promise<void> {
  for (const t of takes) {
    const res = await ctx.client.query(
      `UPDATE inventory_lots
       SET quantity_kg = quantity_kg - $2,
           reserved_kg = reserved_kg - $3,
           cost_basis_paise = cost_basis_paise - $4,
           version = version + 1
       WHERE id = $1 AND quantity_kg - $2 >= reserved_kg - $3 AND reserved_kg - $3 >= 0`,
      [t.lot.id, t.kg, opts.fromReserved ? t.kg : 0, t.costPaise],
    );
    if (res.rowCount !== 1) throw insufficientStock(t.kg, 0);
  }
}

export async function insertLot(
  ctx: CommandContext,
  lot: {
    companyId: string;
    itemId: ItemId;
    quantityKg: number;
    quality: number;
    costBasisPaise: number;
    source: LotRow['source'];
    sourceRef: string;
    producedDay: number;
    expiresDay: number;
  },
): Promise<string> {
  const { rows } = await ctx.client.query<{ id: string }>(
    `INSERT INTO inventory_lots (company_id, item_id, quantity_kg, quality, cost_basis_paise, source,
       source_ref, produced_day, expires_day)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [
      lot.companyId,
      lot.itemId,
      lot.quantityKg,
      lot.quality,
      lot.costBasisPaise,
      lot.source,
      lot.sourceRef,
      lot.producedDay,
      lot.expiresDay,
    ],
  );
  return rows[0]!.id;
}
