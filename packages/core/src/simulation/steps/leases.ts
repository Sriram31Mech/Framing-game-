import { tickEvent, tickNotify } from '../effects';
import type { TickContext } from '../types';

const LEASE_WARNING_DAYS = 7;

/**
 * Clear (forfeit) every live plot on the given parcels. Used when a lease ends or land is
 * liquidated. Crop costs were already expensed when incurred, so there is nothing to post.
 */
export async function forfeitLivePlots(
  ctx: TickContext,
  parcelIds: string[],
  reason: string,
): Promise<number> {
  if (parcelIds.length === 0) return 0;
  const { rows } = await ctx.client.query<{
    id: string;
    parcel_id: string;
    company_id: string;
    crop_id: string;
  }>(
    `UPDATE crop_plots SET status = 'cleared', version = version + 1, updated_at = now()
     WHERE parcel_id = ANY($1::text[]) AND status IN ('growing', 'ready', 'failed')
     RETURNING id, parcel_id, company_id, crop_id`,
    [parcelIds],
  );
  rows.sort((a, b) => a.id.localeCompare(b.id));
  for (const p of rows) {
    await tickNotify(ctx, {
      companyId: p.company_id,
      type: 'crop_forfeited',
      severity: 'danger',
      title: 'Crop forfeited',
      body: `Your crop on parcel ${p.parcel_id} was forfeited: ${reason}.`,
      entityType: 'crop_plot',
      entityId: p.id,
      dedupeKey: `crop-forfeited:${p.id}`,
    });
  }
  return rows.length;
}

/**
 * Step 7 — leases. A lease is usable through `end_day` inclusive and expires at the end of that
 * day (tick D processes leases with end_day <= D): the parcel returns to its lessor (the state →
 * `for_sale` at base price), and any crop the lessee still has on it is forfeited. Lessees are
 * warned once, 7 days ahead.
 */
export async function processLeases(ctx: TickContext): Promise<void> {
  const { rows: ending } = await ctx.client.query<{
    id: string;
    parcel_id: string;
    lessor_company_id: string | null;
    lessee_company_id: string;
  }>(
    `SELECT l.id, l.parcel_id, l.lessor_company_id, l.lessee_company_id
     FROM land_leases l JOIN land_parcels p ON p.id = l.parcel_id
     WHERE p.region_id = $1 AND l.status = 'active' AND l.end_day <= $2
     ORDER BY l.id
     FOR UPDATE OF l, p`,
    [ctx.regionId, ctx.day],
  );

  for (const lease of ending) {
    await ctx.client.query(`UPDATE land_leases SET status = 'ended' WHERE id = $1`, [lease.id]);
    const forfeited = await forfeitLivePlots(ctx, [lease.parcel_id], 'the lease ended');
    const toState = lease.lessor_company_id === null;
    const status = toState ? 'for_sale' : 'owned';
    // State land is listed at its base price again (as at bootstrap); private land goes back to
    // its owner unlisted.
    const { rows: parcelRows } = await ctx.client.query<{ list_price_paise: number | null }>(
      `UPDATE land_parcels
       SET status = $2, owner_company_id = $3,
           list_price_paise = CASE WHEN $3::uuid IS NULL THEN base_price_paise ELSE NULL END,
           version = version + 1, updated_at = now()
       WHERE id = $1
       RETURNING list_price_paise`,
      [lease.parcel_id, status, lease.lessor_company_id],
    );
    ctx.stats.leasesEnded++;
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
    await tickNotify(ctx, {
      companyId: lease.lessee_company_id,
      type: 'lease_ended',
      severity: forfeited > 0 ? 'danger' : 'info',
      title: 'Lease ended',
      body:
        `Your lease on parcel ${lease.parcel_id} has ended and the land was returned.` +
        (forfeited > 0 ? ' The crop still on it was forfeited.' : ''),
      entityType: 'lease',
      entityId: lease.id,
      dedupeKey: `lease-ended:${lease.id}`,
    });
  }

  const { rows: expiring } = await ctx.client.query<{
    id: string;
    parcel_id: string;
    lessee_company_id: string;
    end_day: number;
  }>(
    `SELECT l.id, l.parcel_id, l.lessee_company_id, l.end_day
     FROM land_leases l JOIN land_parcels p ON p.id = l.parcel_id
     WHERE p.region_id = $1 AND l.status = 'active' AND l.end_day > $2 AND l.end_day <= $3
     ORDER BY l.id`,
    [ctx.regionId, ctx.day, ctx.day + LEASE_WARNING_DAYS],
  );
  for (const lease of expiring) {
    // Whole days of use left after today (the lease is still usable on its end day).
    const days = lease.end_day - ctx.day;
    await tickNotify(ctx, {
      companyId: lease.lessee_company_id,
      type: 'lease_expiring',
      severity: 'warning',
      title: 'Lease ending soon',
      body: `Your lease on parcel ${lease.parcel_id} ends in ${days} day${days === 1 ? '' : 's'} (day ${lease.end_day} is the last day). Harvest any crop before then or it will be forfeited.`,
      entityType: 'lease',
      entityId: lease.id,
      dedupeKey: `lease-expiring:${lease.id}`,
    });
  }
}
