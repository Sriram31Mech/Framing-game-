import { getCrop, type ItemId } from '@bh/domain';
import { tickEvent, tickNotify, tickPost } from '../effects';
import type { TickContext } from '../types';

interface LotRow {
  id: string;
  company_id: string;
  item_id: ItemId;
  quantity_kg: number;
  cost_basis_paise: number;
}

/**
 * Step 4 — spoilage. Lots whose `expires_day` has been reached at the end of day D are written
 * off: open listings on them are expired (reservation released), quantity goes to zero and the
 * remaining cost basis is removed from the `inventory` ledger account
 * (Dr expense_spoilage / Cr inventory), mirroring how harvest/trades carry inventory at cost.
 */
export async function spoilExpiredLots(ctx: TickContext): Promise<void> {
  const { rows: lots } = await ctx.client.query<LotRow>(
    `SELECT l.id, l.company_id, l.item_id, l.quantity_kg, l.cost_basis_paise
     FROM inventory_lots l JOIN companies c ON c.id = l.company_id
     WHERE c.region_id = $1 AND l.quantity_kg > 0 AND l.expires_day <= $2
     ORDER BY l.id
     FOR UPDATE OF l`,
    [ctx.regionId, ctx.day],
  );
  if (lots.length === 0) return;
  const lotIds = lots.map((l) => l.id);

  const { rows: listings } = await ctx.client.query<{ id: string; remaining_kg: number }>(
    `UPDATE market_listings SET status = 'expired', version = version + 1
     WHERE lot_id = ANY($1::uuid[]) AND status = 'open'
     RETURNING id, remaining_kg`,
    [lotIds],
  );
  for (const l of listings) {
    ctx.stats.listingsExpired++;
    await tickEvent(ctx, {
      type: 'listing.updated',
      companyId: null,
      entityType: 'listing',
      entityId: l.id,
      payload: { listingId: l.id, status: 'expired', remainingKg: l.remaining_kg },
    });
  }

  await ctx.client.query(
    `UPDATE inventory_lots
     SET quantity_kg = 0, reserved_kg = 0, cost_basis_paise = 0, version = version + 1
     WHERE id = ANY($1::uuid[])`,
    [lotIds],
  );

  const writeOff = new Map<string, number>();
  for (const lot of lots) {
    ctx.stats.lotsSpoiled++;
    if (lot.cost_basis_paise > 0) {
      writeOff.set(lot.company_id, (writeOff.get(lot.company_id) ?? 0) + lot.cost_basis_paise);
    }
    const name = getCrop(lot.item_id).name;
    await tickNotify(ctx, {
      companyId: lot.company_id,
      type: 'inventory_spoiled',
      severity: 'warning',
      title: `${name} spoiled`,
      body: `${lot.quantity_kg.toLocaleString('en-IN')} kg of ${name} passed its shelf life and was written off.`,
      entityType: 'inventory_lot',
      entityId: lot.id,
      dedupeKey: `spoiled:${lot.id}`,
    });
  }

  for (const [companyId, amount] of [...writeOff].sort(([a], [b]) => a.localeCompare(b))) {
    await tickPost(ctx, {
      kind: 'spoilage',
      description: 'Spoiled inventory written off',
      refType: 'company',
      refId: companyId,
      entries: [
        { companyId, account: 'expense_spoilage', amountPaise: amount },
        { companyId, account: 'inventory', amountPaise: -amount },
      ],
    });
  }
}
