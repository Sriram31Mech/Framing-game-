/**
 * Deadlines processed by the tick: listing expiry (reservation released), open contract expiry
 * (escrow refunded), accepted contract default (refund + seller penalty) and lease expiry
 * (warning, parcel back to the state, crop forfeited).
 */
import {
  applyBps,
  CONTRACT_DEFAULT_PENALTY_BPS,
  cropDurationDays,
  getCrop,
  type CropId,
  type ItemId,
} from '@bh/domain';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { CoreDeps } from '../../src/commands/types';
import { runReconciliation } from '../../src/simulation/reconcile';
import {
  assertInvariants,
  cashOf,
  createHuman,
  execOk,
  gameDay,
  plantBest,
  REGION,
  setupWorld,
  starterParcel,
  tickDays,
  tickTo,
} from './helpers';

const quickest = (crops: CropId[]) =>
  [...crops].sort((a, b) => cropDurationDays(getCrop(a)) - cropDurationDays(getCrop(b)))[0]!;

async function bestPrice(deps: CoreDeps, itemId: ItemId): Promise<number> {
  const { rows } = await deps.pool.query<{ best: number }>(
    'SELECT MAX(price_paise_per_kg)::bigint AS best FROM market_item_states WHERE item_id = $1',
    [itemId],
  );
  return Number(rows[0]!.best);
}

describe('listing, contract and lease deadlines', () => {
  let deps: CoreDeps;
  let seller: string;
  let buyer: string;
  let lessee: string;
  let itemId: ItemId;
  let lotId: string;

  beforeAll(async () => {
    deps = await setupWorld();
    seller = await createHuman(deps, 'Seller Farms');
    buyer = await createHuman(deps, 'Buyer Foods');
    lessee = await createHuman(deps, 'Lessee Agro');
    const plot = await plantBest(deps, seller, (await starterParcel(deps, seller)).id, {
      pick: quickest,
    });
    itemId = plot.cropId;
    for (let i = 0; i < cropDurationDays(getCrop(plot.cropId)) + 10; i++) {
      const { rows } = await deps.pool.query<{ status: string }>(
        'SELECT status FROM crop_plots WHERE id = $1',
        [plot.plotId],
      );
      if (rows[0]!.status === 'ready') break;
      await tickDays(deps, 1);
    }
    const res = await execOk<{ lotId: string; quantityKg: number }>(deps, seller, {
      type: 'harvest',
      plotId: plot.plotId,
    });
    expect(res.quantityKg).toBeGreaterThan(100);
    lotId = res.lotId;
  }, 300_000);
  afterAll(async () => {
    await deps.pool.end();
  });

  it('expires a listing after its last day and releases the reservation', async () => {
    const listing = await execOk<{ listingId: string; expiresDay: number }>(deps, seller, {
      type: 'create_listing',
      itemId,
      quantityKg: 100,
      unitPricePaise: await bestPrice(deps, itemId),
      durationDays: 2,
      lotId,
    });
    const reserved = async () =>
      (
        await deps.pool.query<{ reserved_kg: number }>(
          'SELECT reserved_kg FROM inventory_lots WHERE id = $1',
          [lotId],
        )
      ).rows[0]!.reserved_kg;
    expect(await reserved()).toBe(100);
    await tickTo(deps, listing.expiresDay);
    const status = async () =>
      (
        await deps.pool.query<{ status: string }>(
          'SELECT status FROM market_listings WHERE id = $1',
          [listing.listingId],
        )
      ).rows[0]!.status;
    expect(await status()).toBe('open');
    await tickDays(deps, 1);
    expect(await status()).toBe('expired');
    expect(await reserved()).toBe(0);
    const { rows } = await deps.pool.query(
      `SELECT 1 FROM notifications WHERE company_id = $1 AND type = 'listing_expired'`,
      [seller],
    );
    expect(rows).toHaveLength(1);
  });

  it('expires an unaccepted contract and refunds the escrow', async () => {
    const cashBefore = await cashOf(deps, buyer);
    const contract = await execOk<{
      contractId: string;
      totalPaise: number;
      deliveryByDay: number;
    }>(deps, buyer, {
      type: 'create_contract',
      itemId,
      quantityKg: 50,
      minQuality: 0,
      unitPricePaise: await bestPrice(deps, itemId),
      deliveryWithinDays: 3,
    });
    expect(await cashOf(deps, buyer)).toBe(cashBefore - contract.totalPaise);
    await tickTo(deps, contract.deliveryByDay + 1);
    const { rows } = await deps.pool.query<{ status: string; escrow_paise: number }>(
      'SELECT status, escrow_paise FROM contracts WHERE id = $1',
      [contract.contractId],
    );
    expect(rows[0]).toEqual({ status: 'expired', escrow_paise: 0 });
    const { rows: co } = await deps.pool.query<{ escrow_paise: number }>(
      'SELECT escrow_paise FROM companies WHERE id = $1',
      [buyer],
    );
    expect(co[0]!.escrow_paise).toBe(0);
    // Cash may also have moved by land tax etc.; the escrow itself came back in full.
    const { rows: refund } = await deps.pool.query<{ total: number }>(
      `SELECT SUM(e.amount_paise)::bigint AS total FROM ledger_entries e
       JOIN ledger_transactions t ON t.id = e.transaction_id
       WHERE t.kind = 'contract_escrow_refund' AND t.ref_id = $1 AND e.account_code = 'cash'`,
      [contract.contractId],
    );
    expect(Number(refund[0]!.total)).toBe(contract.totalPaise);
  });

  it('defaults an accepted, undelivered contract: refund plus penalty from the seller', async () => {
    const contract = await execOk<{
      contractId: string;
      totalPaise: number;
      deliveryByDay: number;
      termsHash: string;
      version: number;
    }>(deps, buyer, {
      type: 'create_contract',
      itemId,
      quantityKg: 50,
      minQuality: 0,
      unitPricePaise: await bestPrice(deps, itemId),
      deliveryWithinDays: 4,
    });
    await execOk(deps, seller, {
      type: 'accept_contract',
      contractId: contract.contractId,
      expectedVersion: contract.version,
      termsHash: contract.termsHash,
    });
    await tickTo(deps, contract.deliveryByDay);
    const sellerCash = await cashOf(deps, seller);
    const buyerCash = await cashOf(deps, buyer);
    await tickDays(deps, 1);
    const { rows } = await deps.pool.query<{ status: string; escrow_paise: number }>(
      'SELECT status, escrow_paise FROM contracts WHERE id = $1',
      [contract.contractId],
    );
    expect(rows[0]).toEqual({ status: 'defaulted', escrow_paise: 0 });
    const penalty = applyBps(contract.totalPaise, CONTRACT_DEFAULT_PENALTY_BPS);
    // Other daily charges (irrigation/tax) could apply too; the penalty is exact in the ledger.
    const { rows: pen } = await deps.pool.query<{ company_id: string; total: number }>(
      `SELECT e.company_id, SUM(e.amount_paise)::bigint AS total FROM ledger_entries e
       JOIN ledger_transactions t ON t.id = e.transaction_id
       WHERE t.kind = 'contract_default_penalty' AND t.ref_id = $1 AND e.account_code = 'cash'
       GROUP BY e.company_id`,
      [contract.contractId],
    );
    const byCompany = new Map(pen.map((p) => [p.company_id, Number(p.total)]));
    expect(byCompany.get(seller)).toBe(-penalty);
    expect(byCompany.get(buyer)).toBe(penalty);
    expect(await cashOf(deps, seller)).toBeLessThanOrEqual(sellerCash - penalty);
    expect(await cashOf(deps, buyer)).toBeGreaterThanOrEqual(
      buyerCash + contract.totalPaise + penalty - 1_000_00,
    );
    const { rows: notes } = await deps.pool.query<{ company_id: string }>(
      `SELECT company_id FROM notifications WHERE type = 'contract_defaulted' AND entity_id = $1`,
      [contract.contractId],
    );
    expect(notes.map((n) => n.company_id).sort()).toEqual([buyer, seller].sort());
  });

  it('warns 7 days before a lease ends, then returns the land and forfeits the crop', async () => {
    const { rows } = await deps.pool.query<{
      id: string;
      version: number;
      lease_rent_paise: number;
    }>(
      `SELECT id, version, lease_rent_paise FROM land_parcels
       WHERE region_id = $1 AND status = 'for_sale' AND owner_company_id IS NULL
         AND (env->>'waterAccess') <> 'none'
       ORDER BY lease_rent_paise LIMIT 1`,
      [REGION],
    );
    const parcel = rows[0]!;
    const lease = await execOk<{ leaseId: string; endDay: number }>(deps, lessee, {
      type: 'lease_parcel',
      parcelId: parcel.id,
      expectedVersion: parcel.version,
      seasons: 1,
      expectedRentPaise: parcel.lease_rent_paise,
    });
    // If nothing sowable fits the lease right now, forfeiture is simply not exercised.
    const plotId = await plantBest(deps, lessee, parcel.id, { pick: quickest }).then(
      (p) => p.plotId,
      () => null,
    );

    await tickTo(deps, lease.endDay - 7);
    const warned = async () =>
      (
        await deps.pool.query(
          `SELECT 1 FROM notifications WHERE company_id = $1 AND type = 'lease_expiring' AND entity_id = $2`,
          [lessee, lease.leaseId],
        )
      ).rowCount;
    expect(await warned()).toBe(0);
    await tickDays(deps, 1);
    expect(await warned()).toBe(1);

    await tickTo(deps, lease.endDay);
    const { rows: still } = await deps.pool.query<{ status: string }>(
      'SELECT status FROM land_leases WHERE id = $1',
      [lease.leaseId],
    );
    expect(still[0]!.status).toBe('active'); // usable through its last day
    await tickDays(deps, 1);
    expect(await warned()).toBe(1);

    const { rows: ended } = await deps.pool.query<{ status: string }>(
      'SELECT status FROM land_leases WHERE id = $1',
      [lease.leaseId],
    );
    expect(ended[0]!.status).toBe('ended');
    const { rows: land } = await deps.pool.query<{
      status: string;
      owner_company_id: string | null;
      list_price_paise: number;
      base_price_paise: number;
    }>(
      'SELECT status, owner_company_id, list_price_paise, base_price_paise FROM land_parcels WHERE id = $1',
      [parcel.id],
    );
    expect(land[0]!.status).toBe('for_sale');
    expect(land[0]!.owner_company_id).toBeNull();
    expect(land[0]!.list_price_paise).toBe(land[0]!.base_price_paise);
    if (plotId) {
      const { rows: plot } = await deps.pool.query<{ status: string }>(
        'SELECT status FROM crop_plots WHERE id = $1',
        [plotId],
      );
      expect(plot[0]!.status).toBe('cleared');
      const { rows: forfeited } = await deps.pool.query(
        `SELECT 1 FROM notifications WHERE type = 'crop_forfeited' AND entity_id = $1`,
        [plotId],
      );
      expect(forfeited).toHaveLength(1);
    }
    expect(await gameDay(deps)).toBe(lease.endDay + 1);
    await assertInvariants(deps.pool);
    expect((await runReconciliation(deps, REGION)).issues).toEqual([]);
  });
});
