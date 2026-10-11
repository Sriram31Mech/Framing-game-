import { applyBps, CONTRACT_DEFAULT_PENALTY_BPS, getCrop, type ItemId } from '@bh/domain';
import { tickEvent, tickNotify, tickPost } from '../effects';
import type { TickContext } from '../types';

/**
 * Step 6a — listings whose `expires_day` has been reached at the end of day D expire and release
 * their stock reservation. A listing is therefore tradable through its expiry day inclusive.
 */
export async function expireListings(ctx: TickContext): Promise<void> {
  const { rows } = await ctx.client.query<{
    id: string;
    lot_id: string;
    remaining_kg: number;
    seller_company_id: string;
    item_id: ItemId;
  }>(
    `UPDATE market_listings SET status = 'expired', version = version + 1
     WHERE region_id = $1 AND status = 'open' AND expires_day <= $2
     RETURNING id, lot_id, remaining_kg, seller_company_id, item_id`,
    [ctx.regionId, ctx.day],
  );
  if (rows.length === 0) return;
  rows.sort((a, b) => a.id.localeCompare(b.id));

  const release = new Map<string, number>();
  for (const l of rows) release.set(l.lot_id, (release.get(l.lot_id) ?? 0) + l.remaining_kg);
  const lotIds = [...release.keys()].sort();
  await ctx.client.query(
    `UPDATE inventory_lots l SET reserved_kg = GREATEST(l.reserved_kg - u.qty, 0), version = l.version + 1
     FROM unnest($1::uuid[], $2::bigint[]) AS u(id, qty) WHERE l.id = u.id`,
    [lotIds, lotIds.map((id) => release.get(id) ?? 0)],
  );

  for (const l of rows) {
    ctx.stats.listingsExpired++;
    await tickEvent(ctx, {
      type: 'listing.updated',
      companyId: null,
      entityType: 'listing',
      entityId: l.id,
      payload: { listingId: l.id, status: 'expired', remainingKg: l.remaining_kg },
    });
    if (l.remaining_kg > 0) {
      await tickNotify(ctx, {
        companyId: l.seller_company_id,
        type: 'listing_expired',
        severity: 'info',
        title: 'Listing expired',
        body: `Your ${getCrop(l.item_id).name} listing expired with ${l.remaining_kg.toLocaleString('en-IN')} kg unsold; the stock is available again.`,
        entityType: 'listing',
        entityId: l.id,
        dedupeKey: `listing-expired:${l.id}`,
      });
    }
  }
}

export interface ContractRow {
  id: string;
  buyer_company_id: string;
  seller_company_id: string | null;
  item_id: ItemId;
  quantity_kg: number;
  total_paise: number;
  escrow_paise: number;
  status: 'open' | 'accepted';
}

/**
 * Step 6b — contract deadlines (a contract is deliverable through `delivery_by_day` inclusive).
 * Open → expired, escrow refunded to the buyer. Accepted but undelivered → defaulted: escrow
 * refunded and the seller pays CONTRACT_DEFAULT_PENALTY_BPS of the contract value to the buyer
 * (scheduled obligation: the seller's cash may go negative).
 */
export async function settleContractDeadlines(ctx: TickContext): Promise<void> {
  const { rows } = await ctx.client.query<ContractRow>(
    `SELECT id, buyer_company_id, seller_company_id, item_id, quantity_kg, total_paise, escrow_paise, status
     FROM contracts
     WHERE region_id = $1 AND status IN ('open', 'accepted') AND delivery_by_day <= $2
     ORDER BY id FOR UPDATE`,
    [ctx.regionId, ctx.day],
  );
  for (const c of rows) {
    if (c.status === 'open' || c.seller_company_id === null) {
      await closeContract(ctx, c, 'expired');
      ctx.stats.contractsExpired++;
      await tickNotify(ctx, {
        companyId: c.buyer_company_id,
        type: 'contract_expired',
        severity: 'info',
        title: 'Contract expired',
        body: `Nobody accepted your ${getCrop(c.item_id).name} contract before the deadline. Escrowed funds were returned.`,
        entityType: 'contract',
        entityId: c.id,
        dedupeKey: `contract-expired:${c.id}`,
      });
    } else {
      await defaultContract(ctx, c);
    }
  }
}

/**
 * Close a contract that will not be delivered: refund the remaining escrow to the buyer and set
 * the terminal status. Shared with bankruptcy liquidation. Caller holds the company locks.
 */
export async function closeContract(
  ctx: TickContext,
  c: ContractRow,
  status: 'expired' | 'defaulted' | 'cancelled',
): Promise<void> {
  if (c.escrow_paise > 0) {
    await tickPost(ctx, {
      kind: 'contract_escrow_refund',
      description: `Escrow refund (contract ${status})`,
      refType: 'contract',
      refId: c.id,
      entries: [
        { companyId: c.buyer_company_id, account: 'cash', amountPaise: c.escrow_paise },
        { companyId: c.buyer_company_id, account: 'escrow', amountPaise: -c.escrow_paise },
      ],
    });
  }
  await ctx.client.query(
    `UPDATE contracts SET status = $2, escrow_paise = 0, settled_day = $3, version = version + 1,
            updated_at = now()
     WHERE id = $1`,
    [c.id, status, ctx.day],
  );
  await tickEvent(ctx, {
    type: 'contract.updated',
    companyId: null,
    entityType: 'contract',
    entityId: c.id,
    payload: { contractId: c.id, status },
  });
}

/** Accepted contract past its deadline (or seller liquidated): refund + seller penalty. */
export async function defaultContract(ctx: TickContext, c: ContractRow): Promise<void> {
  const sellerId = c.seller_company_id;
  if (!sellerId) throw new Error(`contract ${c.id} has no seller to default`);
  await closeContract(ctx, c, 'defaulted');
  ctx.stats.contractsDefaulted++;

  const penalty = applyBps(c.total_paise, CONTRACT_DEFAULT_PENALTY_BPS);
  if (penalty > 0) {
    await tickPost(ctx, {
      kind: 'contract_default_penalty',
      description: 'Contract default penalty',
      refType: 'contract',
      refId: c.id,
      allowNegativeCash: true,
      entries: [
        { companyId: sellerId, account: 'expense_fees', amountPaise: penalty },
        { companyId: sellerId, account: 'cash', amountPaise: -penalty },
        { companyId: c.buyer_company_id, account: 'cash', amountPaise: penalty },
        { companyId: c.buyer_company_id, account: 'revenue_other', amountPaise: -penalty },
      ],
    });
  }
  const crop = getCrop(c.item_id).name;
  const rupees = `₹${(penalty / 100).toLocaleString('en-IN')}`;
  await tickNotify(ctx, {
    companyId: sellerId,
    type: 'contract_defaulted',
    severity: 'danger',
    title: 'Contract defaulted',
    body: `You did not deliver ${c.quantity_kg.toLocaleString('en-IN')} kg of ${crop} in time. A default penalty of ${rupees} was charged.`,
    entityType: 'contract',
    entityId: c.id,
    dedupeKey: `contract-defaulted:${c.id}`,
  });
  await tickNotify(ctx, {
    companyId: c.buyer_company_id,
    type: 'contract_defaulted',
    severity: 'warning',
    title: 'Contract defaulted by seller',
    body: `The seller did not deliver your ${crop}. Your escrow was refunded and you received a ${rupees} penalty.`,
    entityType: 'contract',
    entityId: c.id,
    dedupeKey: `contract-defaulted:${c.id}`,
  });
}
